// Entry point for the iOS document-preparation bundle.
//
// The app downloads MinerU's original result archive, and `full.md` in it is the
// provider's own reading of the page: the running header on every page, the page
// numbers, the two columns of a two-column paper read left-to-right as one
// stream, and a caption attached to whichever image MinerU happened to emit
// first. The extension does not render that file. It rebuilds a document IR from
// the archive's `layout.json` (`*_middle.json` for the open-source CLI, or
// `*_content_list.json` when there is no layout), orders the blocks the way the
// page is read, drops repeated page chrome, infers heading levels, merges
// continued tables, and only then writes Markdown.
//
// This bundle is that pipeline, and nothing else: it has no DOM if the caller
// passes no PDF text, no Zotero, and no network, so JavaScriptCore can run it
// without a WebView.
//
// It exposes one global:
//
//   MkteroDocument.prepare({ markdown, layout, contentList, assets })
//       -> { markdown, structured }
//
// `layout` is the raw `pdf_info` document from the archive, as text or as an
// object. `contentList` is the raw `*_content_list.json` array, used only when
// the layout is missing. Passing neither keeps the provider's `full.md`, which
// is what a result without structure gets.
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { prepareMinerUDocument } from '../src/mineru/document/prepare.js';

/** Parses a JSON argument that may arrive as text, an object, or nothing. */
function parseJSON(value) {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    return value ?? null;
}

/**
 * Rewrites an archive's Markdown with the document IR.
 *
 * `assets` is the list of `{ path }` entries the archive provided, in the same
 * shape the figure pipeline expects: it is what lets a figure block resolve its
 * image. The bytes never cross this boundary; the app serves them by path.
 *
 * Returns `{ markdown, structured }`. `structured` is false when the archive had
 * no usable layout or content list, in which case the input Markdown is returned
 * unchanged — a document MinerU could not structure is still readable, just not
 * reordered.
 */
function prepare({ markdown, layout, contentList, assets } = {}) {
    const source = typeof markdown === 'string' ? markdown : '';
    const assetList = Array.isArray(assets) ? assets : [];

    let projected = null;
    try {
        // The archive holds MinerU's own `pdf_info`; every field the pipeline
        // reads is validated here, and an unusable layout comes back null.
        const raw = parseJSON(layout);
        projected = raw ? projectMinerULayout(raw) : null;
    }
    catch {
        projected = null;
    }

    const parsedContentList = parseJSON(contentList);
    const hasContentList = Array.isArray(parsedContentList) && parsedContentList.length > 0;
    // An empty layout projects to a valid document with no pages, and the writer
    // then produces an empty Markdown string. That is a blank page, not a
    // reading order, so a structure with nothing in it is treated as no
    // structure at all.
    const hasPages = Boolean(projected && Array.isArray(projected.pages) && projected.pages.length);
    if (!hasPages && !hasContentList) {
        return { markdown: source, structured: false };
    }

    try {
        const bundle = {
            markdown: source,
            assets: assetList,
            assetBasePath: '',
            ...(hasPages ? { layout: projected } : {}),
            ...(hasContentList ? { contentList: parsedContentList } : {}),
        };
        const prepared = prepareMinerUDocument(bundle, {
            // The PDF text layer corrects words MinerU misread, but reading the
            // PDF is the extension's job and the app has no PDF view. Skipping it
            // changes no structure: ordering, chrome removal and heading levels
            // all run from the layout alone.
            pdfText: null,
        });
        const rewritten = typeof prepared?.markdown === 'string' ? prepared.markdown : source;
        // A pipeline that produced nothing left the document unreadable; the
        // provider's own text is still a readable paper.
        if (!rewritten.trim()) {
            return { markdown: source, structured: false };
        }
        return {
            markdown: rewritten,
            structured: prepared?.documentStructure === 'mineru-ir-v1',
        };
    }
    catch (error) {
        // A pipeline failure must not lose the document: the provider's own
        // Markdown is still readable.
        return {
            markdown: source,
            structured: false,
            error: String(error && error.message || error),
        };
    }
}

globalThis.MkteroDocument = {
    version: __MKTERO_VERSION__,
    prepare,
};
