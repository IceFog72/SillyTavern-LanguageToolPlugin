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

    describe('suggestion markup', () => {
        let lower, modal;
        before(async () => {
            lower = await worker.request({ text: 'i am here.', languages: ['en-US'] });
            modal = await worker.request({ text: 'I could of done it.', languages: ['en-US'] });
        });

        it('replaces suggestion tags in I_LOWERCASE message', () => {
            const match = lower.matches.find(m => m.rule.id === 'I_LOWERCASE');
            assert.ok(match);
            assert.equal(match.message, 'The personal pronoun \u201cI\u201d should be uppercase.');
        });

        it('replaces suggestion tags in MODAL_OF message', () => {
            const match = modal.matches.find(m => m.rule.id === 'MODAL_OF');
            assert.ok(match);
            assert.ok(match.message.includes('\u201ccould have\u201d'));
            assert.ok(match.message.includes('\u201ccould\'ve\u201d'));
            assert.equal(match.message.includes('<'), false);
        });

        it('leaves no suggestion tags in shortMessage', () => {
            for (const m of [...lower.matches, ...modal.matches]) {
                assert.equal(m.shortMessage.includes('<suggestion>'), false);
                assert.equal(m.message.includes('suggestion>'), false);
            }
        });
    });

    describe('multi-language merge', () => {
        const misspellings = r => r.matches.filter(m => m.rule.issueType === 'misspelling');
        const MIXED = 'I like the Haus and the Kater.';

        it('accepts words valid in any selected language (de first)', async () => {
            const r = await worker.request({ text: 'Ich habe einen Hund und I like it.', languages: ['de-DE', 'en-US'] });
            assert.equal(misspellings(r).length, 0);
        });

        it('accepts words valid in any selected language (en first)', async () => {
            const r = await worker.request({ text: MIXED, languages: ['en-US', 'de-DE'] });
            assert.equal(misspellings(r).length, 0);
        });

        it('keeps a word unknown to every language, once', async () => {
            const r = await worker.request({ text: TYPO, languages: ['en-US', 'de-DE'] });
            const found = misspellings(r);
            assert.equal(found.length, 1);
            assert.equal(found[0].offset, 12);
            assert.equal(found[0].length, 4);
        });

        it('drops duplicate grammar matches across similar languages', async () => {
            const r = await worker.request({ text: ARTICLE, languages: ['en-US', 'en-GB'] });
            assert.equal(r.matches.length, 1);
            assert.equal(r.matches[0].offset, 4);
            assert.equal(r.matches[0].length, 1);
        });

        it('drops duplicate language codes', async () => {
            const r = await worker.request({ text: TYPO, languages: ['en-US', 'en-US'] });
            assert.equal(r.matches.length, 1);
            assert.equal(r.matches[0].offset, 12);
            assert.equal(r.matches[0].length, 4);
        });

        it('single language output is unchanged', async () => {
            const r = await worker.request({ text: MIXED, languages: ['en-US'] });
            const found = misspellings(r);
            assert.deepEqual(found.map(m => m.offset), [11, 24]);
            assert.deepEqual(found.map(m => m.length), [4, 5]);
        });
    });
});
