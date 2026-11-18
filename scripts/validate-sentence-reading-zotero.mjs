import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { runSmoke } from './sentence-reading-zotero/smoke.mjs';

const app = '/Applications/Zotero.app';
const sandbox = '/usr/bin/sandbox-exec';
const perl = '/usr/bin/perl5.34';
const productID = 'mktero@tenglvjun.github.io';
const helperID = 'sentence-reading-smoke@mktero.local';
const [argument, ...extra] = process.argv.slice(2);
assert.ok(argument && !extra.length && (argument === '--preflight' || argument === '--fixtures'
    || (!argument.startsWith('-') && argument.endsWith('.xpi'))),
'Usage: node scripts/validate-sentence-reading-zotero.mjs <product.xpi> | --preflight | --fixtures');
const fixtureOnly = argument === '--fixtures';
const preflightOnly = argument === '--preflight';
if (!fixtureOnly) assert.equal(process.platform, 'darwin', 'Refusing to launch Zotero without the macOS sandbox');
const run = await mkdtemp(path.join(fixtureOnly ? tmpdir() : '/private/tmp', 'mktero-sentence-reading-'));
let keep = true;
try {
    const profile = path.join(run, 'profile');
    const data = path.join(run, 'data');
    const extensions = path.join(profile, 'extensions');
    const home = path.join(run, 'home');
    const tmp = path.join(run, 'tmp');
    for (const dir of [extensions, data, home, tmp]) await mkdir(dir, { recursive: true });
    const env = {
        HOME: home, CFFIXED_USER_HOME: home, TMPDIR: tmp + '/', PATH: '/usr/bin:/bin',
        XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
        MOZ_NO_REMOTE: '1', MOZ_CRASHREPORTER_DISABLE: '1',
    };
    const policy = `
        (version 1)
        (allow default)
        (deny network*)
        (deny process-exec)
        (allow process-exec (subpath ${quote(app)}) (literal ${quote(perl)}))
        (deny file-write*)
        (allow file-write* (subpath ${quote(run)}) (literal "/dev/null"))
        (deny file-read-data
            (subpath ${quote(userInfo().homedir)}) (subpath "/Users") (subpath "/Volumes") (subpath "/Network")
            (subpath "/System/Volumes/Data/Users") (subpath "/private/var/root")
            (subpath "/private/var/folders") (subpath "/private/tmp")
            (subpath "/Library/Application Support/Zotero"))
        (allow file-read-data (subpath ${quote(run)}))
    `;
    if (!fixtureOnly) await verifySandbox(policy, env);
    const { fixturePrefs, prepareFixtures } = preflightOnly ? {} : await import('./sentence-reading-zotero/fixtures.mjs');
    const fixtures = await prepareFixtures?.(run, profile) || [];
    if (fixtureOnly) {
        console.log(JSON.stringify({ mode: 'source-module-fixtures-only', fixtures: fixtures.map(f => f.kind) }));
    }
    else {
        let product = null;
        if (!preflightOnly) {
            const xpi = await readFile(argument);
            const files = unzipSync(xpi, { filter: entry => entry.name === 'manifest.json' });
            const manifest = JSON.parse(strFromU8(files['manifest.json']));
            assert.equal(manifest.applications?.zotero?.id, productID, 'Expected the original Mktero product XPI');
            const xpiPath = path.join(extensions, `${productID}.xpi`);
            const sha256 = createHash('sha256').update(xpi).digest('hex');
            product = { id: productID, version: manifest.version, xpiPath, sha256 };
            await writeFile(xpiPath, xpi);
        }
        const resultPath = path.join(run, 'result.json');
        const stagePath = path.join(run, 'stage');
        const config = { profile, data, product, fixtures, resultPath, stagePath };
        const bootstrap = `
            function install() {}
            function uninstall() {}
            function shutdown() {}
            function startup() {
                const config = ${JSON.stringify(config)};
                (${runSmoke.toString()})(config).then(
                    value => ({ ok: true, value }),
                    error => ({ ok: false, error: String(error), stack: error.stack })
                ).then(result => IOUtils.writeUTF8(config.resultPath, JSON.stringify(result), {
                    tmpPath: config.resultPath + '.tmp',
                }));
            }
        `;
        await writeFile(path.join(extensions, `${helperID}.xpi`), zipSync({
            'manifest.json': strToU8(JSON.stringify({
                manifest_version: 2, name: 'Mktero Sentence Reading Smoke Driver', version: '1.0.0',
                applications: { zotero: { id: helperID, update_url: 'https://sentence-reading.invalid/updates.json',
                    strict_min_version: '10.0', strict_max_version: '10.0.*' } },
            })),
            'bootstrap.js': strToU8(bootstrap),
        }));
        const prefs = {
            'extensions.enabledScopes': 1, 'extensions.autoDisableScopes': 0,
            'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
            'extensions.logging.enabled': true, 'browser.dom.window.dump.enabled': true,
            'devtools.console.stdout.chrome': true,
            // The enclosing Seatbelt policy cannot be stacked with Gecko's socket-process
            // policy. Keep Gecko networking in the still network-denied parent.
            'network.process.enabled': false,
            'extensions.zotero.useDataDir': true, 'extensions.zotero.dataDir': data,
            'extensions.zotero.firstRun2': false, 'extensions.zotero.firstRunGuidance': false,
            'extensions.zotero.automaticScraperUpdates': false, 'extensions.zotero.sync.autoSync': false,
            'app.update.enabled': false, 'toolkit.telemetry.enabled': false, 'network.manage-offline-status': false,
            'browser.shell.checkDefaultBrowser': false, ...fixturePrefs,
        };
        await writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
            .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
        await launch({ policy, env, profile, run, resultPath, stagePath });
    }
    keep = false;
}
finally {
    if (keep) console.error(`Isolated synthetic run retained for diagnostics: ${run}`);
    else {
        if (!fixtureOnly) {
            // macOS installs deny-delete ACLs on generated home directories.
            // Clear them only in our temporary HOME, without following symlinks.
            const acl = spawnSync('/bin/chmod', ['-R', '-P', '-N', path.join(run, 'home')], { encoding: 'utf8' });
            assert.ok(acl.status === 0, `Could not clean synthetic HOME ${run}: ${acl.error || acl.stderr}`);
        }
        await rm(run, { recursive: true, force: true });
    }
}

