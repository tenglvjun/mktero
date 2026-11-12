// Builds the iOS reader stylesheet from the extension's own ui/markdown.css.
//
// The iOS reader used to carry a hand-written stylesheet (MkteroStyleSheet.swift)
// that only approximated the desktop reader: another font, line height and
// margin scale, and no rules at all for the elements the renderer actually emits
// (`mktero-figure`, `math-inline`, `math-display`, `page-marker`,
// `missing-image`, `mktero-section-label`). The same paper therefore looked like
// two different products.
//
// The sheet is assembled from the desktop stylesheet in three parts:
//
//   1. variables. The `:host { … }` block — the light and dark palettes and every
//      `--reader-*` typography variable — moves onto the app's content host,
//      `.mktero-reader`.
//
//   2. block typography. The rules the desktop reader writes for a *saved
//      snapshot* are kept verbatim apart from the host prefix. A snapshot is one
//      flat HTML tree in one container, which is exactly what the app renders, so
//      these are the extension's own rules for `p`, `h1`…`h6`, `table`, `pre`,
//      `figure`, `figcaption`, `blockquote`, `code` and links.
//
//   3. figure, math and code modules. The desktop reading pane styles these
//      through the wrapper element each per-block widget adds, and the app has no
//      such wrappers. `EDITOR_MODULE_RULES` is an explicit translation table: the
//      source selector from `ui/markdown.css`, the flat selector it becomes, and
//      why. The declarations are copied unchanged, so the module still looks the
//      way the desktop reader draws it rather than the way someone re-typed it.
//      A rule that is not in the table is dropped: it belongs to a wrapper the
//      app does not have, and guessing at it is how the two readers diverged.
//
// Everything else — side panels, toolbar, notes column, popovers, translation and
// correction affordances, selection highlights, copy toolbars, CodeMirror lines —
// is chrome the app does not draw, and is dropped.
//
// KaTeX MathML is laid out from font metrics, not heuristics: without KaTeX_Main
// and the symbol fonts, fraction bars, large operators and `\rule` are misplaced
// rather than merely unstyled. Its stylesheet and woff2 fonts are packaged next
// to the reader sheet.
//
// Run after changing ui/markdown.css or the katex version:
//
//   npm run build:ios-reader
//
// `npm run check` fails when the committed output is stale, so a stylesheet
// change cannot silently skip the app. The output is committed so an iOS build
// needs no Node, exactly like the renderer bundle.
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The iOS checkout is a sibling by default. MKTERO_IOS_ROOT overrides it, so a
// git worktree, a CI checkout, or a build script can point at the real app
// without the two repositories having to sit side by side.
const iosRepository = process.env.MKTERO_IOS_ROOT
    ? path.resolve(process.env.MKTERO_IOS_ROOT)
    : path.resolve(projectRoot, '..', 'mktero-iOS');
export const styleOutput = path.join(iosRepository, 'Mktero/Resources/Reader');
export const STYLE_MANIFEST = 'mktero-reader-styles.json';
const SOURCE_STYLESHEET = path.join(projectRoot, 'ui/markdown.css');
const KATEX_STYLESHEET = path.join(projectRoot, 'node_modules/katex/dist/katex.min.css');
const KATEX_FONT_DIRECTORY = path.join(projectRoot, 'node_modules/katex/dist/fonts');

// Where the rendered document lives in the app. The desktop reader puts the same
// markup either in a CodeMirror pane or in a saved-snapshot container.
export const HOST = '.mktero-reader';
const EDITOR_PREFIX = '.markdown-editor-host > .cm-editor';
const SNAPSHOT_PREFIX = '.markdown-snapshot-host';

export const READER_STYLE_FILES = Object.freeze({
    stylesheet: 'reader.css',
    katexStylesheet: 'katex.css',
    manifest: STYLE_MANIFEST,
});

/**
 * The desktop pane's figure, math, code and label modules, translated onto the
 * flat markup `renderMarkdownHTML` produces.
 *
 * `from` is the selector as it appears after `.markdown-editor-host > .cm-editor`
 * in ui/markdown.css. `to` is what the app styles instead. `why` records the
 * mapping, because the next person to change the desktop rule needs to know which
 * app rule to change with it. The declarations are copied, never re-typed.
 *
 * The wrapper classes the pane relies on and the flat markup's stand-ins:
 *
 *   .cm-mktero-image          → the <figure class="mktero-figure"> itself
 *   .cm-mktero-math           → <span class="math-inline">
 *   .cm-mktero-math-display   → <div class="math math-display">
 *   .cm-mktero-algorithm      → <div class="mktero-algorithm">
 *   .cm-mktero-divider        → <hr>
 *   .cm-mktero-task           → <li> with an <input type="checkbox">
 *   .cm-mktero-image-inline   → an inline <img>
 */
