import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKDOWN_STYLES = readFileSync(
    new URL('../ui/markdown.css', import.meta.url),
    'utf8'
);

function ruleBody(selector) {
    return ruleBodies(selector)[0];
}

function ruleBodies(selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...MARKDOWN_STYLES.matchAll(
        new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'g')
    )];
    assert.ok(matches.length, `Missing CSS rule: ${selector}`);
    return matches.map(match => match[1]);
}

function lastRuleBody(selector) {
    return ruleBodies(selector).at(-1);
}

function pixelDeclaration(body, property) {
    const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`${escapedProperty}:\\s*(\\d+)px`));
    assert.ok(match, `Missing pixel declaration: ${property}`);
    return Number(match[1]);
}

test('uses balanced typography for long-form Markdown', () => {
    const host = ruleBody(':host');

    assert.match(host, /--reader-width:\s*60rem/);
    assert.match(host, /--reader-font-size:\s*18px/);
    assert.match(host, /--reader-line-height:\s*1\.78/);
    assert.match(host, /--reader-text:\s*#2c3238/);
    assert.match(
        host,
        /--reader-font:\s*"STIX Two Text",\s*"Noto Serif SC",\s*ui-serif,\s*"Iowan Old Style",\s*Charter,\s*"Bitstream Charter",\s*Georgia,\s*serif/
    );

    const editor = lastRuleBody('.markdown-editor-host > .cm-editor');
    assert.match(editor, /color:\s*var\(--reader-text\)/);

    const snapshot = ruleBody('.markdown-snapshot-host');
    assert.match(snapshot, /color:\s*var\(--reader-text\)/);

    const sharedTypography = ruleBody([
        '.markdown-snapshot-host,',
        '.markdown-editor-host > .cm-editor',
    ].join('\n'));
    assert.match(sharedTypography, /font-weight:\s*400/);
    assert.match(sharedTypography, /font-kerning:\s*normal/);
    assert.match(sharedTypography, /font-optical-sizing:\s*auto/);
    assert.match(
        sharedTypography,
        /font-variant-numeric:\s*oldstyle-nums proportional-nums/
    );
    assert.match(sharedTypography, /text-wrap:\s*pretty/);
    assert.doesNotMatch(MARKDOWN_STYLES, /text-rendering:\s*optimizeLegibility/);
});

test('renders conversion notices as compact overlay toasts', () => {
    const view = ruleBody('.mktero-tab-view');
    assert.match(view, /position:\s*relative/);

    const message = ruleBody('.message');
    assert.match(message, /position:\s*absolute/);
    assert.match(message, /top:\s*12px/);
    assert.match(message, /left:\s*50%/);
    assert.match(message, /width:\s*fit-content/);
    assert.match(message, /max-width:\s*min\(680px, calc\(100% - 32px\)\)/);
    assert.match(message, /transform:\s*translateX\(-50%\)/);
    assert.match(message, /z-index:\s*20/);
});

test('styles confirmations as Mktero modal surfaces with explicit action tones',
    () => {
        const backdrop = ruleBody('.mktero-confirmation-backdrop');
        const dialog = ruleBody('.mktero-confirmation-dialog');
        const button = ruleBody('.mktero-confirmation-button');
        const danger = ruleBody(
            '.mktero-confirmation-button--confirm[data-tone="danger"]'
        );

        assert.match(backdrop, /position:\s*absolute/);
        assert.match(backdrop, /background:\s*rgb\(/);
        assert.match(dialog, /background:\s*var\(--surface-raised\)/);
        assert.match(dialog, /border:\s*1px solid var\(--border\)/);
        assert.match(dialog, /border-radius:\s*var\(--radius-lg\)/);
        assert.match(dialog, /box-shadow:\s*var\(--shadow-popover\)/);
        assert.match(button, /min-height:\s*34px/);
        assert.match(danger, /background:\s*var\(--error\)/);
        assert.match(MARKDOWN_STYLES,
            /\.mktero-confirmation-button:focus-visible[\s\S]*?outline:\s*2px solid/);
    });

test('article layout outranks the CodeMirror adopted base theme', () => {
    const scroller = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-scroller'
    );
    assert.match(scroller, /font-family:\s*inherit/);
    assert.match(scroller, /line-height:\s*inherit/);
    assert.match(scroller, /overflow-x:\s*hidden/);
    assert.match(scroller, /overflow-y:\s*auto/);

    const content = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-content'
    );
    assert.match(content, /width:\s*calc\(100% - 48px\)/);
    assert.match(content, /max-width:\s*var\(--reader-width\)/);
    assert.match(content, /flex:\s*0 0 auto/);
    assert.match(content, /padding:\s*48px 0 80px/);

    const line = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-line'
    );
    assert.match(line, /padding-inline:\s*0/);

    const heading = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-heading'
    );
    assert.match(heading, /font-weight:\s*700/);
    assert.match(heading, /line-height:\s*1\.25/);
});

