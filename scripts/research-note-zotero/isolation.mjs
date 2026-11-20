import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const zoteroApp = '/Applications/Zotero.app';
const sandbox = '/usr/bin/sandbox-exec';
const perl = '/usr/bin/perl5.34';

export function isolatedEnvironment(run) {
    const home = path.join(run, 'home');
    return {
        HOME: home, CFFIXED_USER_HOME: home, TMPDIR: path.join(run, 'tmp') + '/',
        PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
        MOZ_NO_REMOTE: '1', MOZ_CRASHREPORTER_DISABLE: '1',
    };
}

export function sandboxPolicy(run) {
    // Same Seatbelt boundary as validate-sentence-reading-zotero.mjs. HOME
    // overrides and Gecko offline mode alone do not isolate a real library.
    const quote = JSON.stringify;
    return `
        (version 1)
        (allow default)
        (deny network*)
        (deny process-exec)
        (allow process-exec (subpath ${quote(zoteroApp)}) (literal ${quote(perl)}))
        (deny file-write*)
        (allow file-write* (subpath ${quote(run)}) (literal "/dev/null"))
        (deny file-read-data
            (subpath ${quote(userInfo().homedir)}) (subpath "/Users") (subpath "/Volumes") (subpath "/Network")
            (subpath "/System/Volumes/Data/Users") (subpath "/private/var/root")
            (subpath "/private/var/folders") (subpath "/private/tmp")
            (subpath "/Library/Application Support/Zotero"))
        (allow file-read-data (subpath ${quote(run)}))
    `;
}

export async function verifySandbox(policy, env) {
    const outside = await mkdtemp('/private/tmp/mktero-research-note-probe-');
    const inside = path.join(env.HOME, 'sandbox-probe');
    try {
        const sentinel = path.join(outside, 'sentinel');
        await writeFile(sentinel, 'synthetic');
        await writeFile(inside, 'synthetic');
        const probe = `
            use Errno qw(EPERM EACCES);
            sub denied { my ($ok, $what) = @_; !$ok && ($! == EPERM || $! == EACCES) or die "$what not denied ($!)"; }
            for my $family (AF_INET, AF_INET6) {
                my $address = $family == AF_INET ? sockaddr_in(9, inet_aton('127.0.0.1'))
                    : Socket::sockaddr_in6(9, Socket::inet_pton(AF_INET6, '::1'));
                socket(my $tcp, $family, SOCK_STREAM, 0) or die "TCP socket: $!";
                denied(connect($tcp, $address), 'TCP connect');
                socket(my $udp, $family, SOCK_DGRAM, 0) or die "UDP socket: $!";
                denied(bind($udp, $address), 'UDP bind');
            }
            denied(open(my $read, '<', $ARGV[0]), 'read outside isolated run');
            denied(open(my $write, '>', $ARGV[0]), 'write outside isolated run');
            denied(opendir(my $home, $ARGV[1]), 'read real user HOME');
            open(my $allowedRead, '<', $ARGV[2]) or die "isolated read: $!";
            close($allowedRead);
            open(my $allowedWrite, '>', $ARGV[2]) or die "isolated write: $!";
            close($allowedWrite);
            print "denied-outside-allowed-inside\\n";
        `;
        const result = spawnSync(sandbox, ['-p', policy, perl, '-MSocket', '-e', probe,
            sentinel, userInfo().homedir, inside], {
            cwd: env.HOME, env, encoding: 'utf8', timeout: 5000,
        });
        assert.ok(result.status === 0 && result.stdout.trim() === 'denied-outside-allowed-inside',
            `Isolation preflight failed; Zotero was not launched: ${result.error || result.stderr || result.signal || result.status}`);
        return { realHomeReadDenied: true, outsideRunReadWriteDenied: true,
            ipv4AndIPv6TCPDenied: true, ipv4AndIPv6UDPDenied: true, isolatedRunReadWriteAllowed: true };
    }
    finally {
        await rm(outside, { recursive: true, force: true });
        await rm(inside, { force: true });
    }
}

