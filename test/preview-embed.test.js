import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EMBED_CSP,
    EMBED_SANDBOX,
    READY_MESSAGE,
    forceLightColorScheme,
    isDarkSchemeQuery,
    lightOnlyStyles,
    postReady,
} from '../preview/embed.js';

test('light-only styles drop every dark-scheme condition however it is spaced', () => {
    const css = [
        '@media (prefers-color-scheme: dark) { a { color: white } }',
        '@media (prefers-color-scheme:dark){b{color:white}}',
        '@media screen and ( prefers-color-scheme : dark ) { c { color: white } }',
        '@media (prefers-color-scheme: light) { d { color: black } }',
    ].join('\n');
    const light = lightOnlyStyles(css);
    assert.equal(isDarkSchemeQuery(light), false);
    assert.match(light, /@media not all \{ a/);
    assert.match(light, /@media not all\{b/);
    assert.match(light, /prefers-color-scheme: light/);
    // The global regex must not keep state between calls.
    assert.equal(isDarkSchemeQuery('(prefers-color-scheme: dark)'), true);
    assert.equal(isDarkSchemeQuery('(prefers-color-scheme: dark)'), true);
});

test('a forced light scheme answers dark queries with a never-matching one', () => {
    const asked = [];
    const target = { matchMedia: query => { asked.push(query); return { matches: query !== 'not all', media: query }; } };
    forceLightColorScheme(target);
    assert.equal(target.matchMedia('(prefers-color-scheme: dark)').matches, false);
    assert.equal(target.matchMedia('(prefers-color-scheme:dark)').matches, false);
    assert.equal(target.matchMedia('(min-width: 900px)').matches, true);
    assert.deepEqual(asked, ['not all', 'not all', '(min-width: 900px)']);
});

test('the ready message goes to the parent, addressed to the site origin only', () => {
    const sent = [];
    const parent = { postMessage: (data, origin) => sent.push({ data, origin }) };
    assert.equal(postReady({ parent, location: { origin: 'https://mktero.com' } }), true);
    assert.deepEqual(sent, [{ data: { type: READY_MESSAGE }, origin: 'https://mktero.com' }]);

    const self = { location: { origin: 'https://mktero.com' } };
    self.parent = self;
    assert.equal(postReady(self), false);
    assert.equal(postReady({ parent, location: { origin: 'null' } }), false);
    const throwing = { postMessage: () => { throw new SyntaxError('bad origin'); } };
    assert.equal(postReady({ parent: throwing, location: { origin: 'https://mktero.com' } }), false);
    assert.equal(sent.length, 1);
});

test('the embed policy isolates the preview and keeps it offline', () => {
    const tokens = EMBED_SANDBOX.split(' ');
    assert.equal(tokens.includes('allow-scripts'), true);
    for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-forms', 'allow-modals']) {
        assert.equal(tokens.includes(forbidden), false, forbidden);
    }
    const directives = Object.fromEntries(EMBED_CSP.split('; ').map(part => {
        const [name, ...values] = part.split(' ');
        return [name, values.join(' ')];
    }));
    assert.equal(directives.sandbox, EMBED_SANDBOX);
    assert.equal(directives['connect-src'], "'none'");
    assert.equal(directives['default-src'], "'none'");
    assert.equal(directives['frame-ancestors'], "'self'");
    assert.equal(directives['form-action'], "'none'");
});
