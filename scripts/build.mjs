import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(projectRoot, 'build');
const packageRoot = path.join(buildRoot, 'package');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'manifest.json'), 'utf8'));
const xpiPath = path.join(buildRoot, `mktero-${manifest.version}.xpi`);

await rm(buildRoot, { recursive: true, force: true });
await mkdir(path.join(packageRoot, 'ui'), { recursive: true });

await Promise.all([
    build({
        entryPoints: [path.join(projectRoot, 'src/bootstrap.js')],
        outfile: path.join(packageRoot, 'bootstrap.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['firefox115'],
        legalComments: 'none',
    }),
    build({
        entryPoints: [path.join(projectRoot, 'src/ui/markdown-window.js')],
        outfile: path.join(packageRoot, 'ui/markdown-window.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['firefox115'],
        legalComments: 'none',
    }),
]);

await Promise.all([
    copyText('manifest.json', 'manifest.json'),
    copyText('ui/markdown.xhtml', 'ui/markdown.xhtml'),
    copyText('ui/markdown.css', 'ui/markdown.css'),
    copyText('ui/preferences.xhtml', 'ui/preferences.xhtml'),
    copyText('ui/preferences.css', 'ui/preferences.css'),
    copyText('prefs.js', 'prefs.js'),
]);

await execFileAsync('zip', ['-qr', xpiPath, '.'], { cwd: packageRoot });
console.log(`Built ${path.relative(projectRoot, xpiPath)}`);

async function copyText(source, destination) {
    const content = await readFile(path.join(projectRoot, source), 'utf8');
    await writeFile(path.join(packageRoot, destination), content);
}
