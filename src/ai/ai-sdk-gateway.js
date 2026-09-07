import '../platform/web-streams.js';
import {
    APICallError,
    generateText,
    streamText as streamTextResult,
} from 'ai';
import { createAlibaba } from '@ai-sdk/alibaba';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMiniMax } from '@ai-sdk/minimax';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenResponses } from '@ai-sdk/open-responses';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
    AI_MAX_OUTPUT_TOKENS,
    AI_PROTOCOL_ANTHROPIC,
    AI_PROTOCOL_GOOGLE,
    AI_PROTOCOL_OPENAI_CHAT,
    AI_PROTOCOL_OPENAI_RESPONSES,
    AI_PROTOCOL_OPEN_RESPONSES,
    AI_PROVIDER_ALIBABA,
    AI_PROVIDER_ANTHROPIC,
    AI_PROVIDER_CUSTOM,
    AI_PROVIDER_DEFAULT_REASONING,
    AI_PROVIDER_DEEPSEEK,
    AI_PROVIDER_GOOGLE,
    AI_PROVIDER_MINIMAX,
    AI_PROVIDER_MOONSHOT,
    AI_PROVIDER_OPENAI,
    validateAISettings,
} from '../config/ai-preferences.js';
import {
    createRuntimeAbortController,
} from '../platform/abort-controller.js';

const MAX_AI_MESSAGES = 100;
const DEFAULT_MAX_AI_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_AI_RESPONSE_BYTES = 1024 * 1024;
const MAX_AI_INPUT_BYTES = 4 * 1024 * 1024 + 256 * 1024;
const MAX_AI_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REASONING_FALLBACKS = 64;
const MAX_SESSION_ID_LENGTH = 128;
const LOCAL_PROVIDER_API_KEY = 'mktero-local';