test('keeps the reader toolbar above content without covering it', () => {
    const toolbar = ruleBody('.markdown-reader-toolbar');
    const translatingToolbar = ruleBody(
        '.markdown-reader-toolbar.is-translating'
    );
    const readerControls = ruleBody('.markdown-reader-controls');
    const translationControls = ruleBody('.markdown-translation-controls');
    const fontFamily = ruleBody('.markdown-reader-font-family');
    const translationSeparator = ruleBody('.markdown-translation-separator');
    const editorHost = ruleBody('.markdown-editor-host');

    assert.match(toolbar, /--toolbar-control-gap:\s*10px/);
    assert.match(toolbar, /position:\s*relative/);
    assert.match(toolbar, /flex:\s*0 0 auto/);
    assert.match(toolbar, /flex-wrap:\s*wrap/);
    assert.match(translatingToolbar, /flex-wrap:\s*nowrap/);
    assert.match(toolbar, /min-height:\s*44px/);
    assert.match(toolbar, /padding:\s*4px 12px/);
    assert.match(toolbar, /border-bottom:\s*1px solid var\(--border-subtle\)/);
    assert.doesNotMatch(toolbar, /position:\s*absolute/);
    assert.match(
        readerControls,
        /gap:\s*var\(--toolbar-control-gap\)/
    );
    assert.match(
        translationControls,
        /gap:\s*var\(--toolbar-control-gap\)/
    );
    assert.doesNotMatch(translationControls, /margin-inline-start:\s*auto/);
    assert.doesNotMatch(translationControls, /padding-inline-start/);
    assert.doesNotMatch(translationControls, /border-inline-start/);
    assert.doesNotMatch(fontFamily, /padding-inline-start/);
    assert.doesNotMatch(fontFamily, /border-inline-start/);
    assert.match(translationSeparator, /width:\s*1px/);
    assert.match(translationSeparator, /height:\s*24px/);
    assert.match(
        translationSeparator,
        /background:\s*var\(--border-subtle\)/
    );
    assert.match(editorHost, /flex:\s*1 1 auto/);
    assert.match(editorHost, /overflow:\s*hidden/);
});

test('keeps block correction actions compact and above the editor', () => {
    const toolbar = ruleBody('.mktero-correction-editor-toolbar');
    const button = ruleBody('.mktero-correction-editor-button');
    const status = ruleBody('.mktero-correction-editor-status');
    const deleted = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-deleted-correction'
    );

    assert.match(toolbar, /position:\s*absolute/);
    assert.match(toolbar, /display:\s*flex/);
    assert.match(toolbar, /z-index:\s*4/);
    assert.match(toolbar, /flex-wrap:\s*wrap/);
    assert.match(button, /flex:\s*0 0 auto/);
    assert.match(button, /white-space:\s*nowrap/);
    assert.match(status, /overflow:\s*hidden/);
    assert.match(status, /text-overflow:\s*ellipsis/);
    assert.match(deleted, /display:\s*flex/);
    assert.match(deleted, /border:\s*1px dashed/);
    assert.match(deleted, /min-height:\s*36px/);
});

test('keeps block correction actions clear of the citation graph button', () => {
    const graphButton = ruleBody('.markdown-citation-graph-button');
    const toolbar = ruleBody('.mktero-correction-editor-toolbar');
    const graphInset = pixelDeclaration(graphButton, 'inset-inline-end');
    const graphWidth = pixelDeclaration(graphButton, 'width');
    const toolbarInset = pixelDeclaration(toolbar, 'inset-inline-end');

    assert.ok(
        toolbarInset >= graphInset + graphWidth + 8,
        'Correction actions must leave 8px beside the citation graph button'
    );
    assert.match(toolbar, /max-width:\s*calc\(100% - 84px\)/);
});

test('keeps the deleted-correction undo prompt usable with long copy', () => {
    const undo = ruleBody('.markdown-correction-undo');
    const message = ruleBody('.markdown-correction-undo-message');

    assert.match(undo, /max-width:\s*calc\(100% - 36px\)/);
    assert.match(undo, /flex-wrap:\s*wrap/);
    assert.match(message, /overflow-wrap:\s*anywhere/);
});

test('styles the reader font picker as part of the top toolbar', () => {
    const picker = ruleBody('.markdown-reader-font-picker');
    const trigger = ruleBody('.markdown-reader-font-select');
    const options = ruleBody('.markdown-reader-font-options');
    const option = ruleBody('.markdown-reader-font-option');

    assert.doesNotMatch(MARKDOWN_STYLES, /\.markdown-reader-font-label/);
    assert.match(picker, /width:\s*148px/);
    assert.match(picker, /position:\s*relative/);
    assert.match(trigger, /display:\s*flex/);
    assert.match(trigger, /height:\s*30px/);
    assert.match(trigger, /border:\s*1px\s+solid\s+var\(--border\)/);
    assert.match(trigger, /cursor:\s*pointer/);
    assert.match(options, /display:\s*grid/);
    assert.match(options, /position:\s*absolute/);
    assert.match(options, /box-shadow:\s*var\(--shadow-popover\)/);
    assert.match(options, /background:\s*color-mix/);
    assert.match(option, /grid-template-columns:\s*14px\s+minmax\(0,\s*1fr\)/);
    assert.match(option, /cursor:\s*pointer/);
});

test('wide Markdown tables scroll inside the aligned reading column', () => {
    const tableFrame = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-table',
    ].join('\n'));
    assert.match(tableFrame, /width:\s*100%/);
    assert.match(tableFrame, /max-width:\s*100%/);
    assert.match(tableFrame, /overflow-x:\s*auto/);
    assert.match(tableFrame, /overflow-y:\s*hidden/);
    assert.match(tableFrame, /overscroll-behavior-x:\s*contain/);
    assert.match(tableFrame, /scrollbar-width:\s*thin/);
    assert.match(tableFrame, /border-radius:\s*var\(--radius-md\)/);

    const tables = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block table',
    ].join('\n'));
    assert.match(tables, /width:\s*100%/);
    assert.match(tables, /min-width:\s*100%/);
    assert.match(tables, /max-width:\s*none/);
    assert.match(tables, /table-layout:\s*auto/);
    assert.match(tables, /font-size:\s*var\(--reader-table-font-size\)/);

    const cells = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table th,',
        '.markdown-editor-host > .cm-editor .cm-mktero-table td,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block th,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block td',
    ].join('\n'));
    assert.match(cells, /min-width:\s*0/);
    assert.match(cells, /overflow-wrap:\s*anywhere/);
    assert.match(cells, /word-break:\s*break-word/);
    assert.match(cells, /white-space:\s*normal/);
});

