import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    createFigurePlaceholderElement,
    isFigurePlaceholderElement,
    replacePendingFigureImages,
    FIGURE_PLACEHOLDER_CLASS,
} from '../src/editor/figure-placeholder.js';

function document() {
    return new JSDOM('<!doctype html><html><body></body></html>').window.document;
}

test('renders a figure placeholder with a lucide image and spinner', () => {
    const doc = document();
    const element = createFigurePlaceholderElement(doc, { id: 'fig-p3-b0', label: 'Figure 3.' });
    assert.equal(element.getAttribute('data-figure-id'), 'fig-p3-b0');
    assert.equal(element.getAttribute('role'), 'status');
    assert.ok(element.classList.contains(FIGURE_PLACEHOLDER_CLASS));
    assert.ok(element.querySelector('svg.lucide-image'), 'image icon expected');
    const spinner = element.querySelector('svg.lucide-loader-circle');
    assert.ok(spinner, 'loader-circle icon expected');
    assert.ok(spinner.closest(`.${FIGURE_PLACEHOLDER_CLASS}-loader`));
    assert.equal(
        element.querySelector(`.${FIGURE_PLACEHOLDER_CLASS}-label`),
        null,
        'the real caption renders below the figure, so no label skeleton is shown'
    );
    assert.ok(element.querySelector(`.${FIGURE_PLACEHOLDER_CLASS}-sr`)?.textContent.length > 0);
});

test('keeps the placeholder free of the resolved image markup', () => {
    const doc = document();
    const element = createFigurePlaceholderElement(doc, { id: 'x' });
    assert.equal(element.querySelector('img'), null);
    assert.ok(isFigurePlaceholderElement(element));
    assert.equal(isFigurePlaceholderElement(doc.createElement('div')), false);
});

test('replaces only the finished figure and keeps a pending placeholder after rebuild', () => {
    const doc = document();
    const container = doc.createElement('div');
    container.innerHTML = [
        '<img data-mktero-asset="images/a.png" alt="">',
        '<img data-mktero-asset="images/b.png" alt="">',
    ].join('');
    const pending = new Map([['images/a.png', 'fig-a'], ['images/b.png', 'fig-b']]);
    const restored = new Map([['fig-a', {
        assetPath: 'generated/figures/fig-a.png',
        data: Uint8Array.of(1, 2, 3),
        mimeType: 'image/png',
    }]]);
    const urls = [];
    replacePendingFigureImages(container, pending, undefined, restored, figure => {
        const url = `blob:${figure.assetPath}`;
        urls.push(url);
        return url;
    });
    const restoredImage = container.querySelector('img[data-figure-id="fig-a"]');
    assert.equal(restoredImage?.getAttribute('src'), 'blob:generated/figures/fig-a.png');
    assert.equal(container.querySelector('[data-figure-id="fig-b"]')?.classList.contains(FIGURE_PLACEHOLDER_CLASS), true);
    container.innerHTML = [
        '<img data-mktero-asset="images/a.png" alt="">',
        '<img data-mktero-asset="images/b.png" alt="">',
    ].join('');
    replacePendingFigureImages(container, pending, undefined, restored, figure => `blob:${figure.assetPath}`);
    assert.equal(container.querySelector('img[data-figure-id="fig-a"]').getAttribute('src'), 'blob:generated/figures/fig-a.png');
});

test('leaves the placeholder when the restored figure URL cannot be resolved', () => {
    const doc = document();
    const container = doc.createElement('div');
    container.innerHTML = '<img data-mktero-asset="images/a.png" alt="">'
        + '<img data-mktero-asset="images/a.png" alt="">';
    const pending = new Map([['images/a.png', 'fig-a']]);
    const restored = new Map([['fig-a', {
        assetPath: 'generated/figures/fig-a.png',
        data: Uint8Array.of(1),
        mimeType: 'image/png',
    }]]);
    for (const resolve of [() => { throw new Error('blob failed'); }, () => 12, null]) {
        container.innerHTML = '<img data-mktero-asset="images/a.png" alt="">'
            + '<img data-mktero-asset="images/a.png" alt="">';
        replacePendingFigureImages(container, pending, undefined, restored, resolve);
        assert.equal(container.querySelectorAll('img').length, 0);
        assert.equal(
            container.querySelector('[data-figure-id="fig-a"]')?.classList.contains(FIGURE_PLACEHOLDER_CLASS),
            true,
        );
        assert.equal(container.querySelectorAll('[data-figure-id="fig-a"]').length, 1);
    }
});
