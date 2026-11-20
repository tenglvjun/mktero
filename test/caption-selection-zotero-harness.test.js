import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import {
    BEFORE_TEXT,
    AFTER_TEXT,
    createCaptionFixtures,
    corpusCaptionFixtures,
} from '../scripts/caption-selection-zotero/fixtures.mjs';

const execute = promisify(execFile);

test('the native caption fixtures render units, formulas, and shared panels at distinct widths', () => {
    const fixtures = createCaptionFixtures();
    assert.equal(fixtures.length, 3);
    assert.equal(new Set(fixtures.map(fixture => fixture.width)).size, 3);
    for (const fixture of fixtures) {
        const dom = new JSDOM('<!doctype html><div id="editor"></div>', { pretendToBeVisual: true });
        const { document } = dom.window;
        const editor = createInlineMarkdownEditor({
            parent: document.querySelector('#editor'), initialMarkdown: fixture.markdown,
            resolveImageURL: () => 'blob:fixture',
        });
        try {
            const captions = document.querySelectorAll('figcaption');
            assert.equal(captions.length, 1, fixture.id);
            assert.ok(captions[0].closest('figure').querySelectorAll('img').length >= fixture.minImages, fixture.id);
            if (fixture.requireMath) assert.ok(captions[0].querySelector('.math-inline'), fixture.id);
            assert.ok(fixture.markdown.startsWith(BEFORE_TEXT));
            assert.ok(fixture.markdown.endsWith(AFTER_TEXT));
        }
        finally {
            editor.destroy();
            dom.window.close();
        }
    }
});

test('external corpus records pass only the selected figure into the isolated reader', () => {
    const first = '![Figure 1. An early spectrum.](images/early.png)';
    const selected = '![](images/left.png)\n![](images/right.png)\n\nFigure 2. Independent paired measurements.';
    const markdown = `# Private research title\n\nUnrelated confidential body text.\n\n${first}\n\n${selected}\n\nUnrelated appendix.`;
    const [fixture] = corpusCaptionFixtures([{ label: 'Paired-figure corpus', markdown, figureIndex: 1 }]);
    assert.ok(fixture.markdown.includes('Independent paired measurements'));
    assert.equal(fixture.markdown.includes('Private research title'), false);
    assert.equal(fixture.markdown.includes('confidential body'), false);
    assert.equal(fixture.markdown.includes('early spectrum'), false);
    assert.equal(fixture.markdown.includes('appendix'), false);
    assert.equal(fixture.corpus, true);
});

test('corpus inputs fail clearly for a missing figure, invalid index, and unbounded input', () => {
    assert.throws(() => corpusCaptionFixtures([{ label: 'Missing', markdown: 'ordinary prose' }]), /no academic figure/u);
    assert.throws(() => corpusCaptionFixtures([{ label: 'Invalid', markdown: '', figureIndex: -1 }]), /invalid figureIndex/u);
    assert.throws(() => corpusCaptionFixtures(Array.from({ length: 13 }, () => ({}))), /between 1 and 12/u);
});

test('fixture-only corpus loading accepts relative markdownPath without copying the paper body', async () => {
    const input = await mkdtemp(path.join(tmpdir(), 'mktero-caption-corpus-'));
    let run;
    try {
        await writeFile(path.join(input, 'paper.md'), '# Unrelated private title\n\n'
            + '![Figure 1. First caption.](images/a.png)\n\n'
            + '![Figure 2. Second independent caption.](images/b.png)');
        await writeFile(path.join(input, 'manifest.json'), JSON.stringify([
            { label: 'Corpus sample', markdownPath: 'paper.md', figureIndex: 1 },
        ]));
        const result = await execute(process.execPath, ['scripts/validate-caption-selection-zotero.mjs',
            '--fixtures', '--corpus', path.join(input, 'manifest.json')], {
            cwd: new URL('../', import.meta.url), timeout: 10_000,
        });
        run = /^Isolated caption run: (.+)$/mu.exec(result.stdout)?.[1];
        assert.ok(run);
        const text = await readFile(`${run}/fixtures.json`, 'utf8');
        const fixtures = JSON.parse(text);
        assert.equal(fixtures.length, 4);
        assert.ok(fixtures.at(-1).markdown.includes('Second independent caption'));
        assert.equal(text.includes('Unrelated private title'), false);
        assert.equal(text.includes(input), false);
    }
    finally {
        await rm(input, { recursive: true, force: true });
        if (run) await rm(run, { recursive: true, force: true });
    }
});

test('fixture-only validation produces reviewable fixtures without starting Zotero', async () => {
    const result = await execute(process.execPath, ['scripts/validate-caption-selection-zotero.mjs', '--fixtures'], {
        cwd: new URL('../', import.meta.url), timeout: 10_000,
    });
    const run = /^Isolated caption run: (.+)$/mu.exec(result.stdout)?.[1];
    assert.ok(run);
    try {
        const report = JSON.parse(await readFile(`${run}/report.json`, 'utf8'));
        assert.equal(report.zoteroLaunched, false);
        assert.equal(report.fixtureCount, 3);
        assert.equal(report.passed, true);
        const fixtures = JSON.parse(await readFile(`${run}/fixtures.json`, 'utf8'));
        assert.deepEqual(fixtures.map(fixture => fixture.id), createCaptionFixtures().map(fixture => fixture.id));
    }
    finally {
        await rm(run, { recursive: true, force: true });
    }
});