test('keeps inline math inside the prose line box', () => {
    const inlineMath = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-math'
    );
    assert.match(inlineMath, /display:\s*inline-block/);
    assert.match(inlineMath, /line-height:\s*1\.2/);
    assert.match(inlineMath, /vertical-align:\s*-0\.1em/);

    const displayMath = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-math-display'
    );
    assert.doesNotMatch(displayMath, /line-height/);
    assert.doesNotMatch(displayMath, /background\s*:/);
});

test('styles academic figure captions as distinct labels', () => {
    const caption = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure figcaption'
    );
    assert.match(caption, /padding:\s*0 12px/);
    assert.doesNotMatch(caption, /border-left/);
    assert.doesNotMatch(caption, /border-radius/);
    assert.doesNotMatch(caption, /background\s*:/);
    assert.match(caption, /font-family:\s*inherit/);
    assert.match(caption, /font-size:\s*var\(--reader-caption-font-size\)/);
    assert.match(caption, /letter-spacing:\s*0/);
    assert.match(caption, /text-align:\s*center/);

    const label = ruleBody(
        '.markdown-editor-host > .cm-editor .mktero-figure-label'
    );
    assert.match(label, /color:\s*var\(--text\)/);
    assert.match(label, /font-weight:\s*650/);
});

test('styles academic table captions above tables without a background', () => {
    const caption = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table table caption,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block table caption',
    ].join('\n'));
    assert.match(caption, /caption-side:\s*top/);
    assert.match(caption, /padding:\s*10px 12px/);
    assert.match(caption, /color:\s*var\(--muted\)/);
    assert.match(caption, /font-size:\s*var\(--reader-caption-font-size\)/);
    assert.match(caption, /letter-spacing:\s*0/);
    assert.match(caption, /text-align:\s*center/);
    assert.doesNotMatch(caption, /background\s*:/);

    const label = ruleBody(
        '.markdown-editor-host > .cm-editor .mktero-table-label'
    );
    assert.match(label, /color:\s*var\(--text\)/);
    assert.match(label, /font-weight:\s*650/);
});

test('preserves line breaks inside rendered MinerU algorithms', () => {
    const algorithm = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-algorithm .mktero-algorithm'
    );
    assert.match(algorithm, /white-space:\s*pre-wrap/);
});

test('separates panels inside a shared academic figure', () => {
    const panels = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure-group img + img'
    );
    assert.match(panels, /margin-top:\s*12px/);

    const labeledPanels = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure-panel + .mktero-figure-panel'
    );
    assert.match(labeledPanels, /margin-top:\s*12px/);

    const panelLabel = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure-panel-label'
    );
    assert.match(panelLabel, /text-align:\s*center/);

    const leadingPanelLabel = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure-panel-label-before'
    );
    assert.match(leadingPanelLabel, /margin:\s*0 auto 6px/);

    const horizontalPanels = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure-panels-horizontal'
    );
    assert.match(horizontalPanels, /display:\s*grid/);
    assert.match(
        horizontalPanels,
        /grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(260px, 100%\), 1fr\)\)/
    );

    const gridPanels = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure-panels-grid'
    );
    assert.match(gridPanels, /display:\s*grid/);
    assert.match(
        gridPanels,
        /grid-template-columns:\s*repeat\(var\(--mktero-figure-grid-columns\), minmax\(0, 1fr\)\)/
    );
});

test('lays out a responsive scrollable outline beside the editor', () => {
    const workspace = ruleBody('.markdown-workspace');
    assert.match(workspace, /display:\s*flex/);
    assert.match(workspace, /min-width:\s*0/);

    const outline = ruleBody('.markdown-outline');
    assert.match(outline, /flex:\s*0 0 var\(--outline-width, 256px\)/);

    const edge = ruleBody('.markdown-side-panel-edge');
    assert.match(edge, /width:\s*7px/);
    assert.match(edge, /flex:\s*0 0 7px/);

    const resizer = ruleBody('.markdown-side-panel-resizer');
    assert.match(resizer, /inset:\s*0/);
    assert.match(resizer, /cursor:\s*col-resize/);

    const notesResizer = ruleBody('.markdown-notes-resizer');
    assert.match(notesResizer, /inset-inline-start:\s*4px/);
    assert.match(notesResizer, /inset-inline-end:\s*0/);

    const resizing = ruleBody('.markdown-workspace.is-resizing-outline');
    assert.match(resizing, /user-select:\s*none/);

    const outlineList = ruleBody('.markdown-outline-list');
    assert.match(outlineList, /overflow-y:\s*auto/);

    const outlineLink = ruleBody('.markdown-outline-link');
    assert.match(
        outlineLink,
        /padding-left:\s*calc\(10px \+ var\(--outline-indent, 0px\)\)/
    );

    assert.match(
        MARKDOWN_STYLES,
        /@container\s+mktero-view\s*\(max-width:\s*760px\)[\s\S]*\.markdown-outline\s*\{[^}]*flex-basis:\s*min\(var\(--outline-width, 256px\), 42cqi\)/
    );
});

test('styles a responsive PDF notes panel beside the editor', () => {
    const notes = ruleBody('.markdown-notes');
    assert.match(notes, /flex:\s*0 0 var\(--notes-width, 300px\)/);
    assert.match(notes, /overflow:\s*hidden/);

    const list = ruleBody('.markdown-notes-list');
    assert.match(list, /overflow-y:\s*auto/);
    assert.match(list, /scrollbar-width:\s*thin/);

    const link = ruleBody('.markdown-note-link');
    assert.match(link, /width:\s*100%/);
    assert.match(link, /text-align:\s*left/);
    assert.match(link, /cursor:\s*pointer/);

    const color = ruleBody('.markdown-note-color');
    assert.match(color, /background:\s*var\(--mktero-annotation-color\)/);

    const comment = ruleBody('.markdown-note-comment');
    assert.match(comment, /white-space:\s*pre-wrap/);
    assert.match(comment, /overflow-wrap:\s*anywhere/);
});

