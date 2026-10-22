import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, symlink, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Starts LanguageToolWorker.java directly and speaks its JSON-lines protocol. */
export function spawnWorker({ cwd = PLUGIN_ROOT } = {}) {
    const classPath = `languagetool-commandline.jar${path.delimiter}${path.join('libs', '*')}`;
    const child = spawn('java', ['--class-path', classPath, 'LanguageToolWorker.java',
        path.join('bin', 'lid.176.bin'), path.join('bin', 'fasttext')], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const waiters = new Map();
    let markReady;
    const ready = new Promise(resolve => { markReady = resolve; });
    createInterface({ input: child.stdout }).on('line', line => {
        if (!line.trim()) return;
        const message = JSON.parse(line);
        if (message.ready) markReady(message);
        else waiters.get(message.id)?.(message);
    });
    const exited = new Promise(resolve => child.once('exit', code => resolve({ code, stderr })));
    let nextId = 0;
    return {
        child, ready, exited,
        request(payload) {
            const id = `t${++nextId}`;
            return new Promise(resolve => {
                waiters.set(id, resolve);
                child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
            });
        },
        writeRaw(text) { child.stdin.write(text); },
        close() { child.stdin.end(); return exited; },
    };
}

/**
 * Copies index.mjs and LanguageToolWorker.java into a temp dir and symlinks the heavy assets,
 * so a test can import a plugin instance whose files are deliberately missing.
 * omit: names from ['languagetool-commandline.jar', 'libs', 'bin/lid.176.bin', 'bin/fasttext'].
 */
export async function makePluginCopy({ omit = [] } = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'lt-plugin-'));
    await mkdir(path.join(dir, 'bin'));
    for (const file of ['index.mjs', 'LanguageToolWorker.java']) await copyFile(path.join(PLUGIN_ROOT, file), path.join(dir, file));
    for (const asset of ['languagetool-commandline.jar', 'libs', 'bin/lid.176.bin', 'bin/fasttext']) {
        if (!omit.includes(asset)) await symlink(path.join(PLUGIN_ROOT, asset), path.join(dir, asset));
    }
    return dir;
}

/** Minimal stand-in for the Express router SillyTavern passes to init(). */
export function fakeRouter() {
    const routes = {};
    return { routes, get(route, handler) { routes[`GET ${route}`] = handler; }, post(route, handler) { routes[`POST ${route}`] = handler; } };
}

/** Calls a route handler and resolves with { status, body } once it responds. */
export function callRoute(handler, body) {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
        };
        Promise.resolve(handler({ body }, res)).catch(reject);
    });
}
