import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RESEARCH_NOTE_TARGETS_DEFAULT,
    RESEARCH_NOTE_TARGETS_PREF,
    clearResearchNoteTarget,
    getResearchNoteTarget,
    observeResearchNoteTargets,
    readResearchNoteTargets,
    setResearchNoteTarget,
} from '../src/config/research-note-preferences.js';

function createPreferences(initial = RESEARCH_NOTE_TARGETS_DEFAULT) {
    let raw = initial;
    const listeners = new Map();
    const calls = [];
    return {
        calls,
        listeners,
        get raw() { return raw; },
        Prefs: {
            get(name, global) {
                assert.equal(name, RESEARCH_NOTE_TARGETS_PREF);
                assert.equal(global, true);
                return raw;
            },
            set(name, value, global) {
                assert.equal(name, RESEARCH_NOTE_TARGETS_PREF);
                assert.equal(global, true);
                calls.push(value);
                raw = value;
                for (const listener of listeners.values()) listener(value);
            },
            registerObserver(name, listener, global) {
                assert.equal(name, RESEARCH_NOTE_TARGETS_PREF);
                assert.equal(global, true);
                const id = listeners.size + 1;
                listeners.set(id, listener);
                return id;
            },
            unregisterObserver(id) { listeners.delete(id); },
        },
    };
}

test('persists only a note key per library and restores through a new caller', () => {
    assert.equal(RESEARCH_NOTE_TARGETS_PREF, 'extensions.mktero.researchNoteTargets');
    assert.equal(RESEARCH_NOTE_TARGETS_DEFAULT, '{}');
    const zotero = createPreferences();

    assert.equal(getResearchNoteTarget(zotero, 7), null);
    setResearchNoteTarget(zotero, 7, 'RESEARCH');
    setResearchNoteTarget(zotero, 8, 'NOTE0008');
    assert.equal(zotero.raw, '{"7":"RESEARCH","8":"NOTE0008"}');
    assert.equal(getResearchNoteTarget({ Prefs: zotero.Prefs }, 7), 'RESEARCH');
    assert.equal(getResearchNoteTarget(zotero, 8), 'NOTE0008');

    clearResearchNoteTarget(zotero, 7);
    assert.deepEqual(readResearchNoteTargets(zotero), { 8: 'NOTE0008' });
    assert.equal(getResearchNoteTarget(zotero, 7), null);
});

test('unset preferences are empty and invalid mappings are never partially restored', () => {
    assert.deepEqual(readResearchNoteTargets({ Prefs: { get: () => undefined } }), {});
    assert.deepEqual(readResearchNoteTargets({}), {});
    for (const raw of [
        '{', '', 'null', '[]', 'true', 42,
        '{"7":"RESEARCH","8":"bad-key"}',
        '{"0":"RESEARCH"}', '{"07":"RESEARCH"}',
        '{"9007199254740992":"RESEARCH"}',
        '{"__proto__":"RESEARCH"}',
        `{${' '.repeat(16 * 1024)}}`,
        JSON.stringify(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [i + 1, 'RESEARCH']))),
    ]) {
        const zotero = createPreferences(raw);
        assert.equal(readResearchNoteTargets(zotero), null, String(raw).slice(0, 100));
        assert.throws(() => getResearchNoteTarget(zotero, 7), /unavailable/);
        assert.throws(() => setResearchNoteTarget(zotero, 7, 'NEWNOTE1'), /unavailable/);
        assert.throws(() => clearResearchNoteTarget(zotero, 7), /unavailable/);
        assert.equal(zotero.calls.length, 0);
    }
});

test('rejects invalid library ids and keys before writing', () => {
    const zotero = createPreferences();
    for (const id of [0, -1, 1.2, NaN, Infinity, '07', '1e2', '__proto__']) {
        assert.throws(() => setResearchNoteTarget(zotero, id, 'RESEARCH'), /library/);
    }
    for (const key of ['', 'lowerkey', 'TOO-LONG-KEY', '1234567', '123456789', null, {}, 12345678]) {
        assert.throws(() => setResearchNoteTarget(zotero, 7, key), /key/);
    }
    assert.equal(zotero.calls.length, 0);
    assert.throws(() => setResearchNoteTarget({}, 7, 'RESEARCH'), /unavailable/);
});

test('bounds the mapping size without evicting another library', () => {
    const initial = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [index + 1, 'RESEARCH']));
    const zotero = createPreferences(JSON.stringify(initial));
    setResearchNoteTarget(zotero, 7, 'NEWNOTE1');
    assert.throws(() => setResearchNoteTarget(zotero, 257, 'RESEARCH'), /limit/);
    assert.equal(getResearchNoteTarget(zotero, 7), 'NEWNOTE1');
    assert.equal(Object.keys(readResearchNoteTargets(zotero)).length, 256);
    clearResearchNoteTarget(zotero, 1);
    setResearchNoteTarget(zotero, 257, 'RESEARCH');
    assert.equal(getResearchNoteTarget(zotero, 257), 'RESEARCH');
});

test('observes external preference changes and disposes its listener', () => {
    const zotero = createPreferences();
    let calls = 0;
    const stop = observeResearchNoteTargets(zotero, () => { calls += 1; });
    assert.equal(zotero.listeners.size, 1);
    zotero.Prefs.set(RESEARCH_NOTE_TARGETS_PREF, '{"7":"RESEARCH"}', true);
    assert.equal(calls, 1);
    stop();
    stop();
    assert.equal(zotero.listeners.size, 0);
    zotero.Prefs.set(RESEARCH_NOTE_TARGETS_PREF, '{}', true);
    assert.equal(calls, 1);
    observeResearchNoteTargets({}, () => {})();
    observeResearchNoteTargets(zotero, null)();
    assert.equal(zotero.listeners.size, 0);
});
