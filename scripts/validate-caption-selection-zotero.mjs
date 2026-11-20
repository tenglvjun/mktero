import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { BEFORE_TEXT, AFTER_TEXT, createCaptionFixtures, corpusCaptionFixtures } from './caption-selection-zotero/fixtures.mjs';
import { runCaptionSelectionSmoke } from './caption-selection-zotero/smoke.mjs';
import { isolatedEnvironment, launchPhase, sandboxPolicy, verifySandbox } from './research-note-zotero/isolation.mjs';

const usage = 'Usage: node scripts/validate-caption-selection-zotero.mjs [--fixtures | --preflight] [--corpus corpus.json]';
const args = process.argv.slice(2);
const fixtureOnly = args.includes('--fixtures');
const preflightOnly = args.includes('--preflight');
assert.ok(!(fixtureOnly && preflightOnly), usage);
let corpusPath;
for (let index = 0; index < args.length; index++) {
    if (args[index] === '--corpus') {
        assert.ok(!corpusPath && args[index + 1] && !args[index + 1].startsWith('--'), usage);
        corpusPath = path.resolve(args[++index]);
    }
    else assert.ok(args[index] === '--fixtures' || args[index] === '--preflight', usage);
}
if (!fixtureOnly) assert.equal(process.platform, 'darwin', 'Real Zotero validation requires the macOS sandbox');
const repository = fileURLToPath(new URL('../', import.meta.url));
const fixtures = createCaptionFixtures();
if (corpusPath) {
    const source = await readFile(corpusPath, 'utf8');
    assert.ok(source.length <= 8 * 1024 * 1024, 'Corpus JSON exceeds 8 MiB');
    const records = JSON.parse(source);
    assert.ok(Array.isArray(records) && records.length <= 12, 'Corpus must be an array of at most 12 records');
    const loaded = [];
    for (const record of records) {
        const markdownPath = record?.markdownPath ?? record?.markdownFile;
        assert.ok(typeof record?.markdown === 'string' || typeof markdownPath === 'string',
            'Corpus records need markdown or markdownPath');
        const markdown = typeof record.markdown === 'string' ? record.markdown
            : await readFile(path.resolve(path.dirname(corpusPath), markdownPath), 'utf8');
        loaded.push({ label: record.label, markdown, figureIndex: record.figureIndex });
    }
    fixtures.push(...corpusCaptionFixtures(loaded));
}
const run = await mkdtemp(path.join(fixtureOnly ? tmpdir() : '/private/tmp', 'mktero-caption-selection-'));
const resultPath = path.join(run, 'phase-1.result.json');
console.log(`Isolated caption run: ${run}`);
console.log(`Result: ${resultPath}`);
try {
    await writeFile(path.join(run, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
    if (fixtureOnly) {
        const report = { mode: 'fixtures-only', passed: true, zoteroLaunched: false,
            fixtureCount: fixtures.length, fixtures: fixtures.map(({ id, label, width }) => ({ id, label, width })) };
        await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    }
    else {
        const profile = path.join(run, 'profile');
        const data = path.join(run, 'data');
        const extensions = path.join(profile, 'extensions');
        for (const directory of [extensions, data, path.join(run, 'home'), path.join(run, 'tmp')]) {
            await mkdir(directory, { recursive: true });
        }
        const env = isolatedEnvironment(run);
        const policy = sandboxPolicy(run);
        await writeFile(path.join(run, 'sandbox.sb'), policy);
        const isolation = await verifySandbox(policy, env);
        await writeFile(path.join(run, 'isolation.json'), JSON.stringify(isolation, null, 2));
        if (preflightOnly) {
            const report = { mode: 'sandbox-preflight-only', passed: true, isolation, zoteroLaunched: false };
            await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
            console.log(JSON.stringify(report));
        }
        else {
            await build({
                entryPoints: [path.join(repository, 'scripts/caption-selection-zotero/editor-entry.mjs')],
                outfile: path.join(run, 'editor.js'), bundle: true, format: 'iife',
                globalName: 'MkteroCaptionHarness', platform: 'browser', target: 'firefox115', logLevel: 'silent',
            });
            await cp(path.join(repository, 'node_modules/katex/dist'), path.join(run, 'katex'), { recursive: true });
            await cp(path.join(repository, 'ui/markdown.css'), path.join(run, 'reader.css'));
            const sourceBundleSHA256 = createHash('sha256').update(await readFile(path.join(run, 'editor.js'))).digest('hex');
            const config = { run, profile, data, fixtures, beforeText: BEFORE_TEXT, afterText: AFTER_TEXT,
                phase: 1, resultPath, stagePath: path.join(run, 'phase-1.stage') };
            const bootstrap = `
                function install() {}
                function shutdown() {}
                function uninstall() {}
                var started;
                function startup() {
                    if (started) return;
                    started = true;
                    (async () => {
                        const config = ${JSON.stringify(config)};
                        let result;
                        try { result = { ok: true, value: await (${runCaptionSelectionSmoke.toString()})(config) }; }
                        catch (error) { result = { ok: false, error: String(error), stack: error.stack }; }
                        result.phase = config.phase;
                        result.stage = await IOUtils.readUTF8(config.stagePath);
                        result.quitRequested = 'eAttemptQuit';
                        await IOUtils.writeUTF8(config.resultPath, JSON.stringify(result, null, 2), {
                            tmpPath: config.resultPath + '.tmp',
                        });
                        Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
                    })().catch(error => Zotero.logError(error));
                }
            `;
            await writeFile(path.join(extensions, 'caption-selection-harness@mktero.local.xpi'), zipSync({
                'manifest.json': strToU8(JSON.stringify({
                    manifest_version: 2, name: 'Mktero Isolated Caption Selection Validation', version: '1.0.0',
                    applications: { zotero: { id: 'caption-selection-harness@mktero.local',
                        update_url: 'https://caption-selection.invalid/updates.json',
                        strict_min_version: '7.0', strict_max_version: '10.0.*' } },
                })),
                'bootstrap.js': strToU8(bootstrap),
            }));
            const prefs = {
                'extensions.enabledScopes': 1, 'extensions.autoDisableScopes': 0,
                'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
                'extensions.logging.enabled': true, 'browser.dom.window.dump.enabled': true,
                'devtools.console.stdout.chrome': true, 'network.process.enabled': false,
                'extensions.zotero.useDataDir': true, 'extensions.zotero.dataDir': data,
                'extensions.zotero.firstRun2': false, 'extensions.zotero.firstRunGuidance': false,
                'extensions.zotero.sync.autoSync': false, 'extensions.zotero.automaticScraperUpdates': false,
                'app.update.enabled': false, 'toolkit.telemetry.enabled': false,
                'network.manage-offline-status': false, 'browser.shell.checkDefaultBrowser': false,
            };
            await writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
                .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
            const phase = await launchPhase({ policy, env, ...config });
            const report = { mode: 'unmodified-editor-source-in-real-gecko', passed: true,
                run, sourceBundleSHA256, isolation, phase };
            await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
            console.log(JSON.stringify(report));
        }
    }
}
catch (error) {
    await writeFile(path.join(run, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2));
    throw error;
}
finally {
    console.log(`Fixtures and diagnostics retained: ${run}`);
}