test('styles secondary document actions as a toolbar popover', () => {
    const editor = ruleBody('.markdown-editor');
    assert.match(editor, /position:\s*relative/);
    assert.match(editor, /container:\s*markdown-reader \/ inline-size/);

    const action = ruleBody('.markdown-reader-action');
    assert.match(action, /width:\s*34px/);
    assert.match(action, /height:\s*34px/);
    assert.match(action, /border-radius:\s*var\(--radius-sm\)/);
    assert.match(action, /align-items:\s*center/);

    const menu = ruleBody('.markdown-reader-action-menu');
    assert.match(menu, /top:\s*calc\(100% \+ 8px\)/);
    assert.match(menu, /right:\s*12px/);
    assert.match(menu, /width:\s*240px/);
    assert.match(menu, /max-width:\s*min\(240px, calc\(100% - 20px\)\)/);
    assert.match(menu, /padding:\s*8px/);
    assert.match(menu, /box-shadow:\s*var\(--shadow-popover\)/);
    const menuAction = ruleBody(
        '.markdown-reader-action-menu .markdown-reader-action'
    );
    assert.match(menuAction, /width:\s*100%/);
    assert.match(menuAction, /min-height:\s*38px/);
    assert.match(menuAction, /height:\s*auto/);
    assert.match(menuAction, /padding:\s*8px 12px/);
    assert.match(menuAction, /gap:\s*10px/);
    assert.match(menuAction, /justify-content:\s*flex-start/);
    assert.match(menuAction, /white-space:\s*normal/);

    const menuLabel = ruleBody(
        '.markdown-reader-action-menu .markdown-reader-action-label'
    );
    assert.match(menuLabel, /overflow-wrap:\s*anywhere/);
    assert.match(menuLabel, /text-align:\s*start/);

    const menuIcon = ruleBody(
        '.markdown-reader-action-menu .markdown-reader-action-icon'
    );
    assert.match(menuIcon, /flex:\s*0 0 18px/);

    const reparsing = ruleBody(
        '.markdown-reader-action.is-reparsing .markdown-reader-action-icon'
    );
    assert.match(reparsing, /animation:\s*mktero-spin 0\.85s linear infinite/);
});

test('keeps document translation status legible without crowding the toolbar', () => {
    const action = ruleBody('.markdown-translation-action');
    const controls = ruleBody('.markdown-translation-controls');
    const status = ruleBody('.markdown-translation-status');
    const failureNavigation = ruleBody(
        '.markdown-translation-failure-navigation'
    );
    const failureNavigationButton = ruleBody(
        '.markdown-translation-failure-navigation-button'
    );
    const translating = ruleBody(
        [
            '.markdown-translation-action.is-translating',
            '    .markdown-translation-loading-icon',
        ].join('\n')
    );
    assert.match(action, /width:\s*auto/);
    assert.match(action, /height:\s*32px/);
    assert.match(action, /min-height:\s*32px/);
    assert.match(action, /padding:\s*0 10px/);
    assert.match(action, /gap:\s*7px/);
    assert.match(controls, /flex:\s*1 1 auto/);
    assert.match(controls, /max-width:\s*100%/);
    assert.match(status, /font-variant-numeric:\s*tabular-nums/);
    assert.match(status, /text-overflow:\s*ellipsis/);
    assert.match(status, /white-space:\s*nowrap/);
    assert.doesNotMatch(
        MARKDOWN_STYLES,
        /\.markdown-translation-language\s*\{/
    );
    assert.match(failureNavigation, /display:\s*inline-flex/);
    assert.match(failureNavigationButton, /width:\s*28px/);
    assert.match(failureNavigationButton, /height:\s*28px/);
    assert.match(translating, /animation:\s*mktero-spin 0\.85s linear infinite/);
});

test('keeps block-level comparison in one full-size reading surface', () => {
    const layout = ruleBody('.markdown-reading-layout');
    const pane = ruleBody('.markdown-reading-pane');
    const translation = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-translation-line'
    );
    const boundary = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-bilingual-boundary'
    );

    assert.match(layout, /display:\s*flex/);
    assert.match(layout, /overflow:\s*hidden/);
    assert.match(pane, /flex:\s*1 1 100%/);
    assert.doesNotMatch(MARKDOWN_STYLES, /markdown-comparison-pane-label/);
    assert.doesNotMatch(MARKDOWN_STYLES, /flex:\s*1 1 50%/);
    assert.match(translation, /padding-inline:\s*18px 4px !important/);
    assert.match(translation, /box-shadow:\s*inset 3px 0 0/);
    assert.match(translation, /color:\s*var\(--reader-text\)/);
    assert.match(translation, /background:\s*color-mix/);
    assert.doesNotMatch(translation, /border-radius/);
    assert.match(boundary, /height:\s*0/);
    assert.match(boundary, /min-height:\s*0/);
    assert.match(boundary, /overflow:\s*hidden/);
});

