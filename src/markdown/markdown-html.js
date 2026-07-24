import { Marked } from 'marked';

export function renderMarkdownHTML(markdown, { resolveImageURL = () => null } = {}) {
    if (typeof markdown !== 'string') {
        throw new TypeError('Markdown must be a string');
    }

    const renderer = createSafeRenderer(resolveImageURL);
    const parser = new Marked({
        gfm: true,
        renderer,
        extensions: [mathBlockExtension],
    });
    return parser.parse(markdown);
}

function createSafeRenderer(resolveImageURL) {
    return {
        html({ text }) {
            const page = text.trim().match(/^<!--\s*zotero-page:\s*(.*?)\s*-->$/);
            if (page) {
                return `<span class="page-marker" data-page="${escapeAttribute(page[1])}">Page ${escapeHTML(page[1])}</span>`;
            }
            return escapeKnownInlineTags(escapeHTML(text));
        },

        link({ href, tokens }) {
            const label = this.parser.parseInline(tokens);
            const safeHref = safeLinkURL(href);
            if (!safeHref) return label;
            return `<a href="${escapeAttribute(safeHref)}" rel="noreferrer">${label}</a>`;
        },

        image({ href, title, text, tokens }) {
            const alt = tokens
                ? this.parser.parseInline(tokens, this.parser.textRenderer)
                : text;
            const resolved = resolveImageURL(href);
            if (!resolved || !String(resolved).startsWith('blob:')) {
                return `<span class="missing-image">${escapeHTML(alt || 'Image')}</span>`;
            }
            const titleAttribute = title
                ? ` title="${escapeAttribute(title)}"`
                : '';
            return `<img src="${escapeAttribute(resolved)}" alt="${escapeAttribute(alt)}"${titleAttribute}>`;
        },
    };
}

const mathBlockExtension = {
    name: 'mkteroMathBlock',
    level: 'block',
    start(source) {
        return source.match(/^\$\$/m)?.index;
    },
    tokenizer(source) {
        const match = /^\$\$[ \t]*\n([\s\S]*?)\n\$\$(?:\n|$)/.exec(source);
        if (!match) return undefined;
        return {
            type: 'mkteroMathBlock',
            raw: match[0],
            text: match[1],
        };
    },
    renderer(token) {
        return `<div class="math"><code>${escapeHTML(token.text)}</code></div>\n`;
    },
};

function safeLinkURL(value) {
    const url = String(value || '').trim();
    if (/^https?:\/\//i.test(url) || /^zotero:\/\//i.test(url) || url.startsWith('#')) {
        return url.replace(/[\u0000-\u001F\u007F]/g, '');
    }
    return null;
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
    return escapeHTML(value).replace(/[\u0000-\u001F\u007F]/g, '');
}

function escapeKnownInlineTags(value) {
    return value
        .replace(/&lt;(br|sup|sub)&gt;/gi, '<$1>')
        .replace(/&lt;\/(br|sup|sub)&gt;/gi, '</$1>');
}
