/**
 * SillyTavern Server Plugin — LanguageTool (Java CLI)
 *
 * Calls languagetool-commandline.jar directly via child_process.
 * No separate HTTP server needed.
 *
 * Endpoint: POST /api/plugins/languagetool/check
 *   Body:    { "text": "...", "languages": ["en-US", "de-DE"] }
 *   Returns: LanguageTool JSON response (matches, replacements, etc.)
 */

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths (relative to this plugin folder) ────────────────────────────────
const PLUGIN_DIR     = path.dirname(fileURLToPath(import.meta.url));
const LT_JAR         = path.join(PLUGIN_DIR, 'languagetool-commandline.jar');
const FASTTEXT_MODEL = path.join(PLUGIN_DIR, 'bin', 'lid.176.bin');
const FASTTEXT_BIN   = path.join(PLUGIN_DIR, 'bin', 'fasttext');
const MAX_TEXT_LENGTH = 100_000;
const WORKER_CLASSPATH = `${LT_JAR}${path.delimiter}${path.join(PLUGIN_DIR, 'libs', '*')}`;

let workerProcess;
let workerReady;
let workerRequestId = 0;
const workerRequests = new Map();

// ── Plugin metadata ────────────────────────────────────────────────────────
export const info = {
    id:          'languagetool',
    name:        'LanguageTool',
    description: 'Grammar and spell checking via LanguageTool Java CLI (no HTTP server).',
};

function checkJavaRuntime() {
    return new Promise(resolve => {
        execFile('java', ['-version'], { cwd: PLUGIN_DIR, timeout: 5_000 }, error => resolve(!error));
    });
}

function startWorker() {
    if (workerReady) return workerReady;
    workerReady = new Promise((resolve, reject) => {
        workerProcess = spawn('java', ['--class-path', WORKER_CLASSPATH, 'LanguageToolWorker.java', FASTTEXT_MODEL, FASTTEXT_BIN], {
            cwd: PLUGIN_DIR,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buffer = '';
        let stderrTail = '';
        workerProcess.stdout.setEncoding('utf8');
        workerProcess.stdout.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const message = JSON.parse(line);
                    if (message.ready) resolve();
                    else workerRequests.get(message.id)?.resolve(message);
                    if (message.id) workerRequests.delete(message.id);
                } catch (error) {
                    console.error('[LanguageTool] Invalid worker response:', error);
                }
            }
        });
        workerProcess.stderr.setEncoding('utf8');
        workerProcess.stderr.on('data', message => {
            stderrTail = (stderrTail + message).slice(-2000);
            console.debug('[LanguageTool worker]', message.trim());
        });
        workerProcess.once('error', reject);
        workerProcess.once('exit', (code, signal) => {
            const error = new Error(`LanguageTool worker exited (${code ?? signal}).`);
            for (const request of workerRequests.values()) request.reject(error);
            workerRequests.clear();
            workerProcess = undefined;
            workerReady = undefined;
            reject(new Error(`LanguageTool worker exited before it was ready (${code ?? signal}).\n${stderrTail.trim()}`));
        });
    });
    return workerReady;
}

async function checkWithWorker(text, languages) {
    await startWorker();
    const id = String(++workerRequestId);
    const response = await new Promise((resolve, reject) => {
        workerRequests.set(id, { resolve, reject });
        workerProcess.stdin.write(`${JSON.stringify({ id, text, languages })}\n`);
    });
    if (response.error) throw new Error(response.error);
    return response;
}

async function getPluginStatus() {
    const [filesAvailable, javaAvailable] = await Promise.all([
        Promise.all([LT_JAR, FASTTEXT_MODEL, FASTTEXT_BIN].map(file => access(file).then(() => true).catch(() => false)))
            .then(results => results.every(Boolean)),
        checkJavaRuntime(),
    ]);
    return { filesAvailable, javaAvailable, workerAlive: Boolean(workerProcess && !workerProcess.killed), ok: filesAvailable && javaAvailable && Boolean(workerProcess && !workerProcess.killed) };
}

// ── Plugin init ────────────────────────────────────────────────────────────
export async function init(router) {
    router.get('/status', async (_req, res) => {
        const status = await getPluginStatus();
        res.status(status.ok ? 200 : 503).json(status);
    });

    /**
     * POST /api/plugins/languagetool/check
     * Body: { text: string, languages?: string[], language?: string }
     *   languages defaults to ["auto"] (fastText detection)
     *   Multiple BCP-47 codes are checked independently and their matches combined.
     */
    router.post('/check', async (req, res) => {
        const { text, language, languages: requestedLanguages } = req.body ?? {};

        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'Missing or empty "text" field.' });
        }
        if (text.length > MAX_TEXT_LENGTH) {
            return res.status(413).json({ error: `Text exceeds the ${MAX_TEXT_LENGTH}-character limit.` });
        }

        const languages = [...new Set((Array.isArray(requestedLanguages) ? requestedLanguages : [language ?? 'auto'])
            .filter(value => typeof value === 'string' && value.trim())
            .map(value => value.trim()))];
        if (!languages.length || languages.length > 8) {
            return res.status(400).json({ error: 'Choose between one and eight languages.' });
        }

        try {
            const results = [];
            results.push(await checkWithWorker(text, languages));
            const firstResult = results[0] ?? { matches: [] };
            res.json({ ...firstResult, matches: results.flatMap(result => result.matches ?? []) });
        } catch (err) {
            const detail = [err.message, err.stderr?.trim()].filter(Boolean).join('\n');
            console.error('[LanguageTool] check failed:', detail);
            res.status(500).json({ error: detail });
        }
    });

    startWorker().catch(error => console.error('[LanguageTool] Worker failed to start:', error.message));
    process.once('exit', () => workerProcess?.kill());
    console.log('[LanguageTool] Plugin loaded — Java worker starting in the background');
}

/** SillyTavern shutdown hook. */
export async function exit() {
    workerProcess?.kill();
}
