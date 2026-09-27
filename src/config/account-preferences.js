import { normalizeMinerULocalApiBase } from '../mineru/local-endpoint.js';
import {
    isDebugBuild,
    MKTERO_DEBUG_API_BASE,
    MKTERO_RELEASE_API_BASE,
} from './runtime-config.js';

export const SERVICE_SOURCE_OWN = 'own';
export const SERVICE_SOURCE_MKTERO = 'mktero';
export const ACCOUNT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const ACCOUNT_EMAIL_PREF = 'extensions.mktero.accountEmail';
export const ACCOUNT_ACCESS_TOKEN_PREF = 'extensions.mktero.accountAccessToken';
export const ACCOUNT_REFRESH_TOKEN_PREF = 'extensions.mktero.accountRefreshToken';
export const ACCOUNT_ACCESS_EXPIRES_AT_PREF =
    'extensions.mktero.accountAccessExpiresAt';
export const ACCOUNT_API_BASE_PREF = 'extensions.mktero.accountApiBase';
export const FEATURE_SOURCE_PREF = 'extensions.mktero.featureSource';
export const FEATURE_SOURCE_EPOCH_PREF = 'extensions.mktero.featureSourceEpoch';
export const FEATURE_SOURCE_EPOCH = 2;
export const PDF_SERVICE_SOURCE_PREF = 'extensions.mktero.pdfServiceSource';
export const AI_SERVICE_SOURCE_PREF = 'extensions.mktero.aiServiceSource';

const migratedProfiles = new WeakSet();

const SESSION_PREFS = [
    ACCOUNT_EMAIL_PREF,
    ACCOUNT_ACCESS_TOKEN_PREF,
    ACCOUNT_REFRESH_TOKEN_PREF,
    ACCOUNT_ACCESS_EXPIRES_AT_PREF,
];

export function normalizeServiceSource(value) {
    return String(value || '').trim() === SERVICE_SOURCE_MKTERO
        ? SERVICE_SOURCE_MKTERO
        : SERVICE_SOURCE_OWN;
}

export function getFeatureSource(zotero) {
    ensureFeatureSourceDefault(zotero);
    const current = zotero?.Prefs?.get?.(FEATURE_SOURCE_PREF, true);
    if (current) return normalizeServiceSource(current);
    return SERVICE_SOURCE_MKTERO;
}

function ensureFeatureSourceDefault(zotero) {
    if (!zotero || migratedProfiles.has(zotero)) return;
    const epoch = Number(zotero?.Prefs?.get?.(FEATURE_SOURCE_EPOCH_PREF, true) || 0);
    if (epoch >= FEATURE_SOURCE_EPOCH) {
        migratedProfiles.add(zotero);
        return;
    }
    setFeatureSource(zotero, SERVICE_SOURCE_MKTERO);
    zotero?.Prefs?.set?.(FEATURE_SOURCE_EPOCH_PREF, FEATURE_SOURCE_EPOCH, true);
    migratedProfiles.add(zotero);
}

export function setFeatureSource(zotero, value) {
    const source = normalizeServiceSource(value);
    zotero?.Prefs?.set?.(FEATURE_SOURCE_PREF, source, true);
    zotero?.Prefs?.set?.(PDF_SERVICE_SOURCE_PREF, source, true);
    zotero?.Prefs?.set?.(AI_SERVICE_SOURCE_PREF, source, true);
    return source;
}

export function getPdfServiceSource(zotero) {
    return getFeatureSource(zotero);
}

export function getAIServiceSource(zotero) {
    return getFeatureSource(zotero);
}

export function getAccountSession(zotero) {
    return {
        email: readString(zotero, ACCOUNT_EMAIL_PREF),
        accessToken: readString(zotero, ACCOUNT_ACCESS_TOKEN_PREF),
        refreshToken: readString(zotero, ACCOUNT_REFRESH_TOKEN_PREF),
        accessExpiresAt: readExpiresAt(zotero),
    };
}

export function isAccountSignedIn(session) {
    return Boolean(session?.refreshToken);
}

export function accessTokenNeedsRefresh(session, now = Date.now()) {
    if (!isAccountSignedIn(session)) return false;
    if (!session.accessToken) return true;
    return session.accessExpiresAt - now <= ACCOUNT_REFRESH_MARGIN_MS;
}

export function saveAccountSession(zotero, session) {
    writeString(zotero, ACCOUNT_EMAIL_PREF, session?.email);
    writeString(zotero, ACCOUNT_ACCESS_TOKEN_PREF, session?.accessToken);
    writeString(zotero, ACCOUNT_REFRESH_TOKEN_PREF, session?.refreshToken);
    const expiresAt = Number(session?.accessExpiresAt);
    zotero?.Prefs?.set?.(
        ACCOUNT_ACCESS_EXPIRES_AT_PREF,
        Number.isFinite(expiresAt) ? expiresAt : 0,
        true
    );
}

export function clearAccountSession(zotero) {
    for (const pref of SESSION_PREFS) {
        zotero?.Prefs?.set?.(
            pref,
            pref === ACCOUNT_ACCESS_EXPIRES_AT_PREF ? 0 : '',
            true
        );
    }
}

export function getAccountApiBase(zotero) {
    if (!isDebugBuild()) return MKTERO_RELEASE_API_BASE;
    const stored = readString(zotero, ACCOUNT_API_BASE_PREF);
    return normalizeAccountApiBase(stored || MKTERO_DEBUG_API_BASE);
}

export function setAccountApiBase(zotero, value) {
    const normalized = normalizeMinerULocalApiBase(value);
    const previous = getAccountApiBase(zotero);
    zotero?.Prefs?.set?.(ACCOUNT_API_BASE_PREF, normalized, true);
    if (previous !== normalized) clearAccountSession(zotero);
    return normalized;
}

function normalizeAccountApiBase(value) {
    try {
        return normalizeMinerULocalApiBase(value);
    }
    catch {
        return normalizeMinerULocalApiBase(MKTERO_DEBUG_API_BASE);
    }
}

function readString(zotero, key) {
    return String(zotero?.Prefs?.get?.(key, true) || '').trim();
}

function writeString(zotero, key, value) {
    zotero?.Prefs?.set?.(key, String(value || '').trim(), true);
}

function readExpiresAt(zotero) {
    const value = Number(zotero?.Prefs?.get?.(ACCOUNT_ACCESS_EXPIRES_AT_PREF, true));
    return Number.isFinite(value) ? value : 0;
}
