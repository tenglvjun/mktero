import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { extractMinerUResultFromZip } from '../src/mineru/zip-markdown.js';
import { decodeMinerUFigureInput } from '../src/mineru/figure-layout-adapter.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

export const FIGURE_CORPUS_ENV = 'MKTERO_FIGURE_CORPUS';
export const FIGURE_CORPUS_EXPECTATION_DIR = fileURLToPath(
    new URL('../test/fixtures/figure-corpus/', import.meta.url)
);
const DEFAULT_BBOX_TOLERANCE = 6;

export async function checkFigureCorpus({ corpusDir, update = false, ids = null, log = console.log } = {}) {
    if (!corpusDir || typeof corpusDir !== 'string') {
        throw new TypeError(`Set ${FIGURE_CORPUS_ENV} to a directory of MinerU result archives`);
    }
    const expectations = await loadExpectations(ids);
    if (update) {
        const known = new Set(expectations.map(expectation => expectation.id));
        for (const id of await discoverCorpusIds(corpusDir)) {
            if (known.has(id) || (ids?.length && !ids.includes(id))) continue;
            expectations.push({ id });
        }
    }
    const report = { checked: [], skipped: [], failures: [], updated: [] };
    for (const expectation of expectations) {
        const archivePath = await findArchive(corpusDir, expectation.id);
        if (!archivePath) {
            report.skipped.push(expectation.id);
            log(`SKIP ${expectation.id}: no archive under ${corpusDir}`);
            continue;
        }
        const archive = new Uint8Array(await readFile(archivePath));
        const archiveSha256 = sha256Hex(archive);
        if (!update && expectation.archiveSha256 && expectation.archiveSha256 !== archiveSha256) {
            report.failures.push({
                id: expectation.id,
                message: `${expectation.id}: archive sha256 changed; re-verify the result and run with --update`,
            });
            log(`DIFF ${expectation.id}: archive sha256 changed`);
            continue;
        }
        const summary = summarizeArchive(archive);
        if (update) {
            await writeExpectation(expectation.id, {
                schema: 1,
                id: expectation.id,
                archiveSha256,
                pages: summary.pages,
                bboxTolerance: DEFAULT_BBOX_TOLERANCE,
                figures: summary.figures,
                preserved: summary.preserved,
            });
            report.updated.push(expectation.id);
            log(`UPDATED ${expectation.id}: ${summary.figures.length} figures, ${summary.preserved.length} preserved`);
            continue;
        }
        const differences = compareExpectation(expectation, summary);
        report.checked.push(expectation.id);
        if (differences.length) {
            const message = `${expectation.id}: ${differences.join('; ')}`;
            report.failures.push({ id: expectation.id, message });
            log(`DIFF ${expectation.id}`);
            for (const difference of differences) log(`  - ${difference}`);
        }
        else {
            log(`OK   ${expectation.id}: ${summary.figures.length} figures, ${summary.preserved.length} preserved`);
        }
    }
    if (!expectations.length) log('No figure corpus expectations are committed');
    return report;
}

export async function loadExpectations(ids = null) {
    let names;
    try {
        names = await readdir(FIGURE_CORPUS_EXPECTATION_DIR);
    }
    catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    names = names.filter(name => name.endsWith('.expected.json')).sort();
    const expectations = [];
    for (const name of names) {
        const id = name.slice(0, -'.expected.json'.length);
        if (ids?.length && !ids.includes(id)) continue;
        expectations.push(JSON.parse(await readFile(path.join(FIGURE_CORPUS_EXPECTATION_DIR, name), 'utf8')));
    }
    return expectations;
}

async function discoverCorpusIds(corpusDir) {
    const ids = [];
    let entries;
    try {
        entries = await readdir(corpusDir, { withFileTypes: true });
    }
    catch {
        return ids;
    }
    for (const entry of entries) {
        if (entry.name.endsWith('.zip')) {
            try {
                if ((await stat(path.join(corpusDir, entry.name))).isFile()) {
                    ids.push(entry.name.slice(0, -'.zip'.length));
                    continue;
                }
            }
            catch {
                continue;
            }
        }
        if (!entry.isDirectory()) continue;
        try {
            const info = await stat(path.join(corpusDir, entry.name, 'result.zip'));
            if (info.isFile()) ids.push(entry.name);
        }
        catch {
            // Not a corpus directory layout.
        }
    }
    return ids.sort();
}