test('uses language-aware academic serif fonts only for translated text', () => {
    const host = ruleBody(':host');
    const editor = lastRuleBody('.markdown-editor-host > .cm-editor');
    const translatedLine = ruleBody([
        '.markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-line[lang],',
        '.markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-block[lang]',
    ].join('\n'));
    const sourceFallback = ruleBody([
        '.markdown-reading-pane[lang]',
        '    .markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-failure-line,',
        '.markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-failure-block',
    ].join('\n'));
    const languageFonts = [
        ['zh-CN', 'zh-cn', 'Noto Serif SC'],
        ['zh-TW', 'zh-tw', 'Noto Serif TC'],
        ['ja-JP', 'ja', 'Noto Serif JP'],
        ['ko-KR', 'ko', 'Noto Serif KR'],
    ];

    for (const [language, variableSuffix, preferredFont] of languageFonts) {
        assert.match(
            host,
            new RegExp(
                `--reader-translation-font-${variableSuffix}:[^;]*${preferredFont}`
            )
        );
        const languageRule = ruleBody([
            `.markdown-reading-pane[lang='${language}'],`,
            '.markdown-editor-host > .cm-editor',
            `    .cm-mktero-translation-line[lang='${language}'],`,
            '.markdown-editor-host > .cm-editor',
            `    .cm-mktero-translation-block[lang='${language}']`,
        ].join('\n'));
        assert.match(
            languageRule,
            new RegExp(
                `--reader-content-font:\\s*var\\(--reader-selected-translation-font,\\s*var\\(--reader-translation-font-${variableSuffix}\\)\\)`
            )
        );
    }
    assert.match(
        editor,
        /font-family:\s*var\(--reader-content-font, var\(--reader-font\)\)/
    );
    assert.match(
        translatedLine,
        /font-family:\s*var\(--reader-content-font, var\(--reader-font\)\)/
    );
    assert.match(
        sourceFallback,
        /--reader-content-font:\s*var\(--reader-font\)/
    );
    assert.match(sourceFallback, /font-family:\s*var\(--reader-font\)/);
    assert.doesNotMatch(
        MARKDOWN_STYLES,
        /cm-mktero-translation-pair-source[^}]*font-family/
    );

    const figureCaption = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-image .mktero-figure figcaption'
    );
    const table = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block table',
    ].join('\n'));
    const tableCaption = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table table caption,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block table caption',
    ].join('\n'));
    assert.match(figureCaption, /font-family:\s*inherit/);
    assert.match(table, /font-family:\s*inherit/);
    assert.match(tableCaption, /font-family:\s*inherit/);
});

test('distinguishes translated headings and source fallbacks', () => {
    const translatedHeading = ruleBody([
        '.markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-line.cm-mktero-heading',
    ].join('\n'));
    const failure = ruleBody([
        '.markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-failure',
    ].join('\n'));
    const failureLine = ruleBody([
        '.markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-failure-line',
    ].join('\n'));
    assert.match(translatedHeading, /font-weight:\s*600/);
    assert.match(translatedHeading, /color:\s*var\(--reader-text\)/);
    assert.match(translatedHeading, /border-bottom:\s*0/);
    assert.match(failure, /display:\s*flex/);
    assert.match(failure, /color:\s*var\(--warning\)/);
    assert.match(failureLine, /background:\s*color-mix/);
});

test('keeps paired bilingual blocks free of per-block action styles', () => {
    const pair = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-translation-pair'
    );
    const active = ruleBody([
        '.markdown-editor-host > .cm-editor',
        '    .cm-mktero-translation-pair.is-translation-pair-active',
    ].join('\n'));
    assert.match(pair, /position:\s*relative/);
    assert.match(active, /background:\s*color-mix/);
    assert.match(active, /box-shadow:/);
    assert.doesNotMatch(MARKDOWN_STYLES, /cm-mktero-translation-retry/);
});

test('wraps translation controls at narrow reader widths', () => {
    const viewButton = ruleBody('.markdown-translation-view-button');

    assert.match(viewButton, /overflow:\s*hidden/);
    assert.match(viewButton, /text-overflow:\s*ellipsis/);
    assert.match(viewButton, /white-space:\s*nowrap/);
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*620px\)[\s\S]*\.markdown-reader-toolbar\.is-translating\s*\{[^}]*flex-wrap:\s*wrap/
    );
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*620px\)[\s\S]*\.markdown-translation-controls\s*\{[^}]*flex:\s*1 0 100%[^}]*flex-wrap:\s*wrap/
    );
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*390px\)[\s\S]*\.markdown-translation-view\s*\{[^}]*width:\s*100%/
    );
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*390px\)[\s\S]*\.markdown-translation-view-button\s*\{[^}]*min-width:\s*0/
    );
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*390px\)[\s\S]*\.markdown-translation-controls\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/
    );
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*390px\)[\s\S]*\.markdown-translation-context\s*\{[^}]*grid-column:\s*1/
    );
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*390px\)[\s\S]*\.markdown-translation-failure-navigation\s*\{[^}]*grid-column:\s*2/
    );
    assert.match(
        MARKDOWN_STYLES,
        /@container\s+markdown-reader\s*\(max-width:\s*390px\)[\s\S]*\.markdown-translation-action\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/
    );
});

test('anchors the cached translation language menu below the mode selector', () => {
    const view = ruleBody('.markdown-translation-view');
    const menu = ruleBody('.markdown-translation-language-options');
    const group = ruleBody('.markdown-translation-language-group');
    const option = ruleBody('.markdown-translation-language-option');
    const disabledOption = ruleBody(
        '.markdown-translation-language-option:disabled'
    );
    const cancel = ruleBody('.markdown-translation-language-cancel');
    const lastButton = ruleBody(
        '.markdown-translation-view-button:last-of-type'
    );

    assert.match(view, /position:\s*relative/);
    assert.match(menu, /position:\s*absolute/);
    assert.match(menu, /top:\s*calc\(100% \+ 6px\)/);
    assert.match(menu, /left:\s*50%/);
    assert.match(menu, /transform:\s*translateX\(-50%\)/);
    assert.match(group, /display:\s*grid/);
    assert.match(option, /grid-template-columns:\s*14px minmax\(0, 1fr\)/);
    assert.match(disabledOption, /opacity:\s*0\.55/);
    assert.match(cancel, /border-top:\s*1px solid var\(--border-subtle\)/);
    assert.match(
        MARKDOWN_STYLES,
        /data-translation-status='translating'[\s\S]*animation:\s*mktero-spin/
    );
    assert.match(lastButton, /border-radius:/);
});

