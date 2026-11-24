// Serialized into the driver XPI. It uses Zotero and DOM APIs, not Mktero source modules.
export async function runSmoke(config) {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const stage = value => IOUtils.writeUTF8(config.stagePath, value, { tmpPath: config.stagePath + '.tmp' });
    Services.io.offline = true;
    await stage('initializing isolated Zotero');
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    check(Zotero.Profile.dir === config.profile, 'Unexpected Zotero profile');
    check(Zotero.DataDirectory.dir === config.data, 'Unexpected Zotero data directory');
    check(Services.io.offline, 'Gecko offline mode is inactive');
    const libraryID = Zotero.Libraries.userLibraryID;
    check((await Zotero.Items.getAll(libraryID, false, true, true)).length === 0, 'Expected an empty library');
    const baseReport = { zoteroVersion: Zotero.version, isolatedProfile: true, emptyLibrary: true, geckoOffline: true };
    if (!config.product) return { mode: 'isolated-zotero-preflight-only', ...baseReport };

    const win = Zotero.getMainWindow();
    const doc = win.document;
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const wait = async (fn, label) => {
        const deadline = Date.now() + 8000;
        do {
            const value = await fn();
            if (value) return value;
            await new Promise(resolve => win.setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw new Error(`Timed out waiting for ${label}`);
    };
    await stage('verifying installed product XPI');
    const addon = await AddonManager.getAddonByID(config.product.id);
    check(addon?.isActive && addon.version === config.product.version, 'Product XPI was not active');
    const uri = Services.io.newFileURI(Zotero.File.pathToFile(config.product.xpiPath)).spec;
    check(addon.getResourceURI('bootstrap.js').spec === `jar:${uri}!/bootstrap.js`, 'Product runtime did not come from the staged XPI');
    const menu = await wait(() => doc.getElementById('mktero-read-as-markdown'), 'product item menu');
    const report = [];
    for (const fixture of config.fixtures) {
        await stage(`opening ${fixture.kind} synthetic PDF via product menu`);
        const pdf = await Zotero.Attachments.importFromFile({ file: fixture.pdfPath, libraryID });
        await wait(() => win.ZoteroPane.collectionsView, 'Zotero collections tree');
        await win.ZoteroPane.selectItem(pdf.id, { inLibraryRoot: true });
        check(win.ZoteroPane.getSelectedItems().map(item => item.id).join() === String(pdf.id), 'Synthetic PDF not selected');
        menu.parentNode.dispatchEvent(new win.Event('popupshowing', { bubbles: true }));
        check(!menu.hidden, 'Product menu unavailable for synthetic PDF');
        const previousTab = win.Zotero_Tabs.selectedID;
        menu.dispatchEvent(new win.Event('command', { bubbles: true }));
        const root = await wait(() => [...doc.querySelectorAll('.mktero-tab-host')].map(host => host.shadowRoot)
            .find(shadow => shadow?.querySelector('.cm-content')?.textContent.includes(fixture.markdown)), 'original Markdown');
        const tab = win.Zotero_Tabs.selectedID;
        check(tab && tab !== previousTab, 'Product tab did not open');
        const viewButton = name => root.querySelector(`[data-translation-view="${name}"]`);
        const selection = () => root.getSelection?.() || doc.getSelection();
        const sourceText = () => root.querySelector('.mktero-translation-source-text')?.textContent;
        const marks = () => [...root.querySelectorAll('.cm-mktero-translation-pair-selected-text')].map(node => node.textContent);
        const excerpt = fixture.units[1].slice(1, -2);
        for (const view of ['translated', 'compare']) {
            await stage(`${fixture.kind} / ${view}`);
            selection().removeAllRanges();
            await changeView(view);
            await selectExcerpt();
            const wholeBlock = '[data-action="show-source-block"]';
            const oldAlignmentActions = '[data-action="enable-alignment"], [data-action="cancel-alignment"]';
            const review = '[data-action="review-source-annotation"]';
            const preview = await wait(() => root.querySelector('[data-action="preview-source"]'), 'selection toolbar');
            check(!sourceText() && !root.querySelector('[data-action="annotate-source"]'), 'Selection prematurely opened review');
            if (fixture.kind !== 'unaligned') {
                check(root.querySelector(review), 'Verified selection lacks Highlight original text');
                preview.click();
                check(sourceText() === fixture.sentences[1], 'Preview did not show the selected original sentence');
                if (view === 'translated') {
                    root.querySelector('[data-action="locate-source"]').click();
                    await wait(() => viewButton('original').getAttribute('aria-checked') === 'true', 'locate original view');
                }
                else check(marks().join('') === fixture.sentences[1], 'Incorrect bilingual source marks');
                check(!root.querySelector(wholeBlock), 'Unexpected whole-block fallback for a verified sentence');
            }
            else {
                check(!root.querySelector(review), 'Unverified source offered a sentence highlight');
                preview.click();
                const show = await wait(() => root.querySelector(wholeBlock), 'show whole block');
                check(!marks().length && !sourceText(), 'Unaligned text was presented as a matched sentence');
                show.click();
                check(sourceText() === fixture.markdown, 'Explicit preview did not show the whole block');
                if (view === 'compare') check(marks().join('') === fixture.markdown, 'Missing bilingual block highlight');
                check(!root.querySelector('[data-action="annotate-source"]'), 'Viewing the block included it in the highlight');
                root.querySelector('[data-action="include-source-block"]').click();
                check(root.querySelector('[data-action="annotate-source"]'), 'Included block cannot be confirmed');
            }
            check(!root.querySelector(oldAlignmentActions), 'Obsolete alignment upgrade action was rendered');
            check(Services.io.offline, 'Gecko went online during reader validation');
            report.push({ fixture: fixture.kind, view, passed: true });
        }
        if (fixture.kind !== 'unaligned') await checkDurableAnnotation();
        win.Zotero_Tabs.close(tab);
        await wait(() => !root.host.isConnected, 'reader tab cleanup');

        async function changeView(view) {
            const button = await wait(() => {
                const candidate = viewButton(view);
                return candidate && !candidate.disabled && candidate;
            }, `${view} view button`);
            if (button.getAttribute('aria-checked') === 'true') return;
            button.click();
            if (view === 'translated' && button.getAttribute('aria-haspopup') === 'menu') {
                const language = await wait(() => root.querySelector('[data-translation-language="zh-CN"]'),
                    'cached translation language');
                language.click();
            }
            await wait(() => viewButton(view)?.getAttribute('aria-checked') === 'true', `${view} mode`);
        }

        async function selectExcerpt() {
            const node = await wait(() => findTextNode(root.querySelector('.cm-content'), excerpt), 'rendered translated text');
            const range = doc.createRange();
            const from = node.textContent.indexOf(excerpt);
            range.setStart(node, from);
            range.setEnd(node, from + excerpt.length);
            selection().removeAllRanges();
            selection().addRange(range);
            check(selection().toString() === excerpt, 'Could not select translated excerpt');
            node.parentElement.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, composed: true, button: 0 }));
        }

        function mouseClick(button) {
            const rect = button.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            check(!button.disabled && button.contains(root.elementFromPoint(x, y)), 'Button is obscured or disabled');
            let clicks = 0;
            button.addEventListener('click', () => clicks++, { once: true });
            win.windowUtils.sendMouseEvent('mousedown', x, y, 0, 1, 0);
            win.windowUtils.sendMouseEvent('mouseup', x, y, 0, 1, 0);
            check(clicks === 1, 'The Gecko mouse gesture missed the button');
        }

        async function checkDurableAnnotation() {
            const ambiguous = fixture.kind === 'ambiguous';
            await stage(`${fixture.kind} / review and confirm`);
            selection().removeAllRanges();
            await changeView('translated');
            const sidebar = root.querySelector('#mktero-annotations');
            const sidebarTab = root.querySelector('#mktero-outline-segment-annotations');
            const sidebarToggle = root.querySelector('#mktero-outline-toggle');
            if (sidebarToggle.getAttribute('aria-expanded') === 'false') sidebarToggle.click();
            sidebarTab.click();
            await wait(() => sidebarTab.getAttribute('aria-selected') === 'true' && sidebar.getClientRects().length,
                'visible Annotations sidebar');
            const rows = () => [...sidebar.querySelectorAll('.markdown-note-item')];
            const highlights = () => [...root.querySelectorAll('.cm-content .cm-mktero-pdf-annotation--highlight')]
                .filter(node => node.getClientRects().length);
            const sidebarID = () => rows()[0]?.querySelector('.markdown-note-link')?.getAttribute('data-annotation-id');
            const hasTemporarySelection = () => Boolean(selection().toString() || marks().length
                || root.querySelector('.cm-mktero-selection-retained'));
            check(!rows().length && !highlights().length, 'Synthetic document already shows annotations');

            await selectExcerpt();
            const review = await wait(() => root.querySelector('[data-action="review-source-annotation"]'), 'highlight original text');
            mouseClick(review);
            const scope = root.querySelector('.mktero-translation-annotation-details[open] .mktero-translation-annotation-text');
            check(scope?.textContent === fixture.sentences[1] && !rows().length, 'Review must show the exact sentence before saving');
            mouseClick(root.querySelector('[data-action="annotate-source"]'));
            await wait(() => rows().length === 1 && highlights().length, 'one durable highlight and sidebar row');
            check(!hasTemporarySelection(), 'Confirmation left a temporary selection over the highlight');

            const storedPath = PathUtils.join(config.profile, 'mktero-annotations', 'v1', `item-${pdf.id}.json`);
            const persistedRecords = async () => {
                const local = await IOUtils.exists(storedPath) ? (await IOUtils.readJSON(storedPath)).annotations : [];
                await Zotero.Items.loadDataTypes([pdf], ['childItems']);
                const pdfItems = pdf.getAnnotations(false);
                if (pdfItems.length) await Zotero.Items.loadDataTypes(pdfItems, ['annotation', 'annotationDeferred']);
                return [...local.map(({ id, color, text, type, ranges }) => ({ id, color, text, type, ranges, storage: 'local' })),
                    ...pdfItems.map(item => ({ id: item.key, color: item.annotationColor, text: item.annotationText,
                        type: item.annotationType, storage: 'pdf', position: JSON.parse(item.annotationPosition) }))];
            };
            const status = root.querySelector('.markdown-reader-action-status');
            const saved = await wait(async () => {
                const records = await persistedRecords();
                if (records.length !== 1 || records[0].id !== sidebarID()) return false;
                const record = records[0];
                if (ambiguous) return record.storage === 'local' && sidebar.querySelector('.markdown-note-sync-retry') && record;
                return record.storage === 'pdf' && record;
            }, ambiguous ? 'local-only annotation with retry' : 'Zotero PDF highlight with matching sidebar ID');
            const normalize = text => String(text).replace(/\s+/g, ' ').trim();
            check(saved.type === 'highlight' && saved.color?.toLowerCase() === '#ffd400'
                && normalize(saved.text) === fixture.sentences[1], 'Stored highlight differs from the reviewed sentence');
            if (ambiguous) {
                const from = fixture.markdown.indexOf(fixture.sentences[1]);
                check(saved.ranges?.length === 1 && saved.ranges[0].from === from && saved.ranges[0].to === fixture.markdown.length,
                    'Local annotation lost its original range');
                check(/multiple|多处/i.test(sidebar.querySelector('.markdown-note-sync--failed').textContent),
                    'Sidebar did not identify the ambiguous match');
                check(!status.hidden && /retry|重试/i.test(status.textContent), 'Local-only outcome missing');
            }
            else {
                const { pageIndex, rects } = saved.position;
                check(pageIndex === 0 && rects?.length === 1, 'Expected one rectangle on the first PDF page');
                const [left, bottom, right, top] = rects[0];
                check(Math.abs(left - 40) < 2 && bottom <= 95 && bottom >= 88 && top >= 99 && top <= 110
                    && right > 140 && right < 180, `PDF rectangle misses the reviewed sentence: ${rects[0]}`);
                check(!status.hidden && /Zotero PDF/.test(status.textContent), 'Confirmed PDF outcome missing');
            }

            // Sample the actual status in a narrow reader with both sidebars hidden.
            root.querySelector('#mktero-focus-toggle').click();
            const pane = root.querySelector('.mktero-tab-view');
            pane.style.maxWidth = '380px';
            const box = status.getBoundingClientRect();
            const bounds = pane.getBoundingClientRect();
            check(pane.classList.contains('is-focus-mode') && bounds.width <= 380 && box.width > 0
                && box.left >= bounds.left && box.right <= bounds.right && box.bottom <= bounds.bottom
                && status.scrollWidth <= status.clientWidth + 1 && status.scrollHeight <= status.clientHeight + 1,
                'Annotation feedback is clipped or hidden in narrow focus mode');
            pane.style.removeProperty('max-width');
            root.querySelector('.markdown-focus-exit').click();

            // Normalize Gecko's computed color-mix() serialization to rendered sRGB.
            const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
            canvas.width = canvas.height = 1;
            const paint = canvas.getContext('2d');
            const views = [];
            for (const view of ['translated', 'original', 'compare', 'translated']) {
                await stage(`${fixture.kind} / durable annotation in ${view}`);
                await changeView(view);
                check(rows().length === 1 && sidebarID() === saved.id,
                    `${view}: expected one sidebar item with ID ${saved.id}; got ${rows().length} (${sidebarID()})`);
                const nodes = highlights();
                const ids = [...new Set(nodes.map(node => node.getAttribute('data-annotation-id')))];
                check(ids.length === 1 && ids[0] === saved.id, `${view}: expected inline ID ${saved.id}; got ${ids.join(', ')}`);
                const text = normalize(nodes.map(node => node.textContent).join(''));
                const expected = view === 'translated' ? fixture.units[1] : fixture.sentences[1];
                check(text === expected, `${view}: expected highlighted text ${JSON.stringify(expected)}; got ${JSON.stringify(text)}`);
                check(!hasTemporarySelection(), `${view}: temporary selection still visible`);
                const fills = [...new Set(nodes.map(node => win.getComputedStyle(node).backgroundColor))];
                for (const fill of fills) {
                    paint.clearRect(0, 0, 1, 1);
                    paint.fillStyle = 'transparent';
                    paint.fillStyle = fill;
                    paint.fillRect(0, 0, 1, 1);
                    const [red, green, blue, alpha] = paint.getImageData(0, 0, 1, 1).data;
                    check(red >= 245 && green >= 185 && green <= 230 && blue <= 15 && alpha > 0,
                        `${view}: highlight has no painted yellow background (${fill})`);
                }
                views.push({ view, inlineID: ids[0], sidebarID: sidebarID(), sidebarCount: rows().length,
                    fills, temporarySelection: false });
            }
            const records = await persistedRecords();
            check(records.length === 1 && records[0].id === saved.id, 'View changes did not preserve a single persisted record');
            check(Services.io.offline, 'Gecko went online during annotation validation');
            report.push({ fixture: fixture.kind, check: 'durable-annotation', storage: saved.storage, position: saved.position, views, passed: true });
        }
    }
    return { mode: 'installed-product-xpi', ...baseReport,
        productVersion: addon.version, xpiSHA256: config.product.sha256, checks: report };

    function findTextNode(content, text) {
        if (!content) return null;
        const walker = doc.createTreeWalker(content, win.NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
            if (node.textContent.includes(text)) return node;
        }
        return null;
    }
}
