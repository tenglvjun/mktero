import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getZoteroLocale,
    MINERU_PREFERENCE_PANE_ID,
    openMinerUPreferences,
    registerMinerUPreferencesPane,
} from '../src/config/mineru-preferences.js';

test('uses the Zotero locale and ignores the operating system locale', () => {
    assert.equal(
        getZoteroLocale(
            { locale: 'zh-CN' },
            {
                locale: {
                    systemLocaleAsBCP47: 'en-GB',
                    appLocaleAsBCP47: 'fr-FR',
                },
            }
        ),
        'zh-CN'
    );
    assert.equal(
        getZoteroLocale(
            {},
            { locale: { appLocaleAsBCP47: 'fr-FR' } }
        ),
        'fr-FR'
    );
    assert.equal(
        getZoteroLocale(
            {},
            { locale: { systemLocaleAsBCP47: 'zh-CN' } }
        ),
        ''
    );
    assert.equal(getZoteroLocale({}, null), '');
});

test('registers and opens the Mktero preference pane', async () => {
    let registered;
    let opened;
    const zotero = {
        PreferencePanes: {
            register: async options => {
                registered = options;
                return options.id;
            },
        },
        Utilities: {
            Internal: {
                openPreferences: paneID => {
                    opened = paneID;
                },
            },
        },
    };

    const paneID = await registerMinerUPreferencesPane({
        zotero,
        pluginID: 'mktero@example.com',
        rootURI: 'resource://mktero/',
    });
    openMinerUPreferences(zotero);

    assert.equal(paneID, MINERU_PREFERENCE_PANE_ID);
    assert.deepEqual(registered, {
        pluginID: 'mktero@example.com',
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        image: 'resource://mktero/ui/icons/mktero.svg',
        src: 'resource://mktero/ui/preferences.xhtml',
        scripts: ['resource://mktero/ui/preferences.js'],
        stylesheets: ['resource://mktero/ui/preferences.css'],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
    assert.equal(opened, MINERU_PREFERENCE_PANE_ID);
});
