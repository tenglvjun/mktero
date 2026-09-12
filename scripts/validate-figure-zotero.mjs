import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const executable = process.env.MKTERO_ZOTERO_PATH || '/Applications/Zotero.app/Contents/MacOS/zotero';
const runID = process.env.MKTERO_ZOTERO_RUN_ID || 'local';
assert.match(runID, /^[a-z0-9-]+$/u);
const output = path.join(root, 'build/figure-validation', `zotero-${runID}`);
const profile = path.join(output, `profile-${process.pid}`);
const dataDir = path.join(output, 'data');
const extensionPath = path.join(profile, 'extensions', 'figure-validation@mktero.local.xpi');
await mkdir(dataDir, { recursive: true });
await mkdir(path.dirname(extensionPath), { recursive: true });
await rm(path.join(output, 'validation.json'), { force: true });
await rm(path.join(output, 'stage.json'), { force: true });
await build({ entryPoints: [path.join(root, 'scripts/figure-region-zotero-harness.mjs')],
    outfile: path.join(output, 'harness.js'), bundle: true, format: 'iife',
    globalName: 'MkteroFigureValidation', target: ['firefox115'], logLevel: 'silent' });
const manifest = JSON.stringify({
    manifest_version: 2, name: 'Mktero Figure Validation', version: '0.0.0',
    applications: { zotero: { id: 'figure-validation@mktero.local',
        update_url: 'https://example.invalid/figure-validation-updates.json',
        strict_min_version: '7.0', strict_max_version: '10.0.*' } },
});
const bootstrap = [
    'function install() {}', 'function uninstall() {}', 'function shutdown() {}',
    'function startup() {',
    `    (${runValidation.toString()})(${JSON.stringify(root)}, ${JSON.stringify(output)}, Zotero,`,
    `        ${JSON.stringify(process.env.MKTERO_FIGURE_CASES?.split(',') || null)})`,
    `        .then(value => IOUtils.writeUTF8(${JSON.stringify(path.join(output, 'validation.json'))},`,
    '            JSON.stringify({ ok: true, value }, null, 2)),',
    `            error => IOUtils.writeUTF8(${JSON.stringify(path.join(output, 'validation.json'))},`,
    '                JSON.stringify({ ok: false, error: String(error), stack: error.stack }, null, 2)));',
    '}',
].join('\n');
await writeFile(extensionPath, zipSync({
    'manifest.json': strToU8(manifest),
    'bootstrap.js': strToU8(bootstrap),
}));
await writeFile(path.join(profile, 'user.js'), [
    ['extensions.enabledScopes', 15], ['extensions.autoDisableScopes', 0],
    ['extensions.update.enabled', false],
    ['extensions.zotero.useDataDir', true], ['extensions.zotero.dataDir', dataDir],
    ['extensions.zotero.firstRun2', false], ['extensions.zotero.automaticScraperUpdates', false],
    ['extensions.zotero.sync.autoSync', false], ['toolkit.telemetry.enabled', false],
    ['app.update.enabled', false], ['browser.shell.checkDefaultBrowser', false],
    ['extensions.logging.enabled', true], ['browser.dom.window.dump.enabled', true],
    ['devtools.console.stdout.chrome', true],
].map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
const processLog = await open(path.join(output, 'process.log'), 'w');
const child = spawn(executable, ['-no-remote', '-profile', profile], {
    stdio: ['ignore', processLog.fd, processLog.fd],
});
let launchError;
const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', error => { launchError = error; resolve(); });
});
try {
    let result;
    let lastStage;
    const startupDeadline = Date.now() + 30000;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error('Zotero exited before validation finished');
        try { result = JSON.parse(await readFile(path.join(output, 'validation.json'), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        try {
            const { stage } = JSON.parse(await readFile(path.join(output, 'stage.json'), 'utf8'));
            if (stage !== lastStage) console.log(`Zotero validation: ${stage}`);
            lastStage = stage;
        }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        assert.ok(lastStage || Date.now() < startupDeadline,
            'Validation extension did not start; inspect process.log');
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(result, 'Zotero validation timed out; inspect stage.json and process.log');
    console.log(JSON.stringify(result.ok ? { version: result.value.version,
        passed: result.value.report.passed, pixelCases: result.value.report.cases.length,
        reader: { passed: result.value.reader.passed, cycles: result.value.reader.cycles,
            windows: result.value.reader.windows, layouts: result.value.reader.layouts.length,
            imageZoom: result.value.reader.imageZoom, sourceReplacement: result.value.reader.sourceReplacement },
        renderLifecycle: result.value.renderLifecycle, workflows: result.value.workflows,
        failures: result.value.report.cases.filter(item => !item.passed) } : result));
    assert.equal(result.ok, true, 'Zotero validation failed to run');
    assert.equal(result.value.report.passed, true, 'Zotero pixel checks failed');
    assert.equal(result.value.reader.passed, true, 'Zotero reader checks failed');
    assert.equal(result.value.renderLifecycle.passed, true, 'Zotero render lifecycle checks failed');
}
finally {
    if (!launchError && child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await processLog.close();
}

// Serialized into the temporary extension, so this uses only Zotero globals.
async function runValidation(root, output, zotero, caseIDs) {
    const stage = value => IOUtils.writeUTF8(output + '/stage.json', JSON.stringify({ stage: value }));
    await stage('initializing');
    await zotero.initializationPromise;
    await zotero.uiReadyPromise;
    const win = zotero.getMainWindow();
    const scope = { Zotero: zotero, Services, IOUtils, PathUtils,
        TextEncoder: win.TextEncoder, TextDecoder: win.TextDecoder,
        setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win),
        performance: win.performance, console: win.console };
    await stage('loading-harness');
    const file = zotero.File.pathToFile(output + '/harness.js');
    Services.scriptloader.loadSubScript(Services.io.newFileURI(file).spec, scope);
    const resource = Services.io.newFileURI(zotero.File.pathToFile(root + '/build/package')).spec;
    let workflow;
    let secondWindow;
    try {
        await stage('pixels');
        const report = await scope.MkteroFigureValidation.runFigureValidation({
            fixtureRoot: root + '/test/fixtures/figures', resourceRoot: resource,
            outputRoot: output, ownerDocument: win.document,
            caseIDs,
        });
        if (!report.passed) throw new Error('Pixel validation failed: ' + JSON.stringify(
            report.cases.filter(value => !value.passed).slice(0, 2).map(({ provider, caseID, errors, reasons }) => (
                { provider, caseID, errors: errors.slice(0, 1), reasons }
            ))
        ));
        await stage('second-window');
        const previousWindows = zotero.getMainWindows();
        zotero.openMainWindow();
        const windowDeadline = Date.now() + 15000;
        while (Date.now() < windowDeadline) {
            secondWindow = zotero.getMainWindows().find(owner => !previousWindows.includes(owner));
            if (secondWindow?.Zotero_Tabs?.add && secondWindow.document.readyState === 'complete') break;
            await new Promise(resolve => win.setTimeout(resolve, 50));
        }
        if (!secondWindow?.Zotero_Tabs?.add) throw new Error('Second Zotero window did not initialize');
        await stage('render-lifecycle');
        const renderLifecycle = await scope.MkteroFigureValidation.runFigureRenderLifecycleValidation({
            fileData: await IOUtils.read(root + '/test/fixtures/figures/compound-figures.pdf'),
            resourceRoot: resource, ownerWindows: [win, secondWindow],
            onProgress: progress => IOUtils.writeUTF8(output + '/render-progress.json', JSON.stringify(progress)),
        });
        await stage('workflows');
        workflow = await scope.MkteroFigureValidation.createFigureWorkflowValidation({
            zotero, root, output, ownerWindow: win,
            document: scope.MkteroFigureValidation.validationDocuments.find(value => (
                value.provider === 'mineru' && value.caseID === 'grid-2x2'
            )).document,
        });
        await stage('reader');
        const reader = await scope.MkteroFigureValidation.runFigureReaderValidation({
            zotero, rootURI: resource + '/',
            ownerWindow: win, ownerWindows: [win, secondWindow],
            stylesheetText: await IOUtils.readUTF8(root + '/ui/markdown.css'),
            documents: scope.MkteroFigureValidation.validationDocuments,
            onOpenSource: location => workflow.onOpenSource(location),
            onSaveSnapshot: () => workflow.onSaveSnapshot(),
            onExportMarkdown: () => workflow.onExportMarkdown(),
            captureScreenshot: async (host, name) => {
                const rect = host.getBoundingClientRect();
                const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
                canvas.width = Math.min(rect.width, win.innerWidth);
                canvas.height = Math.min(rect.height, win.innerHeight);
                try {
                    canvas.getContext('2d').drawWindow(win, rect.x, rect.y, canvas.width, canvas.height, 'white');
                    const data = win.atob(canvas.toDataURL('image/png').split(',')[1]);
                    await IOUtils.write(output + '/' + name, Uint8Array.from(data, value => value.charCodeAt(0)));
                }
                finally { canvas.width = canvas.height = 0; }
            },
            onProgress: progress => IOUtils.writeUTF8(output + '/reader-progress.json', JSON.stringify(progress)),
            listenerSnapshot: owner => {
                const service = Components.classes['@mozilla.org/eventlistenerservice;1']
                    .getService(Components.interfaces.nsIEventListenerService);
                return [owner, owner.document].map(target => service.getListenerInfoFor(target)
                    .map(listener => listener.type + ':' + String(listener.listenerObject).slice(0, 160)).sort());
            },
        });
        await stage('complete');
        return { version: zotero.version, report, reader, renderLifecycle, workflows: workflow.report };
    }
    finally {
        await scope.MkteroFigureValidation.disposeFigureValidation();
        await workflow?.dispose();
        secondWindow?.close();
    }
}
