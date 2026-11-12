import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildModuleIndex,
    buildReaderStyles,
    buildShellRules,
    EDITOR_MODULE_RULES,
    HOST,
    katexFontFiles,
    normalizeSelector,
    parseStylesheet,
    splitDeclarations,
    splitSelectorList,
    stripFontFallbacks,
    transformStylesheet,
} from '../scripts/build-ios-reader-styles.mjs';

test('parses the nested blocks of a stylesheet without losing at-rule bodies', () => {
    const blocks = parseStylesheet(`
        .a { color: red; }
        @media (max-width: 480px) { .b { color: blue; } }
        .c, .d { margin: 0; }
    `);
    assert.deepEqual(blocks.map(block => block.selector), [
        '.a',
        '@media (max-width: 480px)',
        '.c, .d',
    ]);
    // The nested block stays intact, so it can be transformed on its own.
    assert.match(blocks[1].body, /\.b \{ color: blue; \}/);
});

test('strips comments before parsing, including one in front of a selector', () => {
    const blocks = parseStylesheet(`
        /* a note about the next rule */
        .a { color: red; }
    `);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].selector, '.a');
});

test('splits a selector list only on top-level commas', () => {
    assert.deepEqual(
        splitSelectorList(".a:is([x='1,2'], [y]), .b"),
        [".a:is([x='1,2'], [y])", '.b']
    );
});

test('splits declarations without breaking strings or functions', () => {
    assert.deepEqual(
        splitDeclarations('content: "a;b"; background: url(data:image/png;base64,AA); color: red'),
        ['content: "a;b"', 'background: url(data:image/png;base64,AA)', 'color: red']
    );
});

test('the reader host keeps every typography variable the desktop reader sets', () => {
    const stylesheet = buildReaderStyles;
    assert.equal(typeof stylesheet, 'function');
    const shell = buildShellRules();
    assert.match(shell, new RegExp(`\\${HOST} \\{`));
    // The serif stack is what makes a paper read like a paper; a fallback to the
    // system sans-serif is the bug this ruleset exists to fix.
    assert.match(shell, /--reader-font: "STIX Two Text"/);
    assert.match(shell, /ui-serif, serif/);
    // A phone needs a narrower gutter than the desktop pane's 48px.
    assert.match(shell, /@media \(max-width: 500px\)/);
});

test('every module translation targets markup the flat renderer produces', () => {
    assert.ok(EDITOR_MODULE_RULES.length > 20);
    for (const rule of EDITOR_MODULE_RULES) {
        assert.ok(
            rule.from.startsWith('.cm-mktero-') || rule.from.startsWith('.mktero-'),
            rule.from
        );
        // A translated selector must never re-introduce an editor wrapper class.
        assert.doesNotMatch(rule.to, /cm-mktero-/u, `${rule.from} → ${rule.to}`);
        assert.ok(rule.why.length > 0, `${rule.from} needs a reason`);
    }
});

test('module translations cover the figure grid, display math and tables', () => {
    const index = buildModuleIndex();
    const targets = selector => index.get(normalizeSelector(selector));

    assert.deepEqual(
        targets('.cm-mktero-image .mktero-figure-panels-grid'),
        [`${HOST} .mktero-figure-panels-grid`]
    );
    assert.deepEqual(
        targets('.cm-mktero-math-display'),
        [`${HOST} .math.math-display`]
    );
    assert.deepEqual(targets('.cm-mktero-table'), [`${HOST} table`]);
    // The pane's inner-grid rules would fight the card the snapshot baseline
    // draws on the same <table>, so they are deliberately not mapped.
    assert.equal(targets('.cm-mktero-table table'), undefined);
    assert.equal(targets('.cm-mktero-html-block table'), undefined);
    // A rule from both editor branches in one block targets one flat selector.
    assert.deepEqual(
        targets('.cm-mktero-image .mktero-figure'),
        [`${HOST} .mktero-figure`]
    );
});

test('a ruleset keeps the snapshot branch and the module branch apart', () => {
    const { base, snapshot, editor, dropped } = transformStylesheet(
        parseStylesheet(`
            .markdown-snapshot-host p { margin: 0 0 1.25em; }
            .markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure { margin: 16px 0; }
            .markdown-outline-link { color: red; }
            .markdown-editor-host > .cm-editor .cm-mktero-code-toolbar { display: flex; }
        `)
    );
    assert.equal(base.length, 0);
    assert.deepEqual(snapshot, [
        `${HOST} p {\n    margin: 0 0 1.25em;\n}\n`,
    ]);
    assert.deepEqual(editor, [
        `${HOST} .mktero-figure {\n    margin: 16px 0;\n}\n`,
    ]);
    // The outline is a side panel, the code toolbar is an editor affordance.
    assert.equal(dropped.selectors, 2);
});

test('a rule from both desktop branches is split, not duplicated or dropped', () => {
    const { editor, snapshot } = transformStylesheet(
        parseStylesheet(`
            .markdown-editor-host > .cm-editor .cm-mktero-math-toolbar,
            .markdown-snapshot-host .cm-mktero-math-toolbar { opacity: 0; }
        `)
    );
    assert.deepEqual(editor, []);
    assert.deepEqual(snapshot, []);
});

