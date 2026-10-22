import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { packPreview, previewArchiveName } from '../scripts/package-preview.mjs';

async function previewFixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'mktero-preview-pack-'));
    await mkdir(path.join(root, 'chunks'));
    const files = {
        'index.html': '<!doctype html><script type="module" src="preview.js"></script>\n',
        'preview.js': 'import "./chunks/chunk-A1.js";\n',
        'preview.css': 'body{margin:0}\n',
        'preview.js.LEGAL.txt': 'MIT\n',
        'mktero-preview.json': '{"name":"mktero-preview","version":"1.2.3","commit":null,"embed":1}\n',
        'chunks/chunk-A1.js': 'export const a = 1;\n',
        'chunks/cpp-B2.js': 'x'.repeat(1300),
        'bundle-inputs.json': '{}\n',
    };
    for (const [name, content] of Object.entries(files)) {
        await writeFile(path.join(root, name), content);
    }
    return { root, files };
}

function readTar(archive) {
    const tar = gunzipSync(archive);
    const entries = [];
    for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
        const stored = Number.parseInt(header.subarray(148, 156).toString('ascii'), 8);
        let checksum = 0;
        for (let index = 0; index < 512; index += 1) {
            checksum += index >= 148 && index < 156 ? 0x20 : header[index];
        }
        entries.push({
            name,
            type: String.fromCharCode(header[156]),
            mode: header.subarray(100, 107).toString('ascii'),
            mtime: header.subarray(136, 147).toString('ascii'),
            magic: header.subarray(257, 263).toString('ascii'),
            checksumOK: checksum === stored,
            content: tar.subarray(offset + 512, offset + 512 + size).toString('utf8'),
        });
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
}

test('packs the preview as a sorted, normalized ustar archive without diagnostics', async () => {
    const { root, files } = await previewFixture();
    try {
        const first = await packPreview(root);
        const second = await packPreview(root);
        assert.equal(first.sha256, second.sha256);
        assert.deepEqual(first.archive, second.archive);
        assert.equal(first.sha256, createHash('sha256').update(first.archive).digest('hex'));
        assert.equal(first.archive[9], 0xff);

        const entries = readTar(first.archive);
        const names = entries.map(entry => entry.name);
        assert.deepEqual(names, [...names].sort());
        assert.equal(names.includes('bundle-inputs.json'), false);
        assert.deepEqual(names, Object.keys(files).filter(name => name !== 'bundle-inputs.json').sort());
        for (const entry of entries) {
            assert.equal(entry.type, '0', entry.name);
            assert.equal(entry.mode, '0000644', entry.name);
            assert.equal(entry.mtime, '00000000000', entry.name);
            assert.equal(entry.magic, 'ustar\0', entry.name);
            assert.equal(entry.checksumOK, true, entry.name);
            assert.equal(entry.content, files[entry.name], entry.name);
        }
        assert.equal(previewArchiveName('1.2.3'), 'mktero-preview-1.2.3.tar.gz');
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a system tar lists and extracts the archive', async t => {
    try {
        execFileSync('tar', ['--version'], { stdio: 'ignore' });
    }
    catch {
        t.skip('tar is not installed');
        return;
    }
    const { root, files } = await previewFixture();
    const out = await mkdtemp(path.join(tmpdir(), 'mktero-preview-unpack-'));
    try {
        const { archive } = await packPreview(root);
        const file = path.join(out, 'preview.tar.gz');
        await writeFile(file, archive);
        const listed = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
        assert.equal(listed.length, Object.keys(files).length - 1);
        await mkdir(path.join(out, 'x'));
        execFileSync('tar', ['-xzf', file, '-C', path.join(out, 'x')]);
        assert.equal(await readFile(path.join(out, 'x', 'chunks', 'cpp-B2.js'), 'utf8'), files['chunks/cpp-B2.js']);
    }
    finally {
        await rm(root, { recursive: true, force: true });
        await rm(out, { recursive: true, force: true });
    }
});

test('refuses a preview without its manifest, or with a link or an unsafe name', async () => {
    const { root } = await previewFixture();
    try {
        await rm(path.join(root, 'mktero-preview.json'));
        await assert.rejects(packPreview(root), /preview file missing: mktero-preview\.json/);
        await writeFile(path.join(root, 'mktero-preview.json'), '{}\n');
        await symlink('preview.js', path.join(root, 'alias.js'));
        await assert.rejects(packPreview(root), /preview link not packable: alias\.js/);
        await rm(path.join(root, 'alias.js'));
        await writeFile(path.join(root, 'bad name.js'), '');
        await assert.rejects(packPreview(root), /preview path not packable: bad name\.js/);
        await rm(path.join(root, 'bad name.js'));
        await mkdir(path.join(root, 'a', 'b', 'c', 'd'), { recursive: true });
        await writeFile(path.join(root, 'a', 'b', 'c', 'd', 'deep.js'), '');
        await assert.rejects(packPreview(root), /preview path not packable: a\/b\/c\/d\/deep\.js/);
        await rm(path.join(root, 'a'), { recursive: true });
        await writeFile(path.join(root, 'chunks', 'huge.js'), Buffer.alloc(8 * 1024 * 1024 + 1));
        await assert.rejects(packPreview(root), /preview file too large: chunks\/huge\.js/);
        await rm(path.join(root, 'chunks', 'huge.js'));
        for (let index = 0; index < 400; index += 1) {
            await writeFile(path.join(root, 'chunks', `n${index}.js`), '');
        }
        await assert.rejects(packPreview(root), /preview has 4\d\d files; the limit is 400/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
