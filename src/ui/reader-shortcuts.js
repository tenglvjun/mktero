// The reader accepts the history chord of both platforms: Alt+Arrow, which
// browsers use on Windows and Linux, and Cmd+bracket, which they use on macOS.
// The hint names the one this platform's users expect; the other still works.
const MAC_SHORTCUTS = Object.freeze({
    back: '⌘[',
    forward: '⌘]',
});
const DEFAULT_SHORTCUTS = Object.freeze({
    back: 'Alt+←',
    forward: 'Alt+→',
});

export function navigationShortcutLabels({ isMac = false } = {}) {
    return isMac ? MAC_SHORTCUTS : DEFAULT_SHORTCUTS;
}