export const EDITOR_MODULE_RULES = Object.freeze([
    // --- figure module ------------------------------------------------------
    { from: '.cm-mktero-image', to: '.mktero-figure', why: 'figure block wrapper' },    { from: '.cm-mktero-image img', to: '.mktero-figure img', why: 'figure asset' },
    {
        from: '.cm-mktero-image + .cm-mktero-image img',
        to: '.mktero-figure + .mktero-figure img',
        why: 'two consecutive figures',
    },
    {
        from: '.cm-mktero-image .mktero-figure',
        to: '.mktero-figure',
        why: 'wrapper and <figure> are the same node',
    },
    {
        from: '.cm-mktero-image .mktero-figure img',
        to: '.mktero-figure img',
        why: 'figure asset inside the block',
    },
    {
        from: '.cm-mktero-image .mktero-figure-group img + img',
        to: '.mktero-figure-group img + img',
        why: 'stacked figure panels',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-horizontal',
        to: '.mktero-figure-panels-horizontal',
        why: 'side-by-side figure panels',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-horizontal img',
        to: '.mktero-figure-panels-horizontal img',
        why: 'panel asset fills its column',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-horizontal img + img',
        to: '.mktero-figure-panels-horizontal img + img',
        why: 'panel spacing inside the grid',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-horizontal > .mktero-figure-panel + .mktero-figure-panel',
        to: '.mktero-figure-panels-horizontal > .mktero-figure-panel + .mktero-figure-panel',
        why: 'panel spacing inside the grid',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panel > .mktero-figure-panels-horizontal',
        to: '.mktero-figure-panel > .mktero-figure-panels-horizontal',
        why: 'nested panel group',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-grid',
        to: '.mktero-figure-panels-grid',
        why: 'grid figure layout',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-grid img',
        to: '.mktero-figure-panels-grid img',
        why: 'grid panel asset',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-grid .mktero-figure-panel',
        to: '.mktero-figure-panels-grid .mktero-figure-panel',
        why: 'grid panel cell',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panel',
        to: '.mktero-figure-panel',
        why: 'one labelled figure panel',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panel + .mktero-figure-panel',
        to: '.mktero-figure-panel + .mktero-figure-panel',
        why: 'stacked panels',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panels-grid > .mktero-figure-panel + .mktero-figure-panel',
        to: '.mktero-figure-panels-grid > .mktero-figure-panel + .mktero-figure-panel',
        why: 'grid gap replaces the stacked margin',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panel-label',
        to: '.mktero-figure-panel-label',
        why: '“(a)” label above or below a panel',
    },
    {
        from: '.cm-mktero-image .mktero-figure-panel-label-before',
        to: '.mktero-figure-panel-label-before',
        why: 'label placed above its panel',
    },
    {
        from: '.cm-mktero-image .mktero-figure-table-panel',
        to: '.mktero-figure-table-panel',
        why: 'a table rendered as a figure panel',
    },
    {
        from: '.cm-mktero-image .mktero-figure-table-panel table',
        to: '.mktero-figure-table-panel table',
        why: 'table panel grid',
    },
    {
        from: '.cm-mktero-image .mktero-figure figcaption',
        to: '.mktero-figure figcaption',
        why: 'figure caption',
    },
    { from: '.mktero-figure-label', to: '.mktero-figure-label', why: '“Figure 3” label' },

    // --- table module -------------------------------------------------------
    // The pane puts the card on a wrapper <div>; the flat markup's <table> is the
    // card. A rule on the wrapper therefore targets the table, and a rule on a
    // descendant keeps that descendant.
    { from: '.cm-mktero-table', to: 'table', why: 'table card' },
    { from: '.cm-mktero-html-table', to: 'table', why: 'table card' },
    // The pane's card is a wrapper <div> and these two rules describe the *inner*
    // grid (`border-collapse`, `min-width`). The app's <table> is the card, so the
    // snapshot baseline already owns those properties; re-applying them would
    // collapse the card's rounded frame.
    { from: '.cm-mktero-table table caption', to: 'table caption', why: 'caption above the grid' },
    { from: '.cm-mktero-html-block table caption', to: 'table caption', why: 'caption above the grid' },
    {
        from: '.cm-mktero-table th, .cm-mktero-table td, .cm-mktero-html-block th, .cm-mktero-html-block td',
        to: 'table th, table td',
        why: 'cell box',
    },
    {
        from: '.cm-mktero-table tbody tr:nth-child(even) td, .cm-mktero-html-block tbody tr:nth-child(even) td',
        to: 'table tbody tr:nth-child(even) td',
        why: 'zebra rows',
    },

    // --- math module --------------------------------------------------------
    { from: '.cm-mktero-math', to: '.math-inline', why: 'inline KaTeX span' },
    { from: '.cm-mktero-math', to: '.math-inline', why: 'inline KaTeX span' },
    { from: '.cm-mktero-math math', to: '.math-inline math', why: 'inline MathML size' },
    {
        from: '.cm-mktero-math-display',
        to: '.math.math-display',
        why: 'display formula block',
    },
    {
        from: '.cm-mktero-math-display .math.math-display',
        to: '.math.math-display',
        why: 'the block and the wrapper are one node',
    },
    {
        from: '.cm-mktero-math-display .math.math-display-tagged',
        to: '.math.math-display-tagged',
        why: 'formula with an equation number',
    },
    {
        from: '.cm-mktero-math-display .math.math-display-tagged math',
        to: '.math.math-display-tagged math',
        why: 'tagged formula fills the line',
    },
    {
        from: '.cm-mktero-math-display .math.math-display-tagged math > semantics > mtable',
        to: '.math.math-display-tagged math > semantics > mtable',
        why: 'equation-number table',
    },
    {
        from: '.cm-mktero-math-display .math.math-display-tagged math > semantics > mtable > mtr > mtd:last-child',
        to: '.math.math-display-tagged math > semantics > mtable > mtr > mtd:last-child',
        why: 'the tag column is drawn separately',
    },
    {
        from: '.cm-mktero-math-display .math.math-display-tagged .math-display-equation-number',
        to: '.math.math-display-tagged .math-display-equation-number',
        why: 'equation number placement',
    },
    {
        from: '.cm-mktero-math-display math',
        to: '.math.math-display math',
        why: 'display MathML sizing',
    },
    {
        from: '.cm-mktero-math annotation, .cm-mktero-math-display annotation',
        to: '.math-inline annotation, .math.math-display annotation',
        why: 'the TeX source in <annotation> is for copy, not layout',
    },

    // --- code, divider, task, labels ---------------------------------------
    {
        from: '.cm-mktero-algorithm .mktero-algorithm',
        to: '.mktero-algorithm',
        why: 'MinerU algorithm block keeps its preformatted text',
    },
    { from: '.cm-mktero-divider hr', to: 'hr', why: 'a divider is a plain <hr>' },
    {
        from: '.cm-mktero-task input',
        to: 'input[type="checkbox"]',
        why: 'a task item is a bare disabled checkbox',
    },
    { from: '.mktero-table-label', to: '.mktero-table-label', why: '“Table 2” label' },
    { from: '.cm-mktero-rendered a', to: 'a', why: 'links inside rendered content' },
    { from: '.cm-mktero-link', to: 'a', why: 'links inside rendered content' },
]);

