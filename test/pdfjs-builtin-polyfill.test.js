import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { patchPDFJSDefineBuiltIn } from '../scripts/pdfjs-builtin-polyfill.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyBuild = path.join(projectRoot, 'node_modules/pdfjs-dist/legacy/build');

test('keeps a non-configurable native method and still polyfills a missing one', async () => {
    for (const fileName of ['pdf.mjs', 'pdf.worker.mjs']) {
        const source = await readFile(path.join(legacyBuild, fileName), 'utf8');
        const patched = patchPDFJSDefineBuiltIn(source);
        assert.notEqual(patched, source);
        assert.equal(patched.includes('existing.configurable === false'), true);
        assert.throws(
            () => patchPDFJSDefineBuiltIn(patched),
            /matched 0 times/
        );

        const install = defineBuiltInInstaller(patched);
        const nativeTake = function take() {
            return 'native';
        };
        const prototype = {};
        Object.defineProperty(prototype, 'take', {
            value: nativeTake,
            writable: true,
            enumerable: false,
            configurable: false,
        });
        assert.doesNotThrow(() => install(prototype, 'take', function replaced() {}));
        assert.equal(prototype.take, nativeTake);

        const target = {};
        const added = function added() {};
        install(target, 'getOrInsert', added);
        assert.equal(target.getOrInsert, added);
    }
});

function defineBuiltInInstaller(source) {
    const start = source.indexOf('module.exports = function (O, key, value, options)');
    const end = source.indexOf('\n};', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const factory = new vm.Script(`
        var isCallable = function () { return false; };
        var makeBuiltIn = function () {};
        var defineGlobalProperty = function () {};
        var definePropertyModule = { f: function (object, key, descriptor) {
            Object.defineProperty(object, key, descriptor);
        } };
        ${source.slice(start, end + 3).replace('module.exports = ', 'var install = ')}
        install;
    `);
    return factory.runInNewContext({ Object });
}
