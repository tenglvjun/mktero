export function applyProgressiveFigureUpdate(presentation, event, {
    updateDocument,
    showRestoredFigure,
} = {}) {
    if (!presentation || presentation.closed || !event) return;
    if (event.type === 'document') {
        updateDocument?.(presentation, event);
        return;
    }
    if (event.type !== 'figure' || event.figure?.status !== 'composed' || !event.figure.crop) return;
    try {
        showRestoredFigure?.(presentation, event.figure);
    }
    catch {
        // The final document replaces a placeholder that could not be swapped.
    }
}