function quote(value) {
    return JSON.stringify(value);
}

async function verifySandbox(policy, env) {
    const outside = await mkdtemp('/private/tmp/mktero-sandbox-probe-');
    try {
        const sentinel = path.join(outside, 'sentinel');
        await writeFile(sentinel, 'synthetic');
        // No DNS, external address, or listener: a permitted connect would be ECONNREFUSED,
        // not the permission error required here. Check both address families and UDP bind.
        const probe = `
            use Errno qw(EPERM EACCES);
            sub denied { my ($ok, $what) = @_; !$ok && ($! == EPERM || $! == EACCES) or die "$what not denied ($!)"; }
            for my $family (AF_INET, AF_INET6) {
                my $address = $family == AF_INET ? sockaddr_in(9, inet_aton('127.0.0.1'))
                    : Socket::sockaddr_in6(9, Socket::inet_pton(AF_INET6, '::1'));
                socket(my $tcp, $family, SOCK_STREAM, 0) or die "TCP socket: $!";
                denied(connect($tcp, $address), "TCP connect");
                socket(my $udp, $family, SOCK_DGRAM, 0) or die "UDP socket: $!";
                denied(bind($udp, $address), "UDP bind");
            }
            denied(open(my $read, '<', $ARGV[0]), 'read outside isolated run');
            denied(open(my $write, '>', $ARGV[0]), 'write outside isolated run');
            print "denied\\n";
        `;
        const check = spawnSync(sandbox, ['-p', policy, perl, '-MSocket', '-e', probe, sentinel], {
            cwd: env.HOME, env, encoding: 'utf8', timeout: 5000,
        });
        assert.ok(check.status === 0 && check.stdout.trim() === 'denied',
            `Isolation preflight failed; Zotero was not launched: ${check.error || check.stderr || check.signal || check.status}`);
        console.log('Sandbox preflight passed: TCP/UDP and outside-run file access denied.');
    }
    finally {
        await rm(outside, { recursive: true, force: true });
    }
}

async function launch({ policy, env, profile, run, resultPath, stagePath }) {
    const log = await open(path.join(run, 'process.log'), 'w');
    const child = spawn(sandbox, ['-p', policy, app + '/Contents/MacOS/zotero',
        '-no-remote', '-profile', profile, '-offline'], {
        cwd: run, env, stdio: ['ignore', log.fd, log.fd],
    });
    let done = false;
    let launchError;
    const exited = new Promise(resolve => {
        child.once('exit', (code, signal) => { done = true; resolve({ code, signal }); });
        child.once('error', error => { launchError = error; done = true; resolve(); });
    });
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
        const deadline = Date.now() + 60000;
        const startupDeadline = Date.now() + 20000;
        let stage = '';
        while (Date.now() < deadline && !cancelled) {
            const current = await readOptional(stagePath);
            if (current && current !== stage) console.log(`Zotero smoke: ${stage = current}`);
            const serialized = await readOptional(resultPath);
            if (serialized) {
                const result = JSON.parse(serialized);
                assert.ok(result.ok, `Zotero smoke failed at ${stage}: ${result.error}\n${result.stack || ''}`);
                console.log(JSON.stringify(result.value));
                return;
            }
            if (launchError) throw launchError;
            if (done) throw new Error(`Zotero exited during ${stage || 'startup'}: ${JSON.stringify(await exited)}`);
            if (!stage && Date.now() >= startupDeadline) break;
            await delay(200);
        }
        throw new Error(cancelled ? 'Zotero smoke cancelled' : `Zotero smoke timed out at ${stage || 'startup'}`);
    }
    finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        // Never discover processes by name or signal any process other than our child.
        if (!done) child.kill('SIGTERM');
        await Promise.race([exited, delay(2500, undefined, { ref: false })]);
        if (!done) child.kill('SIGKILL');
        await exited;
        await log.close();
    }
}

async function readOptional(file) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
