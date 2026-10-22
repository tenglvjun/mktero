// Package build/preview as a release asset, so the website can install the
// reader preview of a published version instead of keeping a copy in git:
//
//   build/mktero-preview-<version>.tar.gz
//   build/mktero-preview-<version>.tar.gz.sha256
//
// The archive is a plain ustar tarball of regular files with fixed modes,
// owners and times, sorted by path, then gzipped. The same build packs to the
// same bytes on one machine. Directories, links and extended headers are not
// written; the website's installer rejects them.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
    PREVIEW_DIAGNOSTICS,
    PREVIEW_MANIFEST,
    buildPreview,
    previewOutput,
} from './build-preview.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCK = 512;
// Every file the embedding page loads directly.
export const PREVIEW_REQUIRED_FILES = ['index.html', 'preview.js', 'preview.css', PREVIEW_MANIFEST];
// The website's installer (mktero-web scripts/app-preview.mjs) refuses
// anything outside these limits, so a release that broke one would be
// published and then fail every deploy. Keep the two in step.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PATH = 100;
const MAX_DEPTH = 4;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

export function previewArchiveName(version) {
    return `mktero-preview-${version}.tar.gz`;
}

// Returns the gzipped archive of `directory` and its SHA-256.
export async function packPreview(directory) {
    const files = await listFiles(directory);
    for (const name of PREVIEW_REQUIRED_FILES) {
        if (!files.includes(name)) throw new Error(`preview file missing: ${name}`);
    }
    if (files.length > MAX_FILES) throw new Error(`preview has ${files.length} files; the limit is ${MAX_FILES}`);
    const blocks = [];
    let total = 0;
    for (const name of files) {
        const content = await readFile(path.join(directory, ...name.split('/')));
        if (content.length > MAX_FILE_BYTES) throw new Error(`preview file too large: ${name}`);
        total += content.length;
        if (total > MAX_FILES_BYTES) throw new Error('preview too large');
        blocks.push(tarHeader(name, content.length), content);
        const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
        if (padding) blocks.push(Buffer.alloc(padding));
    }
    blocks.push(Buffer.alloc(BLOCK * 2));
    const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
    // The gzip header records the packing OS (byte 9). Write "unknown" so the
    // bytes do not depend on where the archive was packed.
    archive[9] = 0xff;
    if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('preview archive too large');
    return {
        archive,
        files,
        sha256: createHash('sha256').update(archive).digest('hex'),
    };
}

async function listFiles(directory, prefix = '') {
    const found = [];
    const entries = await readdir(path.join(directory, ...prefix.split('/').filter(Boolean)), {
        withFileTypes: true,
    });
    for (const entry of entries) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (name === PREVIEW_DIAGNOSTICS) continue;
        if (!SAFE_SEGMENT.test(entry.name) || name.length > MAX_PATH || name.split('/').length > MAX_DEPTH) {
            throw new Error(`preview path not packable: ${name}`);
        }
        const info = await lstat(path.join(directory, ...name.split('/')));
        if (info.isSymbolicLink()) throw new Error(`preview link not packable: ${name}`);
        if (info.isDirectory()) found.push(...await listFiles(directory, name));
        else if (info.isFile()) found.push(name);
        else throw new Error(`preview entry not packable: ${name}`);
    }
    return found.sort();
}

function tarHeader(name, size) {
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    header.write('0000000\0', 329, 'ascii');
    header.write('0000000\0', 337, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return header;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const summary = await buildPreview();
    const { archive, files, sha256 } = await packPreview(previewOutput);
    const name = previewArchiveName(summary.version);
    const target = path.join(projectRoot, 'build', name);
    await writeFile(target, archive);
    await writeFile(`${target}.sha256`, `${sha256}  ${name}\n`);
    console.log(`build/${name}: ${files.length} files, ${(archive.length / 1024).toFixed(0)} KiB, sha256 ${sha256}`);
}
