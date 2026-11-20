// Serialized into a separate driver add-on. All tested mutations are native
// clicks on the installed product. Zotero APIs below only import fixtures and
// read back persisted fields; no synchronization or persistence API is stubbed.
export async function runSmoke(config) {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const writeJSON = (file, value) => IOUtils.writeUTF8(file, JSON.stringify(value, null, 2), { tmpPath: file + '.tmp' });
    const stage = value => IOUtils.writeUTF8(config.stagePath, value, { tmpPath: config.stagePath + '.tmp' });
    Services.io.offline = true;
    await stage('initializing isolated Zotero');
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    check(Zotero.Profile.dir === config.profile, 'Unexpected profile');
    check(Zotero.DataDirectory.dir === config.data, 'Unexpected data directory');
    check(Services.io.offline, 'Gecko offline mode is inactive');
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const libraryID = Zotero.Libraries.userLibraryID;
    const pause = ms => new Promise(resolve => win.setTimeout(resolve, ms));
    const wait = async (fn, label, timeout = 18000) => {
        const deadline = Date.now() + timeout;
        do { const value = await fn(); if (value) return value; await pause(50); } while (Date.now() < deadline);
        throw new Error(`Timed out waiting for ${label}`);
    };
    const checks = [];
    const readers = [];
    const record = async (name, evidence = {}) => {
        checks.push({ check: name, ...evidence, passed: true });
        await writeJSON(config.run + `/phase-${config.phase}.checks.json`, checks);
    };
    const base = { phase: config.phase, zoteroVersion: Zotero.version, isolatedProfile: true,
        isolatedDataDirectory: true, geckoOffline: true };
    if (!config.product) {
        check((await Zotero.Items.getAll(libraryID, false, true, false)).length === 0, 'Preflight library is not empty');
        if (config.phase === 1) await writeJSON(config.statePath, { preflight: true, libraryID, profile: config.profile, data: config.data });
        else {
            const prior = await IOUtils.readJSON(config.statePath);
            check(prior.preflight && prior.libraryID === libraryID && prior.profile === config.profile && prior.data === config.data,
                'Preflight restart changed profile/data/library');
        }
        return { ...base, mode: 'isolated-zotero-preflight-only', emptyLibrary: true };
    }
    await stage('verifying installed product XPI');
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const addon = await AddonManager.getAddonByID(config.product.id);
    check(addon?.isActive && addon.version === config.product.version, 'Product XPI is not active');
    const uri = Services.io.newFileURI(Zotero.File.pathToFile(config.product.xpiPath)).spec;
    check(addon.getResourceURI('bootstrap.js').spec === `jar:${uri}!/bootstrap.js`, 'Runtime is not the staged product XPI');
    const menu = await wait(() => doc.getElementById('mktero-read-as-markdown'), 'product item menu');
    await wait(() => win.ZoteroPane.collectionsView?.itemTreeView && win.ZoteroPane.itemsView, 'native item trees');
    await win.ZoteroPane.collectionsView.waitForLoad();
    await win.ZoteroPane.itemsView.waitForLoad();
    win.resizeTo(1280, 900);
    win.focus();
    let state;
    if (config.phase === 1) {
        check((await Zotero.Items.getAll(libraryID, false, true, false)).length === 0, 'Initial library must be empty');
        state = { schemaVersion: 1, profile: config.profile, data: config.data, libraryID, productIssues: [],
            productSHA256: config.product.sha256, pdfs: [] };
        for (const fixture of config.fixtures) {
            await stage(`${fixture.label}: importing synthetic PDF fixture`);
            const pdf = await Zotero.Attachments.importFromFile({ file: fixture.pdfPath, libraryID });
            const attachmentPath = await pdf.getFilePathAsync();
            check(attachmentPath.startsWith(config.data + '/'), 'Fixture import escaped isolated data');
            state.pdfs.push({ ...fixture, id: pdf.id, key: pdf.key, attachmentPath });
        }
        await writeJSON(config.statePath, state);
        for (const fixture of state.pdfs.filter(value => value.label !== 'retry')) {
            const reader = await openPDF(fixture);
            await stage(`${fixture.label}: creating annotation through native selection and comment Save`);
            await createWithComment(reader, fixture);
            if (fixture.label === 'caption') {
                fixture.color = '#ffd400';
                fixture.saved = await waitForCaption(fixture, fixture.color);
                await record('figcaption-native-backward-drag-and-comment-save-creates-one-pdf-item-without-group', {
                    label: fixture.label, gesture: fixture.captionGesture, annotations: fixture.saved,
                    localStore: await localRecords(fixture), groups: await groups(fixture) });
            }
            else {
                fixture.saved = await waitForGroup(fixture, '#ffd400');
                await record('create-via-product-selection-and-comment-save', { label: fixture.label, annotations: fixture.saved,
                    localStore: await localRecords(fixture), groups: await groups(fixture) });
                if (fixture.label === 'retain') {
                    await stage('retain: editing the already synchronized primary highlight through its real comment editor');
                    const before = fixture.saved;
                    const editor = await editExistingComment(reader, before[0], fixture.editedComment);
                    fixture.comment = fixture.editedComment;
                    fixture.saved = await waitForGroup(fixture, '#ffd400');
                    const expected = before.map((item, index) => index === 0 ? { ...item, comment: fixture.comment } : item);
                    check(JSON.stringify(fixture.saved) === JSON.stringify(expected),
                        'Editing the primary comment changed another annotation or another PDF field');
                    await record('edit-synchronized-primary-comment-changes-only-selected-segment', {
                        selectedKey: before[0].key, editor, before, annotations: fixture.saved });
                }
                await stage(`${fixture.label}: recoloring both page parts from the second page annotation`);
                await recolor(reader, fixture.saved[1].key, '#5fb236');
                fixture.color = '#5fb236';
                fixture.saved = await waitForGroup(fixture, fixture.color);
                await record('group-recolor-from-second-member-preserves-primary-comment', { label: fixture.label, annotations: fixture.saved });
                if (fixture.label === 'delete') {
                    await stage('delete: deleting the group by its second page sidebar control');
                    fixture.deletedKeys = fixture.saved.map(value => value.key);
                    await click(reader.root, `.markdown-note-delete[data-annotation-id="${fixture.saved[1].key}"]`, 'delete second page member');
                    await wait(async () => (await annotationRecords(fixture)).length === 0 && (await groups(fixture)).length === 0,
                        'all group members and group store removed');
                    await record('delete-second-member-removes-entire-group', { keys: fixture.deletedKeys,
                        localStore: await localRecords(fixture), groups: await groups(fixture) });
                }
            }
            await closeReader(reader);
            const reopened = await openPDF(fixture);
            await verifyFixture(fixture, true);
            await verifySidebar(reopened, fixture);
            await record('close-tab-and-reopen-retains-annotation-state', { label: fixture.label,
                annotations: await annotationRecords(fixture), groups: await groups(fixture), localStore: await localRecords(fixture) });
            await closeReader(reopened);
            await writeJSON(config.statePath, state);
        }
        const fixture = state.pdfs.find(value => value.label === 'retry');
        fixture.localID = 'mktero-legacy-retry-fixture';
        const local = { id: fixture.localID, source: 'markdown', type: 'highlight', text: fixture.text,
            comment: fixture.comment, color: '#ffd400', ranges: [{ from: 0, to: fixture.markdown.length }] };
        // Only seed the old local draft. The failure status must be produced
        // by the real product; synchronization failures are session-only.
        const directory = config.profile + '/mktero-annotations/v1';
        await IOUtils.makeDirectory(directory, { ignoreExisting: true });
        await writeJSON(storePath(fixture, 'v1'), { schemaVersion: 1, itemID: fixture.id, annotations: [local] });
        const failuresBeforeOpen = synchronizationErrors().length;
        const finishTimeline = observeOpenTimeline(fixture);
        const reader = await openPDF(fixture);
        await stage('retry: waiting for real PDF-index failure of seeded legacy local draft');
        const retrySelector = `.markdown-note-sync-retry[data-annotation-id="${fixture.localID}"]`;
        await wait(() => synchronizationErrors().length > failuresBeforeOpen, 'real product synchronization failure log');
        try { await wait(() => reader.root.querySelector(retrySelector), 'failure status and Retry control', 3000); }
        catch { /* Retain the product assertion below while collecting later persistence evidence. */ }
        await finishTimeline();
        await writeJSON(`${config.run}/phase-${config.phase}.retry-diagnostics.json`, {
            sidebar: sidebarRecords(reader),
            controls: [...reader.root.querySelectorAll('.markdown-note-item')].map(node => node.outerHTML),
            highlights: [...reader.root.querySelectorAll('.cm-mktero-pdf-annotation')].map(node => node.outerHTML),
            localStore: await localRecords(fixture), synchronizationErrors: synchronizationErrors(),
        });
        check((await annotationRecords(fixture)).length === 0, 'Damaged PDF unexpectedly produced an annotation');
        check((await localRecords(fixture)).length === 1, 'Failed synchronization discarded local annotation');
        await record('legacy-local-draft-really-fails-and-remains-on-disk', { label: fixture.label,
            localStore: await localRecords(fixture), sidebar: sidebarRecords(reader), reason: 'temporarily damaged synthetic PDF',
            synchronizationErrors: synchronizationErrors() });
        if (reader.root.querySelector(retrySelector)) {
            await stage('retry: clicking explicit retry while the synthetic PDF remains damaged');
            const failuresBeforeRetry = synchronizationErrors().length;
            await click(reader.root, retrySelector, 'failed local draft Retry');
            await wait(() => synchronizationErrors().length > failuresBeforeRetry && reader.root.querySelector(retrySelector)
                && !reader.root.querySelector(retrySelector).disabled, 'explicit retry really failed again');
            check((await annotationRecords(fixture)).length === 0 && (await localRecords(fixture)).length === 1,
                'Failed explicit retry changed persisted item count');
            await record('explicit-retry-failure-does-not-duplicate-or-drop-local-draft', { localStore: await localRecords(fixture) });
        }
        else {
            // Continue collecting persistence evidence, but defer this real
            // product assertion to the final report, which must remain failed.
            state.productIssues.push({ phase: config.phase, label: fixture.label,
                issue: 'A real synchronization failure remains displayed as pending and has no Retry control',
                evidence: `${config.run}/phase-${config.phase}.retry-diagnostics.json` });
        }
        fixture.failedLocalRecord = await localRecords(fixture);
        await closeReader(reader);
        state.phase1Complete = true;
        await writeJSON(config.statePath, state);
    }
    else {
        state = await IOUtils.readJSON(config.statePath);
        check(state.phase1Complete && state.libraryID === libraryID && state.profile === config.profile && state.data === config.data,
            'Restart did not reuse completed phase-one profile/data/library');
        check(state.productSHA256 === config.product.sha256, 'XPI changed between launches');
        for (const fixture of state.pdfs) {
            if (fixture.label === 'retry' && config.phase === 2) {
                await stage('retry: checking failed local draft survived normal exit before opening');
                check(JSON.stringify(await localRecords(fixture)) === JSON.stringify(fixture.failedLocalRecord),
                    'Failed local draft changed across first normal exit');
                check((await annotationRecords(fixture)).length === 0, 'Unexpected annotation before automatic retry');
                await record('failed-local-draft-survives-normal-quit', { localStore: await localRecords(fixture) });
                const reader = await openPDF(fixture);
                await stage('retry: automatic open retry synchronizes the unchanged local draft after PDF recovery');
                fixture.color = '#ffd400';
                fixture.saved = await waitForGroup(fixture, fixture.color);
                await verifySidebar(reader, fixture);
                await record('automatic-open-retry-creates-two-page-group-and-clears-local-store', {
                    annotations: fixture.saved, localStore: await localRecords(fixture), groups: await groups(fixture) });
                await recolor(reader, fixture.saved[1].key, '#2ea8e5');
                fixture.color = '#2ea8e5';
                fixture.saved = await waitForGroup(fixture, fixture.color);
                await closeReader(reader);
                const reopened = await openPDF(fixture);
                await pause(600);
                await verifyFixture(fixture, true);
                await verifySidebar(reopened, fixture);
                await record('repeated-open-retry-does-not-create-duplicates', { keys: fixture.saved.map(value => value.key),
                    count: (await annotationRecords(fixture)).length, groups: await groups(fixture) });
                await closeReader(reopened);
                continue;
            }
            await stage(`${fixture.label}: verifying persisted database fields and group store after normal restart ${config.phase}`);
            await verifyFixture(fixture, true);
            const reader = await openPDF(fixture);
            await verifySidebar(reader, fixture);
            await record('normal-restart-restores-exact-fields-groups-and-deletions', { label: fixture.label,
                annotations: await annotationRecords(fixture), groups: await groups(fixture), localStore: await localRecords(fixture) });
            if (config.phase === 3 && fixture.label === 'retain') {
                await stage('retain: proving restored grouping applies to color changes after restart');
                await recolor(reader, fixture.saved[1].key, '#a28ae5');
                fixture.color = '#a28ae5';
                const updated = await waitForGroup(fixture, fixture.color);
                check(updated.map(value => value.key).join() === fixture.saved.map(value => value.key).join(), 'Recolor replaced annotations');
                fixture.saved = updated;
                await record('restored-group-recolors-both-pages-after-restart', { annotations: updated });
            }
            await closeReader(reader);
        }
        if (config.phase === 2) state.phase2Complete = true;
        if (config.phase === 3) check(state.phase2Complete, 'Recovery phase did not complete');
        await writeJSON(config.statePath, state);
    }
    await stage('closing reader tabs before normal application quit');
    for (const reader of readers.filter(value => !value.closed)) await closeReader(reader);
    check(Services.io.offline, 'Gecko went online');
    return { ...base, mode: 'installed-product-xpi', xpiSHA256: config.product.sha256,
        productVersion: addon.version, checks, productIssues: state.productIssues,
        pdfs: state.pdfs.map(({ label, id, key }) => ({ label, id, key })) };

    function synchronizationErrors() {
        return Zotero.getErrors(true).map(String).filter(value => value.includes('The local PDF text index is unavailable')
            && value.includes(config.product.xpiPath));
    }

    function observeOpenTimeline(fixture) {
        const started = Date.now();
        const timeline = [];
        let signature;
        const sample = () => {
            const root = [...doc.querySelectorAll('.mktero-tab-host')].map(host => host.shadowRoot)
                .find(shadow => shadow?.querySelector('.cm-content')?.textContent === fixture.markdown)
                || [...doc.querySelectorAll('.mktero-tab-host')].at(-1)?.shadowRoot;
            const loading = root?.querySelector('#mktero-loading');
            const current = { rootPresent: Boolean(root), loadingVisible: Boolean(loading && !loading.hidden),
                markdownReady: root?.querySelector('.cm-content')?.textContent === fixture.markdown,
                synchronizationErrors: synchronizationErrors().length,
                sidebarState: root?.querySelector('.markdown-note-sync-label')?.textContent || null,
                retryAvailable: Boolean(root?.querySelector('.markdown-note-sync-retry')) };
            const next = JSON.stringify(current);
            if (next !== signature) timeline.push({ elapsedMilliseconds: Date.now() - started, ...current });
            signature = next;
        };
        sample();
        const timer = win.setInterval(sample, 10);
        return async () => {
            win.clearInterval(timer);
            sample();
            await writeJSON(`${config.run}/phase-${config.phase}.retry-open-timeline.json`, timeline);
        };
    }
    function storePath(fixture, directory) { return `${config.profile}/mktero-annotations/${directory}/item-${fixture.id}.json`; }
    async function storeRecords(fixture, directory) {
        const file = storePath(fixture, directory);
        if (!await IOUtils.exists(file)) return [];
        const value = await IOUtils.readJSON(file);
        check(value.schemaVersion === 1 && value.itemID === fixture.id && Array.isArray(value.annotations), `Invalid ${directory} store`);
        return value.annotations;
    }
    function localRecords(fixture) { return storeRecords(fixture, 'v1'); }
    function groups(fixture) { return storeRecords(fixture, 'groups-v1'); }
    async function annotationRecords(fixture) {
        const pdf = await Zotero.Items.getAsync(fixture.id);
        check(pdf?.isPDFAttachment() && pdf.key === fixture.key && !pdf.deleted, `${fixture.label}: missing attachment`);
        await Zotero.Items.loadDataTypes([pdf], ['childItems']);
        const annotations = pdf.getAnnotations(false);
        await Zotero.Items.loadDataTypes(annotations, ['annotation', 'annotationDeferred']);
        return annotations.map(item => ({ id: item.id, key: item.key, parentID: item.parentID,
            type: item.annotationType, text: item.annotationText, color: item.annotationColor,
            comment: String(item.annotationComment ?? ''), position: JSON.parse(item.annotationPosition),
            pageLabel: item.annotationPageLabel, sortIndex: item.annotationSortIndex }))
            .sort((a, b) => a.position.pageIndex - b.position.pageIndex);
    }
    async function validateGroup(fixture, color) {
        const records = await annotationRecords(fixture);
        check(records.length === 2, `${fixture.label}: expected exactly two PDF annotations, got ${records.length}`);
        for (const [index, item] of records.entries()) {
            check(item.parentID === fixture.id && item.type === 'highlight', `${fixture.label}: invalid annotation parent/type`);
            check(item.text === fixture.pages[index], `${fixture.label}: page ${index} text differs: ${JSON.stringify(item.text)}`);
            check(item.color === color, `${fixture.label}: page ${index} color differs`);
            check(item.comment === (index === 0 ? fixture.comment : ''), `${fixture.label}: page ${index} comment differs`);
            check(item.position.pageIndex === index && item.pageLabel === String(index + 1), `${fixture.label}: incorrect PDF page`);
            check(item.position.rects.length > 0 && item.position.rects.every(rect => rect.length === 4
                && rect.every(Number.isFinite) && rect[0] >= 39 && rect[0] < rect[2] && rect[2] <= fixture.geometry.width
                && rect[1] >= fixture.geometry.baseline - 20 && rect[1] < rect[3]
                && rect[3] <= fixture.geometry.baseline + 20), `${fixture.label}: annotation rectangles miss known PDF text geometry`);
            check(typeof item.sortIndex === 'string' && item.sortIndex.length > 0, 'Missing annotation sort index');
        }
        const storedGroups = await groups(fixture);
        check(storedGroups.length === 1 && [...storedGroups[0]].sort().join() === records.map(value => value.key).sort().join(),
            `${fixture.label}: group does not contain exactly the two created keys`);
        check((await localRecords(fixture)).length === 0, `${fixture.label}: synchronized local draft was not removed`);
        return records;
    }
    async function waitForGroup(fixture, color) {
        let lastError;
        try { return await wait(async () => {
            try { return await validateGroup(fixture, color); } catch (error) { lastError = error; return null; }
        }, `${fixture.label} exact PDF fields and group store`); }
        catch (error) { throw new Error(`${error.message}; last assertion: ${lastError?.message}`); }
    }
    async function validateCaption(fixture, color) {
        const records = await annotationRecords(fixture);
        check(records.length === 1, `caption: expected exactly one PDF annotation, got ${records.length}`);
        const item = records[0];
        check(item.parentID === fixture.id && item.type === 'highlight', 'caption: invalid annotation parent/type');
        check(item.text === fixture.text && item.comment === fixture.comment && item.color === color,
            'caption: saved text/comment/color differs from the exact native selection');
        check(item.position.pageIndex === 0 && item.pageLabel === '1', 'caption: incorrect PDF page');
        const geometry = fixture.geometry;
        check(item.position.rects.length >= geometry.lineCount && item.position.rects.every(rect => rect.length === 4
            && rect.every(Number.isFinite) && rect[0] >= 39 && rect[0] < rect[2] && rect[2] <= geometry.width
            && rect[1] >= geometry.baseline - (geometry.lineCount - 1) * geometry.lineHeight - 20
            && rect[1] < rect[3] && rect[3] <= geometry.baseline + 20), 'caption: rectangles miss known multiline caption geometry');
        check(typeof item.sortIndex === 'string' && item.sortIndex.length > 0, 'caption: missing annotation sort index');
        check((await groups(fixture)).length === 0, 'caption: a single PDF item must have no owned group');
        check((await localRecords(fixture)).length === 0, 'caption: synchronized local draft was not removed');
        return records;
    }
    async function waitForCaption(fixture, color) {
        let lastError;
        try { return await wait(async () => {
            try { return await validateCaption(fixture, color); } catch (error) { lastError = error; return null; }
        }, 'caption exact single PDF item, empty local store and no group'); }
        catch (error) { throw new Error(`${error.message}; last assertion: ${lastError?.message}`); }
    }
    async function verifyFixture(fixture, exact) {
        if (fixture.label === 'delete') {
            check((await annotationRecords(fixture)).length === 0 && (await groups(fixture)).length === 0
                && (await localRecords(fixture)).length === 0, 'Deleted group returned');
            for (const key of fixture.deletedKeys) {
                check(!Zotero.Items.getByLibraryAndKey(libraryID, key), `Deleted annotation ${key} still exists`);
            }
        }
        else {
            const records = fixture.label === 'caption'
                ? await validateCaption(fixture, fixture.color)
                : await validateGroup(fixture, fixture.color);
            if (exact) check(JSON.stringify(records) === JSON.stringify(fixture.saved), `${fixture.label}: saved database fields changed`);
        }
    }
    function sidebarRecords(reader) {
        return [...reader.root.querySelectorAll('.markdown-note-link')].map(node => ({
            id: node.getAttribute('data-annotation-id'), text: node.textContent }));
    }
    async function verifySidebar(reader, fixture) {
        await wait(() => {
            const cards = sidebarRecords(reader);
            return fixture.label === 'delete' ? cards.length === 0
                : cards.length === fixture.saved.length && fixture.saved.every(value => cards.some(card => card.id === value.key && card.text.includes(value.text)));
        }, `${fixture.label} correct restored annotation sidebar`);
        check(!reader.root.querySelector('.markdown-note-sync-retry'), 'A synchronized annotation still offers Retry');
        if (fixture.label === 'caption') await verifyCaptionWidget(reader);
    }
    function readerMatchesFixture(root, fixture) {
        const content = root?.querySelector('.cm-content');
        if (fixture.label !== 'caption') return content?.textContent.includes(fixture.markdown);
        return content?.textContent.includes(fixture.before) && content.textContent.includes(fixture.after)
            && normalize(root.querySelector('figcaption')?.textContent) === fixture.caption;
    }
    async function verifyCaptionWidget(reader) {
        const fixture = reader.fixture;
        return wait(() => {
            const caption = reader.root.querySelector('figcaption');
            const figure = caption?.closest('figure');
            const image = figure?.querySelector('img');
            return caption && readerMatchesFixture(reader.root, fixture)
                && image?.src.startsWith('blob:') && image.complete && image.naturalWidth === fixture.assets[0].width
                && image.naturalHeight === fixture.assets[0].height && caption;
        }, 'real figcaption widget with its decoded offline cache image');
    }
    async function openPDF(fixture) {
        await stage(`${fixture.label}: opening cached Markdown from product item menu`);
        win.Zotero_Tabs.select('zotero-pane');
        await win.ZoteroPane.selectItem(fixture.id, { inLibraryRoot: true });
        check(win.ZoteroPane.getSelectedItems().map(item => item.id).join() === String(fixture.id), 'Wrong PDF selected');
        menu.parentNode.dispatchEvent(new win.Event('popupshowing', { bubbles: true }));
        check(!menu.hidden && !menu.disabled, 'Product menu unavailable');
        menu.dispatchEvent(new win.Event('command', { bubbles: true }));
        const root = await wait(() => [...doc.querySelectorAll('.mktero-tab-host')].map(host => host.shadowRoot)
            .find(shadow => readerMatchesFixture(shadow, fixture)),
        `${fixture.label} original cached Markdown`);
        const reader = { root, tab: win.Zotero_Tabs.selectedID, fixture, closed: false };
        check(reader.tab !== 'zotero-pane', 'No product reader tab');
        readers.push(reader);
        const toggle = root.querySelector('#mktero-outline-toggle');
        if (toggle?.getAttribute('aria-expanded') === 'false') await click(root, '#mktero-outline-toggle', 'open outline column');
        await click(root, '#mktero-outline-segment-annotations', 'Annotations sidebar');
        if (fixture.label === 'caption') await verifyCaptionWidget(reader);
        await pause(250);
        return reader;
    }
    async function closeReader(reader) {
        win.Zotero_Tabs.close(reader.tab);
        await wait(() => !reader.root.host.isConnected, `${reader.fixture.label} tab cleanup`);
        reader.closed = true;
    }
    function visible(node) { return node && !node.hidden && node.getClientRects().length && win.getComputedStyle(node).visibility !== 'hidden'; }
    async function click(root, selector, label) {
        const node = await wait(() => {
            const value = root.querySelector(selector);
            return visible(value) && !value.disabled && value.getAttribute('aria-disabled') !== 'true' && value;
        }, `visible enabled ${label}`);
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = node.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        check(node.contains(root.elementFromPoint(x, y)), `${label} is covered`);
        let count = 0;
        const observe = () => count++;
        node.addEventListener('click', observe);
        try {
            win.windowUtils.sendMouseEvent('mousedown', x, y, 0, 1, 0);
            win.windowUtils.sendMouseEvent('mouseup', x, y, 0, 1, 0);
            check(count === 1, `${label}: expected one native click, got ${count}`);
        }
        finally { node.removeEventListener('click', observe); }
        return node;
    }
    function characterPoint(node, offset, end = false) {
        const range = doc.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        check(rect.width > 0 && rect.height > 0, 'Selection endpoint has no geometry');
        return { x: end ? rect.right - 0.5 : rect.left + 0.5, y: rect.top + rect.height / 2 };
    }
    async function createWithComment(reader, fixture) {
        if (fixture.label === 'caption') await selectCaption(reader, fixture);
        else {
            const content = reader.root.querySelector('.cm-content');
            content.scrollIntoView({ block: 'center' });
            const walker = doc.createTreeWalker(content, win.NodeFilter.SHOW_TEXT);
            const nodes = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.length) nodes.push(node);
            check(nodes.map(value => value.textContent).join('') === fixture.text, 'Unexpected selectable fixture content');
            const first = nodes[0];
            const last = nodes.at(-1);
            await nativeDrag(characterPoint(first, 0), characterPoint(last, last.textContent.length - 1, true));
        }
        await click(reader.root, '.mktero-markdown-selection-actions [data-action="add-note"]', 'selection Add Comment');
        const input = await wait(() => reader.root.querySelector('.mktero-annotation-note-input'), 'draft annotation comment editor');
        check(reader.root.querySelector('.mktero-annotation-note-quote').textContent === fixture.text, 'Native selection did not cover the exact fixture text');
        input.value = fixture.comment;
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        await click(reader.root, '.mktero-annotation-note-save', 'Save draft annotation and comment');
    }
    async function nativeDrag(from, to) {
        win.windowUtils.sendMouseEvent('mousedown', from.x, from.y, 0, 1, 0);
        for (let i = 1; i <= 12; i++) {
            win.windowUtils.sendMouseEvent('mousemove', from.x + (to.x - from.x) * i / 12, from.y + (to.y - from.y) * i / 12, 0, 0, 0);
            await pause(15);
        }
        win.windowUtils.sendMouseEvent('mouseup', to.x, to.y, 0, 1, 0);
    }
    function normalize(value) { return String(value || '').replace(/\s+/gu, ' ').trim(); }
    async function selectCaption(reader, fixture) {
        let caption = await verifyCaptionWidget(reader);
        caption.scrollIntoView({ block: 'center', inline: 'nearest' });
        await pause(150);
        caption = await verifyCaptionWidget(reader);
        const walker = doc.createTreeWalker(caption, win.NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent.trim() && !node.parentElement.closest('.mktero-figure-label')) nodes.push(node);
        }
        check(normalize(nodes.map(node => node.textContent).join('')) === fixture.text, 'caption: unexpected rendered prose');
        const first = nodes[0];
        const last = nodes.at(-1);
        const from = characterPoint(first, first.textContent.search(/\S/u));
        const to = characterPoint(last, last.textContent.length - 1, true);
        const scroller = reader.root.querySelector('.cm-scroller').getBoundingClientRect();
        for (const point of [from, to]) check(point.x > Math.max(scroller.left, 0)
            && point.x < Math.min(scroller.right, win.innerWidth) && point.y > Math.max(scroller.top, 0)
            && point.y < Math.min(scroller.bottom, win.innerHeight), 'caption: drag endpoint is outside the visible reader');
        check(to.y - from.y > 8, 'caption: native drag must cover at least two rendered lines');
        // A backward drag crosses the same real widget/native-selection path
        // that regressed; never replace it with Range/setBaseAndExtent calls.
        await nativeDrag(to, from);
        const currentSelection = () => {
            const selection = doc.getSelection();
            return caption.contains(selection?.anchorNode) ? selection : reader.root.getSelection?.() || selection;
        };
        const selectionEvidence = () => {
            const selection = currentSelection();
            const currentCaption = reader.root.querySelector('figcaption');
            const describeNode = node => node && ({ type: node.nodeType, name: node.nodeName,
                text: node.textContent, connected: node.isConnected,
                parentHTML: node.parentElement?.outerHTML });
            return { text: selection?.toString(), rangeCount: selection?.rangeCount, isCollapsed: selection?.isCollapsed,
                anchorOffset: selection?.anchorOffset, focusOffset: selection?.focusOffset,
                anchorInsideCaption: caption.contains(selection?.anchorNode), focusInsideCaption: caption.contains(selection?.focusNode),
                originalCaptionConnected: caption.isConnected, currentCaptionIsOriginal: currentCaption === caption,
                anchorInsideCurrentCaption: Boolean(currentCaption?.contains(selection?.anchorNode)),
                focusInsideCurrentCaption: Boolean(currentCaption?.contains(selection?.focusNode)),
                anchor: describeNode(selection?.anchorNode), focus: describeNode(selection?.focusNode),
                activeElement: reader.root.activeElement?.outerHTML,
                popupHTML: reader.root.querySelector('.mktero-markdown-selection-actions')?.outerHTML };
        };
        await writeJSON(`${config.run}/phase-${config.phase}.caption-native-selection.json`, {
            direction: 'backward', start: to, end: from, expectedText: fixture.text,
            captionHTML: caption.outerHTML, native: selectionEvidence() });
        await wait(() => reader.root.querySelector('.mktero-markdown-selection-actions'), 'caption selection popup');
        const snapshot = () => {
            const selection = currentSelection();
            check(selection?.rangeCount === 1 && !selection.isCollapsed
                && caption.contains(selection.anchorNode) && caption.contains(selection.focusNode), 'caption: native selection escaped figcaption');
            const text = normalize(selection.toString());
            check(text === fixture.text && !text.includes(fixture.before) && !text.includes(fixture.after),
                `caption: native selected text differs: ${JSON.stringify(text)}`);
            return { text, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset };
        };
        const selected = snapshot();
        const anchorNode = currentSelection().anchorNode;
        const focusNode = currentSelection().focusNode;
        await pause(160);
        await writeJSON(`${config.run}/phase-${config.phase}.caption-native-settled.json`, selectionEvidence());
        check(JSON.stringify(snapshot()) === JSON.stringify(selected) && currentSelection().anchorNode === anchorNode
            && currentSelection().focusNode === focusNode, 'caption: native selection changed before Save');
        fixture.captionGesture = { direction: 'backward', ...selected, start: to, end: from,
            multipleRenderedLines: true, stableAfterMouseup: true, offlineImageDecoded: true };
    }
    async function editExistingComment(reader, annotation, comment) {
        check(typeof comment === 'string' && comment !== annotation.comment, 'Replacement comment must differ from initial comment');
        await openAnnotationActions(reader, annotation.key);
        await click(reader.root, '.mktero-annotation-actions [data-action="add-note"]', 'edit synchronized highlight comment');
        const input = await wait(() => reader.root.querySelector('.mktero-annotation-note-input'), 'existing PDF annotation comment editor');
        const quote = reader.root.querySelector('.mktero-annotation-note-quote').textContent;
        check(quote === annotation.text && input.value === annotation.comment && !input.readOnly,
            'Existing comment editor did not load the selected PDF annotation');
        await click(reader.root, '.mktero-annotation-note-input', 'focus existing PDF annotation comment');
        input.value = comment;
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        await click(reader.root, '.mktero-annotation-note-save', 'Save edited synchronized comment');
        return { quote, originalComment: annotation.comment, editedComment: comment, savedThroughProductEditor: true };
    }
    async function openAnnotationActions(reader, key) {
        await click(reader.root, `.markdown-note-link[data-annotation-id="${key}"]`, 'navigate to grouped page annotation');
        await pause(300);
        const selector = `.cm-content .cm-mktero-pdf-annotation[data-annotation-id="${key}"]`;
        const anchor = await wait(() => reader.root.querySelector(selector), 'rendered PDF highlight');
        anchor.scrollIntoView({ block: 'center' });
        // Focusing the accessible highlight is the product's keyboard entry
        // to its actions popup, and avoids pointing into a wrapped span's gap.
        anchor.focus();
        anchor.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown',
            keyCode: 40, bubbles: true, composed: true }));
        await wait(() => reader.root.querySelector('.mktero-annotation-actions'), 'existing PDF annotation actions popup');
        return anchor;
    }
    async function recolor(reader, key, color) {
        const anchor = await openAnnotationActions(reader, key);
        await pause(50);
        await writeJSON(`${config.run}/phase-${config.phase}.${reader.fixture.label}.color-popup.json`, {
            key, color, anchor: anchor.outerHTML, focused: reader.root.activeElement?.outerHTML,
            popup: reader.root.querySelector('.mktero-annotation-popup')?.outerHTML || null,
        });
        await click(reader.root, `.mktero-annotation-actions [data-color="${color}"]`, 'group color swatch');
    }
}
