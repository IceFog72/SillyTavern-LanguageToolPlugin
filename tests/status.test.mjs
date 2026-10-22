import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, makePluginCopy, fakeRouter, callRoute } from './helpers.mjs';

const realModel = statSync(path.join(PLUGIN_ROOT, 'bin/lid.176.bin')).size > 1_000_000;

async function loadPlugin(options) {
    const dir = await makePluginCopy(options);
    const plugin = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    const router = fakeRouter();
    await plugin.init(router);
    return {
        plugin,
        status: () => callRoute(router.routes['GET /status']),
        check: body => callRoute(router.routes['POST /check'], body),
    };
}

describe('/status and auto-detect health (healthy install)', () => {
    let ctx;
    before(async () => { ctx = await loadPlugin(); });
    after(async () => { await ctx.plugin.exit(); });

    it('reports a live worker and the auto-detect state', { timeout: 120000 }, async () => {
        const { status, body } = await ctx.status();
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.workerAlive, true);
        if (realModel) {
            assert.equal(body.autoDetect, true);
        } else {
            assert.equal(body.autoDetect, false);
            assert.ok(body.autoDetectError.includes('lid.176.bin'), body.autoDetectError);
            assert.ok(body.autoDetectError.includes('git lfs pull'), body.autoDetectError);
        }
    });

    it('fails auto checks with an actionable message when the model is unusable', { timeout: 120000 }, async () => {
        const { status, body } = await ctx.check({ text: 'Hello there.', languages: ['auto'] });
        if (realModel) {
            assert.equal(status, 200);
        } else {
            assert.equal(status, 500);
            assert.ok(body.error.startsWith('Auto-detect is unavailable'), body.error);
        }
    });

    it('still checks explicit languages', { timeout: 120000 }, async () => {
        const { status, body } = await ctx.check({ text: 'I like this tset very much.', languages: ['en-US'] });
        assert.equal(status, 200);
        assert.ok(body.matches.some(m => m.offset === 12 && m.length === 4));
    });
});

describe('/status with a broken install', () => {
    it('survives a missing fasttext binary', { timeout: 120000 }, async () => {
        const ctx = await loadPlugin({ omit: ['bin/fasttext'] });
        try {
            const { status, body } = await ctx.status();
            assert.equal(status, 200);
            assert.equal(body.ok, true);
            assert.equal(body.autoDetect, false);
        } finally {
            await ctx.plugin.exit();
        }
    });

    it('reports start failures as 503 with workerError', { timeout: 120000 }, async () => {
        const ctx = await loadPlugin({ omit: ['libs'] });
        try {
            const { status, body } = await ctx.status();
            assert.equal(status, 503);
            assert.equal(body.ok, false);
            assert.match(body.workerError, /exited before it was ready/);
        } finally {
            await ctx.plugin.exit();
        }
    });
});
