import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = new URL('../test/fixtures/figures/', import.meta.url);
const regular = [0, 0, 600, 800];
const grid = (columns, rows) => Array.from({ length: columns * rows }, (_, i) => {
    const width = (800 - 20 * (columns - 1)) / columns;
    const height = (700 - 20 * (rows - 1)) / rows;
    const x = 100 + (i % columns) * (width + 20);
    const y = 100 + Math.floor(i / columns) * (height + 20);
    return [x, y, x + width, y + height];
});
const scenes = [
    ['grid-2x2', grid(2, 2)], ['grid-4x4', grid(4, 4)],
    ['grid-hole', grid(3, 3).slice(0, 8)],
    ['tall-left', [[100, 100, 450, 800], [470, 100, 900, 440], [470, 460, 900, 800]]],
    ['wide-top', [[100, 100, 900, 440], [100, 460, 490, 800], [510, 460, 900, 800]]],
    ['irregular', [[100, 100, 460, 410], [490, 100, 900, 430],
        [100, 445, 370, 800], [410, 460, 900, 800]]],
    ['independent', [[100, 100, 450, 400], [550, 550, 900, 800]]],
    ['caption-above', grid(2, 2)], ['continued', grid(2, 2)],
    ['rotation-90', grid(2, 2)], ['rotation-180', grid(2, 2)], ['rotation-270', grid(2, 2)],
    ['crop-offset', grid(2, 2)], ['user-unit', grid(2, 2)],
    ['scan-only', grid(2, 2)], ['uncertain', grid(2, 2)],
];
const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const imageHex = '00AAFFFF550033BB88FFDD33003399DD0044';
objects.push(stream(`/Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode`, imageHex + '>'));
const kids = [];
const manifest = { version: 1, cases: {}, pageGeometries: [] };
for (const [caseID, boxes] of scenes) {
    const copies = caseID === 'continued' ? 2 : 1;
    const scene = { caseID, pages: [], expected: {
        figures: caseID === 'uncertain' ? 0 : caseID === 'independent' ? 2 : copies,
        panelCounts: caseID === 'uncertain' ? [] : caseID === 'independent' ? [1, 1] : Array(copies).fill(boxes.length),
        retainedTexts: [], consumedTexts: caseID === 'uncertain' ? [] : ['Axis value'],
        preserve: caseID === 'uncertain',
    } };
    for (let copy = 0; copy < copies; copy++) {
        const pageIndex = kids.length;
        const rotation = Number(caseID.match(/^rotation-(\d+)$/)?.[1] || 0);
        const cropBox = caseID === 'crop-offset' ? [50, 70, 650, 870] : regular;
        const mediaBox = caseID === 'crop-offset' ? [0, 0, 700, 900] : regular;
        const userUnit = caseID === 'user-unit' ? 2 : 1;
        const width = (rotation % 180 ? cropBox[3] - cropBox[1] : cropBox[2] - cropBox[0]) * userUnit;
        const height = (rotation % 180 ? cropBox[2] - cropBox[0] : cropBox[3] - cropBox[1]) * userUnit;
        const bodyText = `Body text for ${caseID} page ${copy + 1}. See Fig. 1.`;
        scene.expected.retainedTexts.push(bodyText);
        const groups = caseID === 'independent' ? boxes.map((box, index) => ({
            panels: [box], caption: `Figure ${index + 1}. Independent result.`,
            captionBBox: index === 0 ? [100, 420, 450, 460] : [550, 840, 900, 900],
        })) : [{ panels: boxes, caption: 'Figure 1. Treatment response in all panels.',
            captionBBox: caseID === 'caption-above' ? [100, 30, 900, 80] : [100, 840, 900, 900] }];
        const page = { pageIndex, width, height, rotation, userUnit, cropBox, mediaBox,
            groups, bodyText, bodyBBox: [100, 950, 900, 985],
            headings: [{ text: `Results ${pageIndex + 1}`, bbox: [100, 5, 900, 25] },
                { text: `Discussion ${pageIndex + 1}`, bbox: [100, 915, 900, 940] }],
            scanOnly: caseID === 'scan-only', uncertain: caseID === 'uncertain' };
        if (caseID === 'irregular') {
            groups[0].legend = { text: 'Baseline', bbox: [495, 435, 700, 455] };
            scene.expected.consumedTexts.push('Baseline');
        }
        if (caseID === 'independent') {
            page.columns = [
                { text: 'Left column body stays outside the second figure.', bbox: [100, 560, 445, 680] },
                { text: 'Right column body stays outside the first figure.', bbox: [550, 110, 895, 230] },
            ];
            scene.expected.retainedTexts.push(...page.columns.map(column => column.text));
        }
        scene.pages.push(page);
        const viewportTransform = transform(cropBox, rotation, userUnit);
        manifest.pageGeometries.push({ pageIndex, width, height, rotation, userUnit,
            viewBox: cropBox, mediaBox, viewportTransform, coordinateFrame: 'display-cropbox' });
        page.expectedBoxes = groups.map(group => {
            const x0 = Math.min(...group.panels.map(box => box[0]));
            const y0 = Math.min(...group.panels.map(box => box[1]));
            const x1 = Math.max(...group.panels.map(box => box[2]));
            const y1 = Math.max(...group.panels.map(box => box[3]));
            return [x0 - 2, y0 - 2, x1 + 2, y1 + 2];
        });
        page.pixelProbes = groups.flatMap(group => group.panels.map((box, index) => ({
            name: 'panel-background', point: [box[0] + 12, box[1] + 12], color: panelColor(index),
        })));
        page.featureProbes = groups.flatMap(group => group.panels.flatMap(box => {
            const x = box[0] * width / 1000;
            const y = box[1] * height / 1000;
            const right = box[2] * width / 1000;
            const bottom = box[3] * height / 1000;
            const region = (name, rect, minDark = 4) => ({ name, minDark,
                bbox: [rect[0] / width * 1000, rect[1] / height * 1000,
                    rect[2] / width * 1000, rect[3] / height * 1000] });
            return [
                region('panel-label', [x + 18, y + 15, x + 30, y + 24]),
                region('axis-label', [x + 32, y + 15, Math.min(right - 2, x + 76), y + 24]),
                region('axis-line', [x + 10, y + 38, x + 14, bottom - 18]),
                region('arrow', [x + 7, y + 24, x + 17, y + 33]),
                region('tick-labels', [x + 18, bottom - 13, x + 46, bottom - 4]),
                { name: 'bitmap-inset', point: [(right - 35) / width * 1000, (bottom - 50) / height * 1000],
                    color: [0, 170, 255] },
            ];
        }));
        for (const group of groups) {
            if (group.legend) page.featureProbes.push({ name: 'shared-legend', bbox: group.legend.bbox, minDark: 4 });
        }
        if (caseID === 'grid-hole') page.pixelProbes.push({ name: 'missing-cell', point: [800, 700], color: [255, 255, 255] });
        const pageObject = objects.length + 1;
        kids.push(pageObject);
        objects.push('');
        const contentObject = objects.length + 1;
        let content;
        if (page.scanOnly) {
            const pixels = await rasterScene(page);
            const scanObject = contentObject + 1;
            content = `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q`;
            objects.push(stream('', content));
            objects.push(stream('/Type /XObject /Subtype /Image /Width 600 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode', pixels + '>'));
            page.scanObject = scanObject;
        }
        else {
            const inverse = invert(viewportTransform);
            content = `q ${inverse.join(' ')} cm\n${drawPage(page)}\nQ`;
            objects.push(stream('', content));
        }
        objects[pageObject - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(' ')}] /CropBox [${cropBox.join(' ')}] /Rotate ${rotation} /UserUnit ${userUnit} /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R ${page.scanObject ? `/Scan ${page.scanObject} 0 R` : ''} >> >> /Contents ${contentObject} 0 R >>`;
        delete page.scanObject;
    }
    manifest.cases[caseID] = scene;
}
objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
objects[1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
await mkdir(root, { recursive: true });
await writeFile(new URL('compound-figures.pdf', root), serializePDF(objects));
await writeFile(new URL('compound-figures.expected.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Generated ${kids.length} fixture pages.`);

