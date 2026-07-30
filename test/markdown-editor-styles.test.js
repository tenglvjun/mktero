import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKDOWN_STYLES = readFileSync(
    new URL('../ui/markdown.css', import.meta.url),
    'utf8'
);

function ruleBody(selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = MARKDOWN_STYLES.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `Missing CSS rule: ${selector}`);
    return match[1];
}

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
    assert.match(content, /max-width:\s*960px/);
    assert.match(content, /flex:\s*0 0 auto/);
    assert.match(content, /padding:\s*32px 0 72px/);

    const line = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-line'
    );
    assert.match(line, /padding-inline:\s*0/);

    const heading = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-heading'
    );
    assert.match(heading, /font-weight:\s*700/);
    assert.match(heading, /line-height:\s*1\.3/);
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
    assert.match(tableFrame, /border-radius:\s*8px/);

    const tables = ruleBody([
        '.markdown-editor-host > .cm-editor .cm-mktero-table table,',
        '.markdown-editor-host > .cm-editor .cm-mktero-html-block table',
    ].join('\n'));
    assert.match(tables, /width:\s*100%/);
    assert.match(tables, /min-width:\s*100%/);
    assert.match(tables, /max-width:\s*none/);
    assert.match(tables, /table-layout:\s*auto/);
    assert.match(tables, /font-size:\s*13px/);

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
    assert.match(caption, /padding:\s*8px 10px/);
    assert.doesNotMatch(caption, /border-left/);
    assert.match(caption, /border-radius:\s*4px/);
    assert.doesNotMatch(caption, /background\s*:/);
    assert.match(caption, /font-family:\s*ui-sans-serif/);
    assert.match(caption, /font-size:\s*12px/);
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
    assert.match(caption, /padding:\s*8px 10px/);
    assert.match(caption, /color:\s*var\(--muted\)/);
    assert.match(caption, /font-size:\s*12px/);
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

    const resizing = ruleBody('.markdown-workspace.is-resizing-outline');
    assert.match(resizing, /user-select:\s*none/);

    const outlineList = ruleBody('.markdown-outline-list');
    assert.match(outlineList, /overflow-y:\s*auto/);

    const outlineLink = ruleBody('.markdown-outline-link');
    assert.match(
        outlineLink,
        /padding-left:\s*calc\(8px \+ var\(--outline-indent, 0px\)\)/
    );

    assert.match(
        MARKDOWN_STYLES,
        /@media\s*\(max-width:\s*760px\)[\s\S]*\.markdown-outline\s*\{[^}]*flex-basis:\s*min\(var\(--outline-width, 256px\), 42vw\)/
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

test('styles citation popups and temporary reference highlights', () => {
    const citation = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-citation'
    );
    assert.match(citation, /color:\s*var\(--accent\)/);
    assert.match(citation, /cursor:\s*pointer/);

    const popup = ruleBody('.mktero-citation-popup');
    assert.match(popup, /position:\s*fixed/);
    assert.match(popup, /max-width:\s*min\(460px, calc\(100vw - 24px\)\)/);
    assert.match(popup, /z-index:\s*900/);
    assert.match(popup, /--citation-popup-surface:\s*var\(--surface\)/);
    assert.match(popup, /--citation-popup-text:\s*var\(--text\)/);
    assert.match(popup, /--citation-popup-border:\s*var\(--border\)/);
    assert.match(
        popup,
        /--citation-popup-hover:\s*color-mix\(\s*in srgb,\s*var\(--accent\) 12%,\s*var\(--surface\)\s*\)/
    );
    assert.match(popup, /--citation-popup-accent:\s*var\(--accent\)/);
    assert.match(popup, /background:\s*var\(--citation-popup-surface\)/);

    const popupItem = ruleBody('.mktero-citation-popup-item');
    assert.match(popupItem, /padding:\s*10px 12px/);
    assert.match(popupItem, /border-radius:\s*7px/);

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
        /background:\s*color-mix\([\s\S]*?var\(--mktero-annotation-color\) 32%[\s\S]*?transparent/
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
    assert.match(popup, /background:\s*var\(--surface\)/);

    const actionsPopup = ruleBody('.mktero-annotation-popup--actions');
    assert.match(actionsPopup, /width:\s*max-content/);
    assert.match(actionsPopup, /max-width:\s*calc\(100vw - 24px\)/);
    assert.match(actionsPopup, /box-sizing:\s*border-box/);

    const notePopup = ruleBody('.mktero-annotation-popup--note-editor');
    assert.match(
        notePopup,
        /width:\s*min\(360px, calc\(100vw - 24px\)\)/
    );

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
        '.mktero-annotation-note-button',
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

test('styles table references, previews, and target highlights', () => {
    const reference = ruleBody(
        [
            '.markdown-editor-host > .cm-editor .cm-mktero-table-reference,',
            '.markdown-editor-host > .cm-editor .cm-mktero-figure-reference',
        ].join('\n')
    );
    assert.match(reference, /color:\s*var\(--accent\)/);
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
        /--reference-preview-surface:\s*var\(--surface\)/
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
    assert.match(content, /padding:\s*10px/);

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
    assert.match(reference, /color:\s*var\(--accent\)/);
    assert.match(reference, /cursor:\s*pointer/);

    const popup = ruleBody('.mktero-figure-preview-popup');
    assert.match(popup, /width:\s*min\(620px, calc\(100vw - 48px\)\)/);

    const content = ruleBody('.mktero-figure-preview-content');
    assert.match(content, /padding:\s*10px/);

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

    const highlight = ruleBody(
        '.markdown-editor-host > .cm-editor .cm-mktero-figure-target-highlight'
    );
    assert.match(highlight, /animation:\s*mktero-figure-target-highlight 3s ease-out/);
});
