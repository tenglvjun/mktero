export function hoverReference(window, element, init = {}) {
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    const scheduled = new Map();
    const intercepted = new Set();
    const eventInit = {
        bubbles: true,
        buttons: 0,
        clientX: 20,
        clientY: 20,
        ...init,
    };
    window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 450) {
            return originalSetTimeout.call(window, callback, delay, ...args);
        }
        const timerID = Symbol('reference-hover');
        intercepted.add(timerID);
        scheduled.set(timerID, () => callback.apply(window, args));
        return timerID;
    };
    window.clearTimeout = timerID => {
        if (intercepted.has(timerID)) {
            scheduled.delete(timerID);
        }
        else {
            originalClearTimeout.call(window, timerID);
        }
    };
    try {
        element.dispatchEvent(new window.MouseEvent('mouseover', eventInit));
        element.dispatchEvent(new window.MouseEvent('mousemove', eventInit));
        for (const [timerID, callback] of scheduled) {
            scheduled.delete(timerID);
            callback();
        }
    }
    finally {
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
    }
}
