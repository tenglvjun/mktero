import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
    constrainExportDirectoryName,
    createMarkdownExportDirectoryName,
    createMarkdownExportPlan,
    createMarkdownExportFileName,
    markdownExportTemporarySuffix,
    MAX_EXPORT_ASSET_BYTES,
    MAX_EXPORT_ASSETS,
    MAX_EXPORT_FILE_STEM_CODE_POINTS,
    MAX_EXPORT_MARKDOWN_BYTES,
    MAX_EXPORT_TOTAL_ASSET_BYTES,
} from '../src/markdown/markdown-export.js';

test('creates safe default Markdown export file names', () => {
    assert.equal(
        createMarkdownExportDirectoryName(
            '  Memory / reactivation: study?.pdf  '
        ),
        'Memory reactivation study'
    );
    assert.equal(
        createMarkdownExportDirectoryName('...', 'document'),
        'document'
    );
    assert.equal(
        createMarkdownExportFileName('  Memory / reactivation: study?.pdf  '),
        'Memory reactivation study.md'
    );
    assert.equal(
        createMarkdownExportFileName('记忆再激活'),
        '记忆再激活.md'
    );
    assert.equal(
        createMarkdownExportFileName('...', 'document'),
        'document.md'
    );
});

test('keeps the reported Windows paper title and shortens names that would reach 260', () => {
    const title = 'Study of (La1-xCax)MnO3. I. Magnetic Structure of LaMnO3 Journal of the Physical Society of Japan';
    const suffix = markdownExportTemporarySuffix(
        'dc3b6389-a940-4a5b-a85b-3369e0ab5e76'
    );
    assert.equal(suffix, '.mktero-dc3b6389.tmp');
    const desktop = 'C:\\Users\\86151\\Desktop';
    const name = constrainExportDirectoryName({
        parentPath: desktop,
        preferredName: title,
        join: path.win32.join,
        temporarySuffix: suffix,
    });
    assert.equal(name, title);
    assert.equal(path.win32.join(
        desktop,
        name,
        `${name}.md${suffix}`
    ).length, 241);
    assert.equal(path.win32.join(
        'D:\\2399067154',
        name,
        `${name}.md${suffix}`
    ).length, 232);

    const shortened = constrainExportDirectoryName({
        parentPath: desktop,
        preferredName: 'x'.repeat(180),
        join: path.win32.join,
        temporarySuffix: suffix,
    });
    assert.equal(shortened, 'x'.repeat(101));
    assert.equal(path.win32.join(
        desktop,
        `${shortened}-1000`,
        `${shortened}-1000.md${suffix}`
    ).length, 259);

    const withFigure = constrainExportDirectoryName({
        parentPath: desktop,
        preferredName: title,
        join: path.win32.join,
        temporarySuffix: suffix,
        assetRelativePaths: [`images/${'a'.repeat(200)}`],
    });
    assert.equal(withFigure, 'Study of (La1-xC');
    assert.equal(path.win32.join(
        desktop,
        `${withFigure}-1000`,
        'assets',
        'images',
        'a'.repeat(200)
    ).length, 259);
});

test('refuses a Windows folder that cannot hold even a one-character export', () => {
    assert.throws(() => constrainExportDirectoryName({
        parentPath: `C:\\${'p'.repeat(240)}`,
        preferredName: 'Paper',
        join: path.win32.join,
        temporarySuffix: '.mktero-dc3b6389.tmp',
    }), /too long to export/);
});

test('enforces Markdown export name and source budgets at their boundaries', () => {
    const exactStem = 'x'.repeat(MAX_EXPORT_FILE_STEM_CODE_POINTS);
    assert.equal(createMarkdownExportFileName(exactStem), exactStem + '.md');
    assert.equal(
        createMarkdownExportFileName(exactStem + 'y'),
        exactStem + '.md'
    );

    const exactMarkdown = 'x'.repeat(MAX_EXPORT_MARKDOWN_BYTES);
    assert.equal(createMarkdownExportPlan({
        markdown: exactMarkdown,
        assetDirectoryName: 'paper.assets',
    }).markdown, exactMarkdown);
    assert.throws(() => createMarkdownExportPlan({
        markdown: exactMarkdown + 'x',
        assetDirectoryName: 'paper.assets',
    }), /source is invalid/);
});

