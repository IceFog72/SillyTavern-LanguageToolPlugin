import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnWorker } from './helpers.mjs';

const TYPO = 'I like this tset very much.';
const ARTICLE = 'Use a apple.';

function hasTypoMatch(matches) {
    return matches.some(m => m.offset === 12 && m.length === 4
        && m.rule.id === 'MORFOLOGIK_RULE_EN_US'
        && m.rule.issueType === 'misspelling'
        && m.replacements.map(r => r.value).includes('test'));
}

function hasArticleMatch(matches) {
    return matches.some(m => m.offset === 4 && m.length === 1
        && m.rule.id === 'EN_A_VS_AN' && m.rule.issueType === 'grammar');
}

describe('LanguageToolWorker protocol', () => {
    let worker;

    before(async () => {
        worker = spawnWorker();
        await worker.ready;
    }, { timeout: 120000 });

    after(async () => {
        await worker.close();
    });

    it('prints a ready line on start', async () => {
        const ready = await worker.ready;
        assert.equal(ready.ready, true);
        assert.equal(typeof ready.autoDetect, 'boolean');
    });

    it('flags a spelling mistake with replacements', async () => {
        const response = await worker.request({ text: TYPO, languages: ['en-US'] });
        assert.ok(Array.isArray(response.matches));
        assert.ok(hasTypoMatch(response.matches));
    });

    it('flags an a/an grammar mistake', async () => {
        const response = await worker.request({ text: ARTICLE, languages: ['en-US'] });
        assert.ok(hasArticleMatch(response.matches));
    });

    it('returns an error for an unknown language and survives it', async () => {
        const bad = await worker.request({ text: TYPO, languages: ['xx-YY'] });
        assert.equal(typeof bad.error, 'string');
        assert.ok(bad.error.includes('xx-YY'));
        assert.equal('matches' in bad, false);
        const good = await worker.request({ text: TYPO, languages: ['en-US'] });
        assert.ok(Array.isArray(good.matches));
    });

    it('skips blank lines', async () => {
        worker.writeRaw('\n');
        const response = await worker.request({ text: TYPO, languages: ['en-US'] });
        assert.match(response.id, /^t\d+$/);
        assert.ok(hasTypoMatch(response.matches));
    });

    it('matches concurrent responses to their own ids', async () => {
        const [a, b] = await Promise.all([
            worker.request({ text: TYPO, languages: ['en-US'] }),
            worker.request({ text: ARTICLE, languages: ['en-US'] }),
        ]);
        assert.notEqual(a.id, b.id);
        assert.ok(hasTypoMatch(a.matches));
        assert.ok(hasArticleMatch(b.matches));
    });
});
