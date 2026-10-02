import test from 'node:test';
import assert from 'node:assert/strict';
import {
    accessTokenNeedsRefresh,
    ACCOUNT_REFRESH_MARGIN_MS,
    clearAccountSession,
    getAccountApiBase,
    getAccountSession,
    getPdfServiceSource,
    isAccountSignedIn,
    saveAccountSession,
    SERVICE_SOURCE_MKTERO,
    SERVICE_SOURCE_OWN,
    setAccountApiBase,
} from '../src/config/account-preferences.js';

function memoryPrefs(initial = {}) {
    const values = { ...initial };
    return {
        get(key) {
            return values[key];
        },
        set(key, value) {
            values[key] = value;
        },
        dump() {
            return values;
        },
    };
}

test('the PDF source reads the stored value and defaults to your own service', () => {
    const zotero = { Prefs: memoryPrefs({
        'extensions.mktero.pdfServiceSource': SERVICE_SOURCE_MKTERO,
    }) };
    assert.equal(getPdfServiceSource(zotero), SERVICE_SOURCE_MKTERO);
    assert.equal(
        getPdfServiceSource({ Prefs: memoryPrefs() }),
        SERVICE_SOURCE_OWN
    );
    assert.equal(
        getPdfServiceSource({ Prefs: memoryPrefs({
            'extensions.mktero.pdfServiceSource': SERVICE_SOURCE_OWN,
        }) }),
        SERVICE_SOURCE_OWN
    );
});

test('stores both tokens and refreshes shortly before the access token expires', () => {
    const zotero = { Prefs: memoryPrefs() };
    const now = 1_000_000;
    saveAccountSession(zotero, {
        email: 'user@example.com',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: now + ACCOUNT_REFRESH_MARGIN_MS + 1,
    });
    const session = getAccountSession(zotero);
    assert.equal(isAccountSignedIn(session), true);
    assert.equal(accessTokenNeedsRefresh(session, now), false);
    assert.equal(
        accessTokenNeedsRefresh(session, now + 2),
        true
    );
    clearAccountSession(zotero);
    assert.equal(isAccountSignedIn(getAccountSession(zotero)), false);
    assert.equal(zotero.Prefs.dump()['extensions.mktero.accountAccessToken'], '');
});

test('debug server address changes clear the saved session', () => {
    const zotero = { Prefs: memoryPrefs() };
    saveAccountSession(zotero, {
        email: 'user@example.com',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: 10,
    });
    assert.equal(getAccountApiBase(zotero), 'http://127.0.0.1:8080');
    assert.equal(
        setAccountApiBase(zotero, 'http://127.0.0.1:8080'),
        'http://127.0.0.1:8080'
    );
    assert.equal(isAccountSignedIn(getAccountSession(zotero)), true);
    setAccountApiBase(zotero, 'http://127.0.0.1:9090');
    assert.equal(isAccountSignedIn(getAccountSession(zotero)), false);
    assert.throws(
        () => setAccountApiBase(zotero, 'http://example.com'),
        { code: 'MINERU_LOCAL_ENDPOINT_INVALID' }
    );
    assert.equal(getPdfServiceSource({ Prefs: memoryPrefs({
        'extensions.mktero.pdfServiceSource': SERVICE_SOURCE_MKTERO,
    }) }), SERVICE_SOURCE_MKTERO);
});
