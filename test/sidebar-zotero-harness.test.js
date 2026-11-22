import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { strToU8, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { createMarkdownCacheKey, MarkdownCache } from '../src/cache/markdown-cache.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../src/mistral/parser-profile.js';
import { clickControl, collectDiagnostics, runSmoke } from '../scripts/sidebar-zotero/smoke.mjs';

const execute = promisify(execFile);
const projectRoot = new URL('../', import.meta.url);

async function helperScope({ smoke, diagnose }) {
    const source = await readFile(new URL('../scripts/validate-sidebar-zotero.mjs', import.meta.url), 'utf8');
    const template = /const bootstrap = (`[\s\S]*?`);/u.exec(source)?.[1];
    assert.ok(template, 'Missing helper bootstrap template');
    const config = { phase: 1, profile: '/isolated/profile', data: '/isolated/data',
        resultPath: '/isolated/result', stagePath: '/isolated/stage' };
    const bootstrap = runInNewContext(template, { config, runSmoke: smoke, clickControl, collectDiagnostics: diagnose });
    const writes = new Map();
    const loggedErrors = [];
    const quitRequested = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const context = {
        productStarted: gate.promise,
        IOUtils: {
            readUTF8: async () => 'fixture stage',
            writeUTF8: async (file, value) => { writes.set(file, value); },
        },
        Zotero: { Debug: { setStore() {} }, logError: error => loggedErrors.push(String(error)) },
        Components: { interfaces: { nsIAppStartup: { eAttemptQuit: 17 } } },
        Services: { startup: { quit: reason => quitRequested.resolve(reason) } },
    };
    runInNewContext(bootstrap, context);
    return { config, context, writes, loggedErrors, gate, quitRequested };
}

for (const kind of ['element', 'shadow', 'fallback']) {
    test(`serialized click driver uses the DOM hit root for a ${kind} query scope`, async () => {
        const listeners = new Map();
        const events = [];
        const hitCalls = [];
        const child = {};
        const observer = {
            addEventListener(type, listener, capture) {
                assert.equal(capture, true);
                listeners.set(type, listener);
            },
            removeEventListener(type, listener, capture) {
                assert.equal(capture, true);
                assert.equal(listeners.get(type), listener);
                listeners.delete(type);
            },
        };
        const document = { ...observer, elementFromPoint(x, y) { hitCalls.push(['document', x, y]); return node; } };
        const shadow = { ...observer, elementFromPoint(x, y) { hitCalls.push(['shadow', x, y]); return child; } };
        const fragment = { ...observer };
        const node = {
            ownerDocument: document,
            getRootNode: () => kind === 'shadow' ? shadow : kind === 'fallback' ? fragment : document,
            getAttribute: () => null, scrollIntoView() {},
            getBoundingClientRect: () => ({ x: 20, y: 30, width: 10, height: 20 }),
            contains: target => target === child,
        };
        const queryScope = { querySelector(selector) { assert.equal(selector, '#target'); return node; } };
        const click = runInNewContext(`(${clickControl.toString()})`);
        const result = await click(queryScope, '#target', 'fixture button', {
            wait: async predicate => { const value = predicate(); assert.ok(value); return value; },
            visible: target => target === node, check: assert.ok,
            window: {
                windowUtils: { sendMouseEvent(type, x, y, button, count, modifiers) {
                    events.push([type, x, y, button, count, modifiers]);
                    if (type === 'mouseup') listeners.get('click')?.({ composedPath: () => [child, node] });
                } },
            },
        });
        assert.equal(result, node);
        assert.deepEqual(hitCalls, [[kind === 'shadow' ? 'shadow' : 'document', 25, 40]]);
        assert.deepEqual(events, [['mousedown', 25, 40, 0, 1, 0], ['mouseup', 25, 40, 0, 1, 0]]);
        assert.equal(listeners.size, 0, 'Click recorder must be removed');
    });
}

for (const shadow of [false, true]) {
    test(`serialized click driver counts a ${shadow ? 'shadow' : 'native'} button click stopped by a product capture listener`, async () => {
        const dom = new JSDOM('<div id="rail"></div>');
        const { window } = dom;
        const rail = window.document.getElementById('rail');
        const root = shadow ? rail.attachShadow({ mode: 'open' }) : rail;
        const container = window.document.createElement('div');
        const node = window.document.createElement('button');
        root.appendChild(container);
        container.appendChild(node);
        node.scrollIntoView = () => {};
        node.getBoundingClientRect = () => ({ x: 10, y: 20, width: 30, height: 40 });
        node.getRootNode().elementFromPoint = () => node;
        let productClicks = 0;
        let targetClicks = 0;
        container.addEventListener('click', event => {
            productClicks++;
            event.stopImmediatePropagation();
            event.preventDefault();
        }, true);
        node.addEventListener('click', () => targetClicks++);
        window.windowUtils = { sendMouseEvent(type) {
            if (type === 'mouseup') node.dispatchEvent(new window.MouseEvent('click', {
                bubbles: true, composed: true, cancelable: true, button: 0, detail: 1,
            }));
        } };
        try {
            const click = runInNewContext(`(${clickControl.toString()})`);
            assert.equal(await click(root, 'button', 'captured section', {
                wait: async predicate => predicate(), visible: target => target === node,
                check: assert.ok, window,
            }), node);
            assert.equal(productClicks, 1);
            assert.equal(targetClicks, 0, 'The product stops propagation before the button target');
        }
        finally { window.close(); }
    });
}

test('serialized click driver rejects a covered native control before dispatching mouse events', async () => {
    const node = {
        getAttribute: () => null, scrollIntoView() {},
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 }),
        getRootNode: () => ({ elementFromPoint: () => ({}) }),
        contains: () => false,
    };
    const click = runInNewContext(`(${clickControl.toString()})`);
    let dispatched = false;
    await assert.rejects(click({ querySelector: () => node }, '#target', 'covered control', {
        wait: async predicate => predicate(), visible: () => true, check: assert.ok,
        window: { windowUtils: { sendMouseEvent() { dispatched = true; } } },
    }), /covered control is covered or not clickable/u);
    assert.equal(dispatched, false);
});

