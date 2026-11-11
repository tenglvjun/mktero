// Builds the Mktero Markdown renderer as a self-contained browser bundle for
// the iOS app.
//
// The website preview (scripts/build-preview.mjs) bundles the whole reader UI:
// a Zotero-style shell, the notes column, the annotation overlay, translation,
// and revision editing. That reader needs 93 model fields and 41 callbacks
// because it is an application, not a renderer, and the iOS app has none of
// those services.
//
// This bundle instead exposes the one piece the app actually needs: the pure
// Markdown-to-HTML function the extension itself uses. It has no Zotero global
// dependency and no network access.
//
// Output goes to the iOS repository as a packaged resource. Run it after any
// change to the extension's renderer:
//
//   npm run build:ios-renderer
//
// The output directory is committed so an iOS build does not require Node.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iosRepository = path.resolve(projectRoot, '..', 'mktero-iOS');
export const rendererOutput = path.join(
    iosRepository,
    'Mktero/Resources/Renderer',
);

// The iOS deployment target is 17.0, which ships Safari 17. Matching a recent
// WebKit keeps the bundle small without emitting syntax an older iOS rejects.
export const IOS_RENDERER_TARGETS = ['safari16.4'];

// Describes the build, so the app can report which renderer it carries and a
// mismatch between app and bundle is visible instead of silent.
export const RENDERER_MANIFEST = 'mktero-renderer.json';

export async function buildIOSRenderer({ minify = true } = {}) {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
    await rm(rendererOutput, { recursive: true, force: true });
    await mkdir(rendererOutput, { recursive: true });

    const result = await build({
        entryPoints: { renderer: path.join(projectRoot, 'scripts/ios-renderer-entry.js') },
        outdir: rendererOutput,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: IOS_RENDERER_TARGETS,
        minify,
        metafile: true,
        legalComments: 'linked',
        logLevel: 'warning',
        define: {
            __MKTERO_BUILD__: JSON.stringify('release'),
            __MKTERO_VERSION__: JSON.stringify(manifest.version),
            process: 'undefined',
            Buffer: 'undefined',
        },
    });

    const output = Object.entries(result.metafile.outputs)
        .filter(([file]) => file.endsWith('.js'))
        .map(([file, meta]) => ({ file: path.basename(file), bytes: meta.bytes }));
    const totalBytes = output.reduce((sum, entry) => sum + entry.bytes, 0);

    await writeFile(
        path.join(rendererOutput, RENDERER_MANIFEST),
        `${JSON.stringify({
            name: 'mktero-renderer',
            extensionVersion: manifest.version,
            targets: IOS_RENDERER_TARGETS,
            entry: output[0]?.file || '',
            bytes: totalBytes,
        }, null, 2)}\n`,
        'utf8',
    );

    return { output, totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { output, totalBytes } = await buildIOSRenderer();
    console.log(
        `ios renderer: ${output.map(entry => `${entry.file} ${(entry.bytes / 1024).toFixed(0)} KiB`).join(', ')}`
        + ` (total ${(totalBytes / 1024).toFixed(0)} KiB)`,
    );
}
