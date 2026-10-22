import { ViewPlugin } from '@codemirror/view';

// CodeMirror sizes a rebuilt block widget from its estimatedHeight until it
// is measured again, and the default estimate is one line. A highlight in a
// figure caption or table cell rebuilds the whole block, so a tall block
// shrinks to one line in the height map. With the viewport deep inside that
// block, CodeMirror drops it from the rendered range, never measures it, and
// everything below moves up by the block's height. Remembering the last
// measured height lets the rebuilt widget keep its size.
const BLOCK_HEIGHT_LIMIT = 4096;

export function createBlockHeightMemory({ limit = BLOCK_HEIGHT_LIMIT } = {}) {
    const entries = new Map();
    return {
        estimate(identity) {
            const entry = identity ? entries.get(identity.key) : null;
            return entry && entry.signature === identity.signature
                ? entry.height
                : -1;
        },
        remember(identity, height) {
            if (!identity || !Number.isFinite(height) || height <= 0) return;
            entries.delete(identity.key);
            entries.set(identity.key, { signature: identity.signature, height });
            if (entries.size > limit) {
                entries.delete(entries.keys().next().value);
            }
        },
    };
}

// A block is the same block while it renders the same source from the same
// offset. Annotations, highlights, and render versions are left out on
// purpose: they rebuild the widget without changing its layout height.
export function createBlockHeightIdentity(kind, from, signature) {
    if (!kind || !Number.isSafeInteger(from) || typeof signature !== 'string') {
        return null;
    }
    return { key: `${kind}:${from}`, signature };
}

// Records heights from measure passes only. A transaction update may carry a
// block that was just rebuilt and still holds its estimate.
export function blockHeightRecorder(memory) {
    return ViewPlugin.define(() => ({
        update(update) {
            if (update.transactions.length
                || !(update.heightChanged
                    || update.geometryChanged
                    || update.viewportChanged)) {
                return;
            }
            for (const line of update.view.viewportLineBlocks) {
                for (const block of Array.isArray(line.type) ? line.type : [line]) {
                    const identity = block.widget?.blockHeightIdentity;
                    if (identity) memory.remember(identity, block.height);
                }
            }
        },
    }));
}

// CodeMirror only watches the scroller's size, so an image that decodes after
// a measure leaves the block's recorded height at its caption. A rebuilt block
// measured before its new image decodes would record that caption height too,
// and the next measure then pins the wrong block. Hold the remembered height
// until every image has settled, then measure the block again.
export function holdBlockHeightWhileImagesLoad(container, view, height) {
    const pending = new Set(
        [...(container?.querySelectorAll?.('img') || [])]
            .filter(image => !image.complete)
    );
    if (!pending.size) return;
    if (Number.isFinite(height) && height > 0) {
        container.style.minHeight = `${height}px`;
    }
    const settle = event => {
        if (!pending.delete(event.target)) return;
        if (!pending.size) {
            container.style.removeProperty('min-height');
            container.removeEventListener('load', settle, true);
            container.removeEventListener('error', settle, true);
        }
        if (container.isConnected) view.requestMeasure();
    };
    container.addEventListener('load', settle, true);
    container.addEventListener('error', settle, true);
}
