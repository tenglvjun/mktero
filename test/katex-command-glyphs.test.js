import test from 'node:test';
import assert from 'node:assert/strict';
import { KATEX_COMMAND_GLYPHS } from '../src/markdown/katex-command-glyphs.js';
import { mathCompactText } from '../src/markdown/math-compact-text.js';
import { readKatexCommandGlyphs } from '../scripts/katex-command-glyphs.mjs';

// The table is generated from KaTeX's own symbol and macro tables. A KaTeX
// upgrade that adds or changes a symbol fails here until the table is
// regenerated with `node scripts/katex-command-glyphs.mjs`.
test('the command glyph table matches the installed KaTeX', async () => {
    assert.deepEqual(
        Object.fromEntries(KATEX_COMMAND_GLYPHS),
        Object.fromEntries(await readKatexCommandGlyphs())
    );
});

test('every KaTeX symbol command reads as the glyph KaTeX prints', () => {
    const differing = [...KATEX_COMMAND_GLYPHS]
        .filter(([name, glyph]) => (
            mathCompactText(`\\${name}`) !== mathCompactText(glyph)
        ))
        .map(([name, glyph]) => `\\${name} ${glyph}`);
    assert.deepEqual(differing, []);
});
