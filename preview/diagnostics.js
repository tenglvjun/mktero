// Error capture and a browser self-test for the preview. Automation (Playwright
// or safaridriver) and a person with `?diagnostics=1` read the same report, so
// every browser is judged by one set of checks.

export function installErrorCapture(window) {
    const errors = [];
    const warnings = [];
    const push = (list, kind, message, extra = {}) => {
        list.push({ kind, message: String(message).slice(0, 600), ...extra });
    };
    window.addEventListener('error', event => {
        push(errors, 'error', event.message || event.error, {
            source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
        });
    });
    window.addEventListener('unhandledrejection', event => {
        push(errors, 'unhandledrejection', event.reason?.stack || event.reason);
    });
    window.document.addEventListener('securitypolicyviolation', event => {
        push(errors, 'csp', `${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`);
    });
    const consoleError = window.console.error.bind(window.console);
    window.console.error = (...args) => {
        push(errors, 'console.error', args.map(formatArgument).join(' '));
        consoleError(...args);
    };
    const consoleWarn = window.console.warn.bind(window.console);
    window.console.warn = (...args) => {
        push(warnings, 'console.warn', args.map(formatArgument).join(' '));
        consoleWarn(...args);
    };
    return {
        errors,
        warnings,
        logError(error) {
            push(errors, 'zotero.logError', error?.stack || error?.message || error);
        },
    };
}

function formatArgument(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}

const delay = (window, ms) => new Promise(resolve => window.setTimeout(resolve, ms));

async function waitFor(window, predicate, { timeout = 2500, interval = 50 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() > deadline) return null;
        await delay(window, interval);
    }
}

