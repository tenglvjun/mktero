// Launch an isolated Zotero profile and probe whether a background Worker can
// run PDF.js offline rendering. Does not touch the user's live Zotero profile.
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const executable = process.env.MKTERO_ZOTERO_PATH || '/Applications/Zotero.app/Contents/MacOS/zotero';
const runID = process.env.MKTERO_PROBE_RUN_ID || 'local';
const output = path.join(root, 'build/worker-probe', runID);
const profile = path.join(output, `profile-${process.pid}`);
const dataDir = path.join(output, 'data');
const extensionPath = path.join(profile, 'extensions', 'worker-probe@mktero.local.xpi');
const pdfPath = process.env.MKTERO_PROBE_PDF
    || path.join(process.env.HOME, 'Zotero/storage/4Q3J8VTX/2606.01767.pdf');

await rm(output, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(path.dirname(extensionPath), { recursive: true });

await build({
    entryPoints: [path.join(root, 'scripts/worker-probe-worker.mjs')],
    outfile: path.join(output, 'worker.js'),
    inject: [path.join(root, 'src/pdf/pdfjs-runtime-compat.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['firefox115'],
    legalComments: 'none',
    define: { process: 'undefined', Buffer: 'undefined' },
    logLevel: 'warning',
});
await build({
    entryPoints: [path.join(root, 'scripts/worker-probe-harness.mjs')],
    outfile: path.join(output, 'harness.js'),
    bundle: true,
    format: 'iife',
    globalName: 'MkteroWorkerProbe',
    target: ['firefox115'],
    logLevel: 'silent',
});
await build({
    entryPoints: [path.join(root, 'src/figures/figure-render-worker-entry.js')],
    outfile: path.join(output, 'figure.worker.js'),
    inject: [path.join(root, 'src/pdf/pdfjs-runtime-compat.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['firefox115'],
    legalComments: 'none',
    define: { process: 'undefined', Buffer: 'undefined' },
    logLevel: 'warning',
});

const manifest = JSON.stringify({
    manifest_version: 2, name: 'Mktero Worker Probe', version: '0.0.0',
    applications: { zotero: { id: 'worker-probe@mktero.local',
        update_url: 'https://example.invalid/worker-probe-updates.json',
        strict_min_version: '7.0', strict_max_version: '10.0.*' } },
});
const bootstrap = [
    'function install() {}', 'function uninstall() {}', 'function shutdown() {}',
    'function startup() {',
    `    (${runProbe.toString()})(${JSON.stringify(root)}, ${JSON.stringify(output)}, Zotero,`,
    `        ${JSON.stringify(pdfPath)});`,
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
    let result = null;
    let lastStage;
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error('Zotero exited before the probe finished');
        try {
            result = JSON.parse(await readFile(path.join(output, 'probe-result.json'), 'utf8'));
            break;
        }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        try {
            const { stage } = JSON.parse(await readFile(path.join(output, 'probe-stage.json'), 'utf8'));
            if (stage !== lastStage) console.log(`probe stage: ${stage}`);
            lastStage = stage;
        }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(result, 'Worker probe timed out; inspect process.log and probe-stage.json');
    console.log('\n===== WORKER PROBE RESULT =====');
    console.log(JSON.stringify(result, null, 2));
}
finally {
    if (!launchError && child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await processLog.close();
}

// Serialized into the temporary extension; only Zotero globals are available.
async function runProbe(root, output, zotero, pdfPath) {
    try {
        const scope = { Zotero: zotero, Services, IOUtils, PathUtils,
            TextEncoder: zotero.getMainWindow().TextEncoder,
            TextDecoder: zotero.getMainWindow().TextDecoder,
            setTimeout: zotero.getMainWindow().setTimeout.bind(zotero.getMainWindow()),
            clearTimeout: zotero.getMainWindow().clearTimeout.bind(zotero.getMainWindow()),
            performance: zotero.getMainWindow().performance, console: zotero.getMainWindow().console };
        const file = zotero.File.pathToFile(output + '/harness.js');
        Services.scriptloader.loadSubScript(Services.io.newFileURI(file).spec, scope);
        await scope.MkteroWorkerProbe.runWorkerProbe(root, output, zotero, pdfPath);
    }
    catch (error) {
        await IOUtils.writeUTF8(output + '/probe-result.json',
            JSON.stringify({ fatal: String(error), stack: String(error && error.stack) }, null, 2));
    }
}
