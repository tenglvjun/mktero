import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { fixturePrefs, prepareFixtures } from './annotation-persistence-zotero/fixtures.mjs';
import { runSmoke } from './annotation-persistence-zotero/smoke.mjs';
import { isolatedEnvironment, launchPhase, sandboxPolicy, verifySandbox } from './research-note-zotero/isolation.mjs';

const productID = 'mktero@tenglvjun.github.io';
const helperID = 'annotation-persistence-smoke@mktero.local';
const args = process.argv.slice(2);
assert.ok(args.length <= 1, 'Usage: node scripts/validate-annotation-persistence-zotero.mjs [product.xpi | --fixtures | --preflight]');
const argument = args[0] || 'build/mktero-0.10.0.xpi';
const fixtureOnly = argument === '--fixtures';
const preflightOnly = argument === '--preflight';
assert.ok(fixtureOnly || preflightOnly || (!argument.startsWith('-') && argument.endsWith('.xpi')), 'Invalid argument');
if (!fixtureOnly) assert.equal(process.platform, 'darwin', 'Seatbelt isolation requires macOS');
const run = await mkdtemp(path.join(fixtureOnly ? tmpdir() : '/private/tmp', 'mktero-annotation-persistence-'));
console.log(`Isolated annotation persistence run: ${run}`);
try {
    const profile = path.join(run, 'profile');
    const data = path.join(run, 'data');
    const extensions = path.join(profile, 'extensions');
    for (const dir of [extensions, data, path.join(run, 'home'), path.join(run, 'tmp')]) await mkdir(dir, { recursive: true });
    // Snapshot the XPI before any asynchronous fixture work. Every later phase
    // reads the staged copy, including the restart, regardless of build output.
    let product = null;
    if (!fixtureOnly && !preflightOnly) {
        const bytes = await readFile(path.resolve(argument));
        const files = unzipSync(bytes, { filter: entry => entry.name === 'manifest.json' });
        assert.ok(files['manifest.json'], 'Product XPI has no manifest');
        const manifest = JSON.parse(strFromU8(files['manifest.json']));
        assert.equal(manifest.applications?.zotero?.id, productID);
        const xpiPath = path.join(extensions, `${productID}.xpi`);
        await writeFile(xpiPath, bytes);
        product = { id: productID, version: manifest.version, xpiPath,
            sha256: createHash('sha256').update(bytes).digest('hex') };
        await writeFile(path.join(run, 'product.json'), JSON.stringify(product, null, 2));
        console.log(`Staged installed product ${product.version}: ${product.sha256}`);
    }
    const fixtures = preflightOnly ? null : await prepareFixtures(run, profile);
    if (fixtureOnly) {
        const report = { passed: true, mode: 'synthetic-fixtures-only', run, zoteroLaunched: false,
            fixtureCount: fixtures.length,
            pagesPerPDF: fixtures.map(fixture => ({ label: fixture.label, pages: fixture.pages.length })) };
        await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    }
    else {
        const env = isolatedEnvironment(run);
        const policy = sandboxPolicy(run);
        await writeFile(path.join(run, 'sandbox.sb'), policy);
        const isolation = await verifySandbox(policy, env);
        await writeFile(path.join(run, 'isolation.json'), JSON.stringify(isolation, null, 2));
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
                    Object.assign(config, await IOUtils.readJSON(config.phasePath));
                    const smoke = ${runSmoke.toString()};
                    let result;
                    try { result = { ok: true, value: await smoke(config) }; }
                    catch (error) { result = { ok: false, error: String(error), stack: error.stack }; }
                    result.phase = config.phase;
                    result.stage = await IOUtils.readUTF8(config.stagePath);
                    result.quitRequested = 'eAttemptQuit';
                    await IOUtils.writeUTF8(config.resultPath, JSON.stringify(result, null, 2), { tmpPath: config.resultPath + '.tmp' });
                    await IOUtils.writeUTF8(config.stagePath, 'requesting normal exit (eAttemptQuit)', { tmpPath: config.stagePath + '.tmp' });
                    Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
                })().catch(error => Zotero.logError(error));
                return running;
            }
        `;
        await writeFile(path.join(extensions, `${helperID}.xpi`), zipSync({
            'manifest.json': strToU8(JSON.stringify({ manifest_version: 2,
                name: 'Mktero Annotation Persistence Driver', version: '1.0.0',
                applications: { zotero: { id: helperID, update_url: 'https://annotation-persistence.invalid/updates.json',
                    strict_min_version: '7.0', strict_max_version: '10.0.*' } } })),
            'bootstrap.js': strToU8(bootstrap),
        }));
        const prefs = {
            'extensions.enabledScopes': 1, 'extensions.autoDisableScopes': 0,
            'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
            'extensions.logging.enabled': true, 'browser.dom.window.dump.enabled': true,
            'devtools.console.stdout.chrome': true, 'network.process.enabled': false,
            'extensions.zotero.useDataDir': true, 'extensions.zotero.dataDir': data,
            'extensions.zotero.firstRun2': false, 'extensions.zotero.firstRunGuidance': false,
            'extensions.zotero.automaticScraperUpdates': false, 'extensions.zotero.sync.autoSync': false,
            'app.update.enabled': false, 'toolkit.telemetry.enabled': false,
            'network.manage-offline-status': false, 'browser.shell.checkDefaultBrowser': false,
            ...fixturePrefs,
        };
        await writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
            .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
        const phases = [];
        for (const phase of (preflightOnly ? [1, 2] : [1, 2, 3])) {
            const phaseConfig = { phase, resultPath: path.join(run, `phase-${phase}.result.json`), stagePath: path.join(run, `phase-${phase}.stage`) };
            await writeFile(config.phasePath, JSON.stringify(phaseConfig));
            const result = await launchPhase({ policy, env, profile, run, ...phaseConfig });
            phases.push(result);
            await writeFile(path.join(run, 'progress.json'), JSON.stringify({ product, phases }, null, 2));
            if (phase === 1 && !preflightOnly) {
                const state = JSON.parse(await readFile(config.statePath, 'utf8'));
                const fixture = state.pdfs.find(value => value.label === 'retry');
                assert.ok(fixture.attachmentPath.startsWith(data + path.sep), 'Recovery target escaped isolated data directory');
                const original = await readFile(fixture.attachmentPath);
                assert.ok(original.includes(Buffer.from('Synthetic temporarily damaged PDF fixture.')));
                const restored = await readFile(fixture.recoveryPath);
                await writeFile(fixture.attachmentPath, restored);
                await writeFile(path.join(run, 'environment-recovery.json'), JSON.stringify({
                    afterNormalExit: result.exit.normal, attachmentPath: fixture.attachmentPath,
                    action: 'replace damaged synthetic PDF with valid two-page PDF; leave local annotation store unchanged',
                    beforeSHA256: createHash('sha256').update(original).digest('hex'),
                    afterSHA256: createHash('sha256').update(restored).digest('hex'),
                }, null, 2));
            }
        }
        const productIssues = phases.at(-1)?.value.productIssues || [];
        const report = { passed: productIssues.length === 0, persistencePassed: preflightOnly ? null : true,
            mode: preflightOnly ? 'isolated-two-phase-preflight-only' : 'installed-product-xpi',
            run, profile, data, product, isolation, phases, productIssues };
        await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ passed: report.passed, persistencePassed: report.persistencePassed,
            reportPath: path.join(run, 'report.json'), product,
            phases: phases.map(value => ({ phase: value.phase, checks: value.value.checks?.length ?? 0, exit: value.exit })),
            productIssues }, null, 2));
        assert.equal(productIssues.length, 0, `Product assertions failed; see ${path.join(run, 'report.json')}`);
    }
}
catch (error) {
    await writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2));
    throw error;
}
finally { console.log(`Fixtures, profile and diagnostics retained: ${run}`); }
