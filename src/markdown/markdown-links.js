// Markdown backslash escapes are syntax, not part of an HTTP URL. Keep this
// normalization shared by the HTML renderer and the editor's link opener so
// old cached Markdown remains usable after the serializer is fixed.
const MARKDOWN_LINK_ESCAPE_PATTERN = /\\([!-/:-@[-`{-~])/gu;

export function normalizeMarkdownLinkURL(value) {
    return String(value || '')
        .trim()
        .replace(MARKDOWN_LINK_ESCAPE_PATTERN, '$1')
        .replace(/[\u0000-\u001F\u007F]/gu, '');
}