async function writeExpectation(id, expectation) {
    await mkdir(FIGURE_CORPUS_EXPECTATION_DIR, { recursive: true });
    const target = path.join(FIGURE_CORPUS_EXPECTATION_DIR, `${id}.expected.json`);
    await writeFile(target, `${JSON.stringify(expectation, null, 2)}\n`, 'utf8');
}

async function findArchive(corpusDir, id) {
    const candidates = [path.join(corpusDir, `${id}.zip`), path.join(corpusDir, id, 'result.zip')];
    for (const candidate of candidates) {
        try {
            const info = await stat(candidate);
            if (info.isFile()) return candidate;
        }
        catch {
            // Try the next layout.
        }
    }
    return null;
}

function summarizeArchive(archive) {
    const raw = extractMinerUResultFromZip(archive);
    const input = decodeMinerUFigureInput(raw);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    const figures = candidates
        .filter(candidate => candidate.decision === 'compose')
        .map(candidate => ({
            pageIndex: candidate.pageIndex,
            label: candidate.label || null,
            panels: candidate.panelBlockIds.length,
            captions: candidate.captionBlockIds.length,
            owned: candidate.ownedTextBlockIds.length,
            bbox: (candidate.visualBBox || []).map(value => Math.round(value)),
        }))
        .sort((left, right) => left.pageIndex - right.pageIndex
            || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
    const preserved = candidates
        .filter(candidate => candidate.decision === 'preserve')
        .map(candidate => ({ pageIndex: candidate.pageIndex, reason: candidate.reason || 'missing-geometry' }))
        .sort((left, right) => left.pageIndex - right.pageIndex
            || left.reason.localeCompare(right.reason));
    return { pages: input.pages.length, figures, preserved };
}

function compareExpectation(expectation, summary) {
    const differences = [];
    const tolerance = expectation.bboxTolerance ?? DEFAULT_BBOX_TOLERANCE;
    if (expectation.pages !== undefined && expectation.pages !== summary.pages) {
        differences.push(`pages expected ${expectation.pages}, actual ${summary.pages}`);
    }
    if (expectation.figures.length !== summary.figures.length) {
        differences.push(`figures expected ${expectation.figures.length}, actual ${summary.figures.length}`);
    }
    for (let index = 0; index < Math.min(expectation.figures.length, summary.figures.length); index++) {
        const expected = expectation.figures[index];
        const actual = summary.figures[index];
        for (const field of ['pageIndex', 'label', 'panels', 'captions', 'owned']) {
            if (expected[field] !== actual[field]) {
                differences.push(`figure[${index}].${field} expected ${JSON.stringify(expected[field])},`
                    + ` actual ${JSON.stringify(actual[field])}`);
            }
        }
        for (const axis of [0, 1, 2, 3]) {
            if (Math.abs(expected.bbox[axis] - actual.bbox[axis]) > tolerance) {
                differences.push(`figure[${index}].bbox[${axis}] expected ${expected.bbox[axis]},`
                    + ` actual ${actual.bbox[axis]}`);
            }
        }
    }
    const expectedPreserved = expectation.preserved.map(value => `${value.pageIndex}:${value.reason}`).join(', ');
    const actualPreserved = summary.preserved.map(value => `${value.pageIndex}:${value.reason}`).join(', ');
    if (expectedPreserved !== actualPreserved) {
        differences.push(`preserved expected [${expectedPreserved}], actual [${actualPreserved}]`);
    }
    return differences;
}

function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
    const args = process.argv.slice(2);
    const update = args.includes('--update');
    const corpusIndex = args.indexOf('--corpus');
    const idIndex = args.indexOf('--id');
    const corpusDir = corpusIndex >= 0 ? args[corpusIndex + 1] : process.env[FIGURE_CORPUS_ENV];
    const ids = idIndex >= 0 ? [args[idIndex + 1]] : null;
    const report = await checkFigureCorpus({ corpusDir, update, ids });
    if (report.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