test('styles citation popups and temporary reference highlights', () => {
    const citation = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-citation'
    );
    assert.match(citation, /color:\s*var\(--accent-strong\)/);
    assert.match(citation, /cursor:\s*pointer/);

    const popup = ruleBody('.mktero-citation-popup');
    assert.match(popup, /position:\s*fixed/);
    assert.match(popup, /width:\s*min\(400px, calc\(100vw - 24px\)\)/);
    assert.match(popup, /z-index:\s*900/);
    assert.match(popup, /--citation-popup-surface:\s*var\(--surface-raised\)/);
    assert.match(popup, /--citation-popup-text:\s*var\(--text\)/);
    assert.match(popup, /--citation-popup-border:\s*var\(--border\)/);
    assert.match(
        popup,
        /--citation-popup-hover:\s*color-mix\(\s*in srgb,\s*var\(--accent\) 12%,\s*var\(--surface\)\s*\)/
    );
    assert.match(popup, /--citation-popup-accent:\s*var\(--accent\)/);
    assert.match(popup, /background:\s*var\(--citation-popup-surface\)/);

    const popupItem = ruleBody('.mktero-citation-popup-item');
    assert.match(popupItem, /padding:\s*8px 10px/);
    assert.match(popupItem, /border-radius:\s*6px/);

    const candidate = ruleBody('.mktero-citation-popup-candidate');
    assert.match(candidate, /display:\s*grid/);
    const candidateTitle = ruleBody(
        '.mktero-citation-popup-candidate-title'
    );
    assert.match(candidateTitle, /overflow-wrap:\s*anywhere/);

    const popupItemHover = ruleBody([
        '.mktero-citation-popup-item:hover,',
        '.mktero-citation-popup-item:focus-visible',
    ].join('\n'));
    assert.match(popupItemHover, /background:\s*var\(--citation-popup-hover\)/);
    assert.match(
        popupItemHover,
        /box-shadow:\s*inset 3px 0 0 var\(--citation-popup-accent\)/
    );

    assert.match(
        MARKDOWN_STYLES,
        /\n\n\.mktero-citation-popup-item:focus-visible\s*\{[^}]*outline:\s*2px solid color-mix\([\s\S]*?var\(--citation-popup-accent\) 35%[^}]*\}/
    );

    const superscriptCitation = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-citation-superscript'
    );
    assert.match(superscriptCitation, /font-size:\s*0\.75em/);
    assert.match(superscriptCitation, /line-height:\s*1/);
    assert.match(superscriptCitation, /vertical-align:\s*super/);

    const affiliationMarker = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-affiliation-marker'
    );
    assert.match(affiliationMarker, /color:\s*var\(--accent\)/);
    assert.match(affiliationMarker, /font-weight:\s*650/);
    assert.doesNotMatch(affiliationMarker, /cursor:\s*pointer/);

    const highlight = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-reference-highlight'
    );
    assert.match(highlight, /animation:\s*mktero-reference-highlight 3s ease-out/);
});

test('styles the citation library picker like the reader font picker', () => {
    const picker = ruleBody('.mktero-citation-popup-library-picker');
    const trigger = ruleBody('.mktero-citation-popup-library-select');
    const options = ruleBody('.mktero-citation-popup-library-options');
    const option = ruleBody('.mktero-citation-popup-library-option');

    assert.match(picker, /position:\s*relative/);
    assert.match(trigger, /display:\s*flex/);
    assert.match(trigger, /height:\s*30px/);
    assert.match(
        trigger,
        /border:\s*1px\s+solid\s+var\(--citation-popup-border\)/
    );
    assert.match(trigger, /cursor:\s*pointer/);
    assert.match(options, /display:\s*grid/);
    assert.match(options, /position:\s*fixed/);
    assert.match(options, /box-shadow:\s*var\(--shadow-popover\)/);
    assert.match(options, /max-height:/);
    assert.match(
        option,
        /grid-template-columns:\s*14px\s+minmax\(0,\s*1fr\)/
    );
    assert.match(option, /cursor:\s*pointer/);
    assert.match(
        MARKDOWN_STYLES,
        /\.mktero-citation-popup-library-option\[aria-selected='true'\][\s\S]*?color:\s*var\(--citation-popup-accent\)/
    );
});