export class AISDKGateway {
    constructor({
        runtimeWindow = resolveRuntimeWindow(),
        fetch = bindRuntimeMethod(runtimeWindow, 'fetch')
            || globalThis.fetch?.bind(globalThis),
        createAbortController = createRuntimeAbortController,
        setTimer,
        clearTimer,
        generate = generateText,
        stream = streamTextResult,
    } = {}) {
        if (typeof fetch !== 'function') {
            throw new TypeError('A fetch implementation is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        if (typeof generate !== 'function') {
            throw new TypeError('An AI SDK generateText implementation is required');
        }
        if (typeof stream !== 'function') {
            throw new TypeError('An AI SDK streamText implementation is required');
        }
        this.fetch = fetch;
        this.createAbortController = createAbortController;
        this.setTimer = setTimer
            || bindRuntimeMethod(runtimeWindow, 'setTimeout');
        this.clearTimer = clearTimer
            || bindRuntimeMethod(runtimeWindow, 'clearTimeout');
        this.generate = generate;
        this.stream = stream;
        this.reasoningFallbacks = new Set();
    }

    async generateText({
        settings,
        messages,
        signal,
        sessionId,
        maxOutputTokens,
        maxInputBytes,
        maxResponseBytes,
        acceptNonTextResponse = false,
    }) {
        const configuration = applyRememberedReasoningFallback(
            validateAISettings(settings),
            this.reasoningFallbacks
        );
        const limits = normalizeRequestByteLimits({
            maxInputBytes,
            maxResponseBytes,
        });
        const prompt = validateMessages(messages, limits.input);
        throwIfAborted(signal);
        const controller = this.createAbortController();
        let timedOut = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const timeoutID = configuration.requestTimeoutMs > 0
            && typeof this.setTimer === 'function'
            ? this.setTimer(() => {
                timedOut = true;
                controller.abort();
            }, configuration.requestTimeoutMs)
            : null;
        try {
            const boundedFetch = createBoundedFetch(
                this.fetch,
                limits.response,
                providerSessionHeaders(configuration.apiBase, sessionId)
            );
            const outputTokens = normalizeOutputTokens(
                maxOutputTokens,
                configuration.maxOutputTokens
            );
            const result = await requestWithReasoningFallback({
                configuration,
                canFallback: () => !timedOut && !signal?.aborted,
                onFallback: () => rememberReasoningFallback(
                    this.reasoningFallbacks,
                    configuration
                ),
                request: attemptConfiguration => this.generate(
                    createAIRequestOptions({
                        configuration: attemptConfiguration,
                        boundedFetch,
                        prompt,
                        outputTokens,
                        signal: controller.signal,
                    })
                ),
            });
            const text = String(result?.text || '');
            if (!text.trim()
                && (!acceptNonTextResponse || !hasNonTextResponseData(result))) {
                throw aiError(
                    'The AI provider returned an invalid response',
                    'AI_INVALID_RESPONSE'
                );
            }
            if (byteLength(text) > limits.response) {
                throw responseTooLargeError();
            }
            return {
                text,
                finishReason: normalizeFinishReason(result?.finishReason),
                model: responseModel(result, configuration.model),
                usage: normalizeUsage(result?.usage),
            };
        }
        catch (error) {
            if (timedOut) {
                throw aiError('The AI request timed out', 'AI_REQUEST_TIMEOUT');
            }
            if (signal?.aborted) throw abortReason(signal);
            if (isAIError(error)) throw error;
            if (APICallError.isInstance(error)) throw apiCallError(error);
            if (isAbortError(error)) throw error;
            throw aiError('The AI provider could not be reached', 'AI_NETWORK_ERROR');
        }
        finally {
            if (timeoutID !== null && typeof this.clearTimer === 'function') {
                this.clearTimer(timeoutID);
            }
            signal?.removeEventListener('abort', relayAbort);
        }
    }

    async streamText({
        settings,
        messages,
        signal,
        sessionId,
        maxOutputTokens,
        onTextDelta,
        onStreamEvent,
        maxInputBytes,
        maxResponseBytes,
    }) {
        const configuration = applyRememberedReasoningFallback(
            validateAISettings(settings),
            this.reasoningFallbacks
        );
        const limits = normalizeRequestByteLimits({
            maxInputBytes,
            maxResponseBytes,
        });
        const prompt = validateMessages(messages, limits.input);
        throwIfAborted(signal);
        const controller = this.createAbortController();
        let timedOut = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const timeoutID = configuration.requestTimeoutMs > 0
            && typeof this.setTimer === 'function'
            ? this.setTimer(() => {
                timedOut = true;
                controller.abort();
            }, configuration.requestTimeoutMs)
            : null;
        try {
            const boundedFetch = createBoundedFetch(
                this.fetch,
                limits.response,
                providerSessionHeaders(configuration.apiBase, sessionId)
            );
            const outputTokens = normalizeOutputTokens(
                maxOutputTokens,
                configuration.maxOutputTokens
            );
            let emittedText = false;
            return await requestWithReasoningFallback({
                configuration,
                canFallback: () => !emittedText
                    && !timedOut
                    && !signal?.aborted,
                onFallback: () => rememberReasoningFallback(
                    this.reasoningFallbacks,
                    configuration
                ),
                request: async attemptConfiguration => {
                    let streamError = null;
                    const result = await this.stream({
                        ...createAIRequestOptions({
                            configuration: attemptConfiguration,
                            boundedFetch,
                            prompt,
                            outputTokens,
                            signal: controller.signal,
                        }),
                        onError: ({ error }) => {
                            streamError = error;
                        },
                    });
                    return consumeAIStreamResult({
                        result,
                        getStreamError: () => streamError,
                        maxResponseBytes: limits.response,
                        fallbackModel: attemptConfiguration.model,
                        onStreamEvent,
                        onTextDelta: (chunk, accumulated) => {
                            emittedText = true;
                            onTextDelta?.(chunk, accumulated);
                        },
                        ensureActive: () => {
                            if (timedOut) {
                                throw aiError(
                                    'The AI request timed out',
                                    'AI_REQUEST_TIMEOUT'
                                );
                            }
                            throwIfAborted(signal);
                        },
                    });
                },
            });
        }
        catch (error) {
            if (timedOut) {
                throw aiError('The AI request timed out', 'AI_REQUEST_TIMEOUT');
            }
            if (signal?.aborted) throw abortReason(signal);
            if (isAIError(error)) throw error;
            if (APICallError.isInstance(error)) throw apiCallError(error);
            if (isAbortError(error)) throw error;
            throw aiError('The AI provider could not be reached', 'AI_NETWORK_ERROR');
        }
        finally {
            if (timeoutID !== null && typeof this.clearTimer === 'function') {
                this.clearTimer(timeoutID);
            }
            signal?.removeEventListener('abort', relayAbort);
        }
    }
}

async function requestWithReasoningFallback({
    configuration,
    request,
    canFallback = () => true,
    onFallback,
}) {
    try {
        return await request(configuration);
    }
    catch (error) {
        if (!canFallback()
            || !isUnsupportedReasoningControl(error, configuration.reasoning)) {
            throw error;
        }
        onFallback?.();
        return request({
            ...configuration,
            reasoning: AI_PROVIDER_DEFAULT_REASONING,
        });
    }
}

function applyRememberedReasoningFallback(configuration, fallbacks) {
    if (configuration.reasoning !== 'none'
        || !fallbacks.has(reasoningFallbackKey(configuration))) {
        return configuration;
    }
    return {
        ...configuration,
        reasoning: AI_PROVIDER_DEFAULT_REASONING,
    };
}

function rememberReasoningFallback(fallbacks, configuration) {
    const key = reasoningFallbackKey(configuration);
    if (!fallbacks.has(key) && fallbacks.size >= MAX_REASONING_FALLBACKS) {
        fallbacks.delete(fallbacks.values().next().value);
    }
    fallbacks.add(key);
}

function reasoningFallbackKey(configuration) {
    return JSON.stringify([
        configuration.provider,
        configuration.protocol,
        configuration.apiBase,
        configuration.model,
    ]);
}

function createAIRequestOptions({
    configuration,
    boundedFetch,
    prompt,
    outputTokens,
    signal,
}) {
    return {
        model: createLanguageModel(configuration, boundedFetch),
        messages: prompt.messages,
        ...(prompt.instructions
            ? { instructions: prompt.instructions }
            : {}),
        ...(outputTokens === null
            ? {}
            : { maxOutputTokens: outputTokens }),
        ...reasoningRequestPolicy(configuration),
        maxRetries: 0,
        abortSignal: signal,
    };
}

async function consumeAIStreamResult({
    result,
    getStreamError,
    maxResponseBytes,
    fallbackModel,
    onStreamEvent,
    onTextDelta,
    ensureActive,
}) {
    const { fullStream, stream } = resolveAIResultStream(result);
    const consumed = await consumeAIStreamEvents({
        stream,
        fullStream,
        maxResponseBytes,
        onStreamEvent,
        onTextDelta,
    });
    ensureActive();
    const streamError = consumed.error || getStreamError();
    if (streamError) throw streamError;
    if (!consumed.text) throw invalidResponseError();

    const metadata = fullStream
        ? consumed
        : await resolveTextStreamMetadata(result);
    const metadataError = getStreamError();
    if (metadataError) throw metadataError;
    ensureActive();
    return {
        text: consumed.text,
        finishReason: normalizeFinishReason(metadata.finishReason),
        model: responseModel({ response: metadata.response }, fallbackModel),
        usage: normalizeUsage(metadata.usage),
    };
}

function resolveAIResultStream(result) {
    const fullStreamCandidate = result?.fullStream;
    const fullStream = fullStreamCandidate?.[Symbol.asyncIterator]
        ? fullStreamCandidate
        : null;
    const textStreamCandidate = fullStream ? null : result?.textStream;
    const stream = fullStream
        || (textStreamCandidate?.[Symbol.asyncIterator]
            ? textStreamCandidate
            : null);
    if (!stream) throw invalidResponseError();
    return { fullStream, stream };
}

async function consumeAIStreamEvents({
    stream,
    fullStream,
    maxResponseBytes,
    onStreamEvent,
    onTextDelta,
}) {
    const state = {
        accumulated: '',
        emittedTextStart: false,
        error: null,
        usage: null,
        response: null,
        finishReason: null,
    };
    const responseBytes = createIncrementalByteCounter();
    for await (const event of stream) {
        if (fullStream) {
            const action = consumeAIStreamMetadataEvent(
                event,
                state,
                onStreamEvent
            );
            if (action === 'finish') break;
            if (action === 'consumed') continue;
        }
        const chunk = fullStream
            ? String(event?.type === 'text-delta' ? event.text || '' : '')
            : String(event || '');
        if (!chunk) continue;
        if (!state.emittedTextStart) {
            state.emittedTextStart = true;
            emitStreamEvent(onStreamEvent, 'text-start');
        }
        state.accumulated += chunk;
        if (responseBytes.add(chunk) > maxResponseBytes) {
            throw responseTooLargeError();
        }
        onTextDelta?.(chunk, state.accumulated);
        emitStreamEvent(onStreamEvent, 'text-delta');
    }
    if (responseBytes.finish() > maxResponseBytes) {
        throw responseTooLargeError();
    }
    return {
        ...state,
        text: state.accumulated.trim(),
    };
}

function consumeAIStreamMetadataEvent(event, state, onStreamEvent) {
    if (event?.type === 'error') {
        state.error = event.error;
        emitStreamEvent(onStreamEvent, 'error');
        return 'consumed';
    }
    if (event?.type === 'finish-step' || event?.type === 'finish') {
        state.usage = event.usage || event.totalUsage || state.usage;
        state.response = event.response || state.response;
        state.finishReason = event.finishReason || state.finishReason;
        emitStreamEvent(onStreamEvent, event.type);
        return event.type === 'finish' ? 'finish' : 'consumed';
    }
    if (event?.type === 'reasoning-start'
        || event?.type === 'reasoning-delta'
        || event?.type === 'reasoning-end'
        || event?.type === 'text-start'
        || event?.type === 'text-end') {
        emitStreamEvent(onStreamEvent, event.type);
        if (event.type === 'text-start') state.emittedTextStart = true;
        return 'consumed';
    }
    return 'text';
}

async function resolveTextStreamMetadata(result) {
    return {
        usage: result.usage ? await result.usage : null,
        response: result.response ? await result.response : null,
        finishReason: result.finishReason ? await result.finishReason : null,
    };
}

function isUnsupportedReasoningControl(error, reasoning) {
    if (reasoning !== 'none') return false;
    if (APICallError.isInstance(error)) {
        const status = Number(error.statusCode) || 0;
        if (status !== 400 && status !== 422) return false;
    }
    else if (error?.name !== 'AI_UnsupportedFunctionalityError') {
        return false;
    }
    const details = [error?.message, error?.responseBody]
        .filter(value => typeof value === 'string')
        .join('\n')
        .slice(0, 32 * 1024);
    const mentionsReasoning = /reasoning(?:[_ -]?effort)?|thinking|enable[_ -]?thinking/i
        .test(details);
    const rejectsControl = /cannot|can't|does not support|invalid|must be enabled|not allowed|requires?|required|unsupported|unknown|unrecognized/i
        .test(details);
    return mentionsReasoning && rejectsControl;
}

function resolveRuntimeWindow() {
    if (typeof globalThis.window?.setTimeout === 'function') {
        return globalThis.window;
    }
    try {
        const zoteroWindow = globalThis.Zotero?.getMainWindow?.();
        if (typeof zoteroWindow?.setTimeout === 'function') {
            return zoteroWindow;
        }
    }
    catch {
        // The Zotero global may not be available during module tests or shutdown.
    }
    return globalThis;
}

function bindRuntimeMethod(runtimeWindow, method) {
    const value = runtimeWindow?.[method];
    return typeof value === 'function'
        ? value.bind(runtimeWindow)
        : undefined;
}

function reasoningRequestPolicy(configuration) {
    const reasoning = configuration.reasoning;
    if (reasoning === AI_PROVIDER_DEFAULT_REASONING) return { reasoning };
    if (configuration.provider === AI_PROVIDER_CUSTOM
        && reasoning === 'none'
        && (
            configuration.protocol === AI_PROTOCOL_OPENAI_CHAT
            || configuration.protocol === AI_PROTOCOL_OPENAI_RESPONSES
            || configuration.protocol === AI_PROTOCOL_OPEN_RESPONSES
        )) {
        return {};
    }
    if (configuration.provider === AI_PROVIDER_MOONSHOT
        && reasoning === 'none') {
        return {
            reasoning: AI_PROVIDER_DEFAULT_REASONING,
            providerOptions: {
                moonshotai: {
                    thinking: { type: 'disabled' },
                },
            },
        };
    }
    if (configuration.provider === AI_PROVIDER_MINIMAX) {
        return {
            reasoning,
            providerOptions: {
                minimax: {
                    thinking: {
                        type: reasoning === 'none'
                            ? 'disabled'
                            : 'adaptive',
                    },
                },
            },
        };
    }
    return { reasoning };
}

export function createLanguageModel(configuration, fetch) {
    const providerOptions = {
        apiKey: providerApiKey(configuration),
        baseURL: configuration.apiBase,
        fetch,
    };
    switch (configuration.provider) {
        case AI_PROVIDER_OPENAI: {
            const provider = createOpenAI(providerOptions);
            return configuration.protocol === AI_PROTOCOL_OPENAI_RESPONSES
                ? provider.responses(configuration.model)
                : provider.chat(configuration.model);
        }
        case AI_PROVIDER_ANTHROPIC:
            return createAnthropic(providerOptions)(configuration.model);
        case AI_PROVIDER_GOOGLE:
            return createGoogleGenerativeAI(providerOptions)(configuration.model);
        case AI_PROVIDER_DEEPSEEK:
            return createDeepSeek(providerOptions)(configuration.model);
        case AI_PROVIDER_ALIBABA:
            return createAlibaba(providerOptions)(configuration.model);
        case AI_PROVIDER_MOONSHOT:
            return createMoonshotAI(providerOptions)(configuration.model);
        case AI_PROVIDER_MINIMAX:
            return createMiniMax(providerOptions)(configuration.model);
        case AI_PROVIDER_CUSTOM:
            return createCustomLanguageModel(configuration, fetch);
        default:
            throw aiError('The AI provider is not supported', 'AI_PROVIDER_UNSUPPORTED');
    }
}

function createCustomLanguageModel(configuration, fetch) {
    const options = {
        apiKey: providerApiKey(configuration),
        baseURL: configuration.apiBase,
        fetch,
    };
    switch (configuration.protocol) {
        case AI_PROTOCOL_OPENAI_CHAT:
            return createOpenAICompatible({
                ...options,
                name: 'mktero-compatible',
            })(configuration.model);
        case AI_PROTOCOL_OPENAI_RESPONSES:
            return createOpenAI({
                ...options,
                name: 'mktero-openai-responses',
            }).responses(configuration.model);
        case AI_PROTOCOL_OPEN_RESPONSES:
            return createOpenResponses({
                apiKey: options.apiKey,
                fetch,
                name: 'mktero-open-responses',
                url: responsesEndpoint(configuration.apiBase),
            })(configuration.model);
        case AI_PROTOCOL_ANTHROPIC:
            return createAnthropic({
                ...options,
                name: 'mktero-anthropic-compatible',
            })(configuration.model);
        case AI_PROTOCOL_GOOGLE:
            return createGoogleGenerativeAI({
                ...options,
                name: 'mktero-google-compatible',
            })(configuration.model);
        default:
            throw aiError('The AI protocol is not supported', 'AI_PROVIDER_UNSUPPORTED');
    }
}

function providerApiKey(configuration) {
    return configuration.apiKey || (isLoopbackURL(configuration.apiBase)
        ? LOCAL_PROVIDER_API_KEY
        : undefined);
}

function validateMessages(messages, maxInputBytes) {
    if (!Array.isArray(messages)
        || !messages.length
        || messages.length > MAX_AI_MESSAGES) {
        throw aiError('Invalid AI messages', 'AI_INVALID_REQUEST');
    }
    const normalized = messages.map(message => {
        const role = String(message?.role || '');
        const content = String(message?.content || '');
        if (!['system', 'user', 'assistant'].includes(role) || !content.trim()) {
            throw aiError('Invalid AI messages', 'AI_INVALID_REQUEST');
        }
        return { role, content };
    });
    if (byteLength(JSON.stringify(normalized)) > maxInputBytes) {
        throw aiError('The AI input is too large', 'AI_INPUT_TOO_LARGE');
    }
    const firstNonSystem = normalized.findIndex(message => (
        message.role !== 'system'
    ));
    const systemEnd = firstNonSystem < 0 ? normalized.length : firstNonSystem;
    if (normalized.slice(systemEnd).some(message => message.role === 'system')) {
        throw aiError('Invalid AI messages', 'AI_INVALID_REQUEST');
    }
    return {
        instructions: normalized
            .slice(0, systemEnd)
            .map(message => message.content)
            .join('\n\n'),
        messages: normalized.slice(systemEnd),
    };
}

function createBoundedFetch(fetch, maxResponseBytes, extraHeaders) {
    return async (input, init) => {
        const response = await fetch(input, withExtraHeaders(init, extraHeaders));
        const declaredLength = Number(response?.headers?.get?.('Content-Length'));
        if (Number.isFinite(declaredLength)
            && declaredLength > maxResponseBytes) {
            await response?.body?.cancel?.().catch?.(() => {});
            throw responseTooLargeError();
        }
        if (!response?.body?.getReader) return response;
        const reader = response.body.getReader();
        const sseDoneDetector = isEventStream(response)
            ? createSSEDoneDetector()
            : null;
        let totalBytes = 0;
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                        return;
                    }
                    if (!isByteView(value)) {
                        throw invalidResponseError();
                    }
                    totalBytes += value.byteLength;
                    if (totalBytes > maxResponseBytes) {
                        await reader.cancel?.().catch?.(() => {});
                        throw responseTooLargeError();
                    }
                    controller.enqueue(value);
                    if (sseDoneDetector?.add(value)) {
                        controller.close();
                        reader.cancel?.().catch?.(() => {});
                    }
                }
                catch (error) {
                    controller.error(error);
                }
            },
            cancel(reason) {
                return reader.cancel?.(reason);
            },
        });
        return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}

