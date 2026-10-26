const SECRET_QUERY_KEY = /^(?:token|access_token|refresh_token|id_token|api_key|apikey|key|password|signature|sig)$/i;
const PRESIGN_QUERY_KEY = /^x-amz-/i;
const BEARER = /\bBearer\s+\S+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PROVIDER_KEY = /\b(?:sk|rk|pk|ak)-[A-Za-z0-9_-]{8,}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UNIX_HOME = /\/(?:Users|home)\/[^/\s]+/g;
const WINDOWS_HOME = /([A-Za-z]:\\Users\\)[^\\]+/g;
const FILE_URL = /\bfile:\/\/\S+/gi;
const ASSIGNED_SECRET = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|authorization|secret|password)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;
const URL_TEXT = /\bhttps?:\/\/[^\s<>"']+/gi;

// redactDiagnosticText removes credentials, presigned URLs, emails, and home
// directories from text that may later be copied out of Zotero. It keeps job
// ids, item keys, and ordinary error text.
export function redactDiagnosticText(value) {
    const text = typeof value === 'string'
        ? value
        : value == null ? '' : String(value);
    return text
        .replace(FILE_URL, '[redacted-path]')
        .replace(URL_TEXT, redactUrl)
        .replace(BEARER, 'Bearer [redacted]')
        .replace(JWT, '[redacted-jwt]')
        .replace(PROVIDER_KEY, '[redacted-key]')
        .replace(ASSIGNED_SECRET, '$1$2[redacted]')
        .replace(EMAIL, '[redacted-email]')
        .replace(UNIX_HOME, home => (
            home.startsWith('/Users/') ? '/Users/[user]' : '/home/[user]'
        ))
        .replace(WINDOWS_HOME, '$1[user]');
}

function redactUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return url;
    }
    const presigned = [...parsed.searchParams.keys()].some(key => (
        PRESIGN_QUERY_KEY.test(key)
        || SECRET_QUERY_KEY.test(key)
        || /signature|credential|token/i.test(key)
    ));
    if (presigned) {
        return `${parsed.origin}${parsed.pathname}?[redacted-url]`;
    }
    if (parsed.username || parsed.password) {
        parsed.username = '';
        parsed.password = '';
        parsed.hash = '';
        return parsed.toString();
    }
    return url;
}
