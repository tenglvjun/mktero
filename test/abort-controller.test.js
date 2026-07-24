import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeAbortController } from '../src/platform/abort-controller.js';

test('prefers the plugin global AbortController without consulting Zotero windows', () => {
    class SandboxAbortController {}
    const controller = createRuntimeAbortController({
        globalObject: { AbortController: SandboxAbortController },
        zotero: {
            getMainWindow() {
                assert.fail('the Zotero window should not be consulted');
            },
        },
    });

    assert.ok(controller instanceof SandboxAbortController);
});

test('falls back to the hidden DOM AbortController without a main window', () => {
    class HiddenAbortController {}
    const controller = createRuntimeAbortController({
        globalObject: {},
        zotero: { getMainWindow: () => null },
        services: {
            appShell: {
                hiddenDOMWindow: { AbortController: HiddenAbortController },
            },
        },
    });

    assert.ok(controller instanceof HiddenAbortController);
});
