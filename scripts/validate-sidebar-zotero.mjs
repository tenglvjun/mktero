// Runs the final XPI only in the existing macOS Seatbelt boundary. --fixtures
// prepares synthetic PDFs/caches without launching Zotero or probing the sandbox.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { clickControl, collectDiagnostics, runSmoke } from './sidebar-zotero/smoke.mjs';
import { fixturePrefs, prepareFixtures } from './research-note-zotero/fixtures.mjs';
import {
    isolatedEnvironment, launchPhase, sandboxPolicy, verifySandbox,
} from './research-note-zotero/isolation.mjs';

const productID = 'mktero@tenglvjun.github.io';
const helperID = 'sidebar-smoke@mktero.local';
const [argument, ...extra] = process.argv.slice(2);
assert.ok(argument && !extra.length && (argument === '--fixtures'
    || (!argument.startsWith('-') && argument.endsWith('.xpi'))),
'Usage: node scripts/validate-sidebar-zotero.mjs <final-product.xpi> | --fixtures');
const fixtureOnly = argument === '--fixtures';
// Validate the supplied artifact before creating a sandbox or starting a process.
let xpi;
let manifest;
if (!fixtureOnly) {
    xpi = await readFile(path.resolve(argument));
    const files = unzipSync(xpi, { filter: entry => entry.name === 'manifest.json' });
    assert.ok(files['manifest.json'], 'Product XPI has no manifest');
    manifest = JSON.parse(strFromU8(files['manifest.json']));
    assert.equal(manifest.applications?.zotero?.id, productID, 'Expected the original Mktero product XPI');
    assert.equal(typeof manifest.version, 'string', 'Product XPI has no version');
    assert.equal(process.platform, 'darwin', 'Refusing to launch Zotero without the macOS sandbox');
}
const run = await mkdtemp(path.join(fixtureOnly ? tmpdir() : '/private/tmp', 'mktero-sidebar-'));
console.log(`Isolated sidebar run: ${run}`);
try {
    const profile = path.join(run, 'profile');
    const data = path.join(run, 'data');
    const extensions = path.join(profile, 'extensions');
    for (const dir of [extensions, data, path.join(run, 'home'), path.join(run, 'tmp')]) {
        await mkdir(dir, { recursive: true });
    }
    if (fixtureOnly) {
        const fixtures = await prepareFixtures(run, profile);
        const report = { mode: 'synthetic-fixtures-only', passed: true, zoteroLaunched: false,
            run, profile, data, fixtureCount: fixtures.pdfs.length,
            plannedParentItems: 2, plannedStandaloneNotes: 1 };
        await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    }
    else {
        const env = isolatedEnvironment(run);
        const policy = sandboxPolicy(run);
        await writeFile(path.join(run, 'sandbox.sb'), policy);
        const isolation = await verifySandbox(policy, env);
        await writeFile(path.join(run, 'isolation.json'), JSON.stringify(isolation, null, 2));
        console.log('Sandbox preflight passed: real HOME/outside-run access and IPv4/IPv6 TCP/UDP denied.');
        const fixtures = await prepareFixtures(run, profile);
        const xpiPath = path.join(extensions, `${productID}.xpi`);
        const product = { id: productID, version: manifest.version, xpiPath,
            sha256: createHash('sha256').update(xpi).digest('hex') };
        await writeFile(xpiPath, xpi);
        const phaseConfig = { phase: 1, resultPath: path.join(run, 'phase-1.result.json'),
            stagePath: path.join(run, 'phase-1.stage') };
        const config = { ...phaseConfig, run, profile, data, product, fixtures, helperID,
            statePath: path.join(run, 'fixture-state.json') };
        const bootstrap = `
            function install() {}
            function uninstall() {}
            function shutdown() {}
            var running;
            function startup() {
                if (running) return;
                // Zotero awaits each plugin startup in sequence. Returning the
                // full smoke promise can prevent the product from starting.
                running = (async () => {
                    const config = ${JSON.stringify(config)};
                    Zotero.Debug.setStore(true);
                    const smoke = ${runSmoke.toString()};
                    const click = ${clickControl.toString()};
                    const diagnose = ${collectDiagnostics.toString()};
                    let result;
                    try { result = { ok: true, value: await smoke(config, click) }; }
                    catch (error) {
                        result = { ok: false, error: String(error), stack: error.stack };
                        try { result.diagnostics = await diagnose(config); }
                        catch (diagnosticError) {
                            result.diagnostics = { error: String(diagnosticError), stack: diagnosticError.stack };
                        }
                    }
                    result.phase = config.phase;
                    result.stage = await IOUtils.readUTF8(config.stagePath);
                    result.quitRequested = 'eAttemptQuit';
                    await IOUtils.writeUTF8(config.resultPath, JSON.stringify(result, null, 2), {
                        tmpPath: config.resultPath + '.tmp',
                    });
                    await IOUtils.writeUTF8(config.stagePath, 'requesting normal exit (eAttemptQuit)', {
                        tmpPath: config.stagePath + '.tmp',
                    });
                    Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
                })().catch(error => Zotero.logError(error));
            }
        `;
        await writeFile(path.join(extensions, `${helperID}.xpi`), zipSync({
            'manifest.json': strToU8(JSON.stringify({
                manifest_version: 2, name: 'Mktero Sidebar Smoke Driver', version: '1.0.0',
                applications: { zotero: { id: helperID, update_url: 'https://sidebar.invalid/updates.json',
                    strict_min_version: '7.0', strict_max_version: '10.0.*' } },
            })),
            'bootstrap.js': strToU8(bootstrap),
        }));
        const prefs = {
            ...fixturePrefs,
            // Keep this test about the right-hand content areas; a narrow
            // desktop must not auto-collapse notes because of the outline.
            'extensions.mktero.readerOutlineVisible': false,
            'extensions.enabledScopes': 1, 'extensions.autoDisableScopes': 0,
            'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
            'extensions.logging.enabled': true, 'browser.dom.window.dump.enabled': true,
            'extensions.zotero.debug.store': true,
            'devtools.console.stdout.chrome': true, 'network.process.enabled': false,
            'extensions.zotero.useDataDir': true, 'extensions.zotero.dataDir': data,
            'extensions.zotero.firstRun2': false, 'extensions.zotero.firstRunGuidance': false,
            'extensions.zotero.automaticScraperUpdates': false, 'extensions.zotero.sync.autoSync': false,
            'app.update.enabled': false, 'toolkit.telemetry.enabled': false,
            'network.manage-offline-status': false, 'browser.shell.checkDefaultBrowser': false,
        };
        await writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
            .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
        const result = await launchPhase({ policy, env, profile, run, ...phaseConfig });
        // launchPhase returns only after a normal exit (code 0, no signal,
        // no forced cleanup); a driver's successful assertions alone do not pass.
        const report = { mode: 'installed-product-xpi', passed: true, zoteroLaunched: true,
            run, profile, data, product, isolation, phases: [result],
            coverage: 'native-sidebar-and-synthetic-registerSection', llmForZoteroTested: false };
        await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    }
}
catch (error) {
    await writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2));
    throw error;
}
finally {
    console.log(`Synthetic fixtures, profile and diagnostics retained: ${run}`);
}
