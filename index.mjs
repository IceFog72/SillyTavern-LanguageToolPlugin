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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths (relative to this plugin folder) ────────────────────────────────
const PLUGIN_DIR     = path.dirname(fileURLToPath(import.meta.url));
const LT_JAR         = path.join(PLUGIN_DIR, 'languagetool-commandline.jar');
const FASTTEXT_MODEL = path.join(PLUGIN_DIR, 'bin', 'lid.176.bin');
const FASTTEXT_BIN   = path.join(PLUGIN_DIR, 'bin', 'fasttext');
const MAX_TEXT_LENGTH = 100_000;
const CHECK_TIMEOUT_MS = 30_000;
// From the Git LFS pointer of bin/lid.176.bin (fastText's published lid.176 model).
const MODEL_SIZE     = 131_266_198;
const MODEL_SHA256   = '7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e';
const WORKER_CLASSPATH = `${LT_JAR}${path.delimiter}${path.join(PLUGIN_DIR, 'libs', '*')}`;

let workerProcess;
let workerReady;
let workerInfo;
let workerError;
let workerRequestId = 0;
const workerRequests = new Map();
let installCheck;

// ── Plugin metadata ────────────────────────────────────────────────────────
export const info = {
    id:          'languagetool',
    name:        'LanguageTool',
    description: 'Grammar and spell checking via LanguageTool Java CLI (no HTTP server).',
};

const exists = (file, mode) => access(file, mode).then(() => true, () => false);

function sha256(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
    });
}

/** Lists missing or partially downloaded files. Each entry says what is wrong and how to fix it. */
async function checkInstall() {
    const problems = [];
    const reinstall = 'Reinstall the plugin.';
    const lfsFix = `Run 'git lfs install --local' and then 'git lfs pull' in ${PLUGIN_DIR}, then restart SillyTavern.`;
    if (!(await exists(LT_JAR))) problems.push(`Missing ${path.basename(LT_JAR)}. ${reinstall}`);
    const libs = await readdir(path.join(PLUGIN_DIR, 'libs')).catch(() => []);
    if (!libs.some(file => file.endsWith('.jar'))) problems.push(`Missing libs/*.jar. ${reinstall}`);
    if (!(await exists(FASTTEXT_BIN, constants.X_OK))) {
        problems.push(`bin/fasttext is missing or not executable, so auto-detect is off. ${reinstall}`);
    }
    const model = await stat(FASTTEXT_MODEL).catch(() => null);
    if (!model) {
        problems.push(`Missing bin/lid.176.bin, so auto-detect is off. ${lfsFix}`);
    } else if (model.size < 1024 && (await readFile(FASTTEXT_MODEL, 'utf8')).startsWith('version https://git-lfs')) {
        problems.push(`bin/lid.176.bin is a Git LFS pointer, not the downloaded model, so auto-detect is off. ${lfsFix}`);
    } else if (model.size !== MODEL_SIZE || (await sha256(FASTTEXT_MODEL)) !== MODEL_SHA256) {
        problems.push(`bin/lid.176.bin is incomplete or corrupted (checksum mismatch), so auto-detect is off. Delete it, then: ${lfsFix}`);
    }
    return problems;
}

function startWorker() {
    if (workerReady) return workerReady;
    workerReady = new Promise((resolve, reject) => {
        workerProcess = spawn('java', ['--class-path', WORKER_CLASSPATH, 'LanguageToolWorker.java', FASTTEXT_MODEL, FASTTEXT_BIN], {
            cwd: PLUGIN_DIR,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        workerProcess.stdin.on('error', error => console.error('[LanguageTool] Worker stdin error:', error.message));
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
                    if (message.ready) { workerInfo = message; workerError = undefined; resolve(); }
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
            workerInfo = undefined;
            const startError = new Error(`LanguageTool worker exited before it was ready (${code ?? signal}).\n${stderrTail.trim()}`);
            workerError = startError.message;
            reject(startError);
        });
    });
    return workerReady;
}

async function checkWithWorker(text, languages) {
    await startWorker();
    const worker = workerProcess;
    if (!worker) throw new Error('LanguageTool worker is not running.');
    const id = String(++workerRequestId);
    let timer;
    const response = await new Promise((resolve, reject) => {
        workerRequests.set(id, { resolve, reject });
        timer = setTimeout(() => {
            workerRequests.delete(id);
            // The worker handles one request at a time, so a stuck one blocks all others: replace it.
            // Reject only after it has exited (the startWorker exit handler runs first and resets state),
            // so the caller's next request spawns a fresh worker instead of reusing the dying one.
            const timedOut = () => reject(new Error(`LanguageTool check timed out after ${CHECK_TIMEOUT_MS / 1000} s; restarting the worker.`));
            if (worker.exitCode !== null || worker.signalCode !== null) timedOut();
            else worker.once('exit', timedOut);
            worker.kill('SIGKILL');
        }, CHECK_TIMEOUT_MS);
        worker.stdin.write(`${JSON.stringify({ id, text, languages })}\n`);
    }).finally(() => clearTimeout(timer));
    if (response.error) throw new Error(response.error);
    return response;
}

async function getPluginStatus() {
    // Starts (or restarts) the worker if needed, so a crashed worker recovers on the next status poll.
    const startError = await startWorker().then(() => undefined, error => error);
    const workerAlive = Boolean(workerProcess && !workerProcess.killed);
    return {
        ok: !startError && workerAlive,
        workerAlive,
        workerError: startError?.message ?? workerError,
        autoDetect: workerInfo?.autoDetect === true,
        autoDetectError: workerInfo?.autoDetectError,
        installProblems: await installCheck,
    };
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

    installCheck = checkInstall().catch(error => [`Install check failed: ${error.message}`]);
    installCheck.then(problems => problems.forEach(problem => console.warn('[LanguageTool] Install problem:', problem)));
    startWorker().catch(error => console.error('[LanguageTool] Worker failed to start:', error.message));
    process.once('exit', () => workerProcess?.kill());
    console.log('[LanguageTool] Plugin loaded — Java worker starting in the background');
}

/** SillyTavern shutdown hook. */
export async function exit() {
    workerProcess?.kill();
}
