export const MKTERO_RELEASE_API_BASE = 'https://api.mktero.com';
export const MKTERO_DEBUG_API_BASE = 'http://127.0.0.1:8080';

export function mkteroBuild() {
    return typeof __MKTERO_BUILD__ === 'string' ? __MKTERO_BUILD__ : 'debug';
}

export function isDebugBuild() {
    return mkteroBuild() !== 'release';
}
