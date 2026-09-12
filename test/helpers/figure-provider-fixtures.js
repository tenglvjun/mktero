import { strToU8, zipSync } from 'fflate';
import { extractMinerUResultFromZip } from '../../src/mineru/zip-markdown.js';
import { decodeMinerUFigureInput } from '../../src/mineru/figure-layout-adapter.js';
import { decodeMistralResult } from '../../src/mistral/mistral-result.js';
import { createTestPNG } from './figure-fixtures.js';

export async function createFigureProviderFixture(caseID, provider, { fileData, manifest, sourceOrder = 'interleaved' }) {
    if (!['mineru', 'mistral'].includes(provider) || !manifest.cases[caseID]) throw new Error('Unknown fixture');
    const scene = manifest.cases[caseID];
    const assets = {};
    const pdfInfo = [];
    const pages = [];
    for (const page of scene.pages) {
        const chunks = [];
        const blocks = [];
        const paraBlocks = [];
        const images = [];
        const box = value => value && [value[0] * page.width / 1000, value[1] * page.height / 1000,
            value[2] * page.width / 1000, value[3] * page.height / 1000];
        const textBlock = (content, bbox, type = 'text') => ({ type, bbox: box(bbox), content });
        for (const heading of page.headings.slice(0, 1)) {
            chunks.push('# ' + heading.text);
            const block = textBlock(heading.text, heading.bbox, 'title');
            blocks.push(block);
            paraBlocks.push(block);
        }
        for (const [groupIndex, group] of page.groups.entries()) {
            const children = [];
            const caption = textBlock(group.caption, group.captionBBox, 'caption');
            const addCaption = () => {
                chunks.push(group.caption); blocks.push(caption);
                children.push({ ...caption, type: 'image_caption' });
            };
            if (caseID === 'caption-above') addCaption();
            for (const [index, bbox] of group.panels.entries()) {
                const path = `images/p${page.pageIndex}-g${groupIndex}-${index}.png`;
                const data = createTestPNG();
                assets[path] = data;
                chunks.push(`![](${path})`);
                const panelBox = page.uncertain && index === 0 ? null : box(bbox);
                blocks.push({ type: 'image', image_id: path, bbox: panelBox });
                children.push({ type: 'image_body', bbox: panelBox,
                    lines: [{ spans: [{ type: 'image', image_path: path, bbox: panelBox }] }] });
                images.push({ id: path, image_base64: 'data:image/png;base64,' + base64(data) });
                const panelLabel = textBlock(`(${String.fromCharCode(97 + index)})`,
                    [bbox[0] + 20, bbox[1] + 15, bbox[0] + 45, bbox[1] + 35]);
                chunks.push(panelLabel.content);
                blocks.push(panelLabel);
                children.push(panelLabel);
                const labelBox = [bbox[0] + 20, bbox[1] + 15, bbox[2] - 20, bbox[1] + 35];
                chunks.push('Axis value');
                const label = textBlock('Axis value', labelBox);
                blocks.push(label);
                children.push(label);
                if (caseID === 'grid-2x2' && index === 0) chunks.push(page.bodyText);
            }
            if (group.legend) {
                const legend = textBlock(group.legend.text, group.legend.bbox);
                chunks.push(group.legend.text);
                blocks.push(legend);
                children.push(legend);
            }
            if (caseID !== 'caption-above') addCaption();
            paraBlocks.push({ type: 'image', bbox: box([Math.min(...group.panels.map(b => b[0]), group.captionBBox[0]),
                Math.min(...group.panels.map(b => b[1]), group.captionBBox[1]),
                Math.max(...group.panels.map(b => b[2]), group.captionBBox[2]),
                Math.max(...group.panels.map(b => b[3]), group.captionBBox[3])]), blocks: children });
        }
        for (const column of page.columns || []) {
            chunks.push(column.text);
            const block = textBlock(column.text, column.bbox);
            blocks.push(block);
            paraBlocks.push(block);
        }
        for (const heading of page.headings.slice(1)) {
            chunks.push('# ' + heading.text);
            const block = textBlock(heading.text, heading.bbox, 'title');
            blocks.push(block);
            paraBlocks.push(block);
        }
        if (caseID !== 'grid-2x2') chunks.push(page.bodyText);
        const body = textBlock(page.bodyText, page.bodyBBox);
        blocks.push(body);
        paraBlocks.push(body);
        if (provider === 'mineru' && sourceOrder === 'interleaved' && images.length > 1) {
            const firstPath = images[0].id;
            const lastPath = images.at(-1).id;
            const firstImage = chunks.splice(chunks.indexOf(`![](${firstPath})`), 1)[0];
            chunks.splice(1, 0, firstImage);
            const lastImage = chunks.splice(chunks.indexOf(`![](${lastPath})`), 1)[0];
            chunks.splice(chunks.findIndex(chunk => chunk === '# ' + page.headings.at(-1).text), 0, lastImage);
            const groups = paraBlocks.filter(block => block.type === 'image');
            const movePanel = (group, path, first) => {
                const index = group.blocks.findIndex(child => child.lines?.[0]?.spans?.[0]?.image_path === path);
                const [panel] = group.blocks.splice(index, 1);
                if (first) group.blocks.unshift(panel);
                else group.blocks.push(panel);
            };
            movePanel(groups[0], firstPath, true);
            movePanel(groups.at(-1), lastPath, false);
        }
        const unit = provider === 'mineru' ? page.userUnit : 1;
        if (unit !== 1) {
            const scale = block => {
                if (block.bbox) block.bbox = block.bbox.map(value => value / unit);
                for (const key of ['blocks', 'lines', 'spans']) for (const child of block[key] || []) scale(child);
            };
            for (const block of paraBlocks) scale(block);
        }
        pdfInfo.push({ page_idx: page.pageIndex, page_size: [page.width / unit, page.height / unit], para_blocks: paraBlocks });
        pages.push({ index: page.pageIndex, markdown: chunks.join('\n\n'),
            dimensions: { width: page.width, height: page.height, dpi: 72 }, images, blocks });
    }
    let input;
    if (provider === 'mineru') {
        const archive = zipSync({ ...assets,
            'full.md': strToU8(pages.map(page => page.markdown).join('\n\n')),
            'paper_middle.json': strToU8(JSON.stringify({ _backend: 'vlm', _version_name: '3.4.5', pdf_info: pdfInfo })),
        });
        input = decodeMinerUFigureInput(extractMinerUResultFromZip(archive));
    }
    else {
        input = decodeMistralResult({ model: 'mistral-ocr-4-1', pages, usage_info: { pages_processed: pages.length } });
        // The generated scene supplies known displayed CropBox coordinates.
        // This tests the shared algorithm, not the provider's page orientation.
        for (const page of input.pages) {
            page.coordinateFrame = 'display-cropbox';
            page.geometryEvidence = 'synthetic-display-cropbox';
            delete page.geometryReason;
        }
    }
    // Interleaved OCR is bounded by two same-page image anchors. The ordinary
    // trailing-caption variant deliberately lacks that evidence in MinerU.
    const expected = provider === 'mineru' && sourceOrder === 'linear' ? {
        ...scene.expected,
        figures: caseID === 'independent' ? 1 : 0,
        panelCounts: caseID === 'independent' ? [1] : [],
        consumedTexts: [],
        preserve: caseID !== 'independent',
        preserveReason: caseID === 'uncertain' ? 'missing-geometry' : 'ambiguous-source-range',
    } : scene.expected;
    return { input, fileData, expected, pageGeometries: manifest.pageGeometries, scene,
        coordinateEvidence: provider === 'mistral' ? 'synthetic-display-cropbox' : 'mineru-vlm-3.4.5' };
}

function base64(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const value = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
        result += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63]
            + (i + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=')
            + (i + 2 < bytes.length ? alphabet[value & 63] : '=');
    }
    return result;
}
