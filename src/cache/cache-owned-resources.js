import { createMarkdownCacheKeyFromHash } from './markdown-cache.js';
import { createMinerUResultKey } from './mineru-result-store.js';
import { createPDFTextIndexCacheKey } from '../pdf/pdf-annotation-locator.js';
import {
    MINERU_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_CLOUD_CACHE_PROFILE_IDS, MINERU_CLOUD_REQUEST_PROFILE_IDS,
    MINERU_COMPATIBLE_CACHE_PROFILE_IDS,
    MINERU_LOCAL_PARSER_PROFILE_ID, MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_LOCAL_REQUEST_PROFILE_ID,
} from '../mineru/parser-profile.js';
import {
    MISTRAL_PARSER_PROFILE_ID, MISTRAL_PREVIOUS_PARSER_PROFILE_IDS,
    MISTRAL_COMPATIBLE_CACHE_PROFILE_IDS,
} from '../mistral/parser-profile.js';
import {
    MKTERO_HOSTED_CACHE_PROFILE_IDS, MKTERO_HOSTED_REQUEST_PROFILE_IDS,
} from '../mktero/conversion-target.js';
import { LEGACY_FIGURE_PROFILES } from '../figures/legacy-figure-profiles.js';
import {
    createLLMCacheParserProfile, getPreviousLLMCacheParserProfiles,
    createLLMCacheRawKey,
} from '../mineru/llm-cache-profile.js';

// Reconstruct only identities supported by this build. Unknown historical
// profile keys are deliberately retained; changing retention never changes OCR.
export async function ownedCacheResources(sourceHash, { pdfIndexProfile, imports = [] } = {}) {
    const profiles = new Set([
        ...MINERU_CLOUD_CACHE_PROFILE_IDS, ...MINERU_PREVIOUS_PARSER_PROFILE_IDS,
        ...MINERU_COMPATIBLE_CACHE_PROFILE_IDS,
        MINERU_LOCAL_PARSER_PROFILE_ID, ...MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
        MISTRAL_PARSER_PROFILE_ID, ...MISTRAL_PREVIOUS_PARSER_PROFILE_IDS,
        ...MISTRAL_COMPATIBLE_CACHE_PROFILE_IDS,
        LEGACY_FIGURE_PROFILES.mineru, LEGACY_FIGURE_PROFILES.mistral,
        // The hosted service can file a result under either MinerU model.
        ...MKTERO_HOSTED_CACHE_PROFILE_IDS,
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
        const requestProfiles = provider === 'mktero'
            ? MKTERO_HOSTED_REQUEST_PROFILE_IDS
            : provider === 'mineru-local'
                ? [MINERU_LOCAL_REQUEST_PROFILE_ID]
                : MINERU_CLOUD_REQUEST_PROFILE_IDS;
        for (const requestProfile of requestProfiles) {
            artifacts.push({ store: 'raw', key: await createMinerUResultKey({
                sourceHash, provider, requestProfile,
            }) });
        }
    }
    if (pdfIndexProfile) artifacts.push({ store: 'pdfIndex', key: await createPDFTextIndexCacheKey(sourceHash, pdfIndexProfile) });
    return artifacts;
}
