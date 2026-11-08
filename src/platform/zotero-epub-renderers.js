import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { createZoteroFigureCanvasEnvironment } from './zotero-figure-canvas.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_TABLE_WIDTH = 2_200;
const MAX_TABLE_HEIGHT = 10_000;
const TABLE_PADDING = 12;

const TABLE_CSS = [
    'table{border-collapse:collapse;border-spacing:0;width:max-content;max-width:2200px;table-layout:auto;background:#fff;color:#111;font:18px Georgia,"Times New Roman",serif}',
    'caption{caption-side:top;text-align:left;font-weight:700;padding:8px 4px}',
    'th,td{border:1px solid #555;padding:6px 9px;vertical-align:top;max-width:380px;overflow-wrap:anywhere;white-space:normal}',
    'th{background:#eee;font-weight:700}',
    'p{margin:0}',
].join('\n');

export function createZoteroEpubRenderers(zotero, { services } = {}) {
    const canvasEnvironment = createZoteroFigureCanvasEnvironment(zotero, { services });
    return Object.freeze({
        renderWideTable: options => renderWideTable(canvasEnvironment, options),
        renderImageToPNG: options => renderImageToPNG(canvasEnvironment, options),
        renderMathToPNG: options => renderMathToPNG(canvasEnvironment, options),
    });
}

async function renderImageToPNG(environment, { data, mimeType } = {}) {
    if (!data?.byteLength || data.byteLength > 25 * 1024 * 1024
        || typeof mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/iu.test(mimeType)) {
        throw new Error('The EPUB image resource is invalid');
    }
    // Figure recovery's decoder deliberately accepts only PNG/JPEG. EPUB also
    // needs browser-supported formats such as WebP without changing that path.
    const view = environment.ownerDocument.defaultView;
    if (typeof view?.createImageBitmap !== 'function' || !view.Blob) {
        throw new Error('The EPUB image decoder is unavailable');
    }
    const bitmap = await view.createImageBitmap(new view.Blob([data], { type: mimeType }));
    const decoded = {
        image: bitmap, width: bitmap.width, height: bitmap.height,
        close: () => bitmap.close(),
    };

    let canvas;
    try {
        if (!decoded.width || !decoded.height
            || decoded.width * decoded.height > FIGURE_LIMITS.maxDecodedImagePixels) {
            throw new Error('The EPUB image exceeds the decoding limit');
        }
        const scale = rasterScale(decoded.width, decoded.height, 1);
        const width = Math.max(1, Math.floor(decoded.width * scale));
        const height = Math.max(1, Math.floor(decoded.height * scale));
        canvas = environment.createCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('The EPUB image canvas is unavailable');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, width, height);
        context.drawImage(decoded.image, 0, 0, width, height);
        return { mimeType: 'image/png', data: await environment.encodePNG(canvas) };
    }
    finally {
        if (canvas) canvas.width = canvas.height = 0;
        decoded.close();
    }
}

const TABLE_HTML_TAGS = new Set([
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'sub', 'sup', 'code', 'pre',
    'span', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr', 'div', 'img',
]);
const TABLE_MATH_TAGS = new Set([
    'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace',
    'ms', 'mfrac', 'msqrt', 'mroot', 'msup', 'msub', 'msubsup', 'mover', 'munder',
    'munderover', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'mmultiscripts', 'mprescripts',
    'none', 'menclose', 'mstyle', 'merror', 'mphantom', 'mpadded',
]);
const TABLE_ACTIVE_CONTENT_TAGS = new Set([
    'base', 'embed', 'iframe', 'link', 'meta', 'object', 'script', 'style',
]);
const TABLE_ATTRIBUTES = new Set([
    'class', 'id', 'title', 'role', 'aria-hidden', 'aria-label', 'xmlns',
    'colspan', 'rowspan', 'span', 'scope', 'align', 'width', 'height', 'alt',
    'accent', 'accentunder', 'bevelled', 'close', 'columnalign', 'columnlines',
    'columnspacing', 'columnspan', 'denomalign', 'depth', 'dir', 'display',
    'displaystyle', 'encoding', 'equalcolumns', 'equalrows', 'fence', 'form',
    'frame', 'framespacing', 'linethickness', 'lspace', 'mathbackground', 'mathcolor',
    'mathsize', 'mathvariant', 'maxsize', 'minsize', 'movablelimits', 'notation',
    'numalign', 'open', 'rowalign', 'rowlines', 'rowspacing', 'rspace', 'scriptlevel',
    'scriptminsize', 'scriptsizemultiplier', 'separator', 'separators', 'stretchy',
    'subscriptshift', 'supscriptshift', 'symmetric', 'voffset',
]);

