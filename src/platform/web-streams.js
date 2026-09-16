// Zotero's privileged bootstrap sandbox can omit Web Streams globals and
// `console` even though the owning browser window provides them. AI SDK Core
// evaluates its event-stream parser and warning logger while the extension
// bundle loads, so these must be bridged before importing the SDK.
let mainWindow = null;
try {
    mainWindow = globalThis.Zotero?.getMainWindow?.() || null;
}
catch {
    mainWindow = null;
}

let hiddenWindow = null;
let hiddenWindowResolved = false;

function resolveHiddenWindow() {
    if (hiddenWindowResolved) return hiddenWindow;
    hiddenWindowResolved = true;
    try {
        hiddenWindow = globalThis.Services?.appShell?.hiddenDOMWindow || null;
    }
    catch {
        hiddenWindow = null;
    }
    return hiddenWindow;
}

function resolveConstructor(owner, name) {
    try {
        const Constructor = owner?.[name];
        return typeof Constructor === 'function' ? Constructor : null;
    }
    catch {
        return null;
    }
}

function resolveConsole(owner) {
    try {
        const consoleObject = owner?.console;
        return typeof consoleObject?.warn === 'function' ? consoleObject : null;
    }
    catch {
        return null;
    }
}

for (const name of [
    'ReadableStream',
    'TransformStream',
    'WritableStream',
    'TextDecoderStream',
    'TextEncoderStream',
]) {
    if (typeof globalThis[name] === 'function') continue;
    const Constructor = resolveConstructor(mainWindow, name)
        || resolveConstructor(resolveHiddenWindow(), name);
    if (Constructor) globalThis[name] = Constructor;
}

if (typeof globalThis.console?.warn !== 'function') {
    globalThis.console = resolveConsole(mainWindow)
        || resolveConsole(resolveHiddenWindow())
        || createSandboxConsole();
}

function createSandboxConsole() {
    const write = (...values) => {
        try {
            const text = values
                .filter(value => typeof value === 'string')
                .join(' ')
                .slice(0, 1024);
            if (text) globalThis.Zotero?.debug?.(text);
        }
        catch {
            // Ignore debug failures during shutdown.
        }
    };
    const noop = () => {};
    return {
        assert: noop,
        clear: noop,
        count: noop,
        countReset: noop,
        debug: write,
        dir: noop,
        error: write,
        group: noop,
        groupCollapsed: noop,
        groupEnd: noop,
        info: write,
        log: write,
        table: noop,
        time: noop,
        timeEnd: noop,
        trace: noop,
        warn: write,
    };
}
