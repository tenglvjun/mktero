// Serialized into the helper XPI; inspect only the already verified isolated
// profile. Convert native error objects to strings without structured cloning.
export async function collectDiagnostics(config) {
    if (Zotero.Profile.dir !== config.profile || Zotero.DataDirectory.dir !== config.data) {
        throw new Error('Refusing diagnostics outside the isolated profile/data directory');
    }
    const result = { zoteroVersion: Zotero.version, profile: Zotero.Profile.dir,
        data: Zotero.DataDirectory.dir, offline: Services.io.offline };
    const describe = value => {
        const entry = { text: String(value) };
        for (const key of ['name', 'message', 'stack', 'errorMessage', 'sourceName',
            'lineNumber', 'columnNumber', 'category', 'flags', 'timeStamp']) {
            try {
                if (value?.[key] !== undefined) entry[key] = String(value[key]);
            }
            catch (error) { entry[key] = `Unavailable: ${String(error)}`; }
        }
        return entry;
    };
    const collect = async (key, fn) => {
        try { result[key] = await fn(); }
        catch (error) { result[key] = { collectionError: describe(error) }; }
    };
    await collect('zoteroErrors', () => Array.from(Zotero.getErrors(true), describe));
    await collect('consoleMessages', () => Array.from(Services.console.getMessageArray()).slice(-100).map(describe));
    await collect('windows', () => {
        const main = Zotero.getMainWindow();
        return Array.from(Services.wm.getEnumerator(null), win => {
            const describeNode = node => {
                const rect = node.getBoundingClientRect();
                const style = win.getComputedStyle(node);
                return { name: node.localName, id: node.id,
                    attributes: Object.fromEntries(Array.from(node.attributes, attribute => [attribute.name, attribute.value])),
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    style: { display: style.display, visibility: style.visibility },
                };
            };
            const rail = win.document.getElementById('zotero-context-pane-sidenav');
            const railAncestors = [];
            for (let node = rail; node; node = node.parentElement) railAncestors.push(describeNode(node));
            return {
                isMainWindow: win === main, closed: win.closed, href: String(win.location.href),
                readyState: win.document.readyState,
                windowType: win.document.documentElement.getAttribute('windowtype'),
                hasZoteroPane: Boolean(win.ZoteroPane), hasTabs: Boolean(win.Zotero_Tabs),
                hasContextPane: Boolean(win.ZoteroContextPane),
                selectedID: win.Zotero_Tabs?.selectedID || null,
                productMenu: Boolean(win.document.getElementById('mktero-read-as-markdown')),
                itemPopup: Boolean(win.document.getElementById('zotero-itemmenu')),
                productElementIDs: Array.from(win.document.querySelectorAll('[id^="mktero-"]'), node => node.id),
                railAncestors,
                railButtons: Array.from(rail?.querySelectorAll('[data-pane], [data-action]') || [], describeNode),
                contextPaneNodes: ['zotero-context-pane', 'zotero-context-pane-inner', 'zotero-context-pane-sidenav']
                    .map(id => win.document.getElementById(id)).filter(Boolean).map(describeNode),
            };
        });
    });
    await collect('addons', async () => {
        const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        return (await AddonManager.getAllAddons()).map(addon => ({
            id: addon.id, version: addon.version, isActive: addon.isActive,
            userDisabled: addon.userDisabled, appDisabled: addon.appDisabled,
            bootstrapURI: addon.getResourceURI('bootstrap.js').spec,
        }));
    });
    await collect('debugLog', async () => typeof Zotero.Debug?.get === 'function'
        ? String(await Zotero.Debug.get()).slice(-100000) : null);
    return result;
}

// Query scopes may be ordinary elements; hit testing belongs to their DOM root.
// Serialize this helper alongside runSmoke into the isolated driver XPI.
export async function clickControl(queryScope, selector, label, { wait, visible, check, window }) {
    const node = await wait(() => {
        const candidate = queryScope.querySelector(selector);
        return visible(candidate) && !candidate.disabled
            && candidate.getAttribute('disabled') !== 'true'
            && candidate.getAttribute('aria-disabled') !== 'true' && candidate;
    }, `enabled visible ${label}`);
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = node.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const domRoot = node.getRootNode();
    const hitRoot = typeof domRoot.elementFromPoint === 'function' ? domRoot : node.ownerDocument;
    const hit = hitRoot.elementFromPoint(x, y);
    check(hit && (hit === node || node.contains(hit)), `${label} is covered or not clickable`);
    let clicks = 0;
    const record = event => {
        if (event.composedPath().includes(node)) clicks++;
    };
    // A product capture listener may stop the event before it reaches the
    // button. Observe it first, retaining the composed path for shadow DOM.
    domRoot.addEventListener('click', record, true);
    try {
        window.windowUtils.sendMouseEvent('mousedown', x, y, 0, 1, 0);
        window.windowUtils.sendMouseEvent('mouseup', x, y, 0, 1, 0);
        check(clicks === 1, `Expected one native click on ${label}; received ${clicks}`);
    }
    finally { domRoot.removeEventListener('click', record, true); }
    return node;
}