async function prepareTableElement(environment, html, assets) {
    const document = environment.ownerDocument;
    // Template contents are inert: URLs and event handlers cannot run while
    // markup is inspected. Only the validated table is adopted into Zotero.
    // A Zotero XUL/XHTML document uses XML fragment parsing. Parse ordinary
    // HTML void tags in an inert HTML document before adopting the table.
    const parsingDocument = document.implementation.createHTMLDocument('');
    const template = parsingDocument.createElementNS(XHTML_NAMESPACE, 'template');
    template.innerHTML = html;
    const table = template.content.firstElementChild;
    if (template.content.children.length !== 1 || table?.localName !== 'table') {
        throw new Error('The wide EPUB table is missing');
    }
    const localAssets = new Map(assets.map(asset => ['../' + asset.path, asset]));
    const embeddedURLs = new Map();
    let embeddedBytes = 0;
    for (const element of [table, ...table.querySelectorAll('*')]) {
        const tags = element.namespaceURI === XHTML_NAMESPACE
            ? TABLE_HTML_TAGS
            : element.namespaceURI === 'http://www.w3.org/1998/Math/MathML'
                ? TABLE_MATH_TAGS : null;
        if (!tags?.has(element.localName)) {
            if (element.namespaceURI !== XHTML_NAMESPACE
                || TABLE_ACTIVE_CONTENT_TAGS.has(element.localName)) {
                element.remove();
            }
            else {
                element.replaceWith(...element.childNodes);
            }
            continue;
        }
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            if ((name === 'href' || name === 'rel')
                && element.localName === 'a') {
                element.removeAttributeNode(attribute);
                continue;
            }
            if (name === 'src' && element.localName === 'img') continue;
            if (name === 'style' && /^\s*text-align\s*:\s*(left|right|center)\s*;?\s*$/iu.test(attribute.value)) continue;
            if (!TABLE_ATTRIBUTES.has(name)) {
                element.removeAttributeNode(attribute);
            }
        }
        if (element.localName !== 'img') continue;
        const source = element.getAttribute('src');
        const asset = localAssets.get(source);
        if (!asset) throw new Error('The EPUB table image is not an available local asset');
        let embedded = embeddedURLs.get(source);
        if (!embedded) {
            const png = await renderImageToPNG(environment, asset);
            let binary = '';
            for (let offset = 0; offset < png.data.length; offset += 8192) {
                binary += String.fromCharCode(...png.data.subarray(offset, offset + 8192));
            }
            embedded = { size: png.data.byteLength, url: 'data:image/png;base64,' + document.defaultView.btoa(binary) };
            embeddedURLs.set(source, embedded);
        }
        embeddedBytes += embedded.size;
        if (embeddedBytes > 25 * 1024 * 1024) {
            throw new Error('The EPUB table images exceed the rendering size limit');
        }
        element.setAttribute('src', embedded.url);
    }
    return table;
}

