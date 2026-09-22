export const DEFAULT_MINERU_LOCAL_API_BASE = 'http://127.0.0.1:8000';
export const MINERU_LOCAL_TIER = 'standard';
export const MINERU_LOCAL_OCR_MODE = 'auto';

const MAX_BASE_LENGTH = 2_048;
const METADATA_HOSTS = new Set([
    'metadata.google.internal',
    'metadata.google.com',
]);

export function normalizeMinerULocalApiBase(value) {
    const source = String(value ?? '').trim();
    if (!source || source.length > MAX_BASE_LENGTH || hasControls(source)) {
        throw endpointError();
    }
    let url;
    try {
        url = new URL(source);
    }
    catch {
        throw endpointError();
    }
    if (url.username || url.password || url.search || url.hash) throw endpointError();
    if (url.pathname !== '/' && url.pathname !== '') throw endpointError();
    const host = stripBrackets(url.hostname);
    if (!host || host.includes('%') || isBlockedHost(host)) throw endpointError();
    if (url.protocol === 'http:') {
        if (!isLoopbackHost(host) && !isPrivateAddress(host)) throw endpointError();
    }
    else if (url.protocol !== 'https:') {
        throw endpointError();
    }
    return trimTrailingSlash(url.toString());
}

export function resolveMinerUURL(current, target) {
    if (typeof current !== 'string' || typeof target !== 'string'
        || !current || !target || hasControls(target)) {
        throw rejectedURL();
    }
    let resolved;
    try {
        resolved = new URL(target, current);
    }
    catch {
        throw rejectedURL();
    }
    const host = stripBrackets(resolved.hostname);
    if (resolved.username || resolved.password
        || (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')
        || !host || host.includes('%') || isBlockedHost(host)) {
        throw rejectedURL();
    }
    return resolved.toString();
}

export function isSameMinerUOrigin(left, right) {
    try {
        return originOf(left) === originOf(right);
    }
    catch {
        return false;
    }
}

function originOf(value) {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
}

function endpointError() {
    const error = new Error('The local MinerU address is invalid');
    error.code = 'MINERU_LOCAL_ENDPOINT_INVALID';
    return error;
}

function rejectedURL() {
    const error = new Error('The MinerU service URL was rejected');
    error.code = 'MINERU_LOCAL_URL_REJECTED';
    return error;
}

function isBlockedHost(host) {
    if (METADATA_HOSTS.has(host) || host.endsWith('.metadata.google.internal')) {
        return true;
    }
    const octets = ipv4Octets(host) || mappedIPv4(host);
    if (octets) {
        return octets[0] === 0
            || octets[0] === 169 && octets[1] === 254
            || octets.every(value => value === 255);
    }
    return isIPv6LinkLocal(host) || host === '::' || host === '0:0:0:0:0:0:0:0';
}

function isLoopbackHost(host) {
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    const octets = ipv4Octets(host) || mappedIPv4(host);
    return Boolean(octets) && octets[0] === 127;
}

function isPrivateAddress(host) {
    const octets = ipv4Octets(host) || mappedIPv4(host);
    if (octets) {
        const [first, second] = octets;
        return first === 10
            || first === 192 && second === 168
            || first === 172 && second >= 16 && second <= 31;
    }
    return isIPv6UniqueLocal(host);
}

function ipv4Octets(host) {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    if (parts.some(part => !/^\d{1,3}$/.test(part))) return null;
    const octets = parts.map(part => Number(part));
    if (octets.some(value => value > 255)) return null;
    return octets;
}

function mappedIPv4(host) {
    const match = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    return match ? ipv4Octets(match[1]) : null;
}

function isIPv6UniqueLocal(host) {
    return /^f[cd][0-9a-f]{0,2}:/i.test(host);
}

function isIPv6LinkLocal(host) {
    return /^fe[89ab][0-9a-f]?:/i.test(host);
}

function stripBrackets(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    return host.startsWith('[') && host.endsWith(']')
        ? host.slice(1, -1)
        : host;
}

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function hasControls(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}
