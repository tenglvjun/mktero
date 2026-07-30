import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(projectRoot, 'build');
const packageRoot = path.join(buildRoot, 'package');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
const markdownStyles = await readFile(
    path.join(projectRoot, 'ui/markdown.css'),
    'utf8'
);
const xpiName = `mktero-${manifest.version}.xpi`;
const xpiPath = path.join(buildRoot, xpiName);
const packageFiles = [
    'bootstrap.js',
    'licenses/lucide.txt',
    'manifest.json',
    'prefs.js',
    'ui/icons/mktero.svg',
    'ui/preferences.css',
    'ui/preferences.js',
    'ui/preferences.xhtml',
].sort();

await rm(buildRoot, { recursive: true, force: true });
await mkdir(path.join(packageRoot, 'ui'), { recursive: true });
await mkdir(path.join(packageRoot, 'ui/icons'), { recursive: true });
await mkdir(path.join(packageRoot, 'licenses'), { recursive: true });

await Promise.all([
    build({
        entryPoints: [path.join(projectRoot, 'src/bootstrap.js')],
        outfile: path.join(packageRoot, 'bootstrap.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['firefox115'],
        legalComments: 'none',
        define: {
            __MKTERO_MARKDOWN_STYLES__: JSON.stringify(markdownStyles),
        },
    }),
    build({
        entryPoints: [path.join(projectRoot, 'src/ui/preferences.js')],
        outfile: path.join(packageRoot, 'ui/preferences.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['firefox115'],
        legalComments: 'none',
    }),
]);

await Promise.all([
    copyText('manifest.json', 'manifest.json'),
    copyText('ui/preferences.xhtml', 'ui/preferences.xhtml'),
    copyText('ui/preferences.css', 'ui/preferences.css'),
    copyText('ui/icons/mktero.svg', 'ui/icons/mktero.svg'),
    copyText('node_modules/lucide/LICENSE', 'licenses/lucide.txt'),
    copyText('prefs.js', 'prefs.js'),
]);

const archiveEntries = Object.fromEntries(await Promise.all(
    packageFiles.map(async fileName => [
        fileName,
        await readFile(path.join(packageRoot, fileName)),
    ])
));
const xpi = zipSync(archiveEntries, {
    level: 9,
    mtime: new Date(1980, 0, 1, 0, 0, 0),
});
const digest = createHash('sha256').update(xpi).digest('hex');
const updateManifest = {
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
};

await Promise.all([
    writeFile(xpiPath, xpi),
    writeFile(
        `${xpiPath}.sha256`,
        `${digest}  ${xpiName}\n`
    ),
    writeFile(
        path.join(buildRoot, 'updates.json'),
        `${JSON.stringify(updateManifest, null, 2)}\n`
    ),
]);
console.log(`Built release assets for ${xpiName}`);

async function copyText(source, destination) {
    const content = await readFile(path.join(projectRoot, source), 'utf8');
    await writeFile(path.join(packageRoot, destination), content);
}
