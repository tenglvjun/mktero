import { AISDKGateway } from '../ai/ai-sdk-gateway.js';
import {
    MarkdownTranslationService,
} from '../ai/markdown-translation-service.js';
import { getAISettings } from '../config/ai-preferences.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';

// Loaded only when the preferences pane tests an AI connection. Keeping this
// out of preferences.js avoids parsing the AI SDK before the pane can paint.
globalThis.MkteroPreferencesAI = {
    testConnection(settings, signal, runtimeWindow = globalThis) {
        const gateway = new AISDKGateway({
            createAbortController: createRuntimeAbortController,
            runtimeWindow,
            onDebug: message => globalThis.Zotero?.debug?.(message),
        });
        const service = new MarkdownTranslationService({
            aiGateway: gateway,
            getSettings: () => getAISettings(globalThis.Zotero),
        });
        return service.testConnection({ settings, signal });
    },
};
