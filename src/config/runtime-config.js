export const MKTERO_RELEASE_API_BASE = 'https://api.mktero.com';
export const MKTERO_DEBUG_API_BASE = 'http://127.0.0.1:8080';
export const MKTERO_RELEASE_SITE_BASE = 'https://mktero.com';
export const MKTERO_DEBUG_SITE_BASE = 'http://127.0.0.1:4173';

export function mkteroBuild() {
    return typeof __MKTERO_BUILD__ === 'string' ? __MKTERO_BUILD__ : 'debug';
}

export function isDebugBuild() {
    return mkteroBuild() !== 'release';
}

// mkteroVersion reports this extension's own version to the Mktero account API
// as operations telemetry, so the service can tell which builds are still in
// the field. esbuild injects __MKTERO_VERSION__ from manifest.json in
// scripts/build.mjs; source that is imported directly rather than bundled, as
// in the tests, reports 'dev'.
export function mkteroVersion() {
    return typeof __MKTERO_VERSION__ === 'string' && __MKTERO_VERSION__
        ? __MKTERO_VERSION__
        : 'dev';
}