// Rules written without a host prefix that the app keeps: the shared content
// rules the desktop reader applies to both of its branches.
const BARE_SELECTORS = new Set([
    '.math-fallback',
    '.mktero-section-label',
    '.mktero-section-label strong',
    '.mktero-table-label',
    '.mktero-caption',
    '.page-marker',
    '.missing-image',
    '.markdown-source-fallback',
    'blockquote.mktero-note',
]);

// Rules naming one of these belong to a desktop panel or to CodeMirror itself.
const CHROME_SELECTOR = /\.(?:markdown-(?:outline|notes|note|reader|toolbar|side-|panel|search|translation|correction|source-peek|focus|loading|message|confirm|export|document-actions|typography|annotations|welcome|error|reading)|mktero-(?:figure-preview|figure-source|image-preview|confirmation|tab-|session)|cm-(?:editor|scroller|content|line|gutters|cursor|selection|activeLine|widgetBuffer))/u;

// ---------------------------------------------------------------------------
// CSS parsing
// ---------------------------------------------------------------------------

/** Splits a stylesheet into top-level blocks, keeping at-rule bodies intact. */
export function parseStylesheet(source) {
    const text = stripComments(String(source || ''));
    const blocks = [];
    let index = 0;
    while (index < text.length) {
        const open = text.indexOf('{', index);
        if (open < 0) break;
        const selector = text.slice(index, open).trim();
        let depth = 1;
        let cursor = open + 1;
        while (cursor < text.length && depth > 0) {
            const character = text[cursor];
            if (character === '{') depth++;
            else if (character === '}') depth--;
            else if (character === '"' || character === "'") {
                cursor = skipString(text, cursor);
                continue;
            }
            cursor++;
        }
        blocks.push({
            selector,
            body: text.slice(open + 1, Math.max(open + 1, cursor - 1)),
        });
        index = cursor;
    }
    return blocks;
}

