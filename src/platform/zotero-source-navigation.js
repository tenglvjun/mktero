import {
    isValidNormalizedSourceBBox,
    isValidSourceLocation,
} from '../core/markdown-source-map.js';

const DEFAULT_INITIALIZATION_TIMEOUT = 15_000;

export function createZoteroSourceNavigation(zotero, {
    delay = defaultDelay,
    now = () => Date.now(),
    initializationTimeout = DEFAULT_INITIALIZATION_TIMEOUT,
} = {}) {
    return {
        async open(itemID, location) {
            const attachment = zotero.Items.get(itemID);
            if (!attachment?.isPDFAttachment?.()) {
                throw new Error('PDF attachment is unavailable');
            }
            validateSourceLocation(location);
            if (typeof zotero.Reader?.open !== 'function') {
                throw new Error('PDF reader is unavailable');
            }

            const waitOptions = {
                delay,
                now,
                timeout: normalizedTimeout(initializationTimeout),
            };
            let reader = await zotero.Reader.open(itemID);
            if (!reader) {
                reader = await waitForValue(
                    () => zotero.Reader?._readers?.find(candidate => (
                        candidate?.itemID === itemID
                    )),
                    waitOptions
                );
            }
            await waitForPromise(reader?._initPromise, waitOptions);
            const view = await waitForValue(
                () => reader?._internalReader?._primaryView,
                waitOptions
            );
            await waitForPromise(view.initializedPromise, waitOptions);
            const viewport = await waitForValue(
                () => pageViewport(view, location.pageIndex),
                waitOptions
            );
            const rect = normalizedBBoxToPDFRect(location.bbox, viewport);
            if (typeof reader.navigate !== 'function') {
                throw new Error('PDF reader navigation is unavailable');
            }
            await reader.navigate({
                position: {
                    pageIndex: location.pageIndex,
                    rects: [rect],
                },
            });
        },
    };
}

export function normalizedBBoxToPDFRect(bbox, viewport) {
    if (!isValidNormalizedSourceBBox(bbox)
        || !Number.isFinite(viewport?.width)
        || viewport.width <= 0
        || !Number.isFinite(viewport?.height)
        || viewport.height <= 0
        || typeof viewport.convertToPdfPoint !== 'function') {
        throw new Error('PDF page geometry is unavailable');
    }
    const left = bbox[0] * viewport.width / 1000;
    const top = bbox[1] * viewport.height / 1000;
    const right = bbox[2] * viewport.width / 1000;
    const bottom = bbox[3] * viewport.height / 1000;
    const points = [
        viewport.convertToPdfPoint(left, top),
        viewport.convertToPdfPoint(right, top),
        viewport.convertToPdfPoint(right, bottom),
        viewport.convertToPdfPoint(left, bottom),
    ];
    if (!points.every(point => (
        Array.isArray(point)
        && point.length === 2
        && point.every(Number.isFinite)
    ))) {
        throw new Error('PDF page geometry is unavailable');
    }
    const xCoordinates = points.map(point => point[0]);
    const yCoordinates = points.map(point => point[1]);
    return [
        Math.min(...xCoordinates),
        Math.min(...yCoordinates),
        Math.max(...xCoordinates),
        Math.max(...yCoordinates),
    ];
}

function pageViewport(view, pageIndex) {
    try {
        return view?._iframeWindow
            ?.PDFViewerApplication
            ?.pdfViewer
            ?.getPageView?.(pageIndex)
            ?.viewport || null;
    }
    catch {
        return null;
    }
}

function validateSourceLocation(location) {
    if (!isValidSourceLocation(location)) {
        throw new Error('PDF source location is unavailable');
    }
}

async function waitForValue(read, options) {
    const startedAt = options.now();
    while (options.now() - startedAt <= options.timeout) {
        const value = read();
        if (value) return value;
        await options.delay(25);
    }
    throw new Error('PDF reader initialization timed out');
}

async function waitForPromise(promise, options) {
    let state = 'pending';
    let failure;
    Promise.resolve(promise).then(
        () => { state = 'fulfilled'; },
        error => {
            state = 'rejected';
            failure = error;
        }
    );
    await Promise.resolve();
    const startedAt = options.now();
    while (state === 'pending' && options.now() - startedAt <= options.timeout) {
        await options.delay(25);
    }
    if (state === 'rejected') throw failure;
    if (state === 'pending') {
        throw new Error('PDF reader initialization timed out');
    }
}

function normalizedTimeout(value) {
    return Number.isFinite(value)
        ? Math.max(1000, Math.min(value, 60_000))
        : DEFAULT_INITIALIZATION_TIMEOUT;
}

function defaultDelay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
