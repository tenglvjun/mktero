import { splitTranslationSegment } from './academic-segments.js';
import {
    TRANSLATION_PROTOCOL_SUFFIX,
    TRANSLATION_PROTOCOL_VERSION,
    translationProfileDescriptor,
} from './translation-profile.js';

export {
    TRANSLATION_PROTOCOL_VERSION,
    translationProfileDescriptor,
};
export const MAX_TRANSLATION_RESPONSE_CHARACTERS = 4 * 1024 * 1024;

export function createTranslationBatches(segments, service) {
    const maximumCharacters = service.maxCharactersPerRequest;
    const maximumParagraphs = service.maxParagraphsPerRequest;
    const chunks = segments.flatMap(segment => (
        splitTranslationSegment(segment, maximumCharacters)
    ));
    const batches = [];
    let batch = [];
    let characters = 0;
    for (const chunk of chunks) {
        const size = chunk.source.length;
        if (batch.length && (batch.length >= maximumParagraphs
            || characters + size > maximumCharacters)) {
            batches.push(batch);
            batch = [];
            characters = 0;
        }
        batch.push(chunk);
        characters += size;
    }
    if (batch.length) batches.push(batch);
    return { batches, chunks };
}

export function createTranslationRequest({
    service,
    targetLanguage,
    systemPrompt,
    documentTitle,
    segments,
}) {
    const prompt = String(systemPrompt || '')
        .replaceAll('{{targetLanguage}}', String(targetLanguage || ''));
    const userContent = JSON.stringify({
        documentTitle: String(documentTitle || '').slice(0, 500),
        targetLanguage,
        segments: segments.map(segment => ({
            id: segment.id,
            kind: segment.kind,
            headingPath: Array.isArray(segment.headingPath)
                ? segment.headingPath.slice(-6)
                : [],
            source: segment.source,
        })),
    });
    return {
        model: service.model,
        temperature: service.temperature,
        messages: [
            { role: 'system', content: `${prompt}\n\n${TRANSLATION_PROTOCOL_SUFFIX}` },
            { role: 'user', content: userContent },
        ],
    };
}

export function parseChatCompletionResponse(value, expectedSegments) {
    const content = value?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw invalidProtocolError('The service returned no translation content');
    }
    if (content.length > MAX_TRANSLATION_RESPONSE_CHARACTERS) {
        throw invalidProtocolError('The translation response is too large');
    }
    return parseTranslationOutput(content, expectedSegments);
}

export function parseTranslationOutput(content, expectedSegments) {
    const source = unwrapSingleJSONFence(String(content || '').trim());
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch {
        throw invalidProtocolError('The translation response is not valid JSON');
    }
    if (!Array.isArray(parsed?.translations)
        || parsed.translations.length !== expectedSegments.length) {
        throw invalidProtocolError('The translation response has the wrong size');
    }
    const expectedIDs = expectedSegments.map(segment => segment.id);
    const output = new Map();
    for (const [index, entry] of parsed.translations.entries()) {
        const expectedID = expectedIDs[index];
        if (entry?.id !== expectedID
            || typeof entry.text !== 'string'
            || !entry.text.trim()
            || entry.text.length > maximumOutputLength(
                expectedSegments[index].source.length
            )
            || output.has(entry.id)) {
            throw invalidProtocolError('The translation response is malformed');
        }
        output.set(entry.id, entry.text.trim());
    }
    return output;
}

function unwrapSingleJSONFence(value) {
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value);
    return match ? match[1] : value;
}

function maximumOutputLength(sourceLength) {
    return Math.min(500_000, Math.max(4000, sourceLength * 12 + 2000));
}

function invalidProtocolError(message) {
    const error = new Error(message);
    error.name = 'TranslationProtocolError';
    error.code = 'TRANSLATION_PROTOCOL_INVALID';
    return error;
}