function withExtraHeaders(init, extraHeaders) {
    if (!extraHeaders) return init;
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extraHeaders)) {
        if (!headers.has(name)) headers.set(name, value);
    }
    return {
        ...init,
        headers,
    };
}

function providerSessionHeaders(apiBase, sessionId) {
    const id = normalizeSessionId(sessionId);
    if (!id || !isOpenCodeGoURL(apiBase)) return undefined;
    return { 'x-opencode-session': id };
}

function normalizeSessionId(value) {
    if (typeof value !== 'string') return '';
    const sessionId = value.trim();
    if (!sessionId
        || sessionId.length > MAX_SESSION_ID_LENGTH
        || /[\s\u0000-\u001f\u007f]/.test(sessionId)) {
        return '';
    }
    return sessionId;
}

function isOpenCodeGoURL(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) {
            return false;
        }
        const path = url.pathname.replace(/\/+$/, '') || '/';
        return path === '/zen/go' || path.startsWith('/zen/go/');
    }
    catch {
        return false;
    }
}

function isEventStream(response) {
    return String(response?.headers?.get?.('Content-Type') || '')
        .toLowerCase()
        .startsWith('text/event-stream');
}

function createSSEDoneDetector() {
    const decoder = new TextDecoder();
    let line = '';
    let lineTooLong = false;
    let previousWasCarriageReturn = false;
    const isDoneLine = () => !lineTooLong
        && /^data:[ \t]*\[DONE\][ \t]*$/.test(line);
    const resetLine = () => {
        line = '';
        lineTooLong = false;
    };
    return {
        add(value) {
            const chunk = decoder.decode(value, { stream: true });
            for (const character of chunk) {
                if (character === '\n' && previousWasCarriageReturn) {
                    previousWasCarriageReturn = false;
                    continue;
                }
                if (character === '\r' || character === '\n') {
                    if (isDoneLine()) return true;
                    resetLine();
                    previousWasCarriageReturn = character === '\r';
                    continue;
                }
                previousWasCarriageReturn = false;
                if (lineTooLong) continue;
                if (line.length >= 64) {
                    lineTooLong = true;
                    line = '';
                    continue;
                }
                line += character;
            }
            return false;
        },
    };
}