test('styles citation rows as compact single-item action surfaces', () => {
    const header = ruleBody('.mktero-citation-popup-header');
    const picker = ruleBody('.mktero-citation-popup-library-picker');
    const item = ruleBody('.mktero-citation-popup-item');
    const actions = ruleBody('.mktero-citation-popup-actions');

    assert.match(header, /display:\s*flex/);
    assert.match(picker, /width:\s*100%/);
    assert.match(item, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(actions, /display:\s*grid/);
    assert.match(actions, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    assert.match(actions, /padding-left:\s*0/);
    assert.doesNotMatch(MARKDOWN_STYLES, /citation-popup-select-all/);
    assert.doesNotMatch(MARKDOWN_STYLES, /citation-popup-batch-import/);
    assert.doesNotMatch(MARKDOWN_STYLES, /citation-popup-reference-checkbox/);
});

test('styles Zotero-colored PDF annotations and their action popup', () => {
    const annotation = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-pdf-annotation'
    );
    assert.match(annotation, /border-radius:\s*3px/);
    assert.match(annotation, /box-decoration-break:\s*clone/);
    assert.match(annotation, /cursor:\s*pointer/);

    const highlight = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-pdf-annotation--highlight'
    );
    assert.match(
        highlight,
        /background:\s*color-mix\([\s\S]*?var\(--mktero-annotation-color\) 24%[\s\S]*?transparent/
    );

    const underline = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-pdf-annotation--underline'
    );
    assert.match(underline, /text-decoration-line:\s*underline/);
    assert.match(
        underline,
        /text-decoration-color:\s*var\(--mktero-annotation-color\)/
    );

    const noteMarker = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-pdf-annotation-note'
    );
    assert.match(noteMarker, /position:\s*relative/);
    assert.match(noteMarker, /display:\s*inline/);
    assert.match(noteMarker, /width:\s*0/);
    assert.match(noteMarker, /height:\s*0/);

    const noteIcon = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-pdf-annotation-note-icon'
    );
    assert.match(noteIcon, /position:\s*absolute/);
    assert.match(noteIcon, /top:\s*-1\.05em/);
    assert.match(noteIcon, /left:\s*-6px/);
    assert.match(noteIcon, /width:\s*15px/);
    assert.match(noteIcon, /height:\s*15px/);
    assert.match(noteIcon, /filter:\s*drop-shadow/);

    const popup = ruleBody('.mktero-annotation-popup');
    assert.match(popup, /position:\s*fixed/);
    assert.match(popup, /z-index:\s*900/);
    assert.match(popup, /background:\s*var\(--surface-raised\)/);

    const actionsPopup = ruleBody('.mktero-annotation-popup--actions');
    assert.match(actionsPopup, /width:\s*max-content/);
    assert.match(actionsPopup, /max-width:\s*calc\(100vw - 24px\)/);
    assert.match(actionsPopup, /box-sizing:\s*border-box/);

    const notePopup = ruleBody('.mktero-annotation-popup--note-editor');
    assert.match(
        notePopup,
        /width:\s*min\(360px, calc\(100vw - 24px\)\)/
    );

    const popupArrow = ruleBody('.mktero-annotation-popup::after');
    assert.match(popupArrow, /background:\s*var\(--surface-raised\)/);

    const noteInput = ruleBody('.mktero-annotation-note-input');
    assert.match(noteInput, /width:\s*100%/);
    assert.match(noteInput, /min-height:\s*82px/);
    assert.match(noteInput, /resize:\s*vertical/);
    assert.match(noteInput, /border-radius:\s*6px/);

    const noteFooter = ruleBody('.mktero-annotation-note-footer');
    assert.match(noteFooter, /display:\s*flex/);
    assert.match(noteFooter, /justify-content:\s*flex-end/);
    assert.match(noteFooter, /gap:\s*6px/);

    const noteButtons = ruleBody([
        '.mktero-annotation-note-cancel,',
        '.mktero-annotation-note-save',
    ].join('\n'));
    assert.match(noteButtons, /height:\s*28px/);
    assert.match(noteButtons, /border-radius:\s*6px/);

    const swatch = ruleBody('.mktero-annotation-popup-swatch');
    assert.match(swatch, /background:\s*var\(--mktero-annotation-color\)/);

    const actions = ruleBody('.mktero-annotation-actions');
    assert.match(actions, /display:\s*flex/);
    assert.match(actions, /flex-wrap:\s*wrap/);
    assert.match(actions, /gap:\s*6px/);
    assert.match(actions, /padding:\s*8px 9px/);

    const colorButton = ruleBody([
        '.mktero-annotation-color-button,',
        '.mktero-annotation-delete-button,',
        '.mktero-annotation-note-button,',
        '.mktero-annotation-source-button,',
        '.mktero-annotation-copy-button',
    ].join('\n'));
    assert.match(colorButton, /width:\s*25px/);
    assert.match(colorButton, /height:\s*25px/);
    assert.match(colorButton, /box-sizing:\s*border-box/);
    assert.match(colorButton, /cursor:\s*pointer/);

    const colorSwatch = ruleBody(
        '.mktero-annotation-color-button::before'
    );
    assert.match(
        colorSwatch,
        /background:\s*var\(--mktero-annotation-color\)/
    );
    assert.match(colorSwatch, /width:\s*15px/);
    assert.match(colorSwatch, /height:\s*15px/);

    const deleteButton = ruleBody('\n\n.mktero-annotation-delete-button');
    assert.match(deleteButton, /position:\s*relative/);
    assert.doesNotMatch(deleteButton, /border-left-color/);

    const deleteSeparator = ruleBody(
        '.mktero-annotation-delete-button::before'
    );
    assert.match(deleteSeparator, /width:\s*1px/);
    assert.match(deleteSeparator, /top:\s*3px/);
    assert.match(deleteSeparator, /bottom:\s*3px/);
    assert.match(deleteSeparator, /background:\s*color-mix/);

    const noteAction = ruleBody('\n\n.mktero-annotation-note-button');
    assert.match(noteAction, /position:\s*relative/);
    assert.match(noteAction, /border-radius:\s*6px/);
    const noteSeparator = ruleBody(
        '.mktero-annotation-note-button::before'
    );
    assert.match(noteSeparator, /width:\s*1px/);
    assert.match(noteSeparator, /top:\s*3px/);
    assert.match(noteSeparator, /bottom:\s*3px/);
});