function skipString(text, start) {
    const quote = text[start];
    let cursor = start + 1;
    while (cursor < text.length) {
        if (text[cursor] === '\\') {
            cursor += 2;
            continue;
        }
        if (text[cursor] === quote) return cursor + 1;
        cursor++;
    }
    return cursor;
}

function stripComments(source) {
    let output = '';
    let index = 0;
    while (index < source.length) {
        const start = source.indexOf('/*', index);
        if (start < 0) {
            output += source.slice(index);
            break;
        }
        output += source.slice(index, start);
        const end = source.indexOf('*/', start + 2);
        index = end < 0 ? source.length : end + 2;
    }
    return output;
}

/** Splits a selector list on commas outside parentheses, brackets and strings. */
export function splitSelectorList(selector) {
    const parts = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (const character of selector) {
        if (quote) {
            current += character;
            if (character === '\\') continue;
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }
        if (character === '(' || character === '[') depth++;
        else if (character === ')' || character === ']') depth--;
        if (character === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += character;
    }
    const last = current.trim();
    if (last) parts.push(last);
    return parts;
}

/**
 * Splits a declaration block into declarations.
 *
 * A `;` inside a string or a function is not a separator: a naive split would
 * corrupt `content: "a;b"` and `background: url(data:…;base64,…)`.
 */
export function splitDeclarations(body) {
    const parts = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (let index = 0; index < body.length; index++) {
        const character = body[index];
        if (quote) {
            current += character;
            if (character === '\\') {
                current += body[++index] ?? '';
                continue;
            }
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }
        if (character === '(') depth++;
        else if (character === ')') depth--;
        if (character === ';' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += character;
    }
    parts.push(current);
    return parts.map(part => part.trim()).filter(Boolean);
}

/** Normalizes whitespace so a selector can be compared with a table entry. */
export function normalizeSelector(selector) {
    return splitSelectorList(selector)
        .map(part => part.replace(/\s*([>+~])\s*/gu, ' $1 ').replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .join(', ');
}

// ---------------------------------------------------------------------------
// Stylesheet transform
// ---------------------------------------------------------------------------

/**
 * Assembles the reader sheet.
 *
 * `modules` maps every editor-branch selector in the source to one or more flat
 * selectors, so a rule is copied only when it is on the list. A source rule that
 * matches no entry is counted as dropped, which makes a new desktop rule show up
 * in the build summary instead of vanishing silently.
 */
export function transformStylesheet(blocks, modules = buildModuleIndex()) {
    const base = [];
    const snapshot = [];
    const editor = [];
    const dropped = { blocks: 0, selectors: 0, unmapped: [] };

    for (const block of blocks) {
        const selector = block.selector;
        if (/^@(-webkit-)?keyframes/u.test(selector)) {
            base.push(`${selector} {\n${block.body.trim()}\n}\n`);
            continue;
        }
        if (selector.startsWith('@container')) {
            // Container queries measure the desktop pane. The app's page is the
            // container, so the shell expresses the same breakpoints as media
            // queries.
            dropped.blocks++;
            continue;
        }
        if (selector.startsWith('@')) {
            const inner = transformStylesheet(parseStylesheet(block.body), modules);
            dropped.blocks += inner.dropped.blocks;
            dropped.selectors += inner.dropped.selectors;
            dropped.unmapped.push(...inner.dropped.unmapped);
            const css = [...inner.base, ...inner.snapshot, ...inner.editor].join('');
            if (!css.trim()) {
                dropped.blocks++;
                continue;
            }
            base.push(`${selector} {\n${css.trimEnd()}\n}\n`);
            continue;
        }

        const hostSelector = rewriteHostSelector(selector);
        if (hostSelector) {
            base.push(formatRule(hostSelector, block.body));
            continue;
        }
        // `blockquote.mktero-note` and friends are written with no host prefix
        // because both desktop branches share them.
        const bare = normalizeSelector(selector);
        if (BARE_SELECTORS.has(bare)) {
            base.push(formatRule(`${HOST} ${bare}`, block.body));
            continue;
        }

        if (selector.includes(SNAPSHOT_PREFIX) || selector.includes(EDITOR_PREFIX)) {
            // A block can list selectors from both branches, and the prefix can
            // appear more than once, so each part is classified on its own.
            const snapshotParts = [];
            const editorParts = [];
            for (const part of splitSelectorList(selector)) {
                if (part.includes(SNAPSHOT_PREFIX)) {
                    const rewritten = rewriteSnapshotSelector(part);
                    if (rewritten) snapshotParts.push(rewritten);
                    else dropped.selectors++;
                    continue;
                }
                if (part.includes(EDITOR_PREFIX)) {
                    const suffix = normalizeSelector(
                        part.slice(part.indexOf(EDITOR_PREFIX) + EDITOR_PREFIX.length)
                    );
                    const targets = modules.get(suffix);
                    if (targets) editorParts.push(...targets);
                    else {
                        dropped.selectors++;
                        dropped.unmapped.push(suffix || '(host only)');
                    }
                    continue;
                }
                // A part with no prefix inside a prefixed block is a rule the
                  // two desktop branches share (`.mktero-section-label` next to
                  // its snapshot twin), or a rule on a wrapper's own class.
                if (BARE_SELECTORS.has(part.trim())) {
                    snapshotParts.push(`${HOST} ${part.trim()}`);
                    continue;
                }
                const suffix = normalizeSelector(part);
                const targets = modules.get(suffix);
                if (targets) editorParts.push(...targets);
                else {
                    dropped.selectors++;
                    dropped.unmapped.push(suffix);
                }
            }
            if (snapshotParts.length) {
                snapshot.push(formatRule([...new Set(snapshotParts)].join(',\n'), block.body));
            }
            if (editorParts.length) {
                editor.push(formatRule([...new Set(editorParts)].join(',\n'), block.body));
            }
            if (!snapshotParts.length && !editorParts.length) dropped.blocks++;
            continue;
        }

        // A rule with no host prefix and no content class: chrome.
        dropped.selectors++;
    }

    return { base, editor, snapshot, dropped };
}

/**
 * Indexes EDITOR_MODULE_RULES by source selector.
 *
 * A translation's `to` may list several flat selectors; each one is scoped to the
 * host here, once, so no caller can emit a bare `table td` rule that would spill
 * onto the native UI around the page.
 */
export function buildModuleIndex(rules = EDITOR_MODULE_RULES) {
    const index = new Map();
    for (const rule of rules) {
        const targets = splitSelectorList(normalizeSelector(rule.to))
            .map(part => `${HOST} ${part}`);
        // A table entry may also list several alternatives on the source side
        // (the pane styles its two table wrappers in one block), and
        // `transformStylesheet` looks each selector up on its own.
        for (const key of splitSelectorList(normalizeSelector(rule.from))) {
            const existing = index.get(key) || [];
            for (const target of targets) {
                if (!existing.includes(target)) existing.push(target);
            }
            index.set(key, existing);
        }
    }
    return index;
}

/**
 * Rewrites one saved-snapshot selector onto the app host.
 *
 * The snapshot branch already matches the flat markup, so only two things change:
 * the host prefix, and the removal of selectors that describe the snapshot
 * container or an editor affordance the app does not render. A snapshot selector
 * naming a `cm-mktero-*` class styles a wrapper the desktop reader builds around
 * the content; the flat markup has no such wrapper, so it is dropped rather than
 * guessed at.
 */
export function rewriteSnapshotSelector(selector) {
    const trimmed = normalizeSelector(selector);
    if (!trimmed) return null;
    const stripped = trimmed.split(SNAPSHOT_PREFIX).join('');
    if (CHROME_SELECTOR.test(stripped)) return null;
    if (/\.cm-mktero-/u.test(stripped)) return null;
    const index = trimmed.indexOf(SNAPSHOT_PREFIX);
    const rest = trimmed.slice(index + SNAPSHOT_PREFIX.length).trim();
    // `.markdown-snapshot-host { … }` is the container; the app shell owns that.
    if (!rest) return null;
    if (rest.startsWith(':')) return `${HOST}${rest}`;
    // A bare class rule (`.mktero-section-label`) is written without the host
    // prefix in the source, so one that arrives here with a leading dot is part
    // of the snapshot container itself and has no app counterpart.
    if (rest.startsWith('.')) return null;
    return `${HOST} ${rest}`;
}

/**
 * Turns a `:host` variable block into the content host's own block.
 *
 * `:host` only exists inside a shadow root; the app's reader is a normal
 * document, so the variables have to live on `.mktero-reader` instead.
 */
export function rewriteHostSelector(selector) {
    if (!/:host\b/u.test(selector)) return null;
    const rewritten = splitSelectorList(selector)
        .map(part => part.replace(/:host/gu, HOST).trim())
        .filter(Boolean)
        .join(',\n');
    return rewritten || HOST;
}

function formatRule(selector, body) {
    const declarations = splitDeclarations(body)
        .map(declaration => `    ${declaration};`)
        .join('\n');
    const selectors = splitSelectorList(selector)
        .map(part => part.replace(/\s*([>+~])\s*/gu, ' $1 ').replace(/\s+/gu, ' ').trim())
        .join(',\n');
    return `${selectors} {\n${declarations}\n}\n`;
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

/**
 * What the app needs that a pane inside Zotero does not.
 *
 * Two kinds of rules live here, both of them things the desktop reader gets for
 * free from its host application:
 *
 *   - layout: the desktop reader scrolls inside a `.cm-scroller` that owns the
 *     reader width and the 48px/80px padding, and its editor container owns the
 *     background. In the app the host *is* the document, so those move onto it,
 *     with a narrower gutter on a phone;
 *   - elements the desktop reader inherits from Zotero's user-agent sheet, so
 *     ui/markdown.css has no rule for them: emphasis, list bullets, the task
 *     checkbox, `hr`.
 */
export function buildShellRules() {
    return `
/* ---------------------------------------------------------------- app shell */

/* The reader host is the document, so the column the desktop reader gets from
   .cm-scroller and .cm-content is set here. */
${HOST} {
    box-sizing: border-box;
    width: 100%;
    max-width: var(--reader-width);
    min-height: 100%;
    margin: 0 auto;
    padding: 48px 24px 80px;
    color: var(--reader-text);
    background: var(--reader-background);
    font-family: var(--reader-content-font, var(--reader-font));
    font-size: var(--reader-font-size);
    line-height: var(--reader-line-height);
    font-kerning: normal;
    font-optical-sizing: auto;
    font-variant-numeric: oldstyle-nums proportional-nums;
    font-weight: 400;
    text-align: var(--reader-text-align);
    text-align-last: start;
    text-justify: inter-word;
    text-wrap: pretty;
    word-break: normal;
    word-spacing: normal;
    overflow-wrap: break-word;
    text-size-adjust: 100%;
    -webkit-text-size-adjust: 100%;
}

${HOST},
${HOST} * {
    box-sizing: border-box;
}

/* iOS ships Charter, Iowan Old Style, Georgia, Times New Roman and the STIX
   families, but not STIX Two Text or Noto Serif, so the desktop stack is
   resolved here in the same order of preference. Without this the body copy
   falls through to the system sans-serif and stops reading like a paper. */
${HOST} {
    --reader-font: "STIX Two Text", "Charter", "Iowan Old Style", "Georgia", "Times New Roman", ui-serif, serif;
    --reader-translation-font-latin: "Times New Roman", Georgia, serif;
}

@media (max-width: 500px) {
    ${HOST} {
        padding: 24px 18px 64px;
    }
}

/* The desktop reader caps the column at the chosen width inside its pane. On a
   phone the pane is narrower than the cap, so the cap must not add a gutter. */
@media (max-width: 760px) {
    ${HOST} {
        max-width: 100%;
    }
}

/* -------------------------------------------------- inherited from Zotero */

${HOST} strong,
${HOST} b {
    font-weight: 700;
}

${HOST} em,
${HOST} i {
    font-style: italic;
}

${HOST} del {
    text-decoration: line-through;
}

${HOST} sup,
${HOST} sub {
    font-size: 0.75em;
    line-height: 0;
}

${HOST} ul,
${HOST} ol {
    margin: 0 0 1.25em;
    padding-inline-start: 1.6em;
}

${HOST} li {
    margin: 0.3em 0;
}

${HOST} li > ul,
${HOST} li > ol {
    margin: 0.3em 0 0;
}

${HOST} li::marker {
    color: var(--muted);
}

/* A task item's checkbox comes from marked as a bare disabled input. */
${HOST} input[type="checkbox"] {
    width: 1em;
    height: 1em;
    margin-inline-end: 0.4em;
    vertical-align: -0.1em;
    accent-color: var(--accent);
}

/* The pane renders a divider as a block with 28px of air above and below; the
   flat markup has a plain <hr>, so the space moves onto it. */
${HOST} hr {
    display: block;
    margin: 28px 0;
    border: 0;
    border-top: 1px solid var(--border);
}

/* ---------------------------------------------------- flat-block adaptation */

@media (max-width: 760px) {
    /* A wide table scrolls inside its own card instead of widening the page. */
    ${HOST} table {
        display: block;
        max-width: 100%;
        overflow-x: auto;
        overscroll-behavior-x: contain;
    }

    /* A display formula wider than a phone scrolls on its own line. */
    ${HOST} .math.math-display {
        max-width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        overscroll-behavior-x: contain;
    }
}
`;
}

// ---------------------------------------------------------------------------
// KaTeX
// ---------------------------------------------------------------------------

/**
 * Keeps only the woff2 font sources.
 *
 * iOS 17 WebKit has loaded woff2 since iOS 10, so the woff and ttf fallbacks
 * only add bytes: 1.5 MB of font files becomes 296 KB. The URLs lose their
 * `fonts/` prefix because the packaged copy sits in one directory.
 */
export function stripFontFallbacks(css) {
    return String(css).replace(
        /src:url\(fonts\/([A-Za-z0-9_-]+\.woff2)\) format\("woff2"\),url\(fonts\/[A-Za-z0-9_-]+\.woff\) format\("woff"\),url\(fonts\/[A-Za-z0-9_-]+\.ttf\) format\("truetype"\)/gu,
        'src:url($1) format("woff2")'
    );
}

/** The woff2 files the stylesheet references, sorted. */
export function katexFontFiles(css) {
    return [...new Set(
        [...String(css).matchAll(/url\(([A-Za-z0-9_-]+\.woff2)\)/gu)].map(match => match[1])
    )].sort();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Builds every generated file in memory, so `--check` can diff it. */
export async function buildReaderStyles() {
    const [source, katexSource, extensionManifest, packageManifest] = await Promise.all([
        readFile(SOURCE_STYLESHEET, 'utf8'),
        readFile(KATEX_STYLESHEET, 'utf8'),
        readFile(path.join(projectRoot, 'manifest.json'), 'utf8'),
        readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    ]);
    const katexVersion = JSON.parse(packageManifest).dependencies?.katex || '';
    const katexCSS = stripFontFallbacks(katexSource);
    const fonts = katexFontFiles(katexCSS);
    if (!fonts.length) {
        throw new Error('katex.min.css references no woff2 font; the vendored copy changed');
    }

    const { base, editor, snapshot, dropped } = transformStylesheet(
        parseStylesheet(source)
    );
    const stylesheet = [
        '/* Generated by scripts/build-ios-reader-styles.mjs — do not edit.',
        '   Source: mktero/ui/markdown.css, the Mktero reader stylesheet.',
        `   Rules: ${base.length} base, ${snapshot.length} snapshot-baseline, `
        + `${editor.length} module, ${dropped.selectors} chrome selectors dropped. */`,
        '',
        base.join('').trimEnd(),
        '',
        '/* -------------------------------------------------- snapshot baseline',
        '   A saved snapshot is one flat HTML tree in one container: the same shape',
        '   the app renders. These are the extension\'s own block rules for p,',
        '   h1…h6, table, pre, figure, figcaption, blockquote, code and links. */',
        '',
        snapshot.join('').trimEnd(),
        '',
        '/* ------------------------------------------------ figure/math/code modules',
        "   The desktop pane's module rules, translated onto the flat markup by the",
        '   table in scripts/build-ios-reader-styles.mjs. Declarations are copied,',
        '   not re-typed, so a module looks the way the desktop reader draws it. */',
        '',
        editor.join('').trimEnd(),
        buildShellRules().trimEnd(),
        '',
    ].join('\n');

    const files = {
        [READER_STYLE_FILES.stylesheet]: stylesheet,
        [READER_STYLE_FILES.katexStylesheet]: [
            '/* Generated by scripts/build-ios-reader-styles.mjs — do not edit.',
            `   Source: katex ${katexVersion} katex.min.css, woff2 sources only. */`,
            '',
            katexCSS.trim(),
            '',
        ].join('\n'),
    };

    const manifest = {
        name: 'mktero-reader-styles',
        extensionVersion: JSON.parse(extensionManifest).version,
        katexVersion,
        host: HOST,
        stylesheet: READER_STYLE_FILES.stylesheet,
        katexStylesheet: READER_STYLE_FILES.katexStylesheet,
        fonts,
        bytes: Object.fromEntries(
            Object.entries(files).map(([name, text]) => [name, byteLength(text)])
        ),
        rules: {
            base: base.length,
            snapshot: snapshot.length,
            modules: editor.length,
        },
        dropped: {
            blocks: dropped.blocks,
            selectors: dropped.selectors,
            // Editor rules with no entry in the translation table. A fresh
            // desktop rule lands here rather than disappearing.
            unmapped: [...new Set(dropped.unmapped)].sort(),
        },
    };

    return { files, manifest, fonts };
}

function byteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}

async function writeOutput({ files, manifest, fonts }) {
    await rm(styleOutput, { recursive: true, force: true });
    await mkdir(path.join(styleOutput, 'fonts'), { recursive: true });
    await Promise.all([
        ...Object.entries(files).map(([name, text]) => (
            writeFile(path.join(styleOutput, name), text, 'utf8')
        )),
        writeFile(
            path.join(styleOutput, STYLE_MANIFEST),
            `${JSON.stringify(manifest, null, 2)}\n`,
            'utf8'
        ),
        ...fonts.map(async font => {
            const bytes = await readFile(path.join(KATEX_FONT_DIRECTORY, font));
            return writeFile(path.join(styleOutput, 'fonts', font), bytes);
        }),
    ]);
}

/** Compares the committed output with a fresh build; returns the stale files. */
async function staleFiles({ files, manifest, fonts }) {
    const stale = [];
    for (const [name, text] of Object.entries(files)) {
        const committed = await readFile(path.join(styleOutput, name), 'utf8')
            .catch(() => null);
        if (committed !== text) stale.push(name);
    }
    const committedManifest = await readFile(
        path.join(styleOutput, STYLE_MANIFEST),
        'utf8'
    ).catch(() => null);
    if (committedManifest !== `${JSON.stringify(manifest, null, 2)}\n`) {
        stale.push(STYLE_MANIFEST);
    }
    for (const font of fonts) {
        const committed = await readFile(path.join(styleOutput, 'fonts', font))
            .catch(() => null);
        const source = await readFile(path.join(KATEX_FONT_DIRECTORY, font));
        if (!committed || Buffer.compare(committed, source) !== 0) {
            stale.push(`fonts/${font}`);
        }
    }
    return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    const built = await buildReaderStyles();
    const kib = name => `${(built.manifest.bytes[name] / 1024).toFixed(1)} KiB`;
    const summary = `${built.manifest.stylesheet} ${kib(built.manifest.stylesheet)}, `
        + `${built.manifest.katexStylesheet} ${kib(built.manifest.katexStylesheet)}, `
        + `${built.fonts.length} fonts, ${built.manifest.rules.base}+`
        + `${built.manifest.rules.snapshot}+${built.manifest.rules.modules} rules, `
        + `${built.manifest.dropped.selectors} chrome selectors dropped`
        + (built.manifest.dropped.unmapped.length
            ? `, ${built.manifest.dropped.unmapped.length} editor rules unmapped`
            : '');
    if (check) {
        const stale = await staleFiles(built);
        if (stale.length) {
            console.error(
                `ios reader styles are stale (${stale.join(', ')}); `
                + 'run npm run build:ios-reader'
            );
            process.exitCode = 1;
        }
        else {
            console.log(`ios reader styles up to date: ${summary}`);
        }
    }
    else {
        await writeOutput(built);
        console.log(`ios reader styles: ${summary}`);
    }
}