test('the snapshot container rules never reach the app host', () => {
    const { snapshot } = transformStylesheet(
        parseStylesheet(`
            .markdown-snapshot-host { padding: 48px 0 80px; }
            .markdown-snapshot-host .cm-mktero-code-block { margin: 0; }
        `)
    );
    // `.markdown-snapshot-host` is the container: the shell owns its padding, so
    // the desktop padding must not be copied over it a second time, and the code
    // card wrapper has no app element.
    assert.deepEqual(snapshot, []);
});

test('an editor wrapper class is never left in a translated selector', () => {
    const { editor } = transformStylesheet(
        parseStylesheet(`
            .markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure img { margin: 0; }
            .markdown-editor-host > .cm-editor .cm-mktero-image-inline { display: inline-block; }
        `)
    );
    for (const rule of editor) {
        assert.doesNotMatch(rule, /cm-mktero-image/u);
    }
    assert.deepEqual(editor, [
        `${HOST} .mktero-figure img {\n    margin: 0;\n}\n`,
    ]);
});

test('wrapper aliases describe what the app draws, not the editor', () => {
    for (const rule of EDITOR_MODULE_RULES) {
        assert.ok(
            rule.from.startsWith('.cm-mktero-') || rule.from.startsWith('.mktero-'),
            rule.from
        );
        // A translated selector must never re-introduce an editor wrapper class.
        assert.doesNotMatch(rule.to, /cm-mktero-/u, `${rule.from} → ${rule.to}`);
        assert.ok(rule.why.length > 0, `${rule.from} needs a reason`);
    }
});

test('the pane\'s inner-grid table rules are not translated onto the card', () => {
    // The pane puts the table card on a wrapper <div> and its inner rules describe
    // the grid (`border-collapse: collapse`). The app's <table> is the card, so
    // translating those would collapse the rounded frame the snapshot baseline
    // draws. They are dropped on purpose, and the reason is recorded here.
    const { editor, dropped } = transformStylesheet(
        parseStylesheet(`
            .markdown-editor-host > .cm-editor .cm-mktero-table table { border-collapse: collapse; }
            .markdown-editor-host > .cm-editor .cm-mktero-html-block table { min-width: 100%; }
        `)
    );
    assert.deepEqual(editor, []);
    assert.equal(dropped.selectors, 2);
    assert.ok(dropped.unmapped.includes('.cm-mktero-table table'));
    assert.ok(dropped.unmapped.includes('.cm-mktero-html-block table'));
});

test('a rule naming a class the app has no element for is dropped', () => {
    const { editor, dropped } = transformStylesheet(
        parseStylesheet(`
            .markdown-editor-host > .cm-editor .cm-mktero-code-toolbar { display: flex; }
            .markdown-editor-host > .cm-editor .cm-mktero-translation-line { padding: 4px; }
        `)
    );
    assert.deepEqual(editor, []);
    assert.equal(dropped.selectors, 2);
    // Every dropped rule is reported, so a new desktop rule cannot vanish quietly.
    assert.ok(dropped.unmapped.includes('.cm-mktero-code-toolbar'));
    assert.ok(dropped.unmapped.includes('.cm-mktero-translation-line'));
});

test('katex loses only its non-woff2 sources', () => {
    const css = [
        '@font-face{font-family:KaTeX_Main;src:url(fonts/KaTeX_Main-Regular.woff2)',
        ' format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff"),',
        'url(fonts/KaTeX_Main-Regular.ttf) format("truetype")}',
    ].join('');
    const stripped = stripFontFallbacks(css);
    assert.match(stripped, /url\(KaTeX_Main-Regular\.woff2\) format\("woff2"\)/);
    assert.doesNotMatch(stripped, /\.woff\)/u);
    assert.doesNotMatch(stripped, /\.ttf\)/u);
    assert.deepEqual(katexFontFiles(stripped), ['KaTeX_Main-Regular.woff2']);
});

test('builds the committed reader styles faithfully from ui/markdown.css', async () => {
    const { files, manifest, fonts } = await buildReaderStyles();
    const css = files['reader.css'];

    // The reader font is the desktop serif stack, not the system sans-serif the
    // hand-written stylesheet fell back to.
    assert.match(css, /--reader-font: "STIX Two Text"/);
    // The flat markup's block typography comes from the extension's own rules.
    assert.match(css, new RegExp(`\\${HOST} p \\{[^}]*margin: 0 0 1.25em`));
    assert.match(css, new RegExp(`\\${HOST} h1 \\{[^}]*font-size: 1\\.95em`));
    assert.match(css, new RegExp(`\\${HOST} table \\{[^}]*border-collapse: separate`));
    // Figure panels, display math and algorithms are carried over as modules.
    assert.match(css, /\.mktero-figure-panels-grid \{/);
    assert.match(css, /\.math\.math-display \{/);
    assert.match(css, /\.mktero-algorithm \{/);
    // No selector may still reference a wrapper class the app has no elements for.
    assert.doesNotMatch(css, /\.cm-mktero-code-/u);
    assert.doesNotMatch(css, /\.cm-mktero-translation/u);
    assert.doesNotMatch(css, /\.markdown-outline/u);

    // Every rule the desktop stylesheet had is either kept or accounted for.
    assert.ok(manifest.rules.snapshot > 0);
    assert.ok(manifest.rules.modules > 0);
    assert.ok(Array.isArray(manifest.dropped.unmapped));

    assert.deepEqual(manifest.fonts, fonts);
    assert.equal(manifest.katexVersion, '0.19.1');
    assert.equal(manifest.bytes['reader.css'], Buffer.byteLength(css, 'utf8'));
});
