import { normalizeMinerULocalApiBase } from '../mineru/local-endpoint.js';
import {
    isDebugBuild,
    MKTERO_DEBUG_API_BASE,
    MKTERO_RELEASE_API_BASE,
} from './runtime-config.js';

export const ACCOUNT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const ACCOUNT_EMAIL_PREF = 'extensions.mktero.accountEmail';
export const ACCOUNT_NICKNAME_PREF = 'extensions.mktero.accountNickname';
export const ACCOUNT_ACCESS_TOKEN_PREF = 'extensions.mktero.accountAccessToken';
export const ACCOUNT_REFRESH_TOKEN_PREF = 'extensions.mktero.accountRefreshToken';
// The access-token expiry is a millisecond timestamp stored as a decimal
// string. It used to be an integer pref, but Firefox integer prefs are signed
// 32-bit, so every timestamp wrapped to a value long in the past and each
// authenticated request refreshed, and rotated, the tokens first.
export const ACCOUNT_ACCESS_EXPIRES_AT_PREF =
    'extensions.mktero.accountAccessExpiresAtMs';
// LEGACY_ACCESS_EXPIRES_AT_PREF holds that wrapped value in existing profiles.
// It is never read; saving or clearing the session removes it.
const LEGACY_ACCESS_EXPIRES_AT_PREF = 'extensions.mktero.accountAccessExpiresAt';
export const ACCOUNT_REFRESH_ATTEMPT_ID_PREF =
    'extensions.mktero.accountRefreshAttemptID';
export const ACCOUNT_API_BASE_PREF = 'extensions.mktero.accountApiBase';

const SESSION_PREFS = [
    ACCOUNT_EMAIL_PREF,
    ACCOUNT_NICKNAME_PREF,
    ACCOUNT_ACCESS_TOKEN_PREF,
    ACCOUNT_REFRESH_TOKEN_PREF,
    ACCOUNT_ACCESS_EXPIRES_AT_PREF,
    ACCOUNT_REFRESH_ATTEMPT_ID_PREF,
];

export function getAccountSession(zotero) {
    return {
        email: readString(zotero, ACCOUNT_EMAIL_PREF),
        nickname: readString(zotero, ACCOUNT_NICKNAME_PREF),
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
    writeString(zotero, ACCOUNT_NICKNAME_PREF, session?.nickname);
    writeString(zotero, ACCOUNT_ACCESS_TOKEN_PREF, session?.accessToken);
    writeString(zotero, ACCOUNT_REFRESH_TOKEN_PREF, session?.refreshToken);
    writeString(
        zotero,
        ACCOUNT_ACCESS_EXPIRES_AT_PREF,
        serializeExpiresAt(session?.accessExpiresAt)
    );
    zotero?.Prefs?.set?.(ACCOUNT_REFRESH_ATTEMPT_ID_PREF, '', true);
    clearLegacyExpiresAt(zotero);
}

// saveAccountProfile updates the display fields of the stored session and
// leaves the tokens alone. Profile requests run while a conversion may refresh
// the session; writing a whole earlier snapshot back would restore a refresh
// token the server has already rotated away and sign the user out.
//
// `expectedEmail` is the account the request was made for. The write is
// skipped, and false is returned, when the user has signed out in the meantime
// or signed in as someone else, so a late response cannot resurrect a session.
export function saveAccountProfile(zotero, { email, nickname } = {}, {
    expectedEmail = '',
} = {}) {
    const current = getAccountSession(zotero);
    if (!isAccountSignedIn(current)) return false;
    const expected = String(expectedEmail || '').trim().toLowerCase();
    if (expected && current.email.toLowerCase() !== expected) return false;
    const nextEmail = String(email || '').trim();
    const nextNickname = String(nickname || '').trim();
    writeString(zotero, ACCOUNT_EMAIL_PREF, nextEmail || current.email);
    writeString(zotero, ACCOUNT_NICKNAME_PREF, nextNickname || current.nickname);
    return true;
}

export function clearAccountSession(zotero) {
    for (const pref of SESSION_PREFS) zotero?.Prefs?.set?.(pref, '', true);
    clearLegacyExpiresAt(zotero);
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
    const value = Number(readString(zotero, ACCOUNT_ACCESS_EXPIRES_AT_PREF));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function serializeExpiresAt(value) {
    const expiresAt = Math.trunc(Number(value));
    return Number.isFinite(expiresAt) && expiresAt > 0 ? String(expiresAt) : '';
}

// Removing the stale pref is housekeeping. A failure must not break the
// session write that just succeeded.
function clearLegacyExpiresAt(zotero) {
    try {
        zotero?.Prefs?.clear?.(LEGACY_ACCESS_EXPIRES_AT_PREF, true);
    }
    catch {
        // The stale value is never read.
    }
}
