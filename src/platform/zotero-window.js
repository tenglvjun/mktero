// On macOS Zotero keeps running after its last main window closes, and a new
// main window can open later. A window captured at startup is then dead: its
// fetch, timers, and document throw NS_ERROR_NOT_INITIALIZED. Window-bound
// work therefore resolves the window when it runs, never when it is wired.

// Returns the open window `resolve` currently yields, or null.
export function openWindow(resolve) {
    try {
        const view = typeof resolve === 'function' ? resolve() : resolve;
        return view && view.closed !== true ? view : null;
    }
    catch {
        return null;
    }
}

// The current Zotero main window, or the hidden DOM window while no main
// window is open. Both lookups are guarded: hiddenDOMWindow can throw
// NS_ERROR_FAILURE on some Windows setups (issue #59).
export function liveZoteroWindow({
    zotero = globalThis.Zotero,
    services = globalThis.Services,
} = {}) {
    return openWindow(() => zotero?.getMainWindow?.())
        || openWindow(() => services?.appShell?.hiddenDOMWindow);
}

// Constructors bridged into the sandbox while the bundle loads (Web Streams,
// AbortController, structuredClone) live for the whole extension session, and
// classes such as an SDK stream subclass capture them at module evaluation.
// They come from the hidden DOM window, which lasts as long as the app, and
// fall back to the main window only when the hidden window is unavailable.
export function lifetimeZoteroWindow({
    zotero = globalThis.Zotero,
    services = globalThis.Services,
} = {}) {
    return openWindow(() => services?.appShell?.hiddenDOMWindow)
        || openWindow(() => zotero?.getMainWindow?.());
}

// A fetch that calls the window `resolveWindow` yields at request time.
// `fallback` is used when no window offers fetch.
export function createWindowFetch(resolveWindow, { fallback } = {}) {
    return async function windowFetch(input, init) {
        const view = windowWithMethod(resolveWindow, 'fetch');
        if (view) return view.fetch(input, init);
        if (typeof fallback === 'function') return fallback(input, init);
        throw new TypeError('fetch is unavailable in the Zotero runtime');
    };
}

// Timers owned by the window `resolveWindow` yields when each timer starts.
// The handle remembers its owner, so clearing reaches the same window and a
// window that has closed since then is skipped instead of throwing.
export function createWindowTimers(resolveWindow) {
    return {
        setTimer(callback, delay) {
            const view = windowWithMethod(resolveWindow, 'setTimeout');
            if (!view) return null;
            return { view, id: view.setTimeout(callback, delay) };
        },
        clearTimer(handle) {
            if (!handle?.view) return;
            try {
                handle.view.clearTimeout(handle.id);
            }
            catch {
                // The owning window closed, which already cancelled the timer.
            }
        },
    };
}

function windowWithMethod(resolveWindow, method) {
    const view = openWindow(resolveWindow);
    try {
        return typeof view?.[method] === 'function' ? view : null;
    }
    catch {
        return null;
    }
}
