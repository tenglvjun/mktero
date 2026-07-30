import { createLocalization } from '../i18n/localization.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

export function createImagePreview(parent, {
    localization = createLocalization(),
} = {}) {
    const document = parent.ownerDocument;
    const ownerWindow = document.defaultView;
    const t = localization.t.bind(localization);
    let dialog = null;
    let image = null;
    let scaleOutput = null;
    let zoomOutButton = null;
    let zoomInButton = null;
    let previousFocus = null;
    let isolatedElements = [];
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let drag = null;

    const renderTransform = () => {
        if (!image) return;
        image.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
        scaleOutput.textContent = `${Math.round(scale * 100)}%`;
        zoomOutButton.disabled = scale <= MIN_SCALE;
        zoomInButton.disabled = scale >= MAX_SCALE;
    };

    const stopDragging = () => {
        drag = null;
        image?.classList.remove('is-dragging');
    };

    const onMouseMove = event => {
        if (!drag) return;
        translateX = drag.translateX + event.clientX - drag.clientX;
        translateY = drag.translateY + event.clientY - drag.clientY;
        renderTransform();
    };

    const onMouseUp = () => stopDragging();

    const restoreBackground = () => {
        for (const state of isolatedElements) {
            if (state.hadInert) state.element.setAttribute('inert', '');
            else state.element.removeAttribute('inert');
            if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden');
            else state.element.setAttribute('aria-hidden', state.ariaHidden);
        }
        isolatedElements = [];
    };

    const close = () => {
        if (!dialog) return;
        stopDragging();
        dialog.remove();
        dialog = null;
        image = null;
        scaleOutput = null;
        zoomOutButton = null;
        zoomInButton = null;
        ownerWindow.removeEventListener('mousemove', onMouseMove);
        ownerWindow.removeEventListener('mouseup', onMouseUp);
        ownerWindow.removeEventListener('keydown', onKeyDown);
        restoreBackground();
        previousFocus?.focus?.();
        previousFocus = null;
    };

    const onKeyDown = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab' || !dialog) return;
        const controls = [...dialog.querySelectorAll('button:not(:disabled)')];
        if (!controls.length) return;
        const activeElement = dialog.getRootNode()?.activeElement || document.activeElement;
        const first = controls[0];
        const last = controls.at(-1);
        let target = null;
        if (!dialog.contains(activeElement)) {
            target = event.shiftKey ? last : first;
        }
        else if (event.shiftKey && activeElement === first) {
            target = last;
        }
        else if (!event.shiftKey && activeElement === last) {
            target = first;
        }
        if (!target) return;
        event.preventDefault();
        target.focus();
    };

    const changeScale = delta => {
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale + delta));
        renderTransform();
    };

    const createButton = (label, icon, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mktero-image-preview-button';
        button.setAttribute('aria-label', label);
        button.title = label;
        button.appendChild(createLucideIcon(document, icon, {
            className: 'mktero-image-preview-button-icon',
            size: 20,
        }));
        button.addEventListener('click', onClick);
        return button;
    };

    const isolateBackground = () => {
        let branch = dialog;
        let ancestor = dialog.parentNode;
        while (ancestor) {
            for (const element of ancestor.children || []) {
                if (element === branch) continue;
                isolatedElements.push({
                    element,
                    hadInert: element.hasAttribute('inert'),
                    ariaHidden: element.getAttribute('aria-hidden'),
                });
                element.setAttribute('inert', '');
                element.setAttribute('aria-hidden', 'true');
            }
            branch = ancestor;
            ancestor = ancestor.parentNode;
        }
    };

    const open = ({ src, alt = '' }) => {
        if (!src) return;
        close();
        previousFocus = parent.getRootNode()?.activeElement || document.activeElement;
        scale = 1;
        translateX = 0;
        translateY = 0;

        dialog = document.createElement('div');
        dialog.className = 'mktero-image-preview';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', t('image.preview'));

        const stage = document.createElement('div');
        stage.className = 'mktero-image-preview-stage';
        image = document.createElement('img');
        image.className = 'mktero-image-preview-image';
        image.src = src;
        image.alt = alt;
        image.draggable = false;
        image.addEventListener('dragstart', event => event.preventDefault());
        image.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            drag = {
                clientX: event.clientX,
                clientY: event.clientY,
                translateX,
                translateY,
            };
            image.classList.add('is-dragging');
        });
        stage.appendChild(image);

        const controls = document.createElement('div');
        controls.className = 'mktero-image-preview-controls';
        zoomOutButton = createButton(
            t('image.zoomOut'),
            LUCIDE_ICONS.zoomOut,
            () => changeScale(-SCALE_STEP)
        );
        scaleOutput = document.createElement('output');
        scaleOutput.className = 'mktero-image-preview-scale';
        scaleOutput.setAttribute('aria-live', 'polite');
        zoomInButton = createButton(
            t('image.zoomIn'),
            LUCIDE_ICONS.zoomIn,
            () => changeScale(SCALE_STEP)
        );
        const closeButton = createButton(
            t('image.closePreview'),
            LUCIDE_ICONS.x,
            close
        );
        controls.append(zoomOutButton, scaleOutput, zoomInButton, closeButton);

        dialog.append(stage, controls);
        dialog.addEventListener('click', event => {
            if (event.target === dialog || event.target === stage) close();
        });
        parent.appendChild(dialog);
        isolateBackground();
        ownerWindow.addEventListener('mousemove', onMouseMove);
        ownerWindow.addEventListener('mouseup', onMouseUp);
        ownerWindow.addEventListener('keydown', onKeyDown);
        renderTransform();
        closeButton.focus();
    };

    return {
        open,
        close,
        destroy: close,
    };
}