function isByteView(value) {
    return ArrayBuffer.isView(value)
        && value.BYTES_PER_ELEMENT === 1
        && typeof value.byteLength === 'number';
}

function responsesEndpoint(apiBase) {
    return apiBase.endsWith('/responses')
        ? apiBase
        : `${apiBase}/responses`;
}

function isLoopbackURL(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:'
            && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
                url.hostname.toLowerCase()
            );
    }
    catch {
        return false;
    }
}

function normalizeOutputTokens(value, fallback) {
    const number = Number(value ?? fallback);
    if (!Number.isFinite(number) || number <= 0) return null;
    return Math.max(1, Math.min(AI_MAX_OUTPUT_TOKENS, Math.round(number)));
}

function normalizeFinishReason(value) {
    const reason = String(value?.unified || value || '').trim().toLowerCase();
    return [
        'stop',
        'length',
        'content-filter',
        'tool-calls',
        'error',
        'other',
    ].includes(reason) ? reason : null;
}

function createIncrementalByteCounter() {
    let total = 0;
    let pendingHighSurrogate = '';
    return {
        add(value) {
            let chunk = pendingHighSurrogate + String(value || '');
            pendingHighSurrogate = '';
            if (/[\uD800-\uDBFF]$/.test(chunk)) {
                pendingHighSurrogate = chunk.at(-1);
                chunk = chunk.slice(0, -1);
            }
            total += byteLength(chunk);
            return total;
        },
        finish() {
            total += byteLength(pendingHighSurrogate);
            pendingHighSurrogate = '';
            return total;
        },
    };
}

