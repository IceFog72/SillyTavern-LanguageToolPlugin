import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makePluginCopy, fakeRouter, callRoute } from './helpers.mjs';

async function loadPlugin(options) {
    const dir = await makePluginCopy(options);
    return import(pathToFileURL(path.join(dir, 'index.mjs')).href);
}

async function timedInit(plugin, router) {
    const started = Date.now();
    await plugin.init(router);
    return Date.now() - started;
}

describe('plugin startup', () => {
    it('does not hang init or the server when the worker cannot start', { timeout: 30000 }, async () => {
        const plugin = await loadPlugin({ omit: ['libs'] });
        try {
            const router = fakeRouter();
            assert.ok(await timedInit(plugin, router) < 2000, 'init must return promptly');
            const { status, body } = await callRoute(router.routes['POST /check'], { text: 'Hello.', languages: ['en-US'] });
            assert.equal(status, 500);
            assert.match(body.error, /exited before it was ready/);
            assert.ok(body.error.includes('org.json'), body.error);
        } finally {
            await plugin.exit();
        }
    });

    it('starts the worker lazily for a healthy install', { timeout: 120000 }, async () => {
        const plugin = await loadPlugin();
        try {
            const router = fakeRouter();
            assert.ok(await timedInit(plugin, router) < 2000, 'init must not wait for the JVM');
            const { status, body } = await callRoute(router.routes['POST /check'], { text: 'I like this tset very much.', languages: ['en-US'] });
            assert.equal(status, 200);
            assert.ok(body.matches.some(m => m.offset === 12 && m.length === 4));
        } finally {
            await plugin.exit();
        }
    });
});
