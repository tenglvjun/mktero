import { webcrypto } from 'node:crypto';
import { makeFigureInput, createTestPNG } from './figure-fixtures.js';
import { bindFigureSourceRanges } from '../../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../../src/figures/figure-transaction.js';
import { finalizeRestoredDocument } from '../../src/figures/figure-finalization.js';
import { prepareMinerUResult } from '../../src/mineru/mineru-result.js';
import { sha256Hex } from '../../src/core/sha256.js';

export async function makeRestoredFigureDocument(options = {}) {
    const { input } = makeFigureInput({ ...options, provider: 'mineru' });
    const bound = bindFigureSourceRanges(input);
    const candidate = resolveFigureCandidates(bound).find(value => value.decision === 'compose');
    if (!candidate) throw new Error('Fixture has no composable figure');
    const hash = value => sha256Hex(value, { crypto: webcrypto });
    const data = createTestPNG(800, 750);
    const digest = (await hash(data)).slice(0, 16);
    const draft = composeFigureDraft(bound, [{ candidate,
        crop: { data, mimeType: 'image/png', width: 800, height: 750 },
        assetPath: `generated/figures/${candidate.id}-${digest}.png`,
    }]);
    return finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
}