export async function readOptional(file) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function launchPhase({ policy, env, profile, run, phase, resultPath, stagePath }) {
    const log = await open(path.join(run, `phase-${phase}.process.log`), 'w');
    const child = spawn(sandbox, ['-p', policy, zoteroApp + '/Contents/MacOS/zotero',
        '-no-remote', '-profile', profile, '-offline'], {
        cwd: run, env, stdio: ['ignore', log.fd, log.fd],
    });
    let done = false;
    let launchError;
    let exit;
    let forcedTermination = false;
    const exited = new Promise(resolve => {
        child.once('exit', (code, signal) => {
            done = true;
            exit = { code, signal };
            resolve();
        });
        child.once('error', error => { launchError = error; done = true; resolve(); });
    });
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
        const deadline = Date.now() + 120000;
        const startupDeadline = Date.now() + 30000;
        let quitDeadline;
        let stage = '';
        let result;
        while (Date.now() < deadline && !cancelled) {
            if (launchError) throw launchError;
            const current = await readOptional(stagePath);
            if (current && current !== stage) console.log(`Zotero research note / phase ${phase}: ${stage = current}`);
            const serialized = await readOptional(resultPath);
            if (serialized) {
                result = JSON.parse(serialized);
                assert.equal(result.phase, phase, 'Driver reported the wrong phase');
                assert.equal(result.quitRequested, 'eAttemptQuit', 'Driver did not request a normal quit');
                if (!result.ok && !quitDeadline) {
                    console.error(`Phase ${phase} failed at ${result.stage}: ${result.error}; waiting for quit/exit. Run: ${run}`);
                }
                quitDeadline ??= Date.now() + 20000;
            }
            if (done) {
                assert.ok(result, `Zotero exited before phase ${phase} completed: ${JSON.stringify(exit)}`);
                assert.equal(exit?.signal, null, 'A signalled Zotero exit cannot pass validation');
                assert.equal(exit?.code, 0, 'Zotero did not exit successfully');
                checkNormalExit({ ...exit, forcedTermination });
                console.log(`Zotero research note / phase ${phase}: normal exit confirmed (code 0, no signal)`);
                assert.ok(result.ok, `Phase ${phase} failed at ${result.stage}: ${result.error}\n${result.stack || ''}`);
                return { ...result, exit: { ...exit, forcedTermination, normal: true } };
            }
            if (quitDeadline && Date.now() >= quitDeadline) {
                throw new Error(`Zotero did not exit after eAttemptQuit in phase ${phase}`);
            }
            if (!stage && Date.now() >= startupDeadline) break;
            await delay(200);
        }
        throw new Error(cancelled ? `Phase ${phase} cancelled`
            : `Phase ${phase} timed out at ${stage || 'startup'}`);
    }
    finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        // Signals are failure cleanup only. Success returns only after a clean
        // exit; never discover or signal another Zotero process by name.
        if (!done) {
            forcedTermination = true;
            child.kill('SIGTERM');
            await Promise.race([exited, delay(2500, undefined, { ref: false })]);
            if (!done) child.kill('SIGKILL');
        }
        await exited;
        try {
            await writeFile(path.join(run, `phase-${phase}.exit.json`), JSON.stringify({
                pid: child.pid, ...exit, launchError: launchError?.message,
                forcedTermination, normal: !launchError && !forcedTermination && exit?.code === 0 && exit?.signal === null,
            }, null, 2));
        }
        finally { await log.close(); }
    }
}

export function checkNormalExit(exit) {
    assert.equal(exit.forcedTermination, false, 'Failure cleanup cannot count as a normal exit');
    assert.equal(exit.signal, null, 'A signalled Zotero exit cannot pass validation');
    assert.equal(exit.code, 0, 'Zotero did not exit successfully');
}
