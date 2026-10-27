import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createNativeContextMenu } from '../src/ui/native-context-menu.js';

function createXULDocument() {
    const { document } = parseHTML('<html><body><popupset></popupset></body></html>');
    const opened = [];
    document.createXULElement = tagName => {
        const element = document.createElement(tagName);
        if (tagName === 'menupopup') {
            element.openPopupAtScreen = (x, y, isContextMenu) => {
                opened.push(['screen', x, y, isContextMenu]);
            };
            element.openPopup = (anchor, position) => {
                opened.push(['anchor', anchor, position]);
            };
            element.hidePopup = () => opened.push(['hide']);
        }
        return element;
    };
    return { document, opened };
}

test('has no menu without XUL', () => {
    const { document } = parseHTML('<html><body></body></html>');
    assert.equal(createNativeContextMenu(document), null);
});

test('opens a native menupopup at the pointer with items and a separator', () => {
    const { document, opened } = createXULDocument();
    const menu = createNativeContextMenu(document);
    const commands = [];
    const popup = menu.open({
        screenX: 120,
        screenY: 340,
        items: [
            { label: 'Show in Library', command: () => commands.push('show') },
            { label: 'Edit in a Separate Window', command: () => commands.push('edit') },
            { separator: true },
            { label: 'Move to Trash', disabled: true, command: () => commands.push('trash') },
        ],
    });

    assert.equal(popup.parentElement, document.querySelector('popupset'));
    assert.deepEqual(
        [...popup.children].map(node => node.localName),
        ['menuitem', 'menuitem', 'menuseparator', 'menuitem']
    );
    assert.equal(popup.children[0].getAttribute('label'), 'Show in Library');
    assert.equal(popup.children[3].getAttribute('disabled'), 'true');
    assert.deepEqual(opened.at(-1), ['screen', 120, 340, true]);

    const command = new document.defaultView.Event('command');
    popup.children[1].dispatchEvent(command);
    popup.children[3].dispatchEvent(new document.defaultView.Event('command'));
    assert.deepEqual(commands, ['edit']);
});

test('opens below the anchor for a keyboard request and reuses one popup', () => {
    const { document, opened } = createXULDocument();
    const menu = createNativeContextMenu(document);
    const anchor = document.createElement('button');
    const first = menu.open({ items: [{ label: 'One' }], anchor });
    const second = menu.open({ items: [{ label: 'Two' }], anchor });

    assert.equal(first, second);
    assert.equal(second.children.length, 1);
    assert.equal(second.children[0].getAttribute('label'), 'Two');
    assert.deepEqual(opened.at(-1), ['anchor', anchor, 'after_start']);
    assert.equal(document.querySelectorAll('menupopup').length, 1);

    menu.destroy();
    assert.equal(document.querySelectorAll('menupopup').length, 0);
});