// Serialized into the helper XPI together with clickControl; exercise the
// installed product and native chrome through their real controls.
export async function runSmoke(config, clickControl) {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const writeJSON = (file, value) => IOUtils.writeUTF8(file, JSON.stringify(value, null, 2), { tmpPath: file + '.tmp' });
    let latestStage = '';
    const stage = value => {
        latestStage = value;
        return IOUtils.writeUTF8(config.stagePath, value, { tmpPath: config.stagePath + '.tmp' });
    };
    await stage('initializing isolated sidebar validation');
    Services.io.offline = true;
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    check(Zotero.Profile.dir === config.profile, 'Unexpected Zotero profile');
    check(Zotero.DataDirectory.dir === config.data, 'Unexpected Zotero data directory');
    check(Services.io.offline, 'Gecko offline mode is inactive');
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const tabs = win.Zotero_Tabs;
    const controller = win.ZoteroContextPane;
    const libraryID = Zotero.Libraries.userLibraryID;
    const pause = ms => new Promise(resolve => win.setTimeout(resolve, ms));
    const wait = async (fn, label, timeout = 10000) => {
        const deadline = Date.now() + timeout;
        do {
            const value = await fn();
            if (value) return value;
            await pause(50);
        } while (Date.now() < deadline);
        throw new Error(`Timed out waiting for ${label}`);
    };
    const evidence = [];
    const screenshots = [];
    const hookCalls = [];
    const readers = [];
    let sectionID;
    let addon;
    let state;
    const initialContextTypes = JSON.stringify(tabs._hasContextPaneTypes);
    const initialHostLayout = Zotero.Prefs.get('layout');
    const hostLayoutRestoration = { original: initialHostLayout, restored: null, passed: false };
    const notePref = () => Zotero.Prefs.get('extensions.mktero.readerNotesVisible', true);
    const selectedTab = () => tabs._getTab(tabs.selectedID).tab;
    const nativeContext = reader => controller.context._getItemContext(reader.tab);
    const sidenav = () => doc.getElementById('zotero-context-pane-sidenav');
    const nativeVisible = () => !controller.collapsed && visible(doc.getElementById('zotero-context-pane-inner'));
    const nativeTrace = [];
    const nativeTraceRestorers = [];
    const traceNative = (operation, detail = {}) => {
        nativeTrace.push({ time: Date.now(), stage: latestStage, selectedID: tabs.selectedID,
            selectedType: tabs.selectedType, collapsed: controller.collapsed,
            outerCollapsed: doc.getElementById('zotero-context-pane')?.getAttribute('collapsed'),
            innerCollapsed: doc.getElementById('zotero-context-pane-inner')?.getAttribute('collapsed'),
            markers: ['mktero-context-pane-pending', 'mktero-context-pane-focus']
                .filter(name => doc.documentElement.hasAttribute(name)),
            operation, ...detail, stack: new Error('Native context-pane write').stack });
    };
    // The native pane helpers write attributes directly, bypassing the
    // controller setter/update method. Capture the caller synchronously.
    for (const [id, attribute] of [
        ['zotero-context-pane', 'collapsed'], ['zotero-context-pane-inner', 'collapsed'],
        ['zotero-context-splitter', 'state'], ['zotero-context-splitter-stacked', 'state'],
    ]) {
        const node = doc.getElementById(id);
        if (!node) continue;
        for (const method of ['setAttribute', 'removeAttribute']) {
            const descriptor = Object.getOwnPropertyDescriptor(node, method);
            const original = node[method];
            const wrapper = function (name, ...args) {
                if (name === attribute) traceNative(method, {
                    nodeID: id, attribute: name, previous: this.getAttribute(name),
                    value: method === 'setAttribute' ? String(args[0]) : null,
                });
                return original.call(this, name, ...args);
            };
            Object.defineProperty(node, method, { configurable: true, writable: true, value: wrapper });
            nativeTraceRestorers.push(() => {
                if (node[method] !== wrapper) return;
                if (descriptor) Object.defineProperty(node, method, descriptor);
                else delete node[method];
            });
        }
    }
    const collapsedDescriptor = Object.getOwnPropertyDescriptor(controller, 'collapsed');
    if (collapsedDescriptor?.configurable && collapsedDescriptor.set) {
        const setter = function (value) {
            traceNative('controller.collapsed', { value: Boolean(value) });
            return collapsedDescriptor.set.call(this, value);
        };
        Object.defineProperty(controller, 'collapsed', { ...collapsedDescriptor, set: setter });
        nativeTraceRestorers.push(() => {
            if (Object.getOwnPropertyDescriptor(controller, 'collapsed')?.set === setter) {
                Object.defineProperty(controller, 'collapsed', collapsedDescriptor);
            }
        });
    }
    else nativeTrace.push({ operation: 'controller-setter-not-configurable', tracedAttributes: true });
    const originalUpdate = controller.update;
    const tracedUpdate = function (...args) {
        traceNative('controller.update');
        return originalUpdate.apply(this, args);
    };
    controller.update = tracedUpdate;
    try {
        await stage('verifying final product XPI and empty isolated library');
        check((await Zotero.Items.getAll(libraryID, false, true, false)).length === 0,
            'Expected an empty isolated library');
        const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        addon = await AddonManager.getAddonByID(config.product.id);
        check(addon?.isActive && addon.version === config.product.version, 'Product XPI was not active');
        const uri = Services.io.newFileURI(Zotero.File.pathToFile(config.product.xpiPath)).spec;
        check(addon.getResourceURI('bootstrap.js').spec === `jar:${uri}!/bootstrap.js`,
            'Product runtime did not come from the staged final XPI');
        const menu = await wait(() => doc.getElementById('mktero-read-as-markdown'), 'product item menu');
        await wait(() => win.ZoteroPane.collectionsView?.itemTreeView && win.ZoteroPane.itemsView,
            'native item and collection trees');
        await win.ZoteroPane.collectionsView.waitForLoad();
        await win.ZoteroPane.itemsView.waitForLoad();
        win.resizeTo(1500, 1000);
        win.focus();
        Zotero.Prefs.set('layout', 'standard');
        win.ZoteroPane.updateLayout();

        await stage('creating two parent articles, synthetic PDFs and an ordinary standalone note');
        state = { schemaVersion: 1, profile: config.profile, data: config.data,
            productSHA256: config.product.sha256, libraryID, pdfs: [] };
        const note = new Zotero.Item('note');
        note.libraryID = libraryID;
        note.setNote(`<h1>${config.fixtures.note.title}</h1><p>${config.fixtures.note.seed}</p>`);
        await note.saveTx();
        state.note = { id: note.id, key: note.key, ...config.fixtures.note };
        for (const fixture of config.fixtures.pdfs) {
            const parent = new Zotero.Item('journalArticle');
            parent.libraryID = libraryID;
            parent.setField('title', `Sidebar fixture ${fixture.label}: ordinary article`);
            await parent.saveTx();
            const pdf = await Zotero.Attachments.importFromFile({
                file: fixture.pdfPath, libraryID, parentItemID: parent.id,
            });
            check(pdf.parentID === parent.id && pdf.isPDFAttachment(), 'Synthetic PDF has the wrong parent');
            check((await pdf.getFilePathAsync()).startsWith(config.data + '/'), 'PDF escaped isolated storage');
            state.pdfs.push({ ...fixture, id: pdf.id, key: pdf.key,
                parentID: parent.id, parentTitle: parent.getField('title') });
        }
        check(state.pdfs.length === 2 && state.pdfs[0].parentID !== state.pdfs[1].parentID,
            'Two different parent articles are required');
        check(!note.parentID && note.isNote(), 'Fixture note must be an ordinary standalone note');
        await writeJSON(config.statePath, state);

        await stage('registering an isolated generic plugin section for custom tabs');
        const icon = 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M3 3h14v14H3zM6 7h8M6 10h8M6 13h5" fill="none" stroke="currentColor"/></svg>');
        sectionID = Zotero.ItemPaneManager.registerSection({
            paneID: 'sidebar-smoke', pluginID: config.helperID,
            // Reuse an existing host localization entry; the fixture owns no
            // product copy and installs no localization or network provider.
            header: { l10nID: 'sidenav-info', icon },
            sidenav: { l10nID: 'sidenav-info', icon },
            onItemChange: ({ item, tabType, setEnabled }) => {
                setEnabled(tabType === 'mktero' && item?.isRegularItem());
            },
            onRender: ({ doc: owner, body, item, tabType }) => {
                const content = owner.createElementNS('http://www.w3.org/1999/xhtml', 'p');
                content.className = 'sidebar-smoke-evidence';
                content.dataset.itemId = String(item.id);
                content.dataset.tabType = tabType;
                content.textContent = `Synthetic section: ${item.getField('title')}`;
                body.replaceChildren(content);
                hookCalls.push({ itemID: item.id, tabType });
            },
        });
        check(typeof sectionID === 'string' && sectionID, 'Generic registerSection fixture was rejected');

        const a = await openPDF(state.pdfs[0], menu);
        await step('default-M-native-icons-visible', a, async () => {
            await layout(a, { notes: true, native: false });
            await wait(() => visible(sidenav()), 'native icon rail on a Mktero tab');
            await wait(() => visible(sidenav().querySelector('[data-pane="info"]')), 'native information icon');
            check(tabs.selectedType === 'mktero' && selectedTab().type === 'mktero', 'Product tab was disguised as reader');
            check(JSON.stringify(tabs._hasContextPaneTypes) === initialContextTypes
                && !tabs._hasContextPaneTypes?.includes('mktero'),
            'Product changed global context-pane tab eligibility');
        });
        await step('mount-ordinary-note-through-product-controls', a, async () => {
            await click(a.root, '[data-note-scope="standalone"]', 'Standalone notes tab');
            await click(a.root, `.mktero-zotero-note-link[data-note-id="${note.id}"]`, 'Ordinary fixture note');
            const mounted = await editor(a);
            a.noteEditor = mounted.node;
            a.editorFrame = mounted.frame;
            a.noteText = mounted.surface.textContent;
            check(a.noteText.includes(state.note.seed), 'Native editor lost the ordinary note seed');
            mounted.surface.focus();
            const selection = mounted.surface.ownerDocument.getSelection();
            selection.selectAllChildren(mounted.surface);
            selection.collapseToEnd();
        });
        await capture('A-mktero-note');
        await step('M-to-ZR-native-current-article-and-editor-retained', a, async () => {
            const pref = notePref();
            await openNative(a, 'info');
            await layout(a, { notes: false, native: true });
            check(notePref() === pref, 'Temporary native expansion changed the notes preference');
            preservedEditor(a);
        });
        await step('native-section-switch-preserves-recovery-intent', a, async () => {
            await openNative(a, sectionID);
            const content = await wait(() => nativeContext(a)?.querySelector('.sidebar-smoke-evidence'),
                'rendered generic plugin fixture');
            check(content.dataset.itemId === String(a.fixture.parentID) && content.dataset.tabType === 'mktero',
                'Generic section received the wrong parent article or tab type');
            await layout(a, { notes: false, native: true });
            await capture('A-native-plugin-section');
            await closeNative(a);
            await layout(a, { notes: true, native: false });
            preservedEditor(a);
        });
        await capture('A-restored-mktero-note');
        await step('N-to-Z-to-N-does-not-open-previously-closed-notes', a, async () => {
            await toggleNotes(a);
            await layout(a, { notes: false, native: false });
            const pref = notePref();
            check(pref === false, 'An explicit notes close did not update the preference');
            await openNative(a, sectionID);
            await layout(a, { notes: false, native: true });
            await closeNative(a);
            await layout(a, { notes: false, native: false });
            check(notePref() === pref, 'Native close changed a closed-notes preference');
            preservedEditor(a);
        });
        await step('native-to-explicit-M-to-N-does-not-reopen-native', a, async () => {
            await openNative(a, 'info');
            await layout(a, { notes: false, native: true });
            await toggleNotes(a);
            await layout(a, { notes: true, native: false });
            preservedEditor(a);
            await toggleNotes(a);
            await layout(a, { notes: false, native: false });
            await pause(250);
            check(controller.collapsed, 'Closing explicitly selected notes reopened the native pane');
        });

        await stage('preparing independent sidebar states in articles A and B');
        await toggleNotes(a);
        await openNative(a, sectionID);
        await layout(a, { notes: false, native: true });
        const b = await openPDF(state.pdfs[1], menu);
        await step('new-B-starts-M-with-its-own-article', b, async () => {
            await layout(b, { notes: true, native: false });
            check(nativeContext(b).item.id === b.fixture.parentID, 'B sidebar still points at article A');
            await toggleNotes(b);
            await openNative(b, 'info');
            await layout(b, { notes: false, native: true });
        });
        await step('A-restores-ZR-with-A-context', a, async () => {
            await select(a);
            await layout(a, { notes: false, native: true });
            check(nativeContext(a).item.id === a.fixture.parentID, 'Returning to A selected another article');
            await closeNative(a);
            await layout(a, { notes: true, native: false });
            preservedEditor(a);
        });
        await step('B-restores-Z-and-closes-to-N', b, async () => {
            await select(b);
            await layout(b, { notes: false, native: true });
            check(nativeContext(b).item.id === b.fixture.parentID, 'Returning to B selected another article');
            await closeNative(b);
            await layout(b, { notes: false, native: false });
        });

        await select(a);
        await step('focus-suspends-ZR-without-consuming-native-or-notes-intent', a, async () => {
            await layout(a, { notes: true, native: false });
            await openNative(a, sectionID);
            const pref = notePref();
            await click(a.root, '#mktero-focus-toggle', 'Enter focus mode');
            await layout(a, { notes: false, native: false, focus: true });
            check(!visible(sidenav()), 'Native icon rail remains visible in focus mode');
            check(notePref() === pref, 'Entering focus changed the notes preference');
            preservedEditor(a);
            await capture('A-focus-suspends-native');
            await click(a.root, '#mktero-focus-exit', 'Exit focus mode');
            await layout(a, { notes: false, native: true, focus: false });
            check(visible(sidenav()), 'Native icon rail did not return after focus mode');
            await closeNative(a);
            await layout(a, { notes: true, native: false });
            check(notePref() === pref, 'Restoring focus/native state changed the notes preference');
            preservedEditor(a);
        });
        await step('focus-restores-M-without-opening-native', a, async () => {
            await click(a.root, '#mktero-focus-toggle', 'Enter focus mode with notes');
            await layout(a, { notes: false, native: false, focus: true });
            await click(a.root, '#mktero-focus-exit', 'Exit focus mode with notes');
            await layout(a, { notes: true, native: false, focus: false });
            preservedEditor(a);
        });
        await capture('A-focus-exit-restored-note');

        for (const hostLayout of ['stacked', 'standard']) {
            await step(`${hostLayout}-M-retains-native-rail-and-editor`, a, async () => {
                const pref = notePref();
                await setHostLayout(hostLayout);
                await layout(a, { notes: true, native: false });
                await railVisible();
                check(notePref() === pref, 'Host layout switch changed the notes preference');
                preservedEditor(a);
                await capture(`${hostLayout}-M-rail`);
            });
            await step(`${hostLayout}-ZR-restores-across-tabs-and-layout-switch`, a, async () => {
                const pref = notePref();
                await openNative(a, sectionID);
                await layout(a, { notes: false, native: true });
                await select(b);
                await layout(b, { notes: false, native: false });
                await railVisible();
                await select(a);
                await layout(a, { notes: false, native: true });
                await setHostLayout(hostLayout === 'stacked' ? 'standard' : 'stacked');
                await layout(a, { notes: false, native: true });
                await railVisible();
                await setHostLayout(hostLayout);
                await layout(a, { notes: false, native: true });
                await railVisible();
                check(notePref() === pref, 'Tab/layout restoration changed the notes preference');
                preservedEditor(a);
                await capture(`${hostLayout}-ZR-restored`);
            });
            await step(`${hostLayout}-focus-restores-ZR-then-M`, a, async () => {
                const pref = notePref();
                await click(a.root, '#mktero-focus-toggle', 'Enter focus in ' + hostLayout);
                await layout(a, { notes: false, native: false, focus: true });
                check(!visible(sidenav()), 'Focus mode left the native rail visible in ' + hostLayout);
                await click(a.root, '#mktero-focus-exit', 'Exit focus in ' + hostLayout);
                await layout(a, { notes: false, native: true });
                await railVisible();
                await closeNative(a);
                await layout(a, { notes: true, native: false });
                check(notePref() === pref, 'Focus restoration changed the notes preference in ' + hostLayout);
                preservedEditor(a);
            });
            await step(`${hostLayout}-responsive-and-focus-preserve-M-intent`, a, async () => {
                const pref = notePref();
                try {
                    win.resizeTo(1000, 900);
                    await wait(() => a.root.host.getBoundingClientRect().width <= 1120,
                        hostLayout + ' viewport below the notes breakpoint');
                    await layout(a, { notes: false, native: false });
                    await railVisible();
                    await click(a.root, '#mktero-focus-toggle', 'Enter narrow focus in ' + hostLayout);
                    await layout(a, { notes: false, native: false, focus: true });
                    check(!visible(sidenav()), 'Narrow focus left the native rail visible in ' + hostLayout);
                    await click(a.root, '#mktero-focus-exit', 'Exit narrow focus in ' + hostLayout);
                    await layout(a, { notes: false, native: false });
                    await capture(`${hostLayout}-responsive-narrow`);
                    check(notePref() === pref, 'Responsive collapse changed the notes preference');
                }
                finally { win.resizeTo(1500, 1000); }
                await layout(a, { notes: true, native: false });
                await railVisible();
                check(notePref() === pref, 'Responsive restoration changed the notes preference');
                preservedEditor(a);
            });
        }

        let nativeReaderTab;
        await step('opening-original-PDF-creates-a-real-reader-tab', a, async () => {
            await Zotero.Reader.open(a.fixture.id);
            await wait(() => tabs.selectedType === 'reader' && tabs.selectedID !== a.tab,
                'real native PDF reader instead of Mktero tab');
            nativeReaderTab = tabs.selectedID;
            const nativeReader = Zotero.Reader.getByTabID(nativeReaderTab);
            check(nativeReader?.itemID === a.fixture.id && selectedTab().type === 'reader',
                'Opening the original PDF did not select its real reader');
            state.nativeReader = { tabID: nativeReaderTab, itemID: nativeReader.itemID, type: selectedTab().type };
            await writeJSON(config.statePath, state);
            check(JSON.stringify(tabs._hasContextPaneTypes) === initialContextTypes,
                'Native reader eligibility was modified');
            await select(a);
            await layout(a, { notes: true, native: false });
            preservedEditor(a);
        });
        await step('tab-close-releases-contexts-and-native-editors', null, async () => {
            tabs.close(readers.map(reader => reader.tab));
            if (nativeReaderTab) tabs.close(nativeReaderTab);
            tabs.select('zotero-pane');
            await wait(() => readers.every(reader => !controller.context._getItemContext(reader.tab))
                && !a.noteEditor.isConnected
                && !doc.documentElement.hasAttribute('mktero-tab-selected'),
            'closed-tab context, editor and asynchronous selection-marker cleanup');
            const saved = await Zotero.DB.valueQueryAsync('SELECT note FROM itemNotes WHERE itemID = ?', [note.id]);
            check(typeof saved === 'string' && saved.includes(state.note.seed), 'Closing the reader lost its ordinary note');
        });
        await step('product-shutdown-removes-sidebar-adapter', null, async () => {
            Zotero.ItemPaneManager.unregisterSection(sectionID);
            sectionID = null;
            await addon.disable();
            await wait(() => !doc.getElementById('mktero-context-pane-style'), 'sidebar adapter style cleanup on shutdown');
            check(!doc.documentElement.hasAttribute('mktero-tab-selected'), 'Shutdown left its active-tab marker');
            check(JSON.stringify(tabs._hasContextPaneTypes) === initialContextTypes,
                'Shutdown did not preserve native context-pane eligibility');
        });
        return { zoteroVersion: Zotero.version, installedProductSHA256: config.product.sha256,
            isolatedProfile: true, isolatedDataDirectory: true, geckoOffline: true,
            checks: evidence, screenshots, sectionHookCalls: hookCalls,
            thirdPartyCoverage: 'synthetic-registerSection-only', llmForZoteroTested: false,
            ordinaryStandaloneNoteID: note.id, syntheticParentCount: state.pdfs.length,
            hostLayoutsTested: ['standard', 'stacked'], hostLayoutRestoration,
            responsiveWidthsRequested: [1000, 1500],
            nativeCloseControls: { standard: 'native-toggle-button-click', stacked: 'ZoteroContextPane.togglePane()' },
            cleanup: 'product-disabled-and-tabs-closed; launcher-must-confirm-normal-process-exit' };
    }
    catch (error) {
        await writeJSON(config.run + '/sidebar-error.json', {
            error: String(error), stack: error.stack, selectedID: tabs.selectedID,
            selectedType: tabs.selectedType, sidebar: currentSnapshot(readers.find(reader => reader.tab === tabs.selectedID)),
        });
        await capture('sidebar-failure');
        throw error;
    }
    finally {
        try {
            Zotero.Prefs.set('layout', initialHostLayout);
            win.ZoteroPane.updateLayout();
            hostLayoutRestoration.restored = Zotero.Prefs.get('layout');
            hostLayoutRestoration.passed = hostLayoutRestoration.restored === initialHostLayout;
            check(hostLayoutRestoration.passed, 'Original host layout preference was not restored');
        }
        finally {
            await writeJSON(config.run + '/sidebar-layout-restoration.json', hostLayoutRestoration);
            if (controller.update === tracedUpdate) controller.update = originalUpdate;
            for (const restore of nativeTraceRestorers.reverse()) restore();
            await writeJSON(config.run + '/sidebar-native-trace.json', nativeTrace);
            if (sectionID) Zotero.ItemPaneManager.unregisterSection(sectionID);
            await writeJSON(config.run + '/sidebar-checks.json', evidence);
            await writeJSON(config.run + '/sidebar-section-hooks.json', hookCalls);
        }
    }

    function visible(node) {
        if (!node || node.hidden || !node.isConnected) return false;
        const rect = node.getBoundingClientRect();
        const style = win.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none'
            && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    }

    function currentSnapshot(reader) {
        const root = reader?.root;
        const context = reader && nativeContext(reader);
        return { selectedID: tabs.selectedID, selectedType: tabs.selectedType,
            fixture: reader?.label || null, expectedParentID: reader?.fixture.parentID || null,
            contextItemID: context?.item?.id || null, contextTabType: context?.tabType || null,
            nativeCollapsed: controller.collapsed, nativeVisible: nativeVisible(),
            nativeIconsVisible: visible(sidenav()), contextMode: controller.context.mode,
            hostLayout: Zotero.Prefs.get('layout'),
            windowSize: { width: win.innerWidth, height: win.innerHeight },
            hostWidth: root?.host.getBoundingClientRect().width || null,
            nativeOuter: describeLayout(doc.getElementById('zotero-context-pane')),
            nativeInner: describeLayout(doc.getElementById('zotero-context-pane-inner')),
            nativeRail: describeLayout(sidenav()),
            nativeRailControls: Array.from(sidenav()?.querySelectorAll('[data-pane], [data-action]') || [],
                node => ({ pane: node.dataset.pane || null, action: node.dataset.action || null,
                    disabled: node.getAttribute('disabled'), ...describeLayout(node) })),
            nativeStackedGrippy: describeLayout(doc.querySelector('#zotero-context-splitter-stacked > grippy')),
            pinnedPane: sidenav()?.container?.pinnedPane || '',
            notesVisible: visible(root?.querySelector('#mktero-notes')),
            notesExpanded: root?.querySelector('#mktero-notes-toggle')?.getAttribute('aria-expanded') || null,
            focus: Boolean(root?.querySelector('.is-focus-mode')),
            notesPreference: notePref(),
            mountedNoteID: root?.host.querySelector('note-editor')?.item?.id || null,
            markers: ['mktero-tab-selected', 'mktero-context-pane-pending',
                'mktero-context-pane-unavailable', 'mktero-context-pane-focus']
                .filter(name => doc.documentElement.hasAttribute(name)) };
    }

    function describeLayout(node) {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        const style = win.getComputedStyle(node);
        return { collapsed: node.getAttribute('collapsed'), classes: node.getAttribute('class'),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: style.display, visibility: style.visibility };
    }

    async function setHostLayout(value) {
        Zotero.Prefs.set('layout', value);
        win.ZoteroPane.updateLayout();
        await wait(() => Zotero.Prefs.get('layout') === value
            && doc.getElementById('zotero-context-pane').classList.contains(value), value + ' native layout');
    }

    async function railVisible() {
        await wait(() => visible(sidenav()) && visible(sidenav().querySelector('[data-pane="info"]')),
            Zotero.Prefs.get('layout') + ' visible native icon rail');
        const rect = sidenav().getBoundingClientRect();
        check(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= win.innerWidth + 1
            && rect.y + rect.height <= win.innerHeight + 1, 'Native rail extends beyond the viewport');
    }

    async function step(name, reader, action) {
        await stage(name);
        const before = currentSnapshot(reader);
        try {
            await action();
            evidence.push({ name, passed: true, before, after: currentSnapshot(reader) });
        }
        catch (error) {
            evidence.push({ name, passed: false, before, after: currentSnapshot(reader), error: String(error) });
            throw error;
        }
        finally { await writeJSON(config.run + '/sidebar-checks.json', evidence); }
    }

    async function click(queryScope, selector, label) {
        return clickControl(queryScope, selector, label, { wait, visible, check, window: win });
    }

    async function openPDF(fixture, menu) {
        await stage(`opening article ${fixture.label} using the product item menu`);
        tabs.select('zotero-pane');
        await win.ZoteroPane.selectItem(fixture.id, { inLibraryRoot: true });
        check(win.ZoteroPane.getSelectedItems().map(item => item.id).join() === String(fixture.id),
            'Wrong PDF selected for product item menu');
        menu.parentNode.dispatchEvent(new win.Event('popupshowing', { bubbles: true }));
        check(!menu.hidden && !menu.disabled, 'Product menu is unavailable for the synthetic PDF');
        menu.dispatchEvent(new win.Event('command', { bubbles: true }));
        const root = await wait(() => [...doc.querySelectorAll('.mktero-tab-host')]
            .map(host => host.shadowRoot).find(shadow => shadow?.querySelector('.cm-content')
                ?.textContent.includes(fixture.markdown)), `${fixture.label} offline cached Markdown`);
        const reader = { root, tab: tabs.selectedID, label: fixture.label, fixture };
        check(reader.tab !== 'zotero-pane' && selectedTab().type === 'mktero', 'Expected a real Mktero tab');
        readers.push(reader);
        await wait(() => nativeContext(reader)?.item?.id === fixture.parentID
            && !doc.documentElement.hasAttribute('mktero-context-pane-pending'), `${fixture.label} current native article`);
        return reader;
    }

    async function layout(reader, expected) {
        await wait(() => {
            const actual = currentSnapshot(reader);
            return tabs.selectedID === reader.tab && actual.notesVisible === expected.notes
                && actual.nativeVisible === expected.native && actual.focus === Boolean(expected.focus)
                && actual.notesExpanded === String(expected.notes)
                && actual.contextItemID === reader.fixture.parentID
                && !actual.markers.includes('mktero-context-pane-pending')
                && !actual.markers.includes('mktero-context-pane-unavailable');
        }, `${reader.label} layout ${JSON.stringify(expected)}`);
        check(!(visible(reader.root.querySelector('#mktero-notes')) && nativeVisible()),
            'Both right-hand content areas are visible');
    }

    async function openNative(reader, pane) {
        check(tabs.selectedID === reader.tab, 'Cannot open a native pane for an inactive fixture tab');
        await click(sidenav(), `[data-pane="${win.CSS.escape(pane)}"]`, `${reader.label} native ${pane} section`);
        await wait(() => !controller.collapsed && nativeVisible(), `${reader.label} native pane expansion`);
    }

    async function closeNative(reader) {
        check(!controller.collapsed, 'Native close requested while already collapsed');
        if (Zotero.Prefs.get('layout') === 'stacked') {
            // Zotero hides toggle-pane in stacked mode; invoke the same native
            // pane command rather than requiring a standard-only control.
            controller.togglePane();
        }
        else {
            await click(sidenav(), '[data-action="toggle-pane"]', `${reader.label} collapse native pane`);
        }
        await wait(() => controller.collapsed, `${reader.label} native pane collapse`);
    }

    async function toggleNotes(reader) {
        return click(reader.root, '#mktero-notes-toggle', `${reader.label} Mktero notes toggle`);
    }

    async function select(reader) {
        tabs.select(reader.tab);
        await wait(() => tabs.selectedID === reader.tab && nativeContext(reader)?.item?.id === reader.fixture.parentID
            && sidenav()?.container === nativeContext(reader)
            && !doc.documentElement.hasAttribute('mktero-context-pane-pending'), `${reader.label} restored native context`);
    }

    async function editor(reader) {
        return wait(() => {
            const node = reader.root.host.querySelector('note-editor');
            const frame = node?._iframe || node?.querySelector('#editor-view') || node?.querySelector('iframe');
            const surface = frame?.contentDocument?.querySelector('.ProseMirror');
            return node?.item?.id === state.note.id && node.getCurrentInstance?.()
                && visible(node) && surface && { node, frame, surface };
        }, `${reader.label} ordinary native note-editor`);
    }

    function preservedEditor(reader) {
        const current = reader.root.host.querySelector('note-editor');
        check(current === reader.noteEditor && current?.isConnected, 'Sidebar coordination destroyed or replaced note-editor');
        const frame = current._iframe || current.querySelector('#editor-view') || current.querySelector('iframe');
        check(frame === reader.editorFrame && frame.contentDocument?.querySelector('.ProseMirror')
            ?.textContent === reader.noteText, 'Sidebar coordination reloaded the editor or changed its content');
        check(current.item?.id === state.note.id, 'Sidebar coordination changed the note destination');
    }

    async function capture(name) {
        const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        try {
            check(Zotero.Profile.dir === config.profile && Zotero.DataDirectory.dir === config.data,
                'Screenshot target is not the isolated Zotero window');
            canvas.width = Math.ceil(win.innerWidth);
            canvas.height = Math.ceil(win.innerHeight);
            const paint = canvas.getContext('2d');
            if (typeof paint.drawWindow !== 'function') {
                screenshots.push({ name, available: false, reason: 'canvas.drawWindow unavailable' });
                return;
            }
            paint.drawWindow(win, 0, 0, canvas.width, canvas.height, 'white');
            const raw = win.atob(canvas.toDataURL('image/png').split(',')[1]);
            const file = config.run + '/' + name + '.png';
            await IOUtils.write(file, Uint8Array.from(raw, ch => ch.charCodeAt(0)));
            screenshots.push({ name, available: true, file });
        }
        catch (error) { screenshots.push({ name, available: false, reason: String(error) }); }
        finally {
            canvas.width = canvas.height = 0;
            await writeJSON(config.run + '/sidebar-screenshots.json', screenshots);
        }
    }
}
