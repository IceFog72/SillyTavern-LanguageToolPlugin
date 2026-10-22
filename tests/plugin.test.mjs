import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makePluginCopy, fakeRouter, callRoute } from './helpers.mjs';

const TYPO = 'I like this tset very much.';

describe('plugin routes', () => {
    let plugin;
    let router;
    const check = body => callRoute(router.routes['POST /check'], body);
    const hasTypoMatch = matches => matches.some(m => m.offset === 12 && m.length === 4);

    before(async () => {
        const dir = await makePluginCopy();
        plugin = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
        router = fakeRouter();
        await plugin.init(router);
    }, { timeout: 120000 });

    after(async () => {
        await plugin.exit();
    });

    it('rejects a missing text with 400', async () => {
        assert.equal((await check({})).status, 400);
    });

    it('rejects whitespace-only text with 400', async () => {
        assert.equal((await check({ text: '   ' })).status, 400);
    });

    it('rejects text over 100000 characters with 413', async () => {
        assert.equal((await check({ text: 'a'.repeat(100001), languages: ['en-US'] })).status, 413);
    });

    it('rejects more than 8 languages with 400', async () => {
        const languages = ['en-US', 'de-DE', 'fr', 'es', 'it', 'nl', 'pl-PL', 'pt-PT', 'sv'];
        assert.equal((await check({ text: TYPO, languages })).status, 400);
    });

    it('checks text with the languages array', async () => {
        const { status, body } = await check({ text: TYPO, languages: ['en-US'] });
        assert.equal(status, 200);
        assert.ok(hasTypoMatch(body.matches));
    });

    it('accepts the legacy language string', async () => {
        const { status, body } = await check({ text: TYPO, language: 'en-US' });
        assert.equal(status, 200);
        assert.ok(hasTypoMatch(body.matches));
    });
});
