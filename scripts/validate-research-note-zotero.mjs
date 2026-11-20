import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { runSmoke } from './research-note-zotero/smoke.mjs';
import {
    isolatedEnvironment, launchPhase, sandboxPolicy, verifySandbox,
} from './research-note-zotero/isolation.mjs';

const productID = 'mktero@tenglvjun.github.io';
const helperID = 'research-note-smoke@mktero.local';
const [argument, ...extra] = process.argv.slice(2);
assert.ok(argument && !extra.length && (argument === '--preflight' || argument === '--fixtures'
    || (!argument.startsWith('-') && argument.endsWith('.xpi'))),
'Usage: node scripts/validate-research-note-zotero.mjs <final-product.xpi> | --preflight | --fixtures');
const fixtureOnly = argument === '--fixtures';
const preflightOnly = argument === '--preflight';
if (!fixtureOnly) assert.equal(process.platform, 'darwin', 'Refusing to launch Zotero without the macOS sandbox');
const run = await mkdtemp(path.join(fixtureOnly ? tmpdir() : '/private/tmp', 'mktero-research-note-'));
console.log(`Isolated synthetic run: ${run}`);
try {
    const profile = path.join(run, 'profile');
    const data = path.join(run, 'data');
    const extensions = path.join(profile, 'extensions');
    for (const dir of [extensions, data, path.join(run, 'home'), path.join(run, 'tmp')]) {
        await mkdir(dir, { recursive: true });
    }
    const { fixturePrefs, prepareFixtures } = await import('./research-note-zotero/fixtures.mjs');
    if (fixtureOnly) {
        const fixtures = await prepareFixtures(run, profile);
        console.log(JSON.stringify({ mode: 'source-module-fixtures-only', run,
            pdfs: fixtures.pdfs.map(({ label, pdfPath }) => ({ label, pdfPath })),
            standaloneNotePlanned: true, zoteroLaunched: false }));
    }
    else {
        const env = isolatedEnvironment(run);
        const policy = sandboxPolicy(run);
        await writeFile(path.join(run, 'sandbox.sb'), policy);
        const isolation = await verifySandbox(policy, env);
        await writeFile(path.join(run, 'isolation.json'), JSON.stringify(isolation, null, 2));
        console.log('Sandbox preflight passed: real HOME/outside-run reads, outside-run writes and IPv4/IPv6 TCP/UDP denied.');
        const fixtures = preflightOnly ? null : await prepareFixtures(run, profile);
        let product = null;
        if (!preflightOnly) {
            const xpi = await readFile(path.resolve(argument));
            const files = unzipSync(xpi, { filter: entry => entry.name === 'manifest.json' });
            assert.ok(files['manifest.json'], 'Product XPI has no manifest');
            const manifest = JSON.parse(strFromU8(files['manifest.json']));
            assert.equal(manifest.applications?.zotero?.id, productID, 'Expected the original Mktero product XPI');
            const xpiPath = path.join(extensions, `${productID}.xpi`);
            product = { id: productID, version: manifest.version, xpiPath,
                sha256: createHash('sha256').update(xpi).digest('hex') };
            await writeFile(xpiPath, xpi);
        }
        const config = { run, profile, data, product, fixtures,
            phasePath: path.join(run, 'phase.json'), statePath: path.join(run, 'fixture-state.json') };
        const bootstrap = `
            function install() {}
            function uninstall() {}
            function shutdown() {}
            var running;
            function startup() {
                if (running) return running;
                running = (async () => {
                    const config = ${JSON.stringify(config)};
                    const phase = await IOUtils.readJSON(config.phasePath);
                    Object.assign(config, phase);
                    const smoke = ${runSmoke.toString()};
                    let result;
                    try { result = { ok: true, value: await smoke(config) }; }
                    catch (error) { result = { ok: false, error: String(error), stack: error.stack }; }
                    result.phase = config.phase;
                    result.stage = await IOUtils.readUTF8(config.stagePath);
                    result.quitRequested = 'eAttemptQuit';
                    await IOUtils.writeUTF8(config.resultPath, JSON.stringify(result, null, 2), {
                        tmpPath: config.resultPath + '.tmp',
                    });
                    await IOUtils.writeUTF8(config.stagePath, 'requesting normal exit (eAttemptQuit)', {
                        tmpPath: config.stagePath + '.tmp',
                    });
                    const Ci = Components.interfaces;
                    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
                })().catch(error => Zotero.logError(error));
                return running;
            }
        `;
        await writeFile(path.join(extensions, `${helperID}.xpi`), zipSync({
            'manifest.json': strToU8(JSON.stringify({
                manifest_version: 2, name: 'Mktero Research Note Smoke Driver', version: '1.0.0',
                applications: { zotero: { id: helperID, update_url: 'https://research-note.invalid/updates.json',
                    strict_min_version: '7.0', strict_max_version: '10.0.*' } },
            })),
            'bootstrap.js': strToU8(bootstrap),
        }));
        const prefs = {
            'extensions.enabledScopes': 1, 'extensions.autoDisableScopes': 0,
            'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
            'extensions.logging.enabled': true, 'browser.dom.window.dump.enabled': true,
            'devtools.console.stdout.chrome': true,
            // Seatbelt remains the network boundary; Gecko's socket-process
            // sandbox cannot stack with this enclosing macOS policy.
            'network.process.enabled': false,
            'extensions.zotero.useDataDir': true, 'extensions.zotero.dataDir': data,
            'extensions.zotero.firstRun2': false, 'extensions.zotero.firstRunGuidance': false,
            'extensions.zotero.automaticScraperUpdates': false, 'extensions.zotero.sync.autoSync': false,
            'app.update.enabled': false, 'toolkit.telemetry.enabled': false, 'network.manage-offline-status': false,
            'browser.shell.checkDefaultBrowser': false, ...(preflightOnly ? {} : fixturePrefs),
        };
        // Write once. In particular, user.js must never reset researchNoteTargets
        // on restart; that mapping must be persisted by Zotero's normal exit.
        await writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
            .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
        const phases = [];
        for (const phase of [1, 2]) {
            const phaseConfig = { phase, resultPath: path.join(run, `phase-${phase}.result.json`),
                stagePath: path.join(run, `phase-${phase}.stage`) };
            await writeFile(config.phasePath, JSON.stringify(phaseConfig));
            const result = await launchPhase({ policy, env, profile, run, ...phaseConfig });
            phases.push(result);
            // This write is reached only after launchPhase observes code 0 and
            // no signal. The same profile/data/extensions are then relaunched.
            await writeFile(path.join(run, 'progress.json'), JSON.stringify({ product, phases }, null, 2));
        }
        const report = { mode: preflightOnly ? 'isolated-two-phase-preflight-only' : 'installed-product-xpi',
            passed: true, run, profile, data, product, isolation, phases };
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
