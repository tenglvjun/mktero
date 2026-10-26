import {
    getAccountSession,
    isAccountSignedIn,
} from '../config/account-preferences.js';
import { AI_API_KEY_PREF } from '../config/ai-preferences.js';
import {
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
    getConversionProvider,
    getMinerUApiKey,
    getMinerUEndpoint,
    getMinerULocalApiBase,
    getMinerULocalApiKey,
    getMistralApiKey,
    MINERU_ENDPOINT_LOCAL,
} from '../config/conversion-preferences.js';
import { sha256Hex } from '../core/sha256.js';
import { FIGURE_PIPELINE_PROFILE } from '../figures/figure-limits.js';
import {
    MINERU_DOCUMENT_PIPELINE,
    MINERU_LOCAL_PARSER_PROFILE_ID,
    MINERU_PARSER_PROFILE_ID,
} from '../mineru/parser-profile.js';
import {
    MISTRAL_OCR_MODEL_ID,
    MISTRAL_PARSER_PROFILE_ID,
} from '../mistral/parser-profile.js';
import {
    mkteroBuild,
    mkteroVersion,
} from '../config/runtime-config.js';

// readDiagnosticEnvironment collects the whitelist a problem report may
// include. It never returns tokens, the account email, PDF paths, or titles.
export async function readDiagnosticEnvironment({
    zotero,
    services = null,
    context = null,
    hash = sha256Hex,
    pluginVersion = mkteroVersion(),
    build = mkteroBuild(),
} = {}) {
    const provider = safe(() => getConversionProvider(zotero), 'unknown');
    const endpoint = provider === CONVERSION_PROVIDER_MINERU
        ? safe(() => getMinerUEndpoint(zotero), '')
        : '';
    const profileId = provider === CONVERSION_PROVIDER_MISTRAL
        ? MISTRAL_PARSER_PROFILE_ID
        : endpoint === MINERU_ENDPOINT_LOCAL
            ? MINERU_LOCAL_PARSER_PROFILE_ID
            : MINERU_PARSER_PROFILE_ID;
    const session = safe(() => getAccountSession(zotero), null);
    return {
        pluginVersion,
        build,
        zoteroVersion: clean(zotero?.version, 32),
        locale: clean(zotero?.locale, 32),
        osName: clean(services?.appinfo?.OS, 32),
        osVersion: clean(
            services?.appinfo?.macOSVersion
                || services?.appinfo?.windowsVersion
                || '',
            64
        ),
        arch: clean(services?.appinfo?.XPCOMABI, 32),
        conversion: {
            provider,
            mineruEndpoint: endpoint,
            localEndpointOrigin: endpoint === MINERU_ENDPOINT_LOCAL
                ? endpointOrigin(safe(() => getMinerULocalApiBase(zotero), ''))
                : '',
            credentialsConfigured: {
                mineruCloud: configured(() => getMinerUApiKey(zotero)),
                mineruLocal: configured(() => getMinerULocalApiKey(zotero)),
                mistral: configured(() => getMistralApiKey(zotero)),
                ai: configured(() => String(
                    zotero?.Prefs?.get?.(AI_API_KEY_PREF, true) || ''
                )),
            },
            parser: {
                figurePipeline: FIGURE_PIPELINE_PROFILE,
                documentPipeline: provider === CONVERSION_PROVIDER_MISTRAL
                    ? MISTRAL_OCR_MODEL_ID
                    : MINERU_DOCUMENT_PIPELINE,
                profileSha256: await profilePrefix(hash, profileId),
            },
        },
        account: {
            signedIn: safe(() => isAccountSignedIn(session), false) === true,
        },
        context: readContext(zotero, context),
    };
}

function readContext(zotero, context) {
    const itemID = Number(context?.itemID);
    if (!Number.isSafeInteger(itemID) || itemID <= 0) return null;
    const item = safe(() => zotero?.Items?.get?.(itemID), null);
    const result = { itemID };
    const libraryID = Number(item?.libraryID);
    if (Number.isSafeInteger(libraryID) && libraryID >= 0) {
        result.libraryID = libraryID;
    }
    const itemKey = clean(item?.key, 32);
    if (/^[A-Za-z0-9]+$/.test(itemKey)) result.itemKey = itemKey;
    return result;
}

async function profilePrefix(hash, profileId) {
    try {
        const digest = await hash(profileId);
        return /^[a-f0-9]{12,}$/.test(digest) ? digest.slice(0, 12) : '';
    }
    catch {
        return '';
    }
}

function endpointOrigin(value) {
    try {
        const url = new URL(String(value || ''));
        if (!/^https?:$/.test(url.protocol)) return '';
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.origin;
    }
    catch {
        return '';
    }
}

function configured(read) {
    try {
        return String(read() || '').trim().length > 0;
    }
    catch {
        return false;
    }
}

function safe(read, fallback) {
    try {
        const value = read();
        return value == null ? fallback : value;
    }
    catch {
        return fallback;
    }
}

function clean(value, limit) {
    const text = String(value || '').trim();
    if (!text || /[\r\n\0]/.test(text)) return '';
    return text.slice(0, limit);
}
