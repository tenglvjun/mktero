import {
    getAccountApiBase,
    getAccountSession,
    getAccountSessionEpoch,
    observeAccountSession,
} from '../config/account-preferences.js';
import {
    getConversionProvider,
    observeConversionProfile,
} from '../config/conversion-preferences.js';

export function createHostedConversionScope({ zotero, onChange = () => {} } = {}) {
    let sequence = 1;
    let identity = readIdentity(zotero);
    let scope = `hosted-session:${sequence}`;
    let disposed = false;

    const refresh = () => {
        const nextIdentity = readIdentity(zotero);
        if (nextIdentity === identity) return scope;

        identity = nextIdentity;
        scope = `hosted-session:${++sequence}`;
        if (!disposed) {
            try {
                onChange(scope);
            }
            catch {
                // Preference observers must not make writes fail.
            }
        }
        return scope;
    };

    const stopAccountObserver = observeAccountSession(zotero, refresh);
    const stopConversionObserver = observeConversionProfile(zotero, refresh);

    return {
        current: refresh,
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const stop of [stopAccountObserver, stopConversionObserver]) {
                try {
                    stop();
                }
                catch {
                    // A failed unregister must not skip the other observer set.
                }
            }
        },
    };
}

function readIdentity(zotero) {
    const account = getAccountSession(zotero);
    return JSON.stringify([
        getAccountApiBase(zotero),
        String(account.email || '').trim().toLowerCase(),
        getAccountSessionEpoch(zotero),
        getConversionProvider(zotero),
        Boolean(account.refreshToken),
    ]);
}
