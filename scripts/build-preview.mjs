// Build the browser preview of the Mktero reader into build/preview. The XPI
// build is separate and unaffected; this output is a static page for a
// website embed and for browser compatibility checks.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const previewOutput = path.join(projectRoot, 'build/preview');

// Browsers the website supports. The reader itself targets Firefox 115 in the
// XPI; this bundle has to run in current Chromium and WebKit as well.
export const PREVIEW_TARGETS = ['chrome111', 'edge111', 'firefox115', 'safari16.4'];

export async function buildPreview({ minify = true } = {}) {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
    const markdownStyles = await readFile(path.join(projectRoot, 'ui/markdown.css'), 'utf8');
    await rm(previewOutput, { recursive: true, force: true });
    await mkdir(previewOutput, { recursive: true });
    // ESM with splitting keeps Shiki's dynamic grammar imports lazy, so a page
    // downloads only the languages its code blocks use.
    const result = await build({
        entryPoints: { preview: path.join(projectRoot, 'preview/main.js') },
        outdir: previewOutput,
        chunkNames: 'chunks/[name]-[hash]',
        splitting: true,
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: PREVIEW_TARGETS,
        minify,
        metafile: true,
        legalComments: 'linked',
        logLevel: 'warning',
        define: {
            __MKTERO_BUILD__: JSON.stringify('release'),
            __MKTERO_VERSION__: JSON.stringify(manifest.version),
            __MKTERO_MARKDOWN_STYLES__: JSON.stringify(markdownStyles),
            process: 'undefined',
            Buffer: 'undefined',
        },
    });
    const outputs = result.metafile.outputs;
    const entryFile = Object.keys(outputs).find(file => outputs[file].entryPoint === 'preview/main.js');
    const output = outputs[entryFile];
    await Promise.all([
        copyFile(path.join(projectRoot, 'preview/index.html'), path.join(previewOutput, 'index.html')),
        copyFile(path.join(projectRoot, 'preview/preview.css'), path.join(previewOutput, 'preview.css')),
        writeFile(
            path.join(previewOutput, 'bundle-inputs.json'),
            `${JSON.stringify(summarizeInputs(output), null, 2)}\n`
        ),
    ]);
    return {
        bytes: output?.bytes ?? 0,
        startupBytes: staticClosureBytes(outputs, entryFile),
        totalBytes: Object.values(outputs).reduce((total, entry) => total + entry.bytes, 0),
        version: manifest.version,
    };
}

// Bytes a browser fetches before the reader starts: the entry and its static
// imports. Grammar chunks behind dynamic imports load only when needed.
function staticClosureBytes(outputs, entryFile) {
    const seen = new Set();
    const visit = file => {
        if (!file || seen.has(file)) return;
        seen.add(file);
        for (const entry of outputs[file]?.imports || []) {
            if (entry.kind === 'import-statement') visit(entry.path);
        }
    };
    visit(entryFile);
    return [...seen].reduce((total, file) => total + (outputs[file]?.bytes || 0), 0);
}

// Minified bytes per package, so a dependency that slips into the preview
// (for example pdf.js) shows up in review.
function summarizeInputs(output) {
    const packages = {};
    for (const [file, input] of Object.entries(output?.inputs || {})) {
        const match = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
        const name = match ? match[1] : file.split('/')[0];
        packages[name] = (packages[name] || 0) + input.bytesInOutput;
    }
    return Object.fromEntries(Object.entries(packages).sort((a, b) => b[1] - a[1]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const summary = await buildPreview({ minify: !process.argv.includes('--no-minify') });
    const kib = value => `${(value / 1024).toFixed(0)} KiB`;
    console.log(`build/preview: entry ${kib(summary.bytes)}, startup ${kib(summary.startupBytes)}, all chunks ${kib(summary.totalBytes)} (Mktero ${summary.version})`);
}