function normalizeByteLimit(value, fallback, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(1, Math.min(maximum, Math.round(number)));
}

function normalizeRequestByteLimits({ maxInputBytes, maxResponseBytes }) {
    return {
        input: normalizeByteLimit(
            maxInputBytes,
            DEFAULT_MAX_AI_INPUT_BYTES,
            MAX_AI_INPUT_BYTES
        ),
        response: normalizeByteLimit(
            maxResponseBytes,
            DEFAULT_MAX_AI_RESPONSE_BYTES,
            MAX_AI_RESPONSE_BYTES
        ),
    };
}

function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const inputTokens = nonNegativeInteger(usage.inputTokens);
    const outputTokens = nonNegativeInteger(usage.outputTokens);
    const totalTokens = nonNegativeInteger(usage.totalTokens);
    if (inputTokens === null
        && outputTokens === null
        && totalTokens === null) {
        return null;
    }
    return { inputTokens, outputTokens, totalTokens };
}

function hasNonTextResponseData(result) {
    if (String(result?.reasoningText || '').trim()) return true;
    if (Array.isArray(result?.content) && result.content.length) return true;
    if (normalizeFinishReason(result?.finishReason) !== null) return true;
    if (normalizeUsage(result?.usage) !== null) return true;
    return result?.response
        && typeof result.response === 'object'
        && Object.keys(result.response).length > 0;
}

