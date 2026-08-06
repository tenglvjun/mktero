import { createHash } from 'node:crypto';
import {
    copyFile,
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
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
const requiredPackageFiles = [
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
].sort();
const pdfjsAssetDirectories = [
    'cmaps',
    'standard_fonts',
    'wasm',
];

await rm(buildRoot, { recursive: true, force: true });
await mkdir(path.join(packageRoot, 'ui'), { recursive: true });
await mkdir(path.join(packageRoot, 'ui/icons'), { recursive: true });
await mkdir(path.join(packageRoot, 'licenses'), { recursive: true });
await mkdir(path.join(packageRoot, 'pdfjs'), { recursive: true });

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
        entryPoints: [path.join(
            projectRoot,
            'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
        )],
        outfile: path.join(packageRoot, 'pdf.worker.mjs'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: ['firefox115'],
        legalComments: 'none',
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
    copyText('node_modules/pdfjs-dist/LICENSE', 'licenses/pdfjs.txt'),
    copyText('prefs.js', 'prefs.js'),
    ...pdfjsAssetDirectories.map(directory => copyDirectory(
        path.join(projectRoot, 'node_modules/pdfjs-dist', directory),
        path.join(packageRoot, 'pdfjs', directory)
    )),
]);

const packageFiles = await collectFiles(packageRoot);
for (const required of requiredPackageFiles) {
    if (!packageFiles.includes(required)) {
        throw new Error(`Missing packaged runtime asset: ${required}`);
    }
}
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

async function copyDirectory(source, destination) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            await copyDirectory(sourcePath, destinationPath);
        }
        else if (entry.isFile()) {
            await copyFile(sourcePath, destinationPath);
        }
    }
}

async function collectFiles(directory, relativePath = '') {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const childRelativePath = relativePath
            ? `${relativePath}/${entry.name}`
            : entry.name;
        if (entry.isDirectory()) {
            files.push(...await collectFiles(
                path.join(directory, entry.name),
                childRelativePath
            ));
        }
        else if (entry.isFile()) {
            files.push(childRelativePath);
        }
    }
    return files.sort();
}
