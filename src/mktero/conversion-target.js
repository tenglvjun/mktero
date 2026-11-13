import { FIGURE_PIPELINE_PROFILE } from '../figures/figure-limits.js';
import {
    MINERU_BATCH_OPTIONS,
    MINERU_DOCUMENT_PIPELINE,
    MINERU_FILE_OPTIONS,
    MINERU_PARSER_PROFILE_ID,
    MINERU_REQUEST_PROFILE_ID,
} from '../mineru/parser-profile.js';

// The two MinerU models the hosted service can submit. They are the service's
// own model names, so a target is one of them and nothing else.
export const MKTERO_MODEL_VLM = 'vlm';
export const MKTERO_MODEL_PIPELINE = 'pipeline';
export const MKTERO_HOSTED_MODELS = Object.freeze([
    MKTERO_MODEL_VLM,
    MKTERO_MODEL_PIPELINE,
]);

// The hosted service reports `<parser_name>/<parser_version>`. Only the model
// matters to this client, so the known versions are a table: an unknown id is
// refused instead of being guessed, because guessing would file a result under
// the wrong cache identity.
const HOSTED_PROFILE_MODELS = Object.freeze({
    'mineru/v4-batch-vlm-1': MKTERO_MODEL_VLM,
    'mineru/v4-batch-pipeline-1': MKTERO_MODEL_PIPELINE,
});

export function hostedModelForParserProfileId(parserProfileId) {
    const value = String(parserProfileId || '').trim();
    return Object.prototype.hasOwnProperty.call(HOSTED_PROFILE_MODELS, value)
        ? HOSTED_PROFILE_MODELS[value]
        : null;
}

function batchOptions(modelVersion) {
    return { ...MINERU_BATCH_OPTIONS, model_version: modelVersion };
}

// These are local cache identities, not the service's short profile strings.
// The vlm identity is the shipped MinerU profile byte for byte, so every vlm
// entry written before hosted model selection stays readable and a pipeline
// result can never be reached through it.
const HOSTED_REQUEST_PROFILES = Object.freeze({
    [MKTERO_MODEL_VLM]: MINERU_REQUEST_PROFILE_ID,
    [MKTERO_MODEL_PIPELINE]: JSON.stringify({
        batch: batchOptions(MKTERO_MODEL_PIPELINE),
        file: MINERU_FILE_OPTIONS,
    }),
});

const HOSTED_CACHE_PROFILES = Object.freeze({
    [MKTERO_MODEL_VLM]: MINERU_PARSER_PROFILE_ID,
    [MKTERO_MODEL_PIPELINE]: JSON.stringify({
        batch: batchOptions(MKTERO_MODEL_PIPELINE),
        file: MINERU_FILE_OPTIONS,
        document: MINERU_DOCUMENT_PIPELINE,
        figureStructure: FIGURE_PIPELINE_PROFILE,
    }),
});

export function hostedCacheProfileFor(modelVersion) {
    return HOSTED_CACHE_PROFILES[modelVersion] || null;
}

export function hostedRequestProfileFor(modelVersion) {
    return HOSTED_REQUEST_PROFILES[modelVersion] || null;
}

// Every identity this build can produce. Markdown cache and raw-result cleanup
// both need the full list, so it is derived from the table once.
export const MKTERO_HOSTED_CACHE_PROFILE_IDS = Object.freeze(
    MKTERO_HOSTED_MODELS.map(modelVersion => HOSTED_CACHE_PROFILES[modelVersion])
);

export const MKTERO_HOSTED_REQUEST_PROFILE_IDS = Object.freeze(
    MKTERO_HOSTED_MODELS.map(modelVersion => HOSTED_REQUEST_PROFILES[modelVersion])
);

/** The cache and raw-result identities one model owns. */
export function hostedProfilesFor(modelVersion) {
    const cacheProfile = hostedCacheProfileFor(modelVersion);
    const requestProfile = hostedRequestProfileFor(modelVersion);
    if (!cacheProfile || !requestProfile) {
        throw codedError(
            'The Mktero service named an unknown MinerU model',
            'MKTERO_INVALID_TARGET'
        );
    }
    return { modelVersion, cacheProfile, requestProfile };
}

/**
 * Validates a target as the service describes it.
 *
 * The model and the profile id must agree: a target that says `vlm` while
 * naming the pipeline profile is inconsistent metadata, and caching its result
 * would corrupt the other model's entries. `routeId` is opaque and is only
 * compared for equality, never parsed.
 */
export function normalizeHostedTarget(target) {
    const routeId = typeof target?.routeId === 'string' ? target.routeId.trim() : '';
    const modelVersion = typeof target?.modelVersion === 'string'
        ? target.modelVersion.trim()
        : '';
    const parserProfileId = typeof target?.parserProfileId === 'string'
        ? target.parserProfileId.trim()
        : '';
    const namedModel = hostedModelForParserProfileId(parserProfileId);
    if (!routeId || !namedModel || namedModel !== modelVersion) {
        throw codedError(
            'The Mktero service did not return a usable conversion target',
            'MKTERO_INVALID_TARGET'
        );
    }
    return { routeId, modelVersion, parserProfileId };
}

export function normalizeHostedTargetOrNull(target) {
    return target ? normalizeHostedTarget(target) : null;
}

/**
 * A job's parse snapshot, as the service reports it.
 *
 * A job carries no route id: the route is a lookup handle, while the job keeps
 * only the model and profile it was submitted with. A snapshot is therefore
 * validated as a model/profile pair, and the caller keeps the route it already
 * holds. An inconsistent pair is a refusal, never a guess.
 */
export function normalizeHostedSnapshot(snapshot) {
    const modelVersion = typeof snapshot?.modelVersion === 'string'
        ? snapshot.modelVersion.trim()
        : '';
    const parserProfileId = typeof snapshot?.parserProfileId === 'string'
        ? snapshot.parserProfileId.trim()
        : '';
    const namedModel = hostedModelForParserProfileId(parserProfileId);
    if (!namedModel || namedModel !== modelVersion) {
        throw codedError(
            'The Mktero service described an inconsistent conversion target',
            'MKTERO_INVALID_TARGET'
        );
    }
    return { modelVersion, parserProfileId };
}

/** A validated snapshot plus the route handle the caller already holds. The
 *  handle may be empty: a job does not carry one, and an older service that
 *  always submits vlm needs none. */
export function targetFromSnapshot(snapshot, routeId = '') {
    const validated = normalizeHostedSnapshot(snapshot);
    return {
        routeId: typeof routeId === 'string' ? routeId.trim() : '',
        ...validated,
    };
}

/**
 * True only for a transport failure: the service could not be reached, or the
 * request timed out. An authentication, quota, or integrity error means the
 * answer is unknown or refused, and reading an unverified local entry then
 * would hide it.
 */
export function isTrustworthyOfflineFailure(error) {
    return error?.code === 'MKTERO_NETWORK_ERROR'
        || error?.code === 'MKTERO_REQUEST_TIMEOUT';
}

function codedError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}
