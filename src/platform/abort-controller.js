export function createRuntimeAbortController({
    globalObject = globalThis,
    zotero = globalObject?.Zotero,
    services = globalObject?.Services,
} = {}) {
    if (typeof globalObject?.AbortController === 'function') {
        return new globalObject.AbortController();
    }
    let owner = null;
    try {
        owner = zotero?.getMainWindow?.();
    }
    catch {
        owner = null;
    }
    const hiddenWindow = services?.appShell?.hiddenDOMWindow;
    const Constructor = [owner, hiddenWindow]
        .map(candidate => candidate?.AbortController)
        .find(candidate => typeof candidate === 'function');
    if (!Constructor) {
        throw new Error('AbortController is unavailable in the Zotero runtime');
    }
    return new Constructor();
}
