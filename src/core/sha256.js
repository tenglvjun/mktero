import { toUint8Array } from '../mineru/binary.js';

export async function sha256Hex(value, { crypto = globalThis.crypto } = {}) {
    if (!crypto?.subtle?.digest) {
        throw new Error('SHA-256 is unavailable in this runtime');
    }
    const bytes = toUint8Array(value, 'SHA-256 input');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
