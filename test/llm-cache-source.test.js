import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createZoteroLLMCacheSource } from '../src/platform/zotero-llm-cache-source.js';

const encode = value => new TextEncoder().encode(value);
const root = '/data/llm-for-zotero-mineru/7';
const code = expected => error => error.code === expected;

function fixture({ limits, yieldToUI, beforeRead } = {}) {
    const nodes = new Map();
    const reads = [];
    const writes = [];
    const attachment = { id: 7, key: 'PDFKEY77', libraryID: 1,
        isPDFAttachment: () => true, getFilePathAsync: async () => '/pdf/paper.pdf' };
    function put(name, contents, type = 'regular') {
        nodes.set(name, { type, size: encode(contents).length, data: encode(contents), lastModified: 10 });
    }
    for (const name of ['/data/llm-for-zotero-mineru', root, `${root}/images`]) put(name, '', 'directory');
    put(`${root}/full.md`, 'Synthetic cached paper body.');
    put(`${root}/content_list.json`, '[]');
    put(`${root}/images/a.png`, 'image');
    put('/pdf/paper.pdf', 'pdf');
    const io = {
        async stat(name) {
            if (!nodes.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
            return { ...nodes.get(name) };
        },
        async getChildren(name) {
            return [...nodes.keys()].filter(candidate => path.posix.dirname(candidate) === name);
        },
        async read(name) {
            reads.push(name);
            await beforeRead?.(name, nodes, reads);
            return Uint8Array.from(nodes.get(name).data);
        },
        async write(...args) { writes.push(args); },
        async remove(...args) { writes.push(args); },
    };
    const zotero = { DataDirectory: { dir: '/data' }, Profile: { dir: '/profile' },
        Items: { get: id => id === attachment.id ? attachment : null } };
    const source = createZoteroLLMCacheSource({ zotero, io, path: path.posix,
        limits, yieldToUI: yieldToUI || (async () => {}) });
    return { source, nodes, reads, writes, attachment, put, zotero, io };
}

test('menu probe only stats fixed candidates and never reads PDF or cache contents', async () => {
    const f = fixture();
    assert.equal(await f.source.probeCandidate(f.attachment), true);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.writes, []);
    f.nodes.delete(`${root}/full.md`);
    assert.equal(await f.source.probeCandidate(f.attachment), false);
    f.put(`${root}/full.md`, 'New cache');
    assert.equal(await f.source.probeCandidate(f.attachment), true);
    f.put(`${root}/_llm_write_pending.json`, '{}');
    assert.equal(await f.source.probeCandidate(f.attachment), false);
});

test('does not search profile cache when configured data directory lacks a result', async () => {
    const f = fixture();
    f.nodes.delete(root);
    f.put('/profile/llm-for-zotero-mineru/7/full.md', 'another cache');
    assert.equal(await f.source.probeCandidate(f.attachment), false);
});

test('falls back to Profile only when DataDirectory is unavailable', async () => {
    const f = fixture();
    f.zotero.DataDirectory = {};
    for (const [name, node] of [...f.nodes]) {
        if (name.startsWith('/data/')) f.nodes.set(name.replace('/data/', '/profile/'), node);
    }
    assert.equal(await f.source.probeCandidate(f.attachment), true);
});

test('captures stable supported inputs and verifies their hashes without writing', async () => {
    const f = fixture();
    f.put(`${root}/private.log`, 'not an input');
    const snapshot = await f.source.capture(f.attachment);
    assert.equal(snapshot.sourceRoot, root);
    assert.match(snapshot.readFingerprint, /^[a-f0-9]{64}$/u);
    assert.deepEqual(snapshot.entries.map(entry => entry.path).sort(), ['content_list.json', 'full.md', 'images/a.png']);
    assert.equal(await f.source.verify(snapshot), true);
    assert.ok(!f.reads.some(name => name.endsWith('private.log') || name.endsWith('.pdf')));
    assert.deepEqual(f.writes, []);
    f.put(`${root}/full.md`, 'Changed paper');
    await assert.rejects(f.source.verify(snapshot), code('LLM_CACHE_CHANGED'));
});

