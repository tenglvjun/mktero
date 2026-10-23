// Key matchers for the reader's landmark jumps and the shortcut cheat sheet.
// Pure predicate functions over KeyboardEvent-like objects so both the view
// wiring and the tests can call them without a live editor.

function hasPlainModifiers(event) {
    return !event.altKey && !event.ctrlKey && !event.metaKey;
}

// '?' is Shift+/. Matching by key keeps non-US layouts working: a layout can
// move '/' but '?' still reports '?' on the unmodified plane.
export function isShortcutsPanelShortcut(event) {
    return String(event.key || '') === '?'
        && hasPlainModifiers(event)
        && !event.isComposing;
}

export function isNextHeadingShortcut(event) {
    return isLetterKey(event, 'n') && !event.shiftKey && !event.altKey;
}

export function isPreviousHeadingShortcut(event) {
    return isLetterKey(event, 'p') && !event.shiftKey && !event.altKey;
}

export function isNextAssetShortcut(event) {
    return isLetterKey(event, 'n') && event.shiftKey && !event.altKey;
}

export function isPreviousAssetShortcut(event) {
    return isLetterKey(event, 'p') && event.shiftKey && !event.altKey;
}

// Alt+letters stay clear of AltGr (Ctrl+Alt on Windows): Ctrl must not be
// held. Shift and Meta also disqualify — Shift changes the meaning, and
// Cmd+letter is a platform shortcut plane.
export function isNextNoteShortcut(event) {
    return isLetterKey(event, 'n')
        && event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey;
}

export function isPreviousNoteShortcut(event) {
    return isLetterKey(event, 'p')
        && event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey;
}

// Matched by position as well as by character, like the history chord: a
// layout or an input method can report a different `key` for the same
// physical press. Shift, Ctrl and Meta are decided by each caller — the
// shiftKey check cannot live here, because Shift+N reports code KeyN too.
function isLetterKey(event, letter) {
    if (event.isComposing) return false;
    if (event.ctrlKey || event.metaKey) return false;
    const key = String(event.key || '').toLowerCase();
    const code = String(event.code || '');
    return key === letter || code === `Key${letter.toUpperCase()}`;
}

// Physical-key matching reports Shift+N as KeyN too, so each matcher owns
// its shiftKey and altKey decision instead: headings take the bare plane,
// figures take Shift, notes take Alt.

// Ctrl+C, or Cmd+C on macOS. Matched by position as well as by character so a
// non-Latin layout still counts; Ctrl+Shift+C is Zotero's own copy command.
export function isCopyShortcut(event, { isMac = false } = {}) {
    if (event.isComposing || event.repeat) return false;
    if (event.altKey || event.shiftKey) return false;
    const accel = isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
    if (!accel) return false;
    const key = String(event.key || '').toLowerCase();
    return key === 'c' || String(event.code || '') === 'KeyC';
}
