// Serialized into the driver XPI. Use only Zotero/Gecko APIs here: the
// installed product is exercised through its menu and rendered controls.
export async function runSmoke(config) {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const writeJSON = (file, value) => IOUtils.writeUTF8(file, JSON.stringify(value, null, 2), { tmpPath: file + '.tmp' });
    const stage = value => IOUtils.writeUTF8(config.stagePath, value, { tmpPath: config.stagePath + '.tmp' });
    const targetsPref = 'extensions.mktero.researchNoteTargets';
    check(config.phase === 1 || config.phase === 2, 'Unknown validation phase');
    Services.io.offline = true;
    await stage('initializing isolated Zotero');
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    check(Zotero.Profile.dir === config.profile, 'Unexpected Zotero profile');
    check(Zotero.DataDirectory.dir === config.data, 'Unexpected Zotero data directory');
    check(Services.io.offline, 'Gecko offline mode is inactive');
    const libraryID = Zotero.Libraries.userLibraryID;
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const pause = milliseconds => new Promise(resolve => win.setTimeout(resolve, milliseconds));
    const wait = async (fn, label, timeout = 12000) => {
        const deadline = Date.now() + timeout;
        do {
            const value = await fn();
            if (value) return value;
            await pause(50);
        } while (Date.now() < deadline);
        throw new Error(`Timed out waiting for ${label}`);
    };
    const allItems = () => Zotero.Items.getAll(libraryID, false, true, false);
    const base = { zoteroVersion: Zotero.version, phase: config.phase,
        isolatedProfile: true, isolatedDataDirectory: true, geckoOffline: true };
    if (!config.product) {
        check((await allItems()).length === 0, 'Preflight library is not empty');
        if (config.phase === 1) {
            await writeJSON(config.statePath, { schemaVersion: 1, preflight: true,
                profile: config.profile, data: config.data, libraryID });
        }
        else {
            const saved = await IOUtils.readJSON(config.statePath);
            check(saved.preflight && saved.profile === config.profile && saved.data === config.data
                && saved.libraryID === libraryID, 'Preflight did not reuse the same profile/data/library');
        }
        return { mode: 'isolated-zotero-preflight-only', ...base, emptyLibrary: true,
            sameProfileRestart: config.phase === 2 };
    }

    await stage('verifying installed product XPI');
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const addon = await AddonManager.getAddonByID(config.product.id);
    check(addon?.isActive && addon.version === config.product.version, 'Product XPI was not active');
    const uri = Services.io.newFileURI(Zotero.File.pathToFile(config.product.xpiPath)).spec;
    check(addon.getResourceURI('bootstrap.js').spec === `jar:${uri}!/bootstrap.js`,
        'Product runtime did not come from the staged final XPI');
    const menu = await wait(() => doc.getElementById('mktero-read-as-markdown'), 'product item menu');
    await stage('waiting for native collections and items trees');
    await wait(() => win.ZoteroPane.collectionsView?.itemTreeView && win.ZoteroPane.itemsView,
        'native item tree before fixture save/import');
    await win.ZoteroPane.collectionsView.waitForLoad();
    await win.ZoteroPane.itemsView.waitForLoad();
    const checks = [];
    const readers = [];
    const layouts = [];
    const screenshots = [];
    // Both side columns must fit so the click is checked by Gecko's hit test.
    win.resizeTo(1280, 900);
    win.focus();
    let state;
    if (config.phase === 1) {
        await stage('creating two synthetic PDF attachments and one ordinary standalone note');
        check((await allItems()).length === 0, 'Expected an empty library before fixture creation');
        const targets = Zotero.Prefs.get(targetsPref, true);
        check(targets === undefined || targets === '{}' || targets === '', 'A research target already exists');
        const note = new Zotero.Item('note');
        note.libraryID = libraryID;
        note.setNote(`<h1>${config.fixtures.note.title}</h1><p>${config.fixtures.note.seed}</p>`);
        await note.saveTx();
        check(!note.parentID && note.getNoteTitle() === config.fixtures.note.title,
            'Fixture is not an ordinary standalone note with the expected title');
        state = { schemaVersion: 1, profile: config.profile, data: config.data,
            productSHA256: config.product.sha256, libraryID, expectedEvidence: [],
            note: { id: note.id, key: note.key, ...config.fixtures.note }, pdfs: [] };
        // Creating fixture annotations is setup. Pin, Continue and insertion
        // below always go through the product's actual rendered controls.
        for (const fixture of config.fixtures.pdfs) {
            const pdf = await Zotero.Attachments.importFromFile({ file: fixture.pdfPath, libraryID });
            const annotations = [];
            for (const [index, quote] of [fixture.quote, fixture.followupQuote].entries()) {
                const annotation = await Zotero.Annotations.saveFromJSON(pdf, {
                    key: Zotero.DataObjectUtilities.generateKey(), type: 'highlight',
                    text: quote, comment: '', color: '#ffd400', pageLabel: '1',
                    sortIndex: `00000|${String(index * 100).padStart(6, '0')}|00000`,
                    position: { pageIndex: 0, rects: [[40 + index * 210, 117, 245 + index * 210, 132]] },
                });
                annotations.push({ id: annotation.id, key: annotation.key, quote });
            }
            state.pdfs.push({ ...fixture, id: pdf.id, key: pdf.key, annotations,
                attachmentURI: Zotero.URI.getItemURI(pdf) });
        }
        await writeJSON(config.statePath, state);
        await verifyFixtureItems();

        const a = await openPDF(state.pdfs[0]);
        await stage('A: inspecting research-note setup and cancelling the standalone-note picker');
        await waitForSetup(a);
        const targetsBeforeSetup = JSON.stringify(readTargets());
        const noteHTMLBeforeSetup = await savedHTML();
        await captureWindow('phase-1-research-note-setup-A');
        await noAutomaticEditor(a, async () => {
            await click(a.root, '.mktero-research-note-choose', 'A Choose research note');
            await waitForResearchPicker(a);
            check(JSON.stringify(readTargets()) === targetsBeforeSetup, 'Opening the picker changed the research target');
            await click(a.root, '.mktero-research-note-cancel', 'A Cancel research note choice');
            await waitForSetup(a);
            check(a.root.querySelector('.mktero-research-note-picker').hidden, 'Cancelling did not hide the note picker');
            check(JSON.stringify(readTargets()) === targetsBeforeSetup, 'Cancelling the picker changed the research target');
        });
        check((await savedHTML()) === noteHTMLBeforeSetup, 'Cancelling research-note choice changed the fixture note content');
        checks.push({ check: 'research-setup-choose-cancel-without-target-or-editor', pdf: 'A',
            visibleStandaloneNote: state.note.title, createEnabled: true, chooseEnabled: true, passed: true });

        await stage('A: creating an ordinary standalone research note via its native Create button');
        await click(a.root, '.mktero-research-note-create', 'A Create research note');
        const createdNote = await wait(async () => {
            const added = (await allItems()).filter(item => item.isNote() && item.id !== state.note.id);
            check(added.length <= 1, 'Create research note created multiple notes');
            return added[0];
        }, 'new ordinary standalone Zotero note');
        check(createdNote.id && createdNote.key && !createdNote.parentID && !createdNote.deleted
            && createdNote.libraryID === libraryID, 'Created research note is not an ordinary standalone note');
        await Zotero.Items.loadDataTypes([createdNote], ['note']);
        check(createdNote.getNoteTitle() === 'Research note', 'Created research note has the wrong default title');
        state.createdNote = { id: createdNote.id, key: createdNote.key, title: 'Research note' };
        await writeJSON(config.statePath, state);
        await wait(() => readTargets()[String(libraryID)] === state.createdNote.key,
            'created research note key in preferences');
        await waitForTarget(a, state.createdNote);
        const createdEditor = await waitForEditor(a, state.createdNote);
        check(createdEditor.surface.textContent.trim() === state.createdNote.title,
            'Created note editor does not contain only the editable default title');
        await captureWindow('phase-1-created-research-note-A');
        await leaveEditor(a);
        await clearTarget(a);
        // Snapshot after the native editor's first save, which may normalize
        // note HTML. Later insertion and restart must leave this note alone.
        state.createdNote.contentHTML = await savedHTML(state.createdNote.id);
        check(typeof state.createdNote.contentHTML === 'string'
            && new win.DOMParser().parseFromString(state.createdNote.contentHTML, 'text/html')
                .body.textContent.trim() === state.createdNote.title,
        'Created research note was not saved with only its default title');
        await writeJSON(config.statePath, state);
        await verifyFixtureItems();
        checks.push({ check: 'create-research-note-via-control-and-clear-without-deletion', pdf: 'A',
            noteID: state.createdNote.id, noteKey: state.createdNote.key, title: state.createdNote.title,
            ordinaryStandaloneNote: true, mountedEditor: true, passed: true });

        await stage('A: choosing the fixture note to pin and open it, then clearing the target');
        await click(a.root, '.mktero-research-note-choose', 'A Choose existing research note');
        await waitForResearchPicker(a);
        await click(a.root, `.mktero-zotero-note-link[data-note-id="${state.note.id}"]`,
            'A standalone fixture note in research-note picker');
        await wait(() => readTargets()[String(libraryID)] === state.note.key, 'chosen fixture note key in preferences');
        await waitForTarget(a);
        await waitForEditor(a);
        check(a.root.querySelector('.mktero-research-note-picker').hidden, 'Selecting a note did not close the picker');
        await leaveEditor(a);
        await clearTarget(a);
        await verifyFixtureItems();
        checks.push({ check: 'choose-research-note-pins-and-opens-fixture-note', pdf: 'A',
            noteID: state.note.id, noteKey: state.note.key, clearedBeforeCardPinSequence: true, passed: true });

        await stage('A: pinning a standalone note from its card without opening an editor');
        await click(a.root, '[data-note-scope="standalone"]', 'standalone notes scope');
        const noteHTMLBeforePin = await savedHTML();
        await toggleCardPin(a, true);
        checks.push({ check: 'pin-via-card-without-editor', pdf: 'A', noteID: state.note.id,
            ariaPressed: 'true', mountedEditor: false, openedWindow: false, passed: true });
        await recordLayout(a, 'pinned-card-A-without-editor');
        await captureWindow('phase-1-pinned-card-A');

        await stage('A: clicking the same card pin to unpin without deleting or changing the note');
        await toggleCardPin(a, false);
        await verifyFixtureItems();
        check((await savedHTML()) === noteHTMLBeforePin, 'Unpinning changed the standalone note content');
        checks.push({ check: 'unpin-via-card-preserves-note', pdf: 'A', noteID: state.note.id,
            ariaPressed: 'false', mountedEditor: false, openedWindow: false, unchangedContent: true, passed: true });
        await captureWindow('phase-1-unpinned-card-A');

        await stage('A: repinning the same standalone note from its card without opening an editor');
        await toggleCardPin(a, true);
        checks.push({ check: 'repin-via-card-without-editor', pdf: 'A', noteID: state.note.id,
            ariaPressed: 'true', mountedEditor: false, openedWindow: false, passed: true });
        await stage('A: explicitly clicking Continue to open the pinned note editor');
        await click(a.root, '.mktero-research-note-continue', 'A Continue research note');
        const editorA = await waitForEditor(a);
        checks.push({ check: 'continue-after-card-pin', pdf: 'A', noteID: state.note.id, passed: true });
        await recordLayout(a, 'continued-editor-A');
        await captureWindow('phase-1-continued-A');

        await stage('A: inserting its saved PDF annotation via Add to Note');
        await moveCaretToEnd(editorA);
        await addAnnotation(a, state.pdfs[0]);
        await leaveEditor(a);
        await waitForSavedEvidence();
        checks.push({ check: 'add-pdf-annotation-via-control', pdf: 'A', noteID: state.note.id, passed: true });

        const b = await openPDF(state.pdfs[1]);
        await stage('B: shared target is visible without mounting a note editor');
        await waitForTarget(b);
        await noAutomaticEditor(b);
        await recordLayout(b, 'shared-target-B-without-editor');
        await captureWindow('phase-1-target-B-before-add');
        checks.push({ check: 'cross-tab-target-without-editor', pdf: 'B', passed: true });
        await stage('B: Add to Note must mount the pinned note on demand and insert B evidence');
        // No Continue/list click here: Add to Note itself must mount the target.
        await addAnnotation(b, state.pdfs[1]);
        await leaveEditor(b);
        await waitForSavedEvidence();
        checks.push({ check: 'add-to-note-mounts-pinned-note-on-demand', pdf: 'B',
            noteID: state.note.id, persistedEvidenceFrom: ['A', 'B'], passed: true });

        await stage('mounting the same native note in both A and B for coexistence validation');
        await selectReader(a);
        await click(a.root, '.mktero-research-note-continue', 'A Continue research note');
        await waitForEditor(a);
        await selectReader(b);
        await click(b.root, '.mktero-research-note-continue', 'B Continue research note');
        await waitForEditor(b);
        check(nativeEditors().length === 2, 'Expected two simultaneously mounted native note editors');
        const updates = [];
        for (const [reader, fixture] of [[a, state.pdfs[0]], [b, state.pdfs[1]]]) {
            await stage(`${fixture.label}: inserting new evidence while both native editors remain mounted`);
            await selectReader(reader);
            await waitForEditorEvidence(reader);
            await addAnnotation(reader, fixture, fixture.annotations[1]);
            const other = reader === a ? b : a;
            await selectReader(other);
            await waitForEditorEvidence(other);
            check(nativeEditors().length === 2, 'Switching tabs unexpectedly removed a native editor');
            updates.push({ insertedIn: fixture.label, observedIn: other.label, nativeEditors: 2,
                quote: fixture.annotations[1].quote, passed: true });
        }
        await captureWindow('phase-1-both-editors-updated');
        await selectReader(a);
        await leaveEditor(a);
        await selectReader(b);
        await leaveEditor(b);
        const contentHTML = await waitForSavedEvidence();
        await verifyFixtureItems();
        state.contentHTML = contentHTML;
        state.phase1Complete = true;
        await writeJSON(config.statePath, state);
        checks.push({ check: 'two-native-editors-share-updates-across-tab-switches', updates, passed: true });
    }
    else {
        await stage('loading phase-one IDs and content from the same profile');
        state = await IOUtils.readJSON(config.statePath);
        check(state.schemaVersion === 1 && state.phase1Complete, 'Phase one fixture state is incomplete');
        check(state.profile === config.profile && state.data === config.data && state.libraryID === libraryID,
            'Restart did not reuse the same profile, data directory and library');
        check(state.productSHA256 === config.product.sha256, 'Product XPI changed between phases');
        check(readTargets()[String(libraryID)] === state.note.key, 'Research target did not survive normal exit');
        await verifyFixtureItems();
        const persisted = await savedHTML();
        check(persisted === state.contentHTML, 'Database note HTML changed or was lost across restart');
        checkEvidence(persisted);
        checks.push({ check: 'same-profile-target-and-content-restored', noteID: state.note.id,
            noteKey: state.note.key, persistedEvidenceFrom: ['A', 'B'], passed: true });
        for (const fixture of state.pdfs) {
            const reader = await openPDF(fixture);
            await stage(`${fixture.label}: target restored without automatic editor after restart`);
            await waitForTarget(reader);
            await noAutomaticEditor(reader);
            await recordLayout(reader, `restored-target-${fixture.label}`);
            checks.push({ check: 'restart-target-without-editor', pdf: fixture.label, passed: true });
            if (fixture.label !== 'B') continue;
            await stage('B: Continue opens the restored note and both PDFs evidence');
            await click(reader.root, '.mktero-research-note-continue', 'Continue research note title');
            await waitForEditorEvidence(reader);
            await captureWindow('phase-2-restored-continue-B');
            checks.push({ check: 'continue-via-title-control', pdf: 'B', noteID: state.note.id,
                editorEvidenceFrom: ['A', 'B'], passed: true });
            await leaveEditor(reader);
        }
        checkEvidence(await savedHTML());
        await verifyFixtureItems();
    }
    await stage('closing synthetic reader tabs before normal application quit');
    for (const reader of readers.reverse()) {
        win.Zotero_Tabs.close(reader.tab);
        await wait(() => !reader.root.host.isConnected, `${reader.label} tab cleanup`);
    }
    check(Services.io.offline, 'Gecko went online during validation');
    return { mode: 'installed-product-xpi', ...base, productVersion: addon.version,
        xpiSHA256: config.product.sha256, noteID: state.note.id, noteKey: state.note.key,
        createdNote: state.createdNote && { id: state.createdNote.id, key: state.createdNote.key,
            title: state.createdNote.title },
        pdfIDs: state.pdfs.map(({ label, id, key }) => ({ label, id, key })), checks, layouts, screenshots };

    function readTargets() {
        const raw = Zotero.Prefs.get(targetsPref, true);
        return raw ? JSON.parse(raw) : {};
    }

    async function verifyFixtureItems() {
        const note = await Zotero.Items.getAsync(state.note.id);
        check(note?.isNote() && !note.deleted && !note.parentID && note.libraryID === libraryID
            && note.key === state.note.key, 'Expected the same ordinary standalone Zotero note');
        await Zotero.Items.loadDataTypes([note], ['note']);
        check(note.getNoteTitle() === state.note.title, 'Standalone note title was changed by insertion');
        const notes = (await allItems()).filter(item => item.isNote());
        const expectedNoteIDs = [note.id];
        if (state.createdNote) {
            const created = await Zotero.Items.getAsync(state.createdNote.id);
            check(created?.isNote() && !created.deleted && !created.parentID && created.libraryID === libraryID
                && created.key === state.createdNote.key, 'Created ordinary standalone research note was lost or changed');
            await Zotero.Items.loadDataTypes([created], ['note']);
            check(created.getNoteTitle() === state.createdNote.title, 'Created research note title was changed');
            check(typeof state.createdNote.contentHTML === 'string'
                && (await savedHTML(created.id)) === state.createdNote.contentHTML,
            'Insertion or restart changed the separately created research note content');
            expectedNoteIDs.push(created.id);
        }
        check(notes.length === expectedNoteIDs.length && notes.every(item => expectedNoteIDs.includes(item.id)),
            'Insertion created or selected an unexpected note');
        check(state.pdfs.length === 2 && state.pdfs[0].id !== state.pdfs[1].id, 'Expected two distinct PDF attachments');
        for (const fixture of state.pdfs) {
            const pdf = await Zotero.Items.getAsync(fixture.id);
            check(pdf?.isPDFAttachment() && pdf.key === fixture.key && pdf.libraryID === libraryID
                && !pdf.deleted && !pdf.parentID, `${fixture.label}: original synthetic PDF is unavailable`);
            for (const stored of fixture.annotations) {
                const annotation = await Zotero.Items.getAsync(stored.id);
                check(annotation?.isAnnotation() && annotation.key === stored.key
                    && annotation.parentID === pdf.id && !annotation.deleted,
                `${fixture.label}: persisted PDF annotation is unavailable`);
            }
            check((await pdf.getFilePathAsync()).startsWith(config.data + '/'), 'PDF escaped the isolated data directory');
        }
    }

    async function openPDF(fixture) {
        await stage(`opening saved PDF ${fixture.label} via product item menu`);
        await wait(() => win.ZoteroPane.collectionsView, 'Zotero collections tree');
        win.Zotero_Tabs.select('zotero-pane');
        await win.ZoteroPane.selectItem(fixture.id, { inLibraryRoot: true });
        check(win.ZoteroPane.getSelectedItems().map(item => item.id).join() === String(fixture.id), 'Wrong PDF selected');
        menu.parentNode.dispatchEvent(new win.Event('popupshowing', { bubbles: true }));
        check(!menu.hidden && !menu.disabled, 'Product menu is unavailable for the saved PDF');
        menu.dispatchEvent(new win.Event('command', { bubbles: true }));
        const root = await wait(() => [...doc.querySelectorAll('.mktero-tab-host')].map(host => host.shadowRoot)
            .find(shadow => shadow?.querySelector('.cm-content')?.textContent.includes(fixture.markdown)),
        `${fixture.label} original Markdown from offline cache`);
        const reader = { root, tab: win.Zotero_Tabs.selectedID, label: fixture.label };
        check(reader.tab && reader.tab !== 'zotero-pane', 'Product reader tab did not open');
        readers.push(reader);
        for (const name of ['notes', 'outline']) {
            const selector = `#mktero-${name}-toggle`;
            const toggle = await wait(() => root.querySelector(selector), `${name} column toggle`);
            if (toggle.getAttribute('aria-expanded') === 'false') await click(root, selector, `${name} column toggle`);
            await wait(() => toggle.getAttribute('aria-expanded') === 'true', `${name} column visibility`);
        }
        await click(root, '#mktero-outline-segment-annotations', 'Annotations sidebar segment');
        check(!root.querySelector('.mktero-research-note-change'),
            `${reader.label}: legacy research-note change class is still present`);
        checks.push({ check: 'research-strip-change-control-absent', pdf: reader.label, passed: true });
        return reader;
    }

    function visible(node) {
        return node && !node.hidden && node.getClientRects().length
            && win.getComputedStyle(node).visibility !== 'hidden';
    }

    async function click(root, selector, label) {
        const node = await wait(() => {
            const candidate = root.querySelector(selector);
            return visible(candidate) && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true' && candidate;
        }, `enabled visible ${label}`);
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = node.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        check(node.contains(root.elementFromPoint(x, y)), `${label} is covered or not clickable`);
        let clicks = 0;
        const record = () => clicks++;
        node.addEventListener('click', record);
        try {
            win.windowUtils.sendMouseEvent('mousedown', x, y, 0, 1, 0);
            win.windowUtils.sendMouseEvent('mouseup', x, y, 0, 1, 0);
            check(clicks === 1, `Expected one native click on ${label}; received ${clicks}`);
        }
        finally { node.removeEventListener('click', record); }
        return node;
    }

    async function waitForCardPin(reader, pinned) {
        const button = await wait(() => {
            const candidate = reader.root.querySelector(`.mktero-zotero-note-pin-card[data-note-id="${state.note.id}"]`);
            return visible(candidate) && !candidate.disabled
                && candidate.getAttribute('aria-pressed') === String(pinned) && candidate;
        }, `${reader.label} standalone card pin aria-pressed=${pinned}`);
        const link = reader.root.querySelector(`.mktero-zotero-note-link[data-note-id="${state.note.id}"]`);
        check(button.localName === 'button' && button.type === 'button'
            && link && button !== link && button.parentNode === link.parentNode
            && !button.parentElement.closest('button'),
        `${reader.label}: card pin must be a separate button beside the note's main button`);
        return button;
    }

    async function toggleCardPin(reader, pinned) {
        await waitForCardPin(reader, !pinned);
        await noAutomaticEditor(reader, async () => {
            await click(reader.root, `.mktero-zotero-note-pin-card[data-note-id="${state.note.id}"]`,
                `${reader.label} standalone card ${pinned ? 'Pin' : 'Unpin'}`);
            await waitForCardPin(reader, pinned);
            await wait(() => readTargets()[String(libraryID)] === (pinned ? state.note.key : undefined),
                `${reader.label} ${pinned ? 'pinned' : 'cleared'} note key in preferences`);
            if (pinned) await waitForTarget(reader);
            else await wait(() => !visible(reader.root.querySelector('.mktero-research-note')),
                `${reader.label} research strip hidden after unpin`);
        });
    }

    async function waitForSetup(reader) {
        await wait(() => {
            const setup = reader.root.querySelector('.mktero-research-note-setup');
            const create = setup?.querySelector('.mktero-research-note-create');
            const choose = setup?.querySelector('.mktero-research-note-choose');
            return visible(setup) && visible(create) && !create.disabled && visible(choose) && !choose.disabled;
        }, `${reader.label} unpinned research-note setup with enabled Create and Choose`);
        check(readTargets()[String(libraryID)] === undefined, `${reader.label}: setup appeared with a research target`);
        check(!visible(reader.root.querySelector('.mktero-research-note')),
            `${reader.label}: research strip is visible without a target`);
    }

    async function waitForResearchPicker(reader) {
        await wait(() => {
            const picker = reader.root.querySelector('.mktero-research-note-picker');
            const link = reader.root.querySelector(`.mktero-zotero-note-link[data-note-id="${state.note.id}"]`);
            const title = link?.querySelector('.mktero-zotero-note-title');
            return visible(picker) && visible(link) && !link.disabled
                && visible(title) && title.textContent === state.note.title;
        }, `${reader.label} research-note picker naming the standalone fixture note`);
        check(reader.root.querySelector('[data-note-scope="standalone"]').getAttribute('aria-selected') === 'true'
            && reader.root.querySelector('.mktero-zotero-notes-list').getAttribute('aria-labelledby')
                === 'mktero-zotero-notes-tab-standalone',
        `${reader.label}: research-note picker is not showing standalone notes`);
        check(reader.root.querySelector('.mktero-research-note-setup').hidden,
            `${reader.label}: setup remains visible while choosing a note`);
    }

    async function clearTarget(reader) {
        await noAutomaticEditor(reader, async () => {
            await click(reader.root, '.mktero-research-note-clear', `${reader.label} Clear research note`);
            await wait(() => readTargets()[String(libraryID)] === undefined,
                `${reader.label} cleared research target in preferences`);
            await waitForSetup(reader);
        });
    }

    async function waitForTarget(reader, note = state.note) {
        await wait(() => {
            const strip = reader.root.querySelector('.mktero-research-note');
            const title = strip?.querySelector('.mktero-research-note-title');
            const button = strip?.querySelector('.mktero-research-note-continue');
            return visible(strip) && title?.textContent === note.title && button && !button.disabled;
        }, `${reader.label} research strip naming the pinned note`);
        check(!reader.root.querySelector('.mktero-research-note-change'),
            `${reader.label}: legacy research-note change class is still present`);
    }

    async function noAutomaticEditor(reader, action = async () => {}) {
        const host = reader.root.host;
        check(!host.querySelector('note-editor'), `${reader.label}: note editor mounted before Continue/Add to Note`);
        let mounted = false;
        let openedWindow = false;
        const windowObserver = { observe(_subject, topic) {
            if (topic === 'domwindowopened') openedWindow = true;
        } };
        const observer = new win.MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
                if (node.matches?.('note-editor') || node.querySelector?.('note-editor')) mounted = true;
            }
        });
        observer.observe(host, { childList: true, subtree: true });
        Services.ww.registerNotification(windowObserver);
        try {
            await action();
            await pause(500);
            check(!mounted && !host.querySelector('note-editor'), `${reader.label}: target update auto-mounted an editor`);
            check(!openedWindow, `${reader.label}: target update opened a separate window`);
        }
        finally {
            observer.disconnect();
            Services.ww.unregisterNotification(windowObserver);
        }
    }

    async function waitForEditor(reader, note = state.note) {
        return wait(() => {
            const editor = reader.root.host.querySelector('note-editor');
            const instance = editor?.getCurrentInstance?.();
            const frame = editor?._iframe || editor?.querySelector('#editor-view') || editor?.querySelector('iframe');
            const surface = frame?.contentDocument?.querySelector('.ProseMirror');
            if (!instance || !visible(editor) || !surface) return null;
            check(editor.item?.id === note.id && editor.item?.key === note.key,
                `${reader.label}: editor mounted a different note`);
            const destination = reader.root.querySelector('.mktero-note-destination');
            if (!visible(destination) || !destination.textContent.includes(note.title)) return null;
            return { editor, surface, destination: destination.textContent };
        }, `${reader.label} native Zotero note editor for note ${note.id}`);
    }

    async function moveCaretToEnd({ surface }) {
        // Only position the native editor caret. All content insertion still
        // comes from the product's Add to Note control and insertAnnotations().
        surface.focus();
        const selection = surface.ownerDocument.getSelection();
        selection.selectAllChildren(surface);
        selection.collapseToEnd();
        await pause(100);
    }

    function editorHasEvidence({ surface }, pdfs) {
        return surface.textContent.includes(state.note.seed)
            && pdfs.every(fixture => surface.textContent.includes(fixture.quote));
    }

    function nativeEditors() {
        return [...doc.querySelectorAll('.mktero-tab-host note-editor')];
    }

    async function selectReader(reader) {
        win.Zotero_Tabs.select(reader.tab);
        await wait(() => win.Zotero_Tabs.selectedID === reader.tab
            && visible(reader.root.querySelector('#mktero-notes')), `${reader.label} tab selected`);
    }

    async function waitForEditorEvidence(reader) {
        return wait(async () => {
            const mounted = await waitForEditor(reader);
            return editorHasEvidence(mounted, state.expectedEvidence) && mounted;
        }, `${reader.label} editor showing every inserted evidence quote`);
    }

    async function addAnnotation(reader, fixture, annotation = fixture.annotations[0]) {
        const selector = `.markdown-note-add-to-note[data-annotation-id="${annotation.key}"]`;
        const mountedBefore = reader.root.host.querySelector('note-editor');
        if (mountedBefore) await moveCaretToEnd(await waitForEditor(reader));
        await click(reader.root, selector, `${fixture.label} saved PDF annotation Add to Note`);
        const mounted = await waitForEditor(reader);
        await wait(() => editorHasEvidence(mounted, [annotation]), `${fixture.label} evidence in the pinned note editor`);
        const hint = await wait(() => {
            const node = reader.root.querySelector('.mktero-note-continuation-hint');
            return visible(node) && node;
        }, `${fixture.label} continuation hint after Add to Note`);
        const hintText = hint.querySelector('.mktero-note-continuation-text')?.textContent.trim();
        check(hintText, `${fixture.label}: continuation hint has no text`);
        check(!mounted.surface.textContent.includes(hintText), `${fixture.label}: continuation hint leaked into the native editor`);
        if (state.continuationHintText) {
            check(hintText === state.continuationHintText, 'Continuation hint text changed between insertions');
        }
        state.continuationHintText = hintText;
        checks.push({ check: 'excerpt-continuation-hint-outside-native-editor', pdf: fixture.label,
            annotationKey: annotation.key, noteID: state.note.id, passed: true });
        const prompts = hint.querySelector('.mktero-note-thinking-prompts');
        const summary = prompts?.querySelector('summary');
        const questions = [...(prompts?.querySelectorAll('li') || [])].map(node => node.textContent);
        check(prompts && summary && !prompts.open && questions.length === 4,
            'Thinking prompts must initially be collapsed with four questions');
        check(!hint.querySelector('input, textarea, [contenteditable]'), 'Hint added an editable surface');
        state.thinkingPromptText = [summary.textContent, ...questions];
        const beforeThoughts = mounted.surface.textContent;
        const caretBefore = noteCaret(mounted);
        await click(reader.root, '.mktero-note-thinking-summary', `${fixture.label} Expand thinking prompts`);
        check(prompts.open, 'Native thinking disclosure did not expand');
        check(mounted.surface.textContent === beforeThoughts, 'Expanding prompts edited the note');
        // The keyboard operates the disclosure, without sending focus back to the editor.
        check(reader.root.activeElement === summary, 'Disclosure did not keep keyboard focus');
        nativeKey(win, 'Enter');
        await wait(() => !prompts.open, 'thinking prompts collapsed by keyboard');
        nativeKey(win, 'Enter');
        await wait(() => prompts.open, 'thinking prompts expanded by keyboard');
        await recordThinkingLayout(reader);
        if (!state.thinkingScreenshot) {
            await captureWindow('phase-1-thinking-prompts-expanded');
            // Zotero's main window has a native minimum height. Constrain the
            // actual notes editor area to exercise the short-space layout even
            // when the platform refuses to resize the top-level test window.
            const editorView = reader.root.querySelector('.mktero-zotero-notes-editor-view');
            editorView.style.maxHeight = '320px';
            await recordThinkingLayout(reader, 'constrained-height-thinking-prompts');
            await captureWindow('phase-1-thinking-prompts-constrained-height');
            editorView.style.removeProperty('max-height');
            state.thinkingScreenshot = true;
        }
        await click(reader.root, '.mktero-note-continuation-dismiss', `${fixture.label} Dismiss continuation hint`);
        await wait(() => hint.hidden && !prompts.open, `${fixture.label} continuation hint closed and reset`);
        const afterDismiss = await waitForEditor(reader);
        check(afterDismiss.editor === mounted.editor && afterDismiss.surface === mounted.surface,
            'Thinking controls replaced the native editor');
        check(mounted.surface.textContent === beforeThoughts, 'Thinking controls edited the note');
        await wait(() => mounted.surface.ownerDocument.activeElement === mounted.surface,
            'native editor focus after dismiss');
        check(noteCaret(mounted) === caretBefore, 'Dismissing prompts moved the excerpt caret');
        const thought = `My question after excerpt ${state.expectedEvidence.length + 1}: what could explain this result?`;
        // Do not focus, set a selection, move the caret, or call an editor insert
        // API here: type into precisely the focus/selection the product left.
        const frameWindow = mounted.surface.ownerDocument.defaultView;
        nativeKey(frameWindow, 'Enter');
        for (const character of thought) nativeKey(frameWindow, character);
        await wait(() => mounted.surface.textContent.includes(thought), 'natural native-keyboard continuation');
        const paragraph = [...mounted.surface.querySelectorAll('p')].find(node => node.textContent === thought);
        check(paragraph && !paragraph.querySelector('.highlight, .citation, [data-annotation]'),
            'Typed thought is not a separate plain paragraph outside excerpt and citation');
        state.userThoughts ||= [];
        state.userThoughts.push(thought);
        checks.push({ check: 'thinking-disclosure-keyboard-dismiss-and-natural-continuation', pdf: fixture.label,
            noteID: state.note.id, sameEditor: true, restoredCaretOffset: caretBefore,
            nativeKeyboardInput: true, thoughtOutsideExcerpt: true, passed: true });
        if (state.userThoughts.length === 1) await captureWindow('phase-1-natural-continuation-after-dismiss');
        state.expectedEvidence.push({ label: fixture.label, quote: annotation.quote,
            annotationKey: annotation.key, attachmentURI: fixture.attachmentURI });
    }

    function nativeKey(targetWindow, key) {
        const { classes: Cc, interfaces: Ci } = Components;
        const input = Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);
        check(input.beginInputTransactionForTests(targetWindow, null), 'Native keyboard transaction unavailable');
        const enter = key === 'Enter';
        const code = enter ? 'Enter' : input.guessCodeValueOfPrintableKeyInUSEnglishKeyboardLayout(key);
        const keyCode = enter ? 13 : input.guessKeyCodeValueOfPrintableKeyInUSEnglishKeyboardLayout(key);
        const flags = enter ? Ci.nsITextInputProcessor.KEY_NON_PRINTABLE_KEY
            : Ci.nsITextInputProcessor.KEY_FORCE_PRINTABLE_KEY;
        const event = new targetWindow.KeyboardEvent('', { key, code, keyCode });
        input.keydown(event, flags);
        input.keyup(event, flags);
    }

    function noteCaret({ surface }) {
        const selection = surface.ownerDocument.getSelection();
        check(selection?.isCollapsed && surface.contains(selection.anchorNode),
            'Expected a collapsed caret inside the native note');
        const range = surface.ownerDocument.createRange();
        range.selectNodeContents(surface);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        return range.toString().length;
    }

    async function recordThinkingLayout(reader, label = 'expanded-thinking-prompts-' + reader.label) {
        const hint = reader.root.querySelector('.mktero-note-continuation-hint');
        const slot = reader.root.querySelector('.mktero-zotero-note-slot');
        const view = reader.root.querySelector('.mktero-zotero-notes-editor-view');
        const hintRect = hint.getBoundingClientRect();
        const viewRect = view.getBoundingClientRect();
        const editorRect = slot.getBoundingClientRect();
        const layout = { phase: config.phase, label,
            width: hintRect.width, clientWidth: hint.clientWidth, scrollWidth: hint.scrollWidth,
            height: hintRect.height, editorHeight: editorRect.height, viewHeight: viewRect.height };
        layouts.push(layout);
        check(hint.scrollWidth <= hint.clientWidth + 1, 'Thinking prompts overflow the notes column');
        check(hintRect.height <= viewRect.height * 0.4 + 1 && editorRect.height > viewRect.height * 0.4,
            'Expanded thinking prompts leave too little room for native writing');
        await writeJSON(config.run + `/phase-${config.phase}.layouts.json`, layouts);
    }

    async function leaveEditor(reader) {
        await click(reader.root, '.mktero-zotero-note-back', 'Back to notes list (save native editor)');
        await wait(() => !reader.root.host.querySelector('note-editor'), 'native editor cleanup');
    }

    async function savedHTML(noteID = state.note.id) {
        return Zotero.DB.valueQueryAsync('SELECT note FROM itemNotes WHERE itemID = ?', [noteID]);
    }

    function checkEvidence(html, evidence = state.expectedEvidence) {
        check(typeof html === 'string', 'Standalone note is missing from the database');
        const parsed = new win.DOMParser().parseFromString(html, 'text/html');
        const text = parsed.body.textContent;
        check(typeof state.continuationHintText === 'string' && state.continuationHintText,
            'Missing continuation hint text for saved-content verification');
        check(!html.includes(state.continuationHintText) && !text.includes(state.continuationHintText)
            && !parsed.querySelector('.mktero-note-continuation-hint'), 'Continuation hint was saved into note HTML');
        for (const prompt of state.thinkingPromptText || []) {
            check(!text.includes(prompt), 'A thinking prompt was saved into the note');
        }
        for (const thought of state.userThoughts || []) {
            const paragraphs = [...parsed.querySelectorAll('p')].filter(node => node.textContent === thought);
            check(paragraphs.length === 1 && !paragraphs[0].querySelector('.highlight, .citation, [data-annotation]'),
                'A naturally typed thought was lost, duplicated or saved inside an excerpt');
        }
        check(text.includes(state.note.seed), 'Standalone note seed was lost');
        const annotations = [...parsed.querySelectorAll('[data-annotation]')]
            .map(node => JSON.parse(decodeURIComponent(node.getAttribute('data-annotation'))));
        for (const fixture of evidence) {
            check(text.split(fixture.quote).length === 2, `${fixture.label}: expected exactly one saved evidence quote`);
            const matching = annotations.filter(value => value.attachmentURI === fixture.attachmentURI
                && value.annotationKey === fixture.annotationKey && value.position?.pageIndex === 0);
            check(matching.length === 1, `${fixture.label}: evidence is missing its original PDF annotation source`);
        }
    }

    async function waitForSavedEvidence() {
        return wait(async () => {
            const html = await savedHTML();
            try { checkEvidence(html); return html; }
            catch { return null; }
        }, 'database note content and source metadata for every inserted quote');
    }

    async function recordLayout(reader, label) {
        const aside = reader.root.querySelector('#mktero-notes');
        const strip = reader.root.querySelector('.mktero-research-note');
        const row = strip.querySelector('.mktero-research-note-row');
        const rect = strip.getBoundingClientRect();
        const controls = [...row.querySelectorAll('button')].map(node => {
            const bounds = node.getBoundingClientRect();
            return { className: node.className, width: bounds.width, left: bounds.left, right: bounds.right,
                insideStrip: bounds.left >= rect.left - 1 && bounds.right <= rect.right + 1 };
        });
        const layout = { phase: config.phase, label, sidebarWidth: aside.getBoundingClientRect().width,
            stripWidth: rect.width, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth,
            rowClientWidth: row.clientWidth, rowScrollWidth: row.scrollWidth, controls };
        layout.horizontalOverflow = strip.scrollWidth > strip.clientWidth + 1
            || row.scrollWidth > row.clientWidth + 1 || controls.some(control => !control.insideStrip);
        layouts.push(layout);
        await writeJSON(config.run + `/phase-${config.phase}.layouts.json`, layouts);
        check(Math.abs(layout.sidebarWidth - 300) <= 2, `Expected a 300px notes column; got ${layout.sidebarWidth}`);
        check(!layout.horizontalOverflow, `Research strip overflows its 300px notes column (${label})`);
    }

    async function captureWindow(name) {
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
            const data = win.atob(canvas.toDataURL('image/png').split(',')[1]);
            const file = config.run + '/' + name + '.png';
            await IOUtils.write(file, Uint8Array.from(data, value => value.charCodeAt(0)));
            screenshots.push({ name, available: true, file });
        }
        catch (error) {
            screenshots.push({ name, available: false, reason: String(error) });
        }
        finally {
            canvas.width = canvas.height = 0;
            await writeJSON(config.run + `/phase-${config.phase}.screenshots.json`, screenshots);
        }
    }
}