test('detects equal-length source mutation even with unchanged timestamps', async () => {
    const f = fixture({ beforeRead(name, nodes, reads) {
        if (name === `${root}/full.md` && reads.filter(value => value === name).length === 2) {
            const node = nodes.get(name);
            node.data[0] ^= 1;
        }
    } });
    await assert.rejects(f.source.capture(f.attachment), code('LLM_CACHE_CHANGED'));
});

test('rejects deleted or replaced attachments before verifying publication', async () => {
    const f = fixture();
    const snapshot = await f.source.capture(f.attachment);
    f.attachment.key = 'REPLACED';
    await assert.rejects(f.source.verify(snapshot), code('LLM_CACHE_CHANGED'));
});

test('rejects symlinks, nested paths returned as immediate children and encoded traversal', async () => {
    for (const [name, type] of [[`${root}/images/a.png`, 'symlink'], [`${root}/images/%2e%2e`, 'directory']]) {
        const f = fixture();
        f.put(name, 'unsafe', type);
        await assert.rejects(f.source.capture(f.attachment), code('LLM_CACHE_UNSAFE_PATH'));
    }
    const f = fixture();
    f.io.getChildren = async () => [`${root}/images/a.png`];
    await assert.rejects(f.source.capture(f.attachment), code('LLM_CACHE_UNSAFE_PATH'));
});

test('canonicalizes an explicitly configured data-root alias without following inner symlinks', async () => {
    const f = fixture();
    f.zotero.DataDirectory.dir = '/system-alias';
    const source = createZoteroLLMCacheSource({ zotero: f.zotero, io: f.io, path: path.posix,
        canonicalizeRoot: async value => value === '/system-alias' ? '/data' : value,
        yieldToUI: async () => {} });
    assert.equal(await source.probeCandidate(f.attachment), true);
    f.put(`${root}/images`, '', 'symlink');
    await assert.rejects(source.capture(f.attachment), code('LLM_CACHE_UNSAFE_PATH'));
});

test('bounds byte counts, entry counts, depth and cancellation', async () => {
    for (const limits of [{ maxTotalBytes: 5 }, { maxEntries: 1 }, { maxAssetBytes: 1 }, { maxDepth: 0 }]) {
        const f = fixture({ limits });
        await assert.rejects(f.source.capture(f.attachment), code('LLM_CACHE_RESOURCE_LIMIT'));
    }
    const controller = new AbortController();
    const f = fixture({ yieldToUI: async () => controller.abort() });
    await assert.rejects(f.source.capture(f.attachment, { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(f.writes, []);
});

test('checks pending markers again before publication', async () => {
    const f = fixture();
    const snapshot = await f.source.capture(f.attachment);
    f.put(`${root}/_llm_write_pending.json`, '{}');
    await assert.rejects(f.source.verify(snapshot), code('LLM_CACHE_WRITING'));
});

test('accepts Windows immediate-child paths without treating the drive as an archive path', async () => {
    const root = 'C:\\Data\\llm-for-zotero-mineru\\7';
    const names = new Map([
        ['C:\\Data\\llm-for-zotero-mineru', { type: 'directory', size: 0 }],
        [root, { type: 'directory', size: 0 }],
        [`${root}\\full.md`, { type: 'regular', size: 4, data: encode('body') }],
        [`${root}\\content_list.json`, { type: 'regular', size: 2, data: encode('[]') }],
        ['C:\\PDF\\paper.pdf', { type: 'regular', size: 3 }],
    ]);
    const attachment = { id: 7, key: 'PDFKEY77', libraryID: 1,
        isPDFAttachment: () => true, getFilePathAsync: async () => 'C:\\PDF\\paper.pdf' };
    const source = createZoteroLLMCacheSource({
        zotero: { DataDirectory: { dir: 'C:\\Data' }, Items: { get: () => attachment } },
        io: {
            async stat(name) {
                if (!names.has(name)) throw Object.assign(new Error(), { name: 'NotFoundError' });
                return names.get(name);
            },
            async getChildren(name) { return [...names.keys()].filter(child => path.win32.dirname(child) === name); },
            async read(name) { return names.get(name).data; },
        },
        path: path.win32, yieldToUI: async () => {},
    });
    assert.equal(await source.probeCandidate(attachment), true);
    assert.deepEqual((await source.capture(attachment)).entries.map(entry => entry.path), ['content_list.json', 'full.md']);
});
