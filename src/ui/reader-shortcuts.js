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

// Single source of truth for the shortcut cheat-sheet panel. Each item pairs
// the platform's key rendering with the localization key for its label, so
// the panel's text and the actual handlers cannot drift apart. Labels use
// viewer.* keys; the panel renders them through the view's localization.
export function readerShortcutGroups({ isMac = false } = {}) {
    const history = navigationShortcutLabels({ isMac });
    return Object.freeze([
        Object.freeze({
            groupKey: 'viewer.shortcutsGroupNavigation',
            items: Object.freeze([
                Object.freeze({
                    keys: `${history.back} / ${history.forward}`,
                    labelKey: 'viewer.shortcutsHistory',
                }),
                Object.freeze({
                    keys: isMac ? '⌘F' : 'Ctrl+F',
                    labelKey: 'viewer.shortcutsFind',
                }),
                Object.freeze({
                    keys: isMac ? '⌘G' : 'F3',
                    labelKey: 'viewer.shortcutsFindNext',
                }),
            ]),
        }),
        Object.freeze({
            groupKey: 'viewer.shortcutsGroupJump',
            items: Object.freeze([
                Object.freeze({
                    keys: 'N / P',
                    labelKey: 'viewer.shortcutsJumpHeading',
                }),
                Object.freeze({
                    keys: 'Shift+N / Shift+P',
                    labelKey: 'viewer.shortcutsJumpFigure',
                }),
                Object.freeze({
                    // The Option key sets altKey. macOS labels it ⌥, not Alt.
                    keys: isMac ? '⌥N / ⌥P' : 'Alt+N / Alt+P',
                    labelKey: 'viewer.shortcutsJumpNote',
                }),
            ]),
        }),
    ]);
}