function drawPage(page) {
    const px = x => x * page.width / 1000;
    const py = y => y * page.height / 1000;
    const commands = ['1 1 1 rg', `0 0 ${page.width} ${page.height} re f`];
    for (const heading of page.headings) {
        commands.push(text(heading.text, px(heading.bbox[0]), py(heading.bbox[1]) + 10, 9));
    }
    for (const group of page.groups) {
        for (const [index, box] of group.panels.entries()) {
            const [x, y, right, bottom] = [px(box[0]), py(box[1]), px(box[2]), py(box[3])];
            commands.push(panelColor(index).map(value => value / 255).join(' ') + ' rg',
                `${x} ${y} ${right - x} ${bottom - y} re f`, '0.12 0.12 0.12 RG 1 w',
                `${x} ${y} ${right - x} ${bottom - y} re S`,
                `${x + 12} ${bottom - 16} m ${x + 12} ${y + 25} l ${x + 9} ${y + 31} l S`,
                `${x + 12} ${y + 25} m ${x + 15} ${y + 31} l S`,
                `${x + 12} ${bottom - 16} m ${right - 12} ${bottom - 16} l S`,
                `q 30 0 0 -20 ${right - 40} ${bottom - 35} cm /Im1 Do Q`,
                text(`(${String.fromCharCode(97 + index)}) Axis value`, x + 18, y + 23, 8),
                text('0 1 2 3', x + 18, bottom - 5, 8));
        }
        if (group.legend) commands.push(text(group.legend.text,
            px(group.legend.bbox[0]), py(group.legend.bbox[1]) + 11, 8));
        commands.push(text(group.caption, px(group.captionBBox[0]), py(group.captionBBox[1]) + 12, 11));
    }
    for (const column of page.columns || []) {
        const words = column.text.split(' ');
        for (let i = 0; i < words.length; i += 5) {
            commands.push(text(words.slice(i, i + 5).join(' '), px(column.bbox[0]),
                py(column.bbox[1]) + 12 + i / 5 * 12, 9));
        }
    }
    commands.push(text(page.bodyText, px(100), py(965), 10));
    return commands.join('\n');
}

