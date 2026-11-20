// Serialized into the temporary driver XPI. All source modules arrive in the
// unmodified editor bundle; this driver only uses its exported reader APIs.
export async function runCaptionSelectionSmoke(config) {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const stage = value => IOUtils.writeUTF8(config.stagePath, value, {
        tmpPath: config.stagePath + '.tmp',
    });
    Services.io.offline = true;
    await stage('initializing isolated caption reader');
    await Zotero.initializationPromise;
    await Zotero.uiReadyPromise;
    check(Zotero.Profile.dir === config.profile, 'Unexpected Zotero profile');
    check(Zotero.DataDirectory.dir === config.data, 'Unexpected Zotero data directory');
    check(Services.io.offline, 'Gecko offline mode is inactive');
    check((await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, true, true)).length === 0,
        'Expected an empty isolated library');
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const uri = file => Services.io.newFileURI(Zotero.File.pathToFile(file)).spec;
    Services.scriptloader.loadSubScript(uri(config.run + '/editor.js'), win);
    const api = win.MkteroCaptionHarness;
    const ns = 'http://www.w3.org/1999/xhtml';
    const sleep = milliseconds => new Promise(resolve => win.setTimeout(resolve, milliseconds));
    const frame = () => new Promise(resolve => win.requestAnimationFrame(resolve));
    const wait = async (read, label) => {
        const deadline = Date.now() + 2500;
        do {
            const value = read();
            if (value) return value;
            await sleep(30);
        } while (Date.now() < deadline);
        throw new Error(`Timed out waiting for ${label}`);
    };
    const settle = async () => { await frame(); await frame(); await sleep(100); };
    const normalize = text => String(text || '').replace(/\s+/gu, ' ').trim();
    const reports = [];
    const errors = [];
    const onError = event => errors.push(String(event.error || event.message || 'window error'));
    win.addEventListener('error', onError);
    const image = new win.Blob([
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="48">'
            + '<rect width="180" height="48" fill="#dbe7ef"/></svg>',
    ], { type: 'image/svg+xml' });
    const imageURL = win.URL.createObjectURL(image);
    const css = await IOUtils.readUTF8(config.run + '/reader.css');
    let current;
    let peer;
    let nativeGestures = 0;
    let savedHighlights = 0;
    let multiEditorChecked = false;
    try {
        for (const fixture of config.fixtures) {
            await stage(`caption / ${fixture.id}`);
            current = await createReader(fixture);
            check(current.caption.querySelectorAll('.math-inline').length > 0 || !fixture.requireMath,
                `${fixture.id}: expected typeset formulas`);
            const imageCount = current.caption.closest('figure').querySelectorAll('img').length;
            check(imageCount >= fixture.minImages, `${fixture.id}: missing figure panels (${imageCount})`);
            for (const direction of ['forward', 'backward', 'multiline']) {
                await stage(`${fixture.id} / ${direction}`);
                const plan = selectionPlan(current, direction);
                const saved = await dragAndSave(current, plan, `${fixture.id}/${direction}`);
                reports.push({ fixture: fixture.id, label: fixture.label, width: current.width,
                    direction, selectedCharacters: saved.text.length, ranges: saved.ranges.length,
                    passed: true });
            }
            await checkCancelAndRestart(current, fixture.id);
            await checkOrdinaryText(current, fixture.id);
            if (!multiEditorChecked) {
                // Keep another live reader in the same document while the first
                // one owns a retained caption selection, then destroy only it.
                await revealCaption(current);
                const retainedPlan = selectionPlan(current, 'forward');
                await nativeDrag(retainedPlan.from, retainedPlan.to);
                await settle();
                checkCaptionSelection(current, `${fixture.id}/before-peer`);
                peer = await createReader(config.fixtures[1] || fixture, true);
                await dragAndSave(peer, selectionPlan(peer, 'forward'), 'second-live-editor');
                reports.push({ fixture: 'second-live-editor', direction: 'forward', passed: true });
                await destroyReader(peer);
                peer = null;
                await checkOrdinaryText(current, `${fixture.id}/after-peer-destroy`);
                await checkLeavingCaption(current);
                multiEditorChecked = true;
            }
            await destroyReader(current);
            current = null;
            await IOUtils.writeUTF8(config.run + '/progress.json', JSON.stringify({
                completedFixtures: fixture.id, nativeGestures, savedHighlights, reports,
            }, null, 2));
        }
        await stage('checking cleanup after reader destruction');
        await checkCleanup();
        check(errors.length === 0, `Unexpected window errors: ${errors.join('; ')}`);
        check(Services.io.offline, 'Gecko went online');
        return { mode: 'unmodified-editor-source-in-real-gecko', zoteroVersion: Zotero.version,
            fixtureCount: config.fixtures.length, nativeGestures, savedHighlights,
            reports, ordinaryText: true, cancelAndRestart: true, multipleEditors: true,
            destroyCleanup: true, windowErrors: errors, geckoOffline: true };
    }
    finally {
        if (peer) await destroyReader(peer);
        if (current) await destroyReader(current);
        win.URL.revokeObjectURL(imageURL);
        win.removeEventListener('error', onError);
    }

    async function createReader(fixture, second = false) {
        const host = doc.createElementNS(ns, 'div');
        const available = win.innerWidth - 48;
        const width = Math.min(fixture.width, available);
        host.style.cssText = `position:fixed;top:${second ? 40 : 20}px;left:${second ? 40 : 20}px;`
            + `width:${width}px;height:${win.innerHeight - 64}px;z-index:${second ? 2147483647 : 2147483646};`
            + 'background:white;color:#222;';
        doc.documentElement.append(host);
        const root = host.attachShadow({ mode: 'open' });
        const link = doc.createElementNS(ns, 'link');
        link.rel = 'stylesheet';
        link.href = uri(config.run + '/katex/katex.min.css');
        root.append(link);
        const style = doc.createElementNS(ns, 'style');
        style.textContent = css;
        root.append(style);
        const parent = doc.createElementNS(ns, 'div');
        parent.className = 'markdown-editor-host';
        parent.style.cssText = 'width:100%;height:100%;';
        root.append(parent);
        const created = [];
        const editor = api.createInlineMarkdownEditor({
            parent,
            initialMarkdown: fixture.markdown,
            resolveImageURL: () => imageURL,
            createMarkdownAnnotation: async annotation => {
                created.push(JSON.parse(JSON.stringify(annotation)));
                return annotation;
            },
        });
        const caption = await wait(() => root.querySelector('figcaption'), `${fixture.id} caption`);
        await settle();
        check(root.querySelectorAll('figcaption').length === 1, `${fixture.id}: expected one shared caption`);
        const reader = { host, root, parent, editor, fixture, caption, created, width };
        await revealCaption(reader);
        return reader;
    }

    function visibleTextNodes(element) {
        const walker = doc.createTreeWalker(element, win.NodeFilter.SHOW_TEXT);
        const nodes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent.trim() || node.parentElement.closest('.math-inline, .mktero-figure-label')) continue;
            nodes.push(node);
        }
        return nodes;
    }

    function point(node, offset, optional = false) {
        const range = doc.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(offset + 1, node.textContent.length));
        let rect = range.getBoundingClientRect();
        let trailing = false;
        if (rect.width <= 0 && offset > 0) {
            range.setStart(node, offset - 1);
            range.setEnd(node, offset);
            rect = range.getBoundingClientRect();
            trailing = true;
        }
        if (rect.width <= 0 || rect.height <= 0) {
            if (optional) return null;
            throw new Error('Selection point has no visible geometry');
        }
        return { x: trailing ? rect.right - Math.min(1, rect.width / 3)
            : rect.x + Math.min(1, rect.width / 3), y: rect.y + rect.height / 2,
        node, offset };
    }

    function visiblePoint(reader, node, offset) {
        const candidate = point(node, offset, true);
        if (!candidate) return null;
        const scroller = reader.root.querySelector('.cm-scroller').getBoundingClientRect();
        const host = reader.host.getBoundingClientRect();
        const top = Math.max(scroller.top, host.top, 0) + 3;
        const bottom = Math.min(scroller.bottom, host.bottom, win.innerHeight) - 8;
        return candidate.y >= top && candidate.y <= bottom
            && candidate.x >= Math.max(scroller.left, host.left, 0)
            && candidate.x <= Math.min(scroller.right, host.right, win.innerWidth)
            ? candidate : null;
    }

    async function revealCaption(reader) {
        reader.caption.scrollIntoView({ block: 'start', inline: 'nearest' });
        await settle();
    }

    function selectionPlan(reader, direction) {
        const nodes = visibleTextNodes(reader.caption);
        const first = nodes.find(node => /\S+(?:\s+\S+){1,3}/u.test(node.textContent.trim())
            && node.textContent.trim().length >= 5);
        check(first, `${reader.fixture.id}: no selectable caption prose`);
        const start = first.textContent.search(/\S/u);
        const phrase = /\S+(?:\s+\S+){1,3}/u.exec(first.textContent.slice(start));
        check(phrase && phrase[0].length >= 5, `${reader.fixture.id}: needs a prose selection`);
        const from = visiblePoint(reader, first, start);
        check(from, `${reader.fixture.id}: caption start is outside the visible reader`);
        let to;
        let expected;
        if (direction === 'multiline') {
            const lineHeight = Number.parseFloat(win.getComputedStyle(reader.caption).lineHeight) || 22;
            const targetBottom = from.y + lineHeight * 4;
            for (const node of nodes.slice(nodes.indexOf(first))) {
                for (const word of node.textContent.matchAll(/\S+/gu)) {
                    const end = word.index + word[0].length;
                    if (end >= node.textContent.length) continue;
                    const candidate = visiblePoint(reader, node, end);
                    if (candidate && candidate.y > from.y + 8 && candidate.y <= targetBottom) to = candidate;
                }
            }
            check(to, `${reader.fixture.id}: multiline selection needs at least two visible lines`);
        }
        else {
            to = visiblePoint(reader, first, start + phrase[0].length);
            check(to, `${reader.fixture.id}: prose selection endpoint is outside the reader`);
            expected = normalize(phrase[0]);
        }
        return { from: direction === 'backward' ? to : from,
            to: direction === 'backward' ? from : to, expected };
    }

    async function nativeDrag(from, to) {
        nativeGestures++;
        win.windowUtils.sendMouseEvent('mousedown', from.x, from.y, 0, 1, 0);
        for (let index = 1; index <= 12; index++) {
            win.windowUtils.sendMouseEvent('mousemove', from.x + (to.x - from.x) * index / 12,
                from.y + (to.y - from.y) * index / 12, 0, 1, 0);
            await sleep(12);
        }
        win.windowUtils.sendMouseEvent('mouseup', to.x, to.y, 0, 1, 0);
    }

    function checkCaptionSelection(reader, label) {
        const selection = api.rootSelectionFor(reader.parent);
        const caption = reader.root.querySelector('figcaption');
        check(!selection.isCollapsed && selection.rangeCount === 1
            && caption.contains(selection.anchorNode) && caption.contains(selection.focusNode),
        `${label}: native selection escaped caption: ${JSON.stringify(selection.toString())}`);
        const snapshot = api.readSelectedAnnotation(reader.parent);
        check(snapshot?.text && snapshot.ranges?.length, `${label}: no source selection snapshot`);
        check(!snapshot.text.includes(config.beforeText) && !snapshot.text.includes(config.afterText),
            `${label}: selection includes an adjacent paragraph`);
        check(api.markdownAnnotationRangeMatchesSource(reader.fixture.markdown, snapshot.ranges, snapshot.text),
            `${label}: source ranges do not quote their selected text`);
        return snapshot;
    }

    async function dragAndSave(reader, plan, label) {
        await nativeDrag(plan.from, plan.to);
        await settle();
        const snapshot = checkCaptionSelection(reader, label);
        if (plan.expected) check(normalize(snapshot.text) === plan.expected,
            `${label}: wrong selected phrase: ${JSON.stringify(snapshot.text)}; expected ${JSON.stringify(plan.expected)}`);
        check(reader.root.querySelector('.mktero-markdown-selection-actions'), `${label}: no annotation popup`);
        // The observer and animation-frame queues must settle before the popup
        // is used. A transient successful clamp is insufficient.
        await sleep(140);
        const later = checkCaptionSelection(reader, `${label}/settled`);
        check(JSON.stringify(later) === JSON.stringify(snapshot), `${label}: selection changed after mouseup`);
        const color = reader.root.querySelector('.mktero-markdown-selection-actions [data-color="#ffd400"]');
        check(color && !color.disabled, `${label}: missing highlight action`);
        const before = reader.created.length;
        const rect = color.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        check(rect.width > 0 && rect.height > 0
            && color.contains(reader.root.elementFromPoint(x, y)), `${label}: highlight action is not clickable`);
        win.windowUtils.sendMouseEvent('mousedown', x, y, 0, 1, 0);
        win.windowUtils.sendMouseEvent('mouseup', x, y, 0, 1, 0);
        await wait(() => reader.created.length > before, `${label} highlight callback`);
        await settle();
        check(reader.created.length === before + 1, `${label}: duplicate highlight creation`);
        const saved = reader.created.at(-1);
        check(saved.text === snapshot.text && JSON.stringify(saved.ranges) === JSON.stringify(snapshot.ranges),
            `${label}: popup saved a different selection`);
        check(api.markdownAnnotationRangeMatchesSource(reader.fixture.markdown, saved.ranges, saved.text),
            `${label}: saved source range is invalid`);
        savedHighlights++;
        return saved;
    }

    function textNode(reader, value) {
        const walker = doc.createTreeWalker(reader.parent, win.NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent.includes(value)) return node;
        }
        throw new Error(`Missing ordinary text: ${value}`);
    }

    async function checkOrdinaryText(reader, label) {
        const before = textNode(reader, config.beforeText);
        before.parentElement.scrollIntoView({ block: 'center', inline: 'nearest' });
        await settle();
        const from = point(before, 0);
        const to = point(before, 'Before the figure'.length);
        await nativeDrag(from, to);
        await settle();
        const snapshot = api.readSelectedAnnotation(reader.parent);
        check(normalize(snapshot?.text) === 'Before the figure', `${label}: ordinary text selection failed`);
        check(!reader.caption.contains(api.rootSelectionFor(reader.parent).anchorNode),
            `${label}: ordinary selection was pulled into the caption`);
    }

    async function checkCancelAndRestart(reader, label) {
        await nativeDrag(selectionPlan(reader, 'forward').from, selectionPlan(reader, 'forward').to);
        await settle();
        checkCaptionSelection(reader, `${label}/cancel`);
        doc.dispatchEvent(new win.KeyboardEvent('keydown', {
            key: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
        }));
        await settle();
        check(!reader.root.querySelector('.mktero-markdown-selection-actions'), `${label}: Escape did not close popup`);
        const before = textNode(reader, config.beforeText);
        before.parentElement.scrollIntoView({ block: 'center', inline: 'nearest' });
        await settle();
        const reset = point(before, 3);
        win.windowUtils.sendMouseEvent('mousedown', reset.x, reset.y, 0, 1, 0);
        win.windowUtils.sendMouseEvent('mouseup', reset.x, reset.y, 0, 1, 0);
        await settle();
        await revealCaption(reader);
        await dragAndSave(reader, selectionPlan(reader, 'backward'), `${label}/restart`);
    }

    async function checkLeavingCaption(reader) {
        await revealCaption(reader);
        const plan = selectionPlan(reader, 'forward');
        const after = textNode(reader, config.afterText);
        await nativeDrag(plan.from, point(after, 'After the figure'.length));
        await settle();
        const selection = api.rootSelectionFor(reader.parent);
        check(!reader.caption.contains(selection.focusNode), 'Leaving a caption still clamps the focus to it');
        check(selection.toString().includes('After the figure'), 'A drag into ordinary text loses its endpoint');
    }

    async function destroyReader(reader) {
        reader.editor.destroy();
        reader.editor.destroy();
        reader.host.remove();
        await settle();
        check(!reader.host.isConnected, 'Destroyed reader host is still connected');
    }

    async function checkCleanup() {
        const host = doc.createElementNS(ns, 'div');
        host.style.cssText = 'position:fixed;top:40px;left:40px;z-index:2147483647;background:white;color:black;'
            + 'display:block;font-size:18px;-moz-user-select:text;user-select:text;';
        const text = doc.createTextNode('Cleanup leaves ordinary selection events available.');
        host.append(text);
        doc.documentElement.append(host);
        let bubbleEvents = 0;
        const observe = () => { bubbleEvents++; };
        doc.addEventListener('selectionchange', observe);
        try {
            await nativeDrag(point(text, 0), point(text, 'Cleanup leaves ordinary'.length));
            await settle();
            check(normalize(doc.getSelection().toString()) === 'Cleanup leaves ordinary',
                `Native text cannot be selected after destruction: ${JSON.stringify(doc.getSelection().toString())}`);
            check(bubbleEvents > 0, 'Selection events were suppressed after destruction');
        }
        finally {
            doc.removeEventListener('selectionchange', observe);
            host.remove();
        }
    }
}
