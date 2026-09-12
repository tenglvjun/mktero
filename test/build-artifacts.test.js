import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { strFromU8, unzipSync } from 'fflate';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);
const manifest = JSON.parse(await readFile(
    path.join(projectRoot, 'manifest.json'),
    'utf8'
));
const xpiName = `mktero-${manifest.version}.xpi`;

test('builds reproducible release assets and Zotero update metadata', async () => {
    await buildProject();
    const firstXPI = await readFile(path.join(projectRoot, 'build', xpiName));
    const checksum = await readFile(
        path.join(projectRoot, 'build', `${xpiName}.sha256`),
        'utf8'
    );
    const updates = JSON.parse(await readFile(
        path.join(projectRoot, 'build', 'updates.json'),
        'utf8'
    ));

    await buildProject();
    const secondXPI = await readFile(path.join(projectRoot, 'build', xpiName));
    const digest = createHash('sha256').update(firstXPI).digest('hex');
    const packageEntries = unzipSync(firstXPI);

    assert.deepEqual(secondXPI, firstXPI);
    assert.equal(checksum, `${digest}  ${xpiName}\n`);
    const packageNames = Object.keys(packageEntries).sort();
    assert.equal(packageNames.some(name => /(?:^|\/)(?:scripts|test|fixtures)\/|figure-validation|compound-figures/u.test(name)), false);
    for (const required of [
        'bootstrap.js',
        'licenses/d3-dispatch.txt',
        'licenses/d3-force.txt',
        'licenses/d3-quadtree.txt',
        'licenses/d3-timer.txt',
        'licenses/lucide.txt',
        'licenses/pdfjs.txt',
        'licenses/shiki.txt',
        'manifest.json',
        'pdf.worker.mjs',
        'prefs.js',
        'ui/icons/mktero.svg',
        'ui/preferences.css',
        'ui/preferences.js',
        'ui/preferences.xhtml',
    ]) {
        assert.ok(packageNames.includes(required), `Missing ${required}`);
    }
    assert.ok(packageNames.some(name => name.startsWith('pdfjs/cmaps/')));
    assert.ok(packageNames.some(name => (
        name.startsWith('pdfjs/standard_fonts/')
    )));
    assert.ok(packageNames.some(name => name.startsWith('pdfjs/wasm/')));
    assert.match(
        strFromU8(packageEntries['licenses/lucide.txt']),
        /Copyright \(c\) 2026 Lucide Icons and Contributors/
    );
    for (const name of [
        'd3-dispatch',
        'd3-force',
        'd3-quadtree',
        'd3-timer',
    ]) {
        assert.match(
            strFromU8(packageEntries[`licenses/${name}.txt`]),
            /Copyright 2010-2021 Mike Bostock/
        );
    }
    assert.match(
        strFromU8(packageEntries['licenses/pdfjs.txt']),
        /Apache License/
    );
    assert.match(
        strFromU8(packageEntries['licenses/shiki.txt']),
        /MIT License/
    );
    assert.deepEqual(updates, {
        addons: {
            [manifest.applications.zotero.id]: {
                updates: [{
                    version: manifest.version,
                    update_link: `https://github.com/tenglvjun/mktero/releases/download/v${manifest.version}/${xpiName}`,
                    update_hash: `sha256:${digest}`,
                    applications: {
                        zotero: {
                            strict_min_version:
                                manifest.applications.zotero.strict_min_version,
                            strict_max_version:
                                manifest.applications.zotero.strict_max_version,
                        },
                    },
                }],
            },
        },
    });
});

test('loads the packaged Zotero bootstrap without window-only PDF globals', async () => {
    await buildProject();
    const lifecycleNames = [
        'install',
        'startup',
        'shutdown',
        'uninstall',
        'onMainWindowLoad',
        'onMainWindowUnload',
    ];
    const script = `
        delete globalThis.DOMException;
        await import('./build/package/bootstrap.js');
        const missing = ${JSON.stringify(lifecycleNames)}.filter(
            name => typeof globalThis[name] !== 'function'
        );
        if (missing.length) {
            throw new Error('Missing Zotero lifecycle globals: ' + missing.join(', '));
        }
    `;

    await execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        script,
    ], { cwd: projectRoot });
});

test('evaluates the packaged bootstrap without Node runtime globals', async () => {
    await buildProject();
    const source = await readFile(
        path.join(projectRoot, 'build', 'package', 'bootstrap.js'),
        'utf8'
    );
    const windowStreams = {
        ReadableStream: class ReadableStream {},
        TransformStream: class TransformStream {},
        WritableStream: class WritableStream {},
        TextDecoderStream: class TextDecoderStream {},
        TextEncoderStream: class TextEncoderStream {},
    };
    const context = vm.createContext({
        console,
        URL,
        TextEncoder,
        TextDecoder,
        Zotero: { getMainWindow: () => windowStreams },
        Blob,
        FormData,
        Response,
        Request,
        Headers,
        AbortController,
        setTimeout,
        clearTimeout,
    });
    vm.runInContext(source, context);
    assert.equal(typeof context.startup, 'function');
    assert.equal(typeof context.shutdown, 'function');
});

test('bridges Web Streams from the Zotero main window before AI SDK loading', async () => {
    const source = await readFile(
        path.join(projectRoot, 'src', 'platform', 'web-streams.js'),
        'utf8'
    );
    const streams = {
        ReadableStream: class ReadableStream {},
        TransformStream: class TransformStream {},
        WritableStream: class WritableStream {},
        TextDecoderStream: class TextDecoderStream {},
        TextEncoderStream: class TextEncoderStream {},
    };
    const context = vm.createContext({
        Zotero: { getMainWindow: () => streams },
        Services: {
            appShell: {
                get hiddenDOMWindow() {
                    throw new Error('NS_ERROR_FAILURE');
                },
            },
        },
    });
    vm.runInContext(source, context);
    assert.equal(context.ReadableStream, streams.ReadableStream);
    assert.equal(context.TransformStream, streams.TransformStream);
    assert.equal(context.WritableStream, streams.WritableStream);
    assert.equal(context.TextDecoderStream, streams.TextDecoderStream);
    assert.equal(context.TextEncoderStream, streams.TextEncoderStream);
});

test('bridges Web Streams from the hidden DOM window when the main window is unavailable', async () => {
    const streams = {
        ReadableStream: class ReadableStream {},
        TransformStream: class TransformStream {},
        WritableStream: class WritableStream {},
        TextDecoderStream: class TextDecoderStream {},
        TextEncoderStream: class TextEncoderStream {},
    };
    const source = await readFile(
        path.join(projectRoot, 'src', 'platform', 'web-streams.js'),
        'utf8'
    );
    const context = vm.createContext({
        Zotero: { getMainWindow: () => null },
        Services: { appShell: { hiddenDOMWindow: streams } },
    });
    vm.runInContext(source, context);
    assert.equal(context.TransformStream, streams.TransformStream);
    assert.equal(context.TextDecoderStream, streams.TextDecoderStream);
});

async function buildProject() {
    await execFileAsync(process.execPath, ['scripts/build.mjs'], {
        cwd: projectRoot,
    });
}
