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
            if (fixture.kind === 'aligned') {
                if (view === 'translated') {
                    await wait(() => sourceText(), 'source sentence bubble');
                    check(sourceText() === fixture.sentences[1], `Expected only original sentence; got ${sourceText()}`);
                    const locate = root.querySelector('[data-action="locate-source"]');
                    check(locate, 'Source sentence has no locate action');
                    locate.click();
                    await wait(() => viewButton('compare').getAttribute('aria-checked') === 'true', 'locate switching to bilingual view');
                    viewButton('original').click();
                }
                else {
                    await wait(() => marks().length, 'original sentence highlight');
                    check(marks().join('') === fixture.sentences[1], `Expected only original sentence highlight; got ${marks().join('')}`);
                    check(!sourceText(), 'Unexpected source bubble in bilingual view');
                }
                check(!root.querySelector(wholeBlock), 'Verified selection should show the matched sentence');
            }
            else {
                const show = await wait(() => root.querySelector(wholeBlock), 'show entire original block action');
                const controls = [...show.closest('section').querySelectorAll('button')];
                check(controls.length === 1 && controls[0] === show, 'Unaligned selection must offer only the whole-block action');
                check(!sourceText() && !marks().length, 'Unaligned text was incorrectly presented as a matched sentence');
                check(!root.querySelector('[data-action="locate-source"], .mktero-related-source-locate'), 'Unaligned text was given a sentence locate action');
                check(!root.querySelector('[data-action="annotate-source"], .mktero-related-source-create'), 'Unaligned text was given an immediate annotation action');
                show.click();
                if (view === 'translated') {
                    await wait(() => sourceText(), 'explicit original block popup');
                    check(sourceText() === fixture.markdown, `Expected whole original block; got ${sourceText()}`);
                    check(!marks().length, 'Unexpected in-place highlight in translated view');
                }
                else {
                    await wait(() => marks().length, 'explicit original block highlight');
                    check(marks().join('') === fixture.markdown, `Expected whole original block highlight; got ${marks().join('')}`);
                    check(!sourceText(), 'Unexpected source bubble in bilingual view');
                }
            }
            check(!root.querySelector(oldAlignmentActions), 'Obsolete alignment upgrade action was rendered');
            check(Services.io.offline, 'Gecko went online during reader validation');
            report.push({ fixture: fixture.kind, view, passed: true });
        }
        if (fixture.kind === 'aligned') await checkDurableAnnotation();
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

        async function checkDurableAnnotation() {
            await stage('aligned / translated one-click annotation');
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
            const action = await wait(() => root.querySelector('[data-action="annotate-source"]'), 'annotate selected translation button');
            const rect = action.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            check(!action.disabled && action.contains(root.elementFromPoint(x, y)), 'Annotate button is not clickable');
            let clicks = 0;
            action.addEventListener('click', () => clicks++);
            // Dispatch a single Gecko mouse gesture to the UI, including pointer-down dismissal logic.
            win.windowUtils.sendMouseEvent('mousedown', x, y, 0, 1, 0);
            win.windowUtils.sendMouseEvent('mouseup', x, y, 0, 1, 0);
            check(clicks === 1, `Expected one annotate click on the button; got ${clicks}`);

            try {
                await wait(() => rows().length && highlights().length, 'saved highlights on translated text and a sidebar row after one click');
            }
            catch (error) {
                const followUp = root.querySelector(
                    '.mktero-annotation-popup .mktero-related-source-scope, .mktero-annotation-popup .mktero-related-source-create'
                );
                throw new Error(`${error.message}; clicks=${clicks}; sidebarRows=${rows().length}; `
                    + `durableMarks=${highlights().length}; followUpPopup=${Boolean(followUp)}`);
            }
            check(rows().length === 1, 'A single click added more than one sidebar row');
            check(!hasTemporarySelection(), 'The click left a temporary selection over the annotation');

            // Background synchronization can replace a local ID with a PDF key. Sample
            // the settled backing store (either type) before comparing IDs across views.
            const storedPath = PathUtils.join(config.profile, 'mktero-annotations', 'v1', `item-${pdf.id}.json`);
            const persistedRecords = async () => {
                const local = await IOUtils.exists(storedPath) ? (await IOUtils.readJSON(storedPath)).annotations : [];
                await Zotero.Items.loadDataTypes([pdf], ['childItems']);
                const pdfItems = pdf.getAnnotations(false);
                if (pdfItems.length) await Zotero.Items.loadDataTypes(pdfItems, ['annotation', 'annotationDeferred']);
                return [...local.map(({ id, color, text, type }) => ({ id, color, text, type, storage: 'local' })),
                    ...pdfItems.map(item => ({ id: item.key, color: item.annotationColor,
                        text: item.annotationText, type: item.annotationType, storage: 'pdf' }))];
            };
            let stableID;
            let stableSince;
            const saved = await wait(async () => {
                const records = await persistedRecords();
                const id = records.length === 1 && records[0].id === sidebarID() ? records[0].id : null;
                if (id !== stableID) {
                    stableID = id;
                    stableSince = Date.now();
                }
                return id && Date.now() - stableSince >= 500 && records[0];
            }, 'one settled local or PDF annotation matching the sidebar ID');
            const normalize = text => String(text).replace(/\s+/g, ' ').trim();
            check(saved.type === 'highlight' && saved.color?.toLowerCase() === '#ffd400'
                && normalize(saved.text) === fixture.markdown, 'Saved highlight must be yellow and attached to the full original block');

            // Normalize Gecko's computed color-mix() serialization to rendered sRGB.
            const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
            canvas.width = canvas.height = 1;
            const paint = canvas.getContext('2d');
            const views = [];
            for (const view of ['translated', 'original', 'compare', 'translated']) {
                await stage(`aligned / durable annotation in ${view}`);
                await changeView(view);
                check(rows().length === 1 && sidebarID() === saved.id,
                    `${view}: expected one sidebar item with ID ${saved.id}; got ${rows().length} (${sidebarID()})`);
                const nodes = highlights();
                const ids = [...new Set(nodes.map(node => node.getAttribute('data-annotation-id')))];
                check(ids.length === 1 && ids[0] === saved.id, `${view}: expected inline ID ${saved.id}; got ${ids.join(', ')}`);
                const text = normalize(nodes.map(node => node.textContent).join(''));
                const expected = view === 'translated' ? fixture.units.join('') : fixture.markdown;
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
            report.push({ fixture: fixture.kind, check: 'durable-annotation', clicks, storage: saved.storage, views, passed: true });
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