// Each check scrolls the real reader to the content it inspects; CodeMirror
// only renders the lines near the viewport.
export function createSelfTest(context) {
    const { window, view, shell, model, markdown, capture } = context;
    const shadow = () => view.host.shadowRoot;
    const query = selector => shadow().querySelector(selector);
    const queryAll = selector => [...shadow().querySelectorAll(selector)];
    const scrollTo = async text => {
        const offset = model().markdown.indexOf(text);
        if (offset < 0) throw new Error(`Fixture text not found: ${text}`);
        view.editor.scrollToOffset(offset);
        await delay(window, 160);
    };

    const checks = [
        ['reader-renders', async () => {
            shell.activate('reader');
            const content = await waitFor(window, () => query('.cm-content'));
            if (!content) throw new Error('CodeMirror content is missing');
            const box = content.getBoundingClientRect();
            if (box.width < 200 || box.height < 200) throw new Error(`Content box is ${box.width}x${box.height}`);
            return { width: Math.round(box.width) };
        }],
        ['outline', async () => {
            const items = queryAll('.markdown-outline-link');
            if (items.length < 8) throw new Error(`Outline has ${items.length} links`);
            return { links: items.length };
        }],
        ['inline-math', async () => {
            await scrollTo('Kendall\'s $\\tau$ of 0.947');
            const math = await waitFor(window, () => queryAll('.cm-mktero-math math')
                .find(node => node.getBoundingClientRect().width > 0));
            if (!math) throw new Error('No visible MathML element');
            const box = math.getBoundingClientRect();
            return { width: Math.round(box.width), height: Math.round(box.height) };
        }],
        ['display-math', async () => {
            await scrollTo('$$\nP(b_i');
            const block = await waitFor(window, () => queryAll('.cm-mktero-math-block math, .cm-mktero-math-display math')
                .find(node => node.getBoundingClientRect().height > 12));
            if (!block) throw new Error('Display math has no height');
            const box = block.getBoundingClientRect();
            return { width: Math.round(box.width), height: Math.round(box.height) };
        }],
        ['code-highlighting', async () => {
            await scrollTo('def decode(blocks, score)');
            const tokens = await waitFor(window, () => {
                const colored = queryAll('.cm-mktero-code-token')
                    .filter(node => node.getAttribute('style')?.includes('color'));
                return colored.length >= 5 ? colored : null;
            });
            if (!tokens) throw new Error('Shiki tokens are not colored');
            return { coloredTokens: tokens.length };
        }],
        ['table', async () => {
            await scrollTo('<table>');
            const table = await waitFor(window, () => query('.cm-mktero-html-table table, .cm-mktero-table table'));
            if (!table) throw new Error('Table is not rendered');
            const rows = table.querySelectorAll('tr').length;
            if (rows < 4) throw new Error(`Table has ${rows} rows`);
            return { rows, width: Math.round(table.getBoundingClientRect().width) };
        }],
        ['figure', async () => {
            await scrollTo('![](images/figure-1.png)');
            const image = await waitFor(window, () => {
                const candidate = query('figure.mktero-figure img:not([aria-hidden="true"])');
                return candidate?.complete && candidate.naturalWidth > 0 ? candidate : null;
            }, { timeout: 4000 });
            if (!image) throw new Error('Figure image did not load');
            if (!image.currentSrc.startsWith('blob:')) throw new Error('Figure is not a blob URL');
            return { naturalWidth: image.naturalWidth, shownWidth: Math.round(image.getBoundingClientRect().width) };
        }],
        ['annotations', async () => {
            await scrollTo('We treat reading order as a pairwise ranking');
            const marks = await waitFor(window, () => {
                const found = queryAll('.cm-mktero-pdf-annotation');
                return found.length ? found : null;
            });
            if (!marks) throw new Error('No annotation decoration in view');
            const notes = queryAll('.markdown-note-item');
            if (notes.length < 4) throw new Error(`Notes pane lists ${notes.length} notes`);
            return { decorations: marks.length, notes: notes.length };
        }],
        ['citation-popup', async () => {
            await scrollTo('recursive X-Y cut [1]');
            // Hover opens the reference card; a click jumps to the reference.
            const citation = await waitFor(window, () => query('.cm-mktero-citation[data-citation-kind="reference"]'));
            if (!citation) throw new Error('Citation is not decorated');
            citation.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, composed: true }));
            const popup = await waitFor(window, () => {
                const node = query('.mktero-citation-popup');
                return node && !node.hidden && node.getBoundingClientRect().height > 0 ? node : null;
            });
            if (!popup) throw new Error('Citation popup did not open');
            const text = popup.textContent.replace(/\s+/g, ' ').slice(0, 80);
            citation.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, composed: true }));
            return { text };
        }],
        ['translation-views', async () => {
            const result = {};
            for (const mode of ['translated', 'compare', 'original']) {
                const button = query(`[data-translation-view="${mode}"]`);
                if (!button) throw new Error(`Missing ${mode} button`);
                button.click();
                await delay(window, 160);
                // The translated button opens a language menu first.
                if (mode === 'translated') {
                    const option = await waitFor(window, () => query('[data-translation-language="zh-CN"]'));
                    if (!option) throw new Error('Language menu did not open');
                    option.click();
                    await delay(window, 220);
                }
                if (model().translationView !== mode) {
                    throw new Error(`View stayed ${model().translationView} after ${mode}`);
                }
                view.editor.scrollToOffset(0);
                await delay(window, 120);
                result[mode] = query('.cm-content').textContent.includes('为多栏科学');
            }
            if (!result.translated || !result.compare || result.original) {
                throw new Error(`Unexpected text per view: ${JSON.stringify(result)}`);
            }
            return result;
        }],
        ['document-search', async () => {
            const toggle = query('.markdown-document-search-toggle');
            if (!toggle) throw new Error('Search toggle is missing');
            toggle.click();
            const input = await waitFor(window, () => {
                const node = query('.markdown-document-search-input');
                return node && node.getBoundingClientRect().width > 0 ? node : null;
            });
            if (!input) throw new Error('Search input did not open');
            input.value = 'column';
            input.dispatchEvent(new window.Event('input', { bubbles: true }));
            const count = await waitFor(window, () => {
                const text = query('.markdown-document-search-count')?.textContent || '';
                return /[1-9]/.test(text) ? text : null;
            });
            if (!count) throw new Error('Search found nothing');
            const matches = queryAll('.cm-mktero-search-match').length;
            input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { count, visibleMatches: matches };
        }],
        ['source-peek', async () => {
            await scrollTo('## 3. Experiments');
            const image = await waitFor(window, () => {
                const node = query('.markdown-source-peek-image');
                return node?.getAttribute('src')?.startsWith('data:image/') && !query('.markdown-source-peek').hidden
                    ? node : null;
            }, { timeout: 3000 });
            if (!image) throw new Error('Source peek did not show a page image');
            return { caption: query('.markdown-source-peek-caption').textContent };
        }],
        ['open-in-pdf', async () => {
            query('.markdown-source-peek').click();
            const opened = await waitFor(window, () => shell.activeTab === 'pdf'
                && window.document.querySelector('.pdf-location-flash'));
            if (!opened) throw new Error('PDF tab did not open at the source');
            const canvas = window.document.querySelector('.pdf-page-canvas');
            if (!canvas.width) throw new Error('PDF page canvas is empty');
            shell.activate('reader');
            await delay(window, 200);
            const box = query('.cm-content').getBoundingClientRect();
            if (box.width < 200) throw new Error('Reader lost its layout after switching tabs');
            return { canvasWidth: canvas.width };
        }],
        ['correction', async () => {
            const current = model();
            current.onSetCorrectionMode(true);
            await delay(window, 120);
            if (!model().correctionMode) throw new Error('Correction mode did not turn on');
            const block = current.editableBlocks.find(entry => entry.markdown.startsWith('A small pairwise model'));
            if (!block) throw new Error('Conclusion is not an editable block');
            await view.commitCorrection({
                blockID: block.id,
                replacementMarkdown: block.markdown.replace('accurately', 'reliably'),
            });
            await scrollTo('reliably at a cost');
            const marker = await waitFor(window, () => query('.cm-mktero-correction-marker'));
            if (!marker) throw new Error('Corrected block has no marker');
            const matched = model().annotationOverlay.matched.length;
            // The view's own restore button asks for confirmation first.
            await model().onRestoreAllCorrections();
            await delay(window, 150);
            model().onSetCorrectionMode(false);
            await delay(window, 120);
            if (model().markdown !== markdown) throw new Error('Restore did not return the original Markdown');
            return { markerShown: true, annotationsAfterCorrection: matched };
        }],
    ];

    return async function selfTest({ only = null } = {}) {
        const results = [];
        for (const [name, run] of checks) {
            if (only && !only.includes(name)) continue;
            const started = Date.now();
            try {
                const detail = await Promise.race([
                    run(),
                    delay(window, 8000).then(() => {
                        throw new Error('Timed out');
                    }),
                ]);
                results.push({ name, passed: true, ms: Date.now() - started, detail });
            }
            catch (error) {
                results.push({ name, passed: false, ms: Date.now() - started, error: error.message });
            }
        }
        view.editor.scrollToOffset(0);
        return {
            userAgent: window.navigator.userAgent,
            passed: results.every(result => result.passed) && capture.errors.length === 0,
            results,
            errors: [...capture.errors],
            warnings: [...capture.warnings],
        };
    };
}

export function renderDiagnosticsPanel(document, report) {
    const panel = document.createElement('aside');
    panel.className = 'preview-diagnostics';
    const title = document.createElement('strong');
    title.textContent = report.passed ? 'Preview checks passed' : 'Preview checks failed';
    panel.appendChild(title);
    const list = document.createElement('ul');
    for (const result of report.results) {
        const item = document.createElement('li');
        item.className = result.passed ? 'is-pass' : 'is-fail';
        item.textContent = `${result.passed ? '✓' : '✗'} ${result.name}${result.passed ? '' : `: ${result.error}`}`;
        list.appendChild(item);
    }
    for (const error of report.errors.slice(0, 6)) {
        const item = document.createElement('li');
        item.className = 'is-fail';
        item.textContent = `${error.kind}: ${error.message.slice(0, 160)}`;
        list.appendChild(item);
    }
    panel.appendChild(list);
    const agent = document.createElement('small');
    agent.textContent = report.userAgent;
    panel.appendChild(agent);
    document.body.appendChild(panel);
}