async function renderMathToPNG(environment, { html } = {}) {
    if (typeof html !== 'string' || html.length > 250_000 || /<!/u.test(html)) {
        throw new Error('The EPUB formula is invalid');
    }
    const document = environment.ownerDocument;
    const view = document.defaultView;
    const parsed = new view.DOMParser().parseFromString(html, 'application/xml');
    const math = parsed.documentElement;
    if (math.localName !== 'math'
        || math.namespaceURI !== 'http://www.w3.org/1998/Math/MathML') {
        throw new Error('The EPUB formula is invalid');
    }
    for (const element of [math, ...math.querySelectorAll('*')]) {
        if (element.namespaceURI !== math.namespaceURI
            || !TABLE_MATH_TAGS.has(element.localName)
            || [...element.attributes].some(attribute => !TABLE_ATTRIBUTES.has(attribute.name))) {
            throw new Error('The EPUB formula contains unsupported markup');
        }
    }
    for (const annotation of math.querySelectorAll('annotation')) annotation.remove();
    const fontSize = 24;
    const padding = 4;
    const wrapper = document.createElementNS(XHTML_NAMESPACE, 'div');
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden';
    const shadow = wrapper.attachShadow({ mode: 'closed' });
    const content = document.createElementNS(XHTML_NAMESPACE, 'span');
    const css = 'display:inline-block;white-space:nowrap;font:24px "Times New Roman",serif;line-height:normal;color:#111';
    content.style.cssText = css;
    const baseline = document.createElementNS(XHTML_NAMESPACE, 'span');
    baseline.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0';
    // Keep the line box identical in HTML, XHTML, and the SVG foreignObject.
    content.append('\u200b', document.importNode(math, true), baseline);
    shadow.append(content);
    (document.body || document.documentElement).append(wrapper);
    let canvas;
    let decoded;
    try {
        await document.fonts?.ready;
        const rect = content.getBoundingClientRect();
        const baselineY = baseline.getBoundingClientRect().top;
        const width = Math.ceil(rect.width) + padding * 2;
        const height = Math.ceil(rect.height) + padding * 2;
        if (!Number.isFinite(width) || !Number.isFinite(height)
            || width < 1 || height < 1 || width > 10_000 || height > 10_000
            || width * height > FIGURE_LIMITS.maxDecodedImagePixels) {
            throw new Error('The EPUB formula exceeds the rendering size limit');
        }
        const markup = new view.XMLSerializer().serializeToString(content);
        const foreignObject = `<div xmlns="${XHTML_NAMESPACE}" style="box-sizing:border-box;display:flex;align-items:flex-start;width:${width}px;height:${height}px;padding:${padding}px;background:#fff">${markup}</div>`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="100%" height="100%">${foreignObject}</foreignObject></svg>`;
        decoded = await decodeSVGImage(view, svg);
        const scale = rasterScale(width, height, 2);
        const pixelWidth = Math.max(1, Math.ceil(width * scale));
        const pixelHeight = Math.max(1, Math.ceil(height * scale));
        canvas = environment.createCanvas(pixelWidth, pixelHeight);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('The EPUB formula canvas is unavailable');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, pixelWidth, pixelHeight);
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.drawImage(decoded.image, 0, 0, width, height);
        return {
            mimeType: 'image/png',
            data: await environment.encodePNG(canvas),
            width: width / fontSize,
            height: height / fontSize,
            verticalAlign: -(rect.bottom - baselineY + padding) / fontSize,
        };
    }
    finally {
        wrapper.remove();
        if (canvas) canvas.width = canvas.height = 0;
        decoded?.close();
    }
}

async function renderWideTable(environment, { html, alt = '', assets = [] } = {}) {
    if (typeof html !== 'string' || !/<table\b/iu.test(html)) {
        throw new Error('The wide EPUB table is invalid');
    }
    const document = environment.ownerDocument;
    const view = document.defaultView;
    const parent = document.body || document.documentElement;
    if (!parent || !view?.Image || !view?.XMLSerializer) {
        throw new Error('The EPUB table renderer is unavailable');
    }

    const wrapper = document.createElementNS(XHTML_NAMESPACE, 'div');
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.style.cssText = [
        'position:fixed', 'left:-100000px', 'top:0', 'z-index:-1',
        'visibility:hidden', 'display:block', `width:${MAX_TABLE_WIDTH}px`,
        'max-width:none', 'margin:0', 'padding:0', 'overflow:visible',
    ].join(';');
    // Measure with the same isolated styles used in the SVG. Host-page styles
    // must neither change the dimensions nor leak out of this temporary tree.
    const shadow = wrapper.attachShadow({ mode: 'closed' });
    const style = document.createElementNS(XHTML_NAMESPACE, 'style');
    style.textContent = TABLE_CSS;
    const table = await prepareTableElement(environment, html, assets);
    shadow.append(style, table);
    parent.append(wrapper);

    let canvas;
    let decoded;
    try {
        await Promise.all([...table.querySelectorAll('img')].map(image => image.decode()));
        void table.offsetWidth;
        const rect = table.getBoundingClientRect();
        const width = Math.ceil(Math.max(rect.width, table.scrollWidth, 320))
            + TABLE_PADDING * 2;
        const height = Math.ceil(Math.max(rect.height, table.scrollHeight, 120))
            + TABLE_PADDING * 2;
        if (width > MAX_TABLE_HEIGHT || height > MAX_TABLE_HEIGHT
            || width * height > FIGURE_LIMITS.maxDecodedImagePixels) {
            throw new Error('The EPUB table exceeds the rendering size limit');
        }
        const markup = new view.XMLSerializer().serializeToString(table);
        const foreignObject = `<div xmlns="${XHTML_NAMESPACE}" style="box-sizing:border-box;width:${width}px;min-height:${height}px;padding:${TABLE_PADDING}px;background:#fff"><style type="text/css">${TABLE_CSS}</style>${markup}</div>`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="100%" height="100%">${foreignObject}</foreignObject></svg>`;
        decoded = await decodeSVGImage(view, svg);
        const scale = rasterScale(width, height, 2);
        const pixelWidth = Math.max(1, Math.ceil(width * scale));
        const pixelHeight = Math.max(1, Math.ceil(height * scale));
        canvas = environment.createCanvas(pixelWidth, pixelHeight);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('The EPUB table canvas is unavailable');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, pixelWidth, pixelHeight);
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.drawImage(decoded.image, 0, 0, width, height);
        const data = await environment.encodePNG(canvas);
        return { mimeType: 'image/png', data, alt: String(alt || '') };
    }
    finally {
        wrapper.remove();
        if (canvas) canvas.width = canvas.height = 0;
        decoded?.close();
    }
}

function rasterScale(width, height, preferredScale) {
    if (!Number.isFinite(width) || !Number.isFinite(height)
        || width < 1 || height < 1) {
        throw new Error('The EPUB raster dimensions are invalid');
    }
    const pixelLimit = FIGURE_LIMITS.maxIntermediateCanvasPixels;
    const edgeLimit = FIGURE_LIMITS.maxIntermediateCanvasEdge;
    return Math.min(
        preferredScale,
        Math.sqrt(pixelLimit / (width * height)),
        edgeLimit / width,
        edgeLimit / height
    );
}

async function decodeSVGImage(view, source) {
    // A Blob URL containing foreignObject taints the canvas in Chromium. A
    // self-contained data URL keeps this local SVG safe to encode as PNG.
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    const image = new view.Image();
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        image.onload = image.onerror = null;
        image.removeAttribute('src');
    };
    try {
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('The EPUB SVG could not be decoded'));
            image.src = url;
        });
        if (!image.naturalWidth || !image.naturalHeight) {
            throw new Error('The EPUB SVG has no renderable dimensions');
        }
        return { image, close };
    }
    catch (error) {
        close();
        throw error;
    }
}