function panelColor(index) {
    return [[216, 235, 250], [245, 215, 207], [209, 237, 214], [236, 223, 250]][index % 4];
}

async function rasterScene(page) {
    const scanObjects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
        objects[2],
        objects[3],
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents 6 0 R >>',
        stream('', 'q 1 0 0 -1 0 800 cm\n' + drawPage(page) + '\nQ'),
    ];
    const task = getDocument({
        data: serializePDF(scanObjects),
        useSystemFonts: false,
        standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
        isEvalSupported: false,
    });
    const canvas = createCanvas(600, 800);
    try {
        const document = await task.promise;
        const pdfPage = await document.getPage(1);
        await pdfPage.render({
            canvas,
            viewport: pdfPage.getViewport({ scale: 1 }),
            background: 'rgb(255, 255, 255)',
        }).promise;
        const rgba = canvas.getContext('2d').getImageData(0, 0, 600, 800).data;
        const rgb = new Uint8Array(600 * 800 * 3);
        for (let i = 0; i < 600 * 800; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
        return Buffer.from(rgb).toString('hex');
    }
    finally {
        canvas.width = canvas.height = 0;
        await task.destroy();
    }
}

function text(value, x, y, size) {
    return `0 0 0 rg BT /F1 ${size} Tf 1 0 0 -1 ${x} ${y} Tm (${value.replace(/[\\()]/g, '\\$&')}) Tj ET`;
}

function transform([x0, y0, x1, y1], rotation, unit) {
    return ({ 0: [1, 0, 0, -1, -x0, y1], 90: [0, 1, 1, 0, -y0, -x0],
        180: [-1, 0, 0, 1, x1, -y0], 270: [0, -1, -1, 0, y1, x1] })[rotation].map(value => value * unit);
}

function invert([a, b, c, d, e, f]) {
    const determinant = a * d - b * c;
    return [d / determinant, -b / determinant, -c / determinant, a / determinant,
        (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}

function stream(dictionary, content) {
    return `<< ${dictionary} /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`;
}

function serializePDF(values) {
    let source = '%PDF-1.7\n';
    const offsets = [0];
    for (const [index, value] of values.entries()) {
        offsets.push(new TextEncoder().encode(source).length);
        source += `${index + 1} 0 obj\n${value}\nendobj\n`;
    }
    const xref = new TextEncoder().encode(source).length;
    source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
    source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(source);
}