test('helper startup releases sequential plugin loading before the smoke waits for product controls', { timeout: 2000 }, async () => {
    const driver = await helperScope({
        smoke: async function () { await productStarted; return { menuReady: true }; },
        diagnose: async function () { return {}; },
    });
    try {
        assert.equal(driver.context.startup(), undefined,
            'Returning the smoke promise blocks the next product plugin startup');
        assert.equal(driver.context.startup(), undefined, 'Repeated startup must not block plugin loading');
    }
    finally { driver.gate.resolve(); }
    assert.equal(await driver.quitRequested.promise, 17);
    const result = JSON.parse(driver.writes.get(driver.config.resultPath));
    assert.equal(result.ok, true);
    assert.equal(result.value.menuReady, true);
    assert.equal(result.quitRequested, 'eAttemptQuit');
    assert.deepEqual(driver.loggedErrors, []);
});

for (const diagnosticFailure of [false, true]) {
    test(`helper records the original failure and requests normal exit when diagnostics ${diagnosticFailure ? 'fail' : 'succeed'}`, { timeout: 2000 }, async () => {
        const driver = await helperScope({
            smoke: async function () { throw new Error('Original smoke failure'); },
            diagnose: diagnosticFailure
                ? async function () { throw new Error('Diagnostics unavailable'); }
                : async function () { return { zoteroErrors: [{ text: 'Product startup stack' }] }; },
        });
        driver.context.startup();
        assert.equal(await driver.quitRequested.promise, 17);
        const result = JSON.parse(driver.writes.get(driver.config.resultPath));
        assert.equal(result.ok, false);
        assert.match(result.error, /Original smoke failure/u);
        assert.match(result.stack, /Original smoke failure/u);
        if (diagnosticFailure) assert.match(result.diagnostics.error, /Diagnostics unavailable/u);
        else assert.equal(result.diagnostics.zoteroErrors[0].text, 'Product startup stack');
        assert.equal(result.quitRequested, 'eAttemptQuit');
        assert.deepEqual(driver.loggedErrors, []);
    });
}

for (const mismatch of ['profile', 'data']) {
    test(`diagnostics refuse a mismatched ${mismatch} before collecting errors or windows`, async () => {
        const diagnose = runInNewContext(`(${collectDiagnostics.toString()})`, {
            Zotero: {
                Profile: { dir: mismatch === 'profile' ? '/unexpected' : '/isolated/profile' },
                DataDirectory: { dir: mismatch === 'data' ? '/unexpected' : '/isolated/data' },
            },
        });
        await assert.rejects(diagnose({ profile: '/isolated/profile', data: '/isolated/data' }),
            /Refusing diagnostics outside the isolated profile\/data directory/u);
    });
}

test('isolated diagnostics preserve native error stacks and continue when a collector fails', async () => {
    const nativeError = { name: 'StartupError', stack: 'startup@product/bootstrap.js:42',
        toString: () => 'Product failed', toJSON() { throw new Error('Native object cannot be cloned'); } };
    const diagnose = runInNewContext(`(${collectDiagnostics.toString()})`, {
        Zotero: {
            version: '10.0.9', Profile: { dir: '/isolated/profile' }, DataDirectory: { dir: '/isolated/data' },
            getErrors(asStrings) { assert.equal(asStrings, true); return [nativeError]; },
            getMainWindow() { return {}; }, Debug: { get: async () => 'Product debug stack' },
        },
        Services: {
            io: { offline: true }, wm: { getEnumerator: () => [] },
            console: { getMessageArray() { throw new Error('Console unavailable'); } },
        },
        ChromeUtils: { importESModule: () => ({ AddonManager: { getAllAddons: async () => [] } }) },
    });
    const result = JSON.parse(JSON.stringify(await diagnose({ profile: '/isolated/profile', data: '/isolated/data' })));
    assert.equal(result.zoteroErrors[0].stack, 'startup@product/bootstrap.js:42');
    assert.match(result.consoleMessages.collectionError.text, /Console unavailable/u);
    assert.equal(result.debugLog, 'Product debug stack');
    assert.deepEqual(result.windows, []);
    assert.deepEqual(result.addons, []);
});