test('enforces individual and aggregate Markdown export image budgets', () => {
    const maxAsset = new Uint8Array(MAX_EXPORT_ASSET_BYTES);
    const exactTotalCount = MAX_EXPORT_TOTAL_ASSET_BYTES
        / MAX_EXPORT_ASSET_BYTES;
    const exactTotal = Array.from({ length: exactTotalCount }, (_, index) => ({
        path: `images/${index}.png`,
        mimeType: 'image/png',
        data: maxAsset,
    }));
    assert.equal(createMarkdownExportPlan({
        markdown: '',
        assetDirectoryName: 'paper.assets',
        assets: exactTotal,
    }).assets.length, exactTotalCount);

    assert.throws(() => createMarkdownExportPlan({
        markdown: '',
        assetDirectoryName: 'paper.assets',
        assets: [{
            path: 'images/oversized.png',
            mimeType: 'image/png',
            data: new Uint8Array(MAX_EXPORT_ASSET_BYTES + 1),
        }],
    }), /metadata is invalid/);
    assert.throws(() => createMarkdownExportPlan({
        markdown: '',
        assetDirectoryName: 'paper.assets',
        assets: [...exactTotal, {
            path: 'images/aggregate-overflow.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    }), /metadata is invalid/);
});

test('enforces the Markdown export image-count budget', () => {
    const data = new Uint8Array([1]);
    const exactAssets = Array.from({ length: MAX_EXPORT_ASSETS }, (_, index) => ({
        path: `images/${index}.png`,
        mimeType: 'image/png',
        data,
    }));
    assert.equal(createMarkdownExportPlan({
        markdown: '',
        assetDirectoryName: 'paper.assets',
        assets: exactAssets,
    }).assets.length, MAX_EXPORT_ASSETS);
    assert.throws(() => createMarkdownExportPlan({
        markdown: '',
        assetDirectoryName: 'paper.assets',
        assets: [...exactAssets, {
            path: 'images/overflow.png',
            mimeType: 'image/png',
            data,
        }],
    }), /images are invalid/);
});

test('rewrites known local Markdown images into the export asset directory', () => {
    const markdown = [
        '![Figure](<images/figure one.png>)',
        '![Panel][panel]',
        '',
        '[panel]: images/panel.png',
        '[Ordinary link](images/figure one.png)',
        '`![Code](images/figure one.png)`',
        '![Remote](https://example.com/remote.png)',
    ].join('\n');
    const plan = createMarkdownExportPlan({
        markdown,
        assetBasePath: 'result',
        assetDirectoryName: 'assets',
        assets: [
            {
                path: 'result/images/figure one.png',
                mimeType: 'image/png',
                data: new Uint8Array([1, 2]),
            },
            {
                path: 'result/images/panel.png',
                mimeType: 'image/png',
                data: new Uint8Array([3, 4]),
            },
        ],
    });

    assert.equal(plan.markdown, [
        '![Figure](assets/images/figure%20one.png)',
        '![Panel][panel]',
        '',
        '[panel]: assets/images/panel.png',
        '[Ordinary link](images/figure one.png)',
        '`![Code](images/figure one.png)`',
        '![Remote](https://example.com/remote.png)',
    ].join('\n'));
    assert.deepEqual(
        plan.assets.map(asset => asset.relativePath),
        ['images/figure one.png', 'images/panel.png']
    );
    assert.deepEqual(plan.assets[0].data, new Uint8Array([1, 2]));
});

test('renames case-colliding export images and rewrites each reference', () => {
    const plan = createMarkdownExportPlan({
        markdown: [
            '![Upper](images/Figure.png)',
            '![Lower](images/figure.png)',
            '![Caps](images/FIGURE.png)',
        ].join('\n'),
        assetBasePath: 'result',
        assetDirectoryName: 'assets',
        assets: [
            {
                path: 'result/images/Figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([1]),
            },
            {
                path: 'result/images/figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([2]),
            },
            {
                path: 'result/images/FIGURE.png',
                mimeType: 'image/png',
                data: new Uint8Array([3]),
            },
        ],
    });

    assert.equal(plan.markdown, [
        '![Upper](assets/images/Figure.png)',
        '![Lower](assets/images/figure-2.png)',
        '![Caps](assets/images/FIGURE-3.png)',
    ].join('\n'));
    assert.deepEqual(
        plan.assets.map(asset => ({
            relativePath: asset.relativePath,
            data: [...asset.data],
        })),
        [
            { relativePath: 'images/Figure.png', data: [1] },
            { relativePath: 'images/figure-2.png', data: [2] },
            { relativePath: 'images/FIGURE-3.png', data: [3] },
        ]
    );
});

test('rewrites collapsed reference images without changing their label', () => {
    const plan = createMarkdownExportPlan({
        markdown: '![Panel][]\n\n[Panel]: images/panel.png',
        assetDirectoryName: 'paper.assets',
        assets: [{
            path: 'images/panel.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    });

    assert.equal(
        plan.markdown,
        '![Panel][]\n\n[Panel]: paper.assets/images/panel.png'
    );
});

test('rewrites parent-relative images and escapes image path parentheses', () => {
    const plan = createMarkdownExportPlan({
        markdown: '![Panel](../images/panel(1).png)',
        assetBasePath: 'result/docs',
        assetDirectoryName: 'assets',
        assets: [{
            path: 'result/images/panel(1).png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    });

    assert.equal(
        plan.markdown,
        '![Panel](assets/result/images/panel%281%29.png)'
    );
    assert.equal(
        plan.assets[0].relativePath,
        'result/images/panel(1).png'
    );
});

test('rejects unsafe and colliding Markdown export image paths', () => {
    assert.throws(() => createMarkdownExportPlan({
        markdown: '![Unsafe](../outside.png)',
        assetDirectoryName: 'paper.assets',
        assets: [{
            path: '../outside.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    }), /escapes its root/);

    assert.throws(() => createMarkdownExportPlan({
        markdown: '',
        assetBasePath: 'result',
        assetDirectoryName: 'paper.assets',
        assets: [
            {
                path: 'result/images/figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([1]),
            },
            {
                path: 'images/figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([2]),
            },
        ],
    }), /metadata is invalid/);
});

test('leaves encoded unsafe image links inert instead of failing export', () => {
    const markdown = [
        '![Absolute](%2Foutside.png)',
        '![Backslash](images%5Coutside.png)',
        '![Null](images%00outside.png)',
        '![Traversal](../outside.png)',
    ].join('\n');

    const plan = createMarkdownExportPlan({
        markdown,
        assetDirectoryName: 'paper.assets',
        assets: [],
    });

    assert.equal(plan.markdown, markdown);
});
