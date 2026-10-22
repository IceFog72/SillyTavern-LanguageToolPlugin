import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makePluginCopy, fakeRouter, callRoute } from './helpers.mjs';

// Finds only this test's own worker: its command line contains the unique temp dir.
const workerPid = dir => {
    const pids = execFileSync('pgrep', ['-f', `${dir}/languagetool-commandline.jar`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert.equal(pids.length, 1, `expected exactly one worker for ${dir}, got ${pids}`);
    return Number(pids[0]);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('worker recovery', () => {
    let dir, plugin, check;
    before(async () => {
        dir = await makePluginCopy();
        plugin = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
        const router = fakeRouter();
        await plugin.init(router);
        check = () => callRoute(router.routes['POST /check'], { text: 'I like this tset very much.', language: 'en-US' });
    });
    after(async () => { await plugin.exit(); });

    it('recovers after the worker is killed', { timeout: 120000 }, async () => {
        const first = await check();
        assert.equal(first.status, 200);
        process.kill(workerPid(dir), 'SIGKILL');
        await sleep(500);
        const second = await check();
        assert.equal(second.status, 200);
        assert.ok(second.body.matches.some(match => match.offset === 12), JSON.stringify(second.body));
    });

    it('times out a frozen worker and then recovers', { timeout: 120000 }, async () => {
        assert.equal((await check()).status, 200);
        const pid = workerPid(dir);
        process.kill(pid, 'SIGSTOP');
        try {
            const started = Date.now();
            const stuck = await check();
            const elapsed = Date.now() - started;
            assert.equal(stuck.status, 500);
            assert.match(stuck.body.error, /timed out/);
            assert.ok(elapsed > 29000 && elapsed < 40000, `elapsed ${elapsed} ms`);
            assert.equal((await check()).status, 200);
        } finally {
            if (alive(pid)) process.kill(pid, 'SIGKILL');
        }
    });
});
