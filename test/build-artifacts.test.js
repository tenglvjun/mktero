import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';

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

    assert.deepEqual(secondXPI, firstXPI);
    assert.equal(checksum, `${digest}  ${xpiName}\n`);
    assert.deepEqual(Object.keys(unzipSync(firstXPI)).sort(), [
        'bootstrap.js',
        'manifest.json',
        'prefs.js',
        'ui/icons/mktero.svg',
        'ui/preferences.css',
        'ui/preferences.js',
        'ui/preferences.xhtml',
    ]);
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

async function buildProject() {
    await execFileAsync(process.execPath, ['scripts/build.mjs'], {
        cwd: projectRoot,
    });
}
