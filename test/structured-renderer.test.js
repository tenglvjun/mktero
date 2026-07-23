import test from 'node:test';
import assert from 'node:assert/strict';
import {
    renderPlainText,
    renderStructuredDocument,
} from '../src/markdown/structured-renderer.js';

test('renders structured blocks as readable Markdown', () => {
    const document = {
        catalog: {
            outline: [
                { title: 'Introduction', ref: [0] },
                { title: 'Details', ref: [2], children: [{ title: 'Nested', ref: [3] }] },
            ],
            pages: [
                { label: '1', contentRange: [[0], [2]] },
                { label: '2', contentRange: [[2], [4]] },
            ],
        },
        content: [
            { type: 'heading', content: [{ text: 'Introduction' }] },
            {
                type: 'paragraph',
                content: [
                    { text: 'A ' },
                    { text: 'bold', style: { bold: true } },
                    { text: ' and ' },
                    { text: 'italic', style: { italic: true } },
                    { text: ' statement.' },
                ],
            },
            { type: 'heading', content: [{ text: 'Details' }] },
            { type: 'heading', content: [{ text: 'Nested' }] },
            {
                type: 'list',
                ordered: false,
                content: [
                    { type: 'listitem', content: [{ text: 'First' }] },
                    { type: 'listitem', content: [{ text: 'Second' }] },
                ],
            },
            {
                type: 'table',
                content: [
                    {
                        type: 'tablerow',
                        content: [
                            { type: 'tablecell', content: [{ type: 'paragraph', content: [{ text: 'Name' }] }] },
                            { type: 'tablecell', content: [{ type: 'paragraph', content: [{ text: 'Value' }] }] },
                        ],
                    },
                    {
                        type: 'tablerow',
                        content: [
                            { type: 'tablecell', content: [{ type: 'paragraph', content: [{ text: 'x' }] }] },
                            { type: 'tablecell', content: [{ type: 'paragraph', content: [{ text: '1' }] }] },
                        ],
                    },
                ],
            },
            { type: 'math', content: [{ text: 'x^2 + y^2 = z^2' }] },
        ],
    };

    assert.equal(renderStructuredDocument(document), [
        '<!-- zotero-page: 1 -->',
        '',
        '# Introduction',
        '',
        'A **bold** and *italic* statement.',
        '',
        '<!-- zotero-page: 2 -->',
        '',
        '# Details',
        '',
        '## Nested',
        '',
        '- First',
        '- Second',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| x | 1 |',
        '',
        '$$',
        'x^2 + y^2 = z^2',
        '$$',
    ].join('\n'));
});

test('escapes source Markdown control characters', () => {
    const document = {
        content: [{ type: 'paragraph', content: [{ text: '# not a heading * literal [link]' }] }],
    };

    assert.equal(
        renderStructuredDocument(document),
        '\\# not a heading \\* literal \\[link\\]'
    );
});

test('renders plain text fallback and page boundaries', () => {
    assert.equal(
        renderPlainText('First page\fSecond page'),
        'First page\n\n<!-- zotero-page: 2 -->\n\nSecond page'
    );
});

test('removes list markers already present in extracted text', () => {
    const document = {
        content: [{
            type: 'list',
            content: [{
                type: 'listitem',
                content: [
                    { text: '•', style: { monospace: true } },
                    { text: ' ' },
                    { text: 'Extracted list item' },
                ],
            }],
        }],
    };

    assert.equal(renderStructuredDocument(document), '- Extracted list item');
});

test('preserves math syntax and chooses a safe code fence', () => {
    const document = {
        content: [
            { type: 'math', content: [{ text: 'x_1 + y_2' }] },
            { type: 'preformatted', content: [{ text: 'before\n```\nafter' }] },
        ],
    };

    assert.equal(renderStructuredDocument(document), [
        '$$',
        'x_1 + y_2',
        '$$',
        '',
        '````',
        'before',
        '```',
        'after',
        '````',
    ].join('\n'));
});

test('uses a code block when untrusted math could escape its delimiter', () => {
    const document = {
        content: [{
            type: 'math',
            content: [{ text: 'x = 1\n$$\n<script>alert(1)</script>' }],
        }],
    };

    assert.equal(renderStructuredDocument(document), [
        '```',
        'x = 1',
        '$$',
        '<script>alert(1)</script>',
        '```',
    ].join('\n'));
});