function responseModel(result, fallback) {
    const value = result?.response?.modelId || result?.finalStep?.response?.modelId;
    return typeof value === 'string'
        && value.trim()
        && value.length <= 512
        ? value
        : fallback;
}

function nonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function apiCallError(error) {
    const status = Number(error.statusCode) || 0;
    if (status >= 200 && status < 300) {
        return aiStatusError(
            'The AI provider returned an invalid response',
            'AI_INVALID_RESPONSE',
            status
        );
    }
    if (status === 401 || status === 403) {
        return aiStatusError('AI authentication failed', 'AI_AUTH_ERROR', status);
    }
    if (status === 429) {
        return aiStatusError(
            'The AI provider rate limit was reached',
            'AI_RATE_LIMITED',
            status
        );
    }
    return aiStatusError('The AI provider request failed', 'AI_HTTP_ERROR', status);
}

function aiStatusError(message, code, status) {
    const error = aiError(message, code);
    error.status = status;
    return error;
}

function byteLength(value) {
    return new TextEncoder().encode(String(value || '')).length;
}

function emitStreamEvent(listener, type) {
    if (typeof listener !== 'function') return;
    try {
        listener({ type });
    }
    catch {
        // Progress reporting must never interrupt a provider response.
    }
}

function responseTooLargeError() {
    return aiError('The AI provider response is too large', 'AI_RESPONSE_TOO_LARGE');
}

function invalidResponseError() {
    return aiError('The AI provider returned an invalid response', 'AI_INVALID_RESPONSE');
}

function aiError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isAIError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('AI_');
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
    if (signal?.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}
