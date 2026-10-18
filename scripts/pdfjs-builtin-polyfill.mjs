import { readFile } from 'node:fs/promises';
import path from 'node:path';

// PDF.js 6 bundles core-js 3.50 and runs its polyfills while the module is
// evaluated. Zotero 11's plugin sandbox freezes built-ins, and Firefox 153
// already has several of those methods as non-configurable properties, so
// core-js's Object.defineProperty throws before bootstrap can export
// install/startup. Keep the native method in that case. Firefox 115 still
// receives polyfills for methods it does not have.
const DEFINE_BUILT_IN = `module.exports = function (O, key, value, options) {
  if (!options) options = {};
  var simple = options.enumerable;
  var name = options.name !== undefined ? options.name : key;
  if (isCallable(value)) makeBuiltIn(value, name, options);
  if (options.global) {
    if (simple) O[key] = value;
    else defineGlobalProperty(key, value);
  } else {
    try {
      if (!options.unsafe) delete O[key];
      else if (O[key]) simple = true;
    } catch (error) { /* empty */ }
    if (simple) O[key] = value;
    else definePropertyModule.f(O, key, {
      value: value,
      enumerable: false,
      configurable: !options.nonConfigurable,
      writable: !options.nonWritable
    });
  } return O;
};`;

const PATCHED_DEFINE_BUILT_IN = `module.exports = function (O, key, value, options) {
  if (!options) options = {};
  var simple = options.enumerable;
  var name = options.name !== undefined ? options.name : key;
  if (isCallable(value)) makeBuiltIn(value, name, options);
  // Zotero 11 freezes built-ins. A non-configurable native method cannot be
  // replaced; keep it instead of aborting plugin startup.
  var existing = Object.getOwnPropertyDescriptor(O, key);
  if (existing && existing.configurable === false) return O;
  if (options.global) {
    if (simple) O[key] = value;
    else defineGlobalProperty(key, value);
  } else {
    try {
      if (!options.unsafe) delete O[key];
      else if (O[key]) simple = true;
    } catch (error) { /* empty */ }
    if (simple) O[key] = value;
    else definePropertyModule.f(O, key, {
      value: value,
      enumerable: false,
      configurable: !options.nonConfigurable,
      writable: !options.nonWritable
    });
  } return O;
};`;

const PDFJS_LEGACY_BUILD = /[/\\]pdfjs-dist[/\\]legacy[/\\]build[/\\]pdf(?:\.worker)?\.mjs$/u;

export function patchPDFJSDefineBuiltIn(source) {
    const matches = source.split(DEFINE_BUILT_IN).length - 1;
    if (matches !== 1) {
        throw new Error(
            `PDF.js defineBuiltIn patch matched ${matches} times; `
            + 'the bundled core-js installer changed'
        );
    }
    return source.replace(DEFINE_BUILT_IN, PATCHED_DEFINE_BUILT_IN);
}

export function pdfjsBuiltinPolyfillPlugin() {
    return {
        name: 'pdfjs-builtin-polyfill',
        setup(build) {
            build.onLoad({ filter: /pdf(\.worker)?\.mjs$/ }, async args => {
                if (!PDFJS_LEGACY_BUILD.test(args.path)) return null;
                return {
                    contents: patchPDFJSDefineBuiltIn(await readFile(args.path, 'utf8')),
                    loader: 'js',
                    resolveDir: path.dirname(args.path),
                };
            });
        },
    };
}
