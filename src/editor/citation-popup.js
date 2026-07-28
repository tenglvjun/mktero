import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';

export function createCitationPopup(parent, {
    localization = createLocalization(),
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-citation-popup',
        idPrefix: 'mktero-citation-popup',
    });

    const open = ({
        anchor,
        targets,
        label = t('citation.details'),
        onActivate,
        focusFirst = false,
    }) => {
        if (!targets?.length) return;
        anchoredPopup.open({
            anchor,
            label,
            renderContent({ document, close }) {
                const content = document.createElement('div');
                content.className = 'mktero-citation-popup-content';
                for (const target of targets) {
                    content.appendChild(createCitationItem(
                        document,
                        target,
                        close,
                        onActivate
                    ));
                }
                return content;
            },
            focusContent: focusFirst ? focusFirstItem : null,
        });
    };

    return {
        open,
        close: anchoredPopup.close,
        scheduleClose: anchoredPopup.scheduleClose,
        cancelClose: anchoredPopup.cancelClose,
        contains: anchoredPopup.contains,
        destroy: anchoredPopup.destroy,
    };
}

function createCitationItem(document, target, close, onActivate) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mktero-citation-popup-item';
    item.addEventListener('click', () => {
        close();
        onActivate?.(target);
    });
    const marker = target.label
        ?? (Number.isInteger(target.number) ? String(target.number) : '');
    if (marker) {
        const number = document.createElement('span');
        number.className = 'mktero-citation-popup-number';
        number.textContent = `[${marker}]`;
        item.appendChild(number);
    }
    const text = document.createElement('span');
    text.className = 'mktero-citation-popup-text';
    text.textContent = target.text;
    item.appendChild(text);
    return item;
}

function focusFirstItem(popup) {
    popup.querySelector('.mktero-citation-popup-item')?.focus();
}
