// Builds the two JavaScript bundles the iOS app carries.
//
// The website preview (scripts/build-preview.mjs) bundles the whole reader UI: a
// Zotero-style shell, the notes column, the annotation overlay, translation, and
// revision editing. That reader needs 93 model fields and 41 callbacks because it
// is an application, not a renderer, and the iOS app has none of those services.
//
// So the app gets the two pure pieces instead, each in its own bundle:
//
//   renderer.js   Markdown in, reader HTML out. It is `renderMarkdownHTML`, the
//                 same function the desktop reader uses, plus the asset blob
//                 placeholders the app turns into its own figure scheme.
//
//   document.js   MinerU's archive in, reading-order Markdown out. This is the
//                 document IR pipeline the extension runs before rendering:
//                 repeated page chrome dropped, blocks ordered the way the page
//                 is read, heading levels inferred, continued tables merged.
//                 It has no DOM, no Zotero, and no network, so the app can run it
//                 in JavaScriptCore instead of a second WebView.
//
// Output goes to the iOS repository as a packaged resource. Run it after any
// change to the extension's renderer or its document pipeline:
//
//   npm run build:ios-renderer
//
// The output directory is committed so an iOS build does not require Node.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The iOS checkout is a sibling by default. MKTERO_IOS_ROOT overrides it, so a
// git worktree, a CI checkout, or a build script can point at the real app
// without the two repositories having to sit side by side.
const iosRepository = process.env.MKTERO_IOS_ROOT
    ? path.resolve(process.env.MKTERO_IOS_ROOT)
    : path.resolve(projectRoot, '..', 'mktero-iOS');
export const rendererOutput = path.join(
    iosRepository,
    'Mktero/Resources/Renderer',
);

// The iOS deployment target is 17.0, which ships Safari 17 and JavaScriptCore 17.
// Matching a recent WebKit keeps the bundles small without emitting syntax an
// older iOS rejects.
export const IOS_RENDERER_TARGETS = ['safari16.4'];

// Describes the build, so the app can report which renderer it carries and a
// mismatch between app and bundle is visible instead of silent.
export const RENDERER_MANIFEST = 'mktero-renderer.json';

/** The bundles, keyed by output name, with the entry point each one wraps. */
export const IOS_BUNDLES = Object.freeze({
    renderer: 'scripts/ios-renderer-entry.js',
    document: 'scripts/ios-document-entry.js',
});

export async function buildIOSRenderer({ minify = true } = {}) {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
    await rm(rendererOutput, { recursive: true, force: true });
    await mkdir(rendererOutput, { recursive: true });

    const result = await build({
        entryPoints: Object.fromEntries(
            Object.entries(IOS_BUNDLES).map(([name, entry]) => (
                [name, path.join(projectRoot, entry)]
            ))
        ),
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
        .map(([file, meta]) => ({
            file: path.basename(file),
            bytes: meta.bytes,
            entry: Object.entries(IOS_BUNDLES)
                .find(([, source]) => meta.entryPoint === source)?.[0] || '',
        }))
        .sort((left, right) => left.file.localeCompare(right.file));
    const totalBytes = output.reduce((sum, entry) => sum + entry.bytes, 0);

    await writeFile(
        path.join(rendererOutput, RENDERER_MANIFEST),
        `${JSON.stringify({
            name: 'mktero-renderer',
            extensionVersion: manifest.version,
            targets: IOS_RENDERER_TARGETS,
            entry: output.find(item => item.entry === 'renderer')?.file || '',
            document: output.find(item => item.entry === 'document')?.file || '',
            bytes: totalBytes,
            bundles: Object.fromEntries(
                output.map(item => [item.entry || item.file, item.bytes])
            ),
        }, null, 2)}\n`,
        'utf8',
    );

    return { output, totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { output, totalBytes } = await buildIOSRenderer();
    console.log(
        `ios bundles: ${output.map(entry => `${entry.file} ${(entry.bytes / 1024).toFixed(0)} KiB`).join(', ')}`
        + ` (total ${(totalBytes / 1024).toFixed(0)} KiB)`,
    );
}