test('styles Markdown selection translation states as a compact popup section', () => {
    const selectionActions = ruleBody('.mktero-markdown-selection-actions');
    const toolbar = ruleBody('.mktero-markdown-selection-toolbar');
    const translation = ruleBody('.mktero-selection-translation');
    const result = lastRuleBody('.mktero-selection-translation-result');
    const error = lastRuleBody('.mktero-selection-translation-error');
    const actions = lastRuleBody('.mktero-selection-translation-actions');
    const button = lastRuleBody('.mktero-selection-translation-button');

    assert.match(selectionActions, /display:\s*grid/);
    assert.match(
        selectionActions,
        /grid-template-columns:\s*minmax\(0, max-content\)/
    );
    assert.match(toolbar, /display:\s*flex/);
    assert.match(toolbar, /flex-wrap:\s*wrap/);
    assert.match(translation, /width:\s*100%/);
    assert.match(translation, /min-width:\s*0/);
    assert.match(
        translation,
        /max-width:\s*min\(320px, calc\(100vw - 42px\)\)/
    );
    assert.match(
        translation,
        /border-top:\s*1px solid var\(--border-subtle\)/
    );
    assert.match(result, /max-width:\s*100%/);
    assert.match(result, /white-space:\s*pre-wrap/);
    assert.match(result, /overflow-wrap:\s*anywhere/);
    assert.match(error, /color:\s*var\(--error, #c62828\)/);
    assert.match(actions, /justify-content:\s*flex-end/);
    assert.match(button, /width:\s*25px/);
    assert.match(button, /height:\s*25px/);
    assert.match(button, /border-radius:\s*6px/);
});

test('keeps snapshot code blocks from inheriting inline code chrome', () => {
    const inlineCode = ruleBody('.markdown-snapshot-host code');
    assert.match(inlineCode, /border:\s*1px solid var\(--border-subtle\)/);
    assert.match(inlineCode, /font-size:\s*var\(--reader-code-font-size\)/);

    const blockCode = ruleBody('.markdown-snapshot-host pre code');
    assert.match(blockCode, /padding:\s*0/);
    assert.match(blockCode, /border:\s*0/);
    assert.match(blockCode, /background:\s*transparent/);
    assert.match(blockCode, /font:\s*inherit/);
});

test('styles paper-like paragraphs and interactive reader code blocks', () => {
    const paragraph = ruleBody('.markdown-snapshot-host p');
    assert.match(paragraph, /hyphens:\s*auto/);
    assert.match(paragraph, /text-align:\s*justify/);
    assert.match(paragraph, /text-justify:\s*inter-word/);

    const line = ruleBody('.markdown-editor-host > .cm-editor .cm-line');
    assert.match(line, /hyphens:\s*auto/);
    assert.match(line, /text-align:\s*justify/);

    const block = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-code-block'
    );
    assert.match(block, /overflow:\s*hidden/);
    assert.match(block, /border-radius:\s*var\(--radius-md\)/);

    const snapshotBlock = ruleBody(
        '.markdown-snapshot-host .cm-mktero-code-block'
    );
    assert.match(snapshotBlock, /overflow:\s*hidden/);

    const toolbar = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-code-toolbar'
    );
    assert.match(toolbar, /justify-content:\s*space-between/);
    assert.match(toolbar, /user-select:\s*none/);

    const copy = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-code-copy'
    );
    assert.match(copy, /cursor:\s*pointer/);
    assert.match(copy, /text-transform:\s*none/);

    const snapshotCopy = ruleBody(
        '.markdown-snapshot-host .cm-mktero-code-copy'
    );
    assert.match(snapshotCopy, /cursor:\s*pointer/);
});

test('styles table references, previews, and target highlights', () => {
    const reference = ruleBody(
        [
            '.markdown-editor-host > .cm-editor .cm-mktero-table-reference,',
            '.markdown-editor-host > .cm-editor .cm-mktero-figure-reference',
        ].join('\n')
    );
    assert.match(reference, /color:\s*var\(--accent-strong\)/);
    assert.match(reference, /cursor:\s*pointer/);

    const popupShell = ruleBody([
        '.mktero-table-preview-popup,',
        '.mktero-figure-preview-popup',
    ].join('\n'));
    assert.match(popupShell, /position:\s*fixed/);
    assert.match(popupShell, /max-width:\s*calc\(100vw - 48px\)/);
    assert.match(popupShell, /box-sizing:\s*border-box/);
    assert.match(popupShell, /z-index:\s*900/);
    assert.match(
        popupShell,
        /--reference-preview-surface:\s*var\(--surface-raised\)/
    );
    assert.match(popupShell, /--reference-preview-text:\s*var\(--text\)/);
    assert.match(popupShell, /--reference-preview-muted:\s*var\(--muted\)/);
    assert.match(popupShell, /--reference-preview-border:\s*var\(--border\)/);
    assert.match(
        popupShell,
        /--reference-preview-header:\s*color-mix\(\s*in srgb,\s*var\(--surface\) 82%,\s*var\(--background\)\s*\)/
    );

    const popup = ruleBody('.mktero-table-preview-popup');
    assert.match(popup, /width:\s*min\(700px, calc\(100vw - 48px\)\)/);

    const content = ruleBody('.mktero-table-preview-content');
    assert.match(content, /padding:\s*12px/);

    const viewport = ruleBody('.mktero-table-preview-viewport');
    assert.match(viewport, /max-height:\s*min\(390px, calc\(100vh - 144px\)\)/);
    assert.match(viewport, /overflow:\s*auto/);

    const highlight = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-table-target-highlight'
    );
    assert.match(highlight, /animation:\s*mktero-table-target-highlight 3s ease-out/);
});

test('styles figure references, previews, and target highlights', () => {
    const reference = ruleBody(
        [
            '.markdown-editor-host > .cm-editor .cm-mktero-table-reference,',
            '.markdown-editor-host > .cm-editor .cm-mktero-figure-reference',
        ].join('\n')
    );
    assert.match(reference, /color:\s*var\(--accent-strong\)/);
    assert.match(reference, /cursor:\s*pointer/);

    const popup = ruleBody('.mktero-figure-preview-popup');
    assert.match(popup, /width:\s*min\(620px, calc\(100vw - 48px\)\)/);

    const content = ruleBody('.mktero-figure-preview-content');
    assert.match(content, /padding:\s*12px/);

    const viewport = ruleBody('.mktero-figure-preview-viewport');
    assert.match(viewport, /max-height:\s*min\(440px, calc\(100vh - 144px\)\)/);
    assert.match(viewport, /overflow:\s*auto/);

    const image = ruleBody('.mktero-figure-preview-viewport img');
    assert.match(image, /max-width:\s*100%/);
    assert.match(image, /object-fit:\s*contain/);

    const panelLabel = ruleBody(
        '.mktero-figure-preview-viewport .mktero-figure-panel-label'
    );
    assert.match(panelLabel, /text-align:\s*center/);
    assert.match(panelLabel, /font-size:\s*var\(--reader-panel-label-font-size\)/);

    const highlight = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-figure-target-highlight'
    );
    assert.match(highlight, /animation:\s*mktero-figure-target-highlight 3s ease-out/);
});
