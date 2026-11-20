export const RESEARCH_NOTE_TARGETS_PREF = 'extensions.mktero.researchNoteTargets';
export const RESEARCH_NOTE_TARGETS_DEFAULT = '{}';

const MAX_TARGETS = 256;
const MAX_PREFERENCE_LENGTH = 16 * 1024;
const NOTE_KEY_PATTERN = /^[A-Z0-9]{8}$/;
const LIBRARY_ID_PATTERN = /^[1-9]\d*$/;

// An invalid mapping is not partly restored: choosing the wrong note is worse
// than asking the reader to retry. No title or note content belongs here.
export function readResearchNoteTargets(zotero) {
    const raw = zotero?.Prefs?.get?.(RESEARCH_NOTE_TARGETS_PREF, true);
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'string' || raw.length > MAX_PREFERENCE_LENGTH) return null;
    try {
        const targets = JSON.parse(raw);
        if (!targets || Array.isArray(targets) || typeof targets !== 'object') return null;
        const entries = Object.entries(targets);
        if (entries.length > MAX_TARGETS || entries.some(([libraryID, key]) => (
            !validLibraryID(libraryID) || !validNoteKey(key)
        ))) return null;
        return Object.fromEntries(entries);
    }
    catch {
        return null;
    }
}

export function getResearchNoteTarget(zotero, libraryID) {
    assertLibraryID(libraryID);
    return requireTargets(zotero)[String(libraryID)] || null;
}

export function setResearchNoteTarget(zotero, libraryID, key) {
    assertLibraryID(libraryID);
    if (!validNoteKey(key)) throw new TypeError('A valid research note key is required');
    const targets = requireTargets(zotero);
    targets[String(libraryID)] = key;
    if (Object.keys(targets).length > MAX_TARGETS) {
        throw new Error('Research note targets exceed the library limit');
    }
    writeTargets(zotero, targets);
    return key;
}

export function clearResearchNoteTarget(zotero, libraryID) {
    assertLibraryID(libraryID);
    const targets = requireTargets(zotero);
    delete targets[String(libraryID)];
    writeTargets(zotero, targets);
}

export function observeResearchNoteTargets(zotero, onChange) {
    if (typeof zotero?.Prefs?.registerObserver !== 'function'
        || typeof onChange !== 'function') return () => {};
    const observer = zotero.Prefs.registerObserver(RESEARCH_NOTE_TARGETS_PREF, onChange, true);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        zotero.Prefs.unregisterObserver?.(observer);
    };
}

function requireTargets(zotero) {
    const targets = readResearchNoteTargets(zotero);
    if (!targets) throw new Error('Research note targets are unavailable');
    return targets;
}

function writeTargets(zotero, targets) {
    if (typeof zotero?.Prefs?.set !== 'function') {
        throw new Error('Research note preferences are unavailable');
    }
    zotero.Prefs.set(RESEARCH_NOTE_TARGETS_PREF, JSON.stringify(targets), true);
}

function validLibraryID(value) {
    return (typeof value === 'number' || typeof value === 'string')
        && LIBRARY_ID_PATTERN.test(String(value))
        && Number.isSafeInteger(Number(value));
}

function assertLibraryID(value) {
    if (!validLibraryID(value)) throw new TypeError('A positive library id is required');
}

function validNoteKey(value) {
    return typeof value === 'string' && NOTE_KEY_PATTERN.test(value);
}
