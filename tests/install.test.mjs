import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, makePluginCopy, fakeRouter, callRoute } from './helpers.mjs';

const MODEL_SIZE = 131_266_198;
const realModel = statSync(path.join(PLUGIN_ROOT, 'bin/lid.176.bin')).size === MODEL_SIZE;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e\nsize 131266198\n';

/** Builds a plugin copy, lets `prepare` damage it, and returns the install problems from /status. */
async function installProblems(omit = [], prepare = async () => {}) {
    const dir = await makePluginCopy({ omit });
    await prepare(dir);
    const plugin = await import(pathToFileURL(path.join(dir, 'index.mjs')).href);
    try {
        const router = fakeRouter();
        await plugin.init(router);
        const { body } = await callRoute(router.routes['GET /status']);
        return body.installProblems;
    } finally {
        await plugin.exit();
    }
}

describe('install check', () => {
    it('reports the model state of this checkout', { timeout: 120000 }, async () => {
        const problems = await installProblems();
        if (realModel) assert.deepEqual(problems, []);
        else assert.ok(problems.length === 1 && problems[0].includes('bin/lid.176.bin'), JSON.stringify(problems));
    });

    it('detects a Git LFS pointer instead of the model', { timeout: 120000 }, async () => {
        const problems = await installProblems(['bin/lid.176.bin'], dir => writeFile(path.join(dir, 'bin/lid.176.bin'), LFS_POINTER));
        assert.equal(problems.length, 1, JSON.stringify(problems));
        assert.match(problems[0], /Git LFS pointer/);
        assert.match(problems[0], /git lfs install --local/);
    });

    it('detects a model with the right size but wrong content', { timeout: 120000 }, async () => {
        const problems = await installProblems(['bin/lid.176.bin'], async dir => {
            const model = path.join(dir, 'bin/lid.176.bin');
            await writeFile(model, '');
            await truncate(model, MODEL_SIZE);
        });
        assert.equal(problems.length, 1, JSON.stringify(problems));
        assert.match(problems[0], /checksum mismatch/);
    });

    it('detects a missing model and fastText binary', { timeout: 120000 }, async () => {
        const problems = await installProblems(['bin/lid.176.bin', 'bin/fasttext']);
        assert.equal(problems.length, 2, JSON.stringify(problems));
        assert.ok(problems.some(problem => problem.startsWith('bin/fasttext is missing')));
        assert.ok(problems.some(problem => problem.startsWith('Missing bin/lid.176.bin')));
    });

    it('detects missing LanguageTool jars', { timeout: 120000 }, async () => {
        const problems = await installProblems(['languagetool-commandline.jar', 'libs']);
        assert.ok(problems.includes('Missing languagetool-commandline.jar. Reinstall the plugin.'), JSON.stringify(problems));
        assert.ok(problems.includes('Missing libs/*.jar. Reinstall the plugin.'), JSON.stringify(problems));
    });
});
