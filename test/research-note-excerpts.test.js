import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { readResearchNoteExcerpts, researchNoteReviewHTML } from '../src/core/research-note-excerpts.js';

const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');
const attachmentURI = 'http://zotero.org/users/local/TESTUSER/items/ABCDEFGH';
const source = { attachmentURI, pageLabel: 'iv', position: { pageIndex: 2, rects: [[1, 2, 3, 4]] } };
const quote = (data, html, type = 'highlight') => `<span class="${type}" data-annotation="${encodeURIComponent(JSON.stringify(data))}">${html}</span>`;
const read = content => readResearchNoteExcerpts(`<div data-schema-version="9">${content}</div>`, { parseHTML });

test('old selections and saved underlines retain their individual PDF positions', () => {
    const old = quote(source, 'First line<br>second line');
    const underline = quote({ ...source, annotationKey: 'ABCD0001',
        position: { pageIndex: 3, rects: [[1, 2, 3, 4]] } }, 'First line', 'underline');
    const rows = read(`<p>${old}</p><p>${old}</p><p>${underline}</p>
        <p>Comment <span class="highlight" data-annotation="%">Unreadable</span></p>`);
    assert.deepEqual(rows.map(row => [row.text, row.source.annotationKey, row.source.position.pageIndex]), [
        ['First line\nsecond line', null, 2], ['First line', 'ABCD0001', 3],
    ]);
});

test('review HTML preserves an excerpt with a display formula and escapes note content', () => {
    const rows = read(`<p>${quote(source, '&lt;SCRIPT&gt;A')}</p><pre class="math">$$x^2$$</pre>
        <p>${quote(source, 'and B<img src="https://example.test/image">')}</p>`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '<SCRIPT>A\n$$x^2$$\nand B');
    const html = researchNoteReviewHTML(rows, { title: 'Review <one>', question: 'Question',
        excerpts: 'Sources', judgment: 'Judgment' }, { parseHTML });
    const document = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
    assert.equal(document.querySelector('script, img, one'), null);
    assert.equal(document.querySelector('h2')?.textContent, 'Review <one>');
    const roundTrip = read(html);
    assert.equal(roundTrip[0].text, rows[0].text);
    assert.deepEqual(roundTrip[0].source, rows[0].source);
});

test('inline and trailing formulas keep the full text of a native quote', () => {
    const rows = read(`<p>${quote(source, '“A ')}<span class="math">$x$</span>
        ${quote(source, ' and ')}<span class="math">$y$</span>${quote(source, '”')}</p>`);
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /“A \$x\$\s+and \$y\$”/u);
});

test('a user formula beside a quote is not attributed to the PDF', () => {
    const [row] = read(`<p>${quote(source, 'Source passage')}<span class="math">$personal$</span></p>`);
    assert.equal(row.text, 'Source passage');
});
