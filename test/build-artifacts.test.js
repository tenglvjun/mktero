import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
    for (const required of [
        'bootstrap.js',
        'licenses/lucide.txt',
        'licenses/pdfjs.txt',
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
    assert.match(
        strFromU8(packageEntries['licenses/pdfjs.txt']),
        /Apache License/
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

async function buildProject() {
    await execFileAsync(process.execPath, ['scripts/build.mjs'], {
        cwd: projectRoot,
    });
}