test('sidebar fixture mode produces two distinct offline PDFs and no installed driver or launched Zotero', async () => {
    const { stdout } = await execute(process.execPath, ['scripts/validate-sidebar-zotero.mjs', '--fixtures'], {
        cwd: projectRoot, timeout: 15000,
    });
    const run = /^Isolated sidebar run: (.+)$/mu.exec(stdout)?.[1];
    assert.ok(run);
    try {
        const report = JSON.parse(await readFile(path.join(run, 'report.json'), 'utf8'));
        assert.equal(report.passed, true);
        assert.equal(report.zoteroLaunched, false);
        assert.equal(report.fixtureCount, 2);
        assert.equal(report.plannedParentItems, 2);
        assert.equal(report.plannedStandaloneNotes, 1);
        assert.deepEqual(await readdir(path.join(run, 'profile', 'extensions')), []);
        assert.ok(!(await readdir(run)).some(file => file.endsWith('.process.log') || file === 'sandbox.sb'));
        const fixtures = JSON.parse(await readFile(path.join(run, 'fixture-plan.json'), 'utf8'));
        assert.deepEqual(fixtures.pdfs.map(fixture => fixture.label), ['A', 'B']);
        assert.notEqual(fixtures.pdfs[0].markdown, fixtures.pdfs[1].markdown);
        const cache = new MarkdownCache({
            rootPath: path.join(run, 'profile', 'mktero-cache', 'v1'),
            pathUtils: { ...path, parent: path.dirname, filename: path.basename },
            ioUtils: {
                exists: async file => { try { await stat(file); return true; } catch { return false; } },
                readUTF8: file => readFile(file, 'utf8'), read: readFile, stat,
                writeUTF8: (file, value) => writeFile(file, value),
                remove: (file, options) => rm(file, { recursive: options?.recursive, force: true }),
            },
        });
        for (const fixture of fixtures.pdfs) {
            assert.ok(fixture.pdfPath.startsWith(run + path.sep));
            const bytes = await readFile(fixture.pdfPath);
            assert.ok(bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-1.4'));
            assert.ok(bytes.includes(Buffer.from(fixture.markdown, 'ascii')));
            const key = await createMarkdownCacheKey(bytes, { parserProfile: MISTRAL_PARSER_PROFILE_ID });
            const cached = await cache.get(key);
            assert.ok(cached, 'Synthetic PDF has no readable cache for its current Mistral parser profile');
            assert.equal(cached.markdown, fixture.markdown);
        }
    }
    finally { await rm(run, { recursive: true, force: true }); }
});

test('sidebar CLI rejects another addon before sandbox setup or process startup', async () => {
    const run = await mkdtemp(path.join(tmpdir(), 'mktero-sidebar-wrong-xpi-'));
    try {
        const xpi = path.join(run, 'other.xpi');
        await writeFile(xpi, zipSync({
            'manifest.json': strToU8(JSON.stringify({ version: '1.0.0',
                applications: { zotero: { id: 'other@fixture.invalid' } } })),
        }));
        await assert.rejects(execute(process.execPath, ['scripts/validate-sidebar-zotero.mjs', xpi], {
            cwd: projectRoot, timeout: 10000,
        }), error => {
            assert.match(error.stderr, /Expected the original Mktero product XPI/u);
            assert.doesNotMatch(error.stdout, /Isolated sidebar run|Sandbox preflight/u);
            return true;
        });
    }
    finally { await rm(run, { recursive: true, force: true }); }
});

for (const mismatch of ['profile', 'data']) {
    test(`serialized sidebar driver rejects a mismatched ${mismatch} before accessing a window or library`, async () => {
        const writes = [];
        let windowAccessed = false;
        const config = { profile: '/isolated/profile', data: '/isolated/data', stagePath: '/isolated/stage' };
        const smoke = runInNewContext(`(${runSmoke.toString()})`, {
            IOUtils: { async writeUTF8(file, value) { writes.push({ file, value }); } },
            Services: { io: { offline: false } },
            Zotero: {
                initializationPromise: Promise.resolve(), uiReadyPromise: Promise.resolve(),
                Profile: { dir: mismatch === 'profile' ? '/unexpected/profile' : config.profile },
                DataDirectory: { dir: mismatch === 'data' ? '/unexpected/data' : config.data },
                getMainWindow() { windowAccessed = true; throw new Error('Window must not be accessed'); },
            },
        });
        await assert.rejects(smoke(config), mismatch === 'profile' ? /Unexpected Zotero profile/u : /Unexpected Zotero data directory/u);
        assert.equal(windowAccessed, false);
        assert.deepEqual(writes, [{ file: config.stagePath, value: 'initializing isolated sidebar validation' }]);
    });
}
