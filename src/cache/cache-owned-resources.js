import { createMarkdownCacheKeyFromHash } from './markdown-cache.js';
import { createMinerUResultKey } from './mineru-result-store.js';
import { createPDFTextIndexCacheKey } from '../pdf/pdf-annotation-locator.js';
import {
    MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_COMPATIBLE_CACHE_PROFILE_IDS, MINERU_REQUEST_PROFILE_ID,
    MINERU_LOCAL_PARSER_PROFILE_ID, MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_LOCAL_REQUEST_PROFILE_ID,
} from '../mineru/parser-profile.js';
import {
    MISTRAL_PARSER_PROFILE_ID, MISTRAL_PREVIOUS_PARSER_PROFILE_IDS,
    MISTRAL_COMPATIBLE_CACHE_PROFILE_IDS,
} from '../mistral/parser-profile.js';
import { LEGACY_FIGURE_PROFILES } from '../figures/legacy-figure-profiles.js';
import {
    createLLMCacheParserProfile, getPreviousLLMCacheParserProfiles,
    createLLMCacheRawKey,
} from '../mineru/llm-cache-profile.js';

// Reconstruct only identities supported by this build. Unknown historical
// profile keys are deliberately retained; changing retention never changes OCR.
export async function ownedCacheResources(sourceHash, { pdfIndexProfile, imports = [] } = {}) {
    const profiles = new Set([
        MINERU_PARSER_PROFILE_ID, ...MINERU_PREVIOUS_PARSER_PROFILE_IDS,
        ...MINERU_COMPATIBLE_CACHE_PROFILE_IDS,
        MINERU_LOCAL_PARSER_PROFILE_ID, ...MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
        MISTRAL_PARSER_PROFILE_ID, ...MISTRAL_PREVIOUS_PARSER_PROFILE_IDS,
        ...MISTRAL_COMPATIBLE_CACHE_PROFILE_IDS,
        LEGACY_FIGURE_PROFILES.mineru, LEGACY_FIGURE_PROFILES.mistral,
    ]);
    const artifacts = [{ store: 'readingPosition', key: sourceHash }];
    for (const selection of imports.filter(record => record.sourceHash === sourceHash)) {
        profiles.add(createLLMCacheParserProfile(selection.snapshotHash, { adapterVersion: selection.adapterVersion }));
        for (const profile of getPreviousLLMCacheParserProfiles(selection.snapshotHash)) profiles.add(profile);
        const key = await createLLMCacheRawKey(selection);
        if (key !== selection.rawKey) throw new Error('Imported cache identity mismatch');
        artifacts.push({ store: 'raw', key });
    }
    for (const parserProfile of profiles) {
        const key = await createMarkdownCacheKeyFromHash(sourceHash, { parserProfile });
        artifacts.push({ store: 'markdown', key }, { store: 'revisions', key });
    }
    for (const provider of ['mineru', 'mktero', 'mineru-local']) {
        artifacts.push({ store: 'raw', key: await createMinerUResultKey({
            sourceHash, provider,
            requestProfile: provider === 'mineru-local' ? MINERU_LOCAL_REQUEST_PROFILE_ID : MINERU_REQUEST_PROFILE_ID,
        }) });
    }
    if (pdfIndexProfile) artifacts.push({ store: 'pdfIndex', key: await createPDFTextIndexCacheKey(sourceHash, pdfIndexProfile) });
    return artifacts;
}
