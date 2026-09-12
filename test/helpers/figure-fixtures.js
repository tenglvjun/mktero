import { zlibSync } from 'fflate';

export function createTestPNG(width = 8, height = 8) {
    const scanlines = new Uint8Array(height * (1 + width * 4)).fill(255);
    for (let y = 0; y < height; y++) scanlines[y * (1 + width * 4)] = 0;
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 6;
    const chunks = [
        Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlibSync(scanlines)),
        pngChunk('IEND', new Uint8Array()),
    ];
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

function pngChunk(name, data) {
    const result = new Uint8Array(data.length + 12);
    const view = new DataView(result.buffer);
    view.setUint32(0, data.length);
    result.set(new TextEncoder().encode(name), 4);
    result.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, 8 + data.length)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
    return result;
}

export function makeFigureInput({
    boxes = [[100, 100, 450, 400], [550, 100, 900, 400],
        [100, 550, 450, 850], [550, 550, 900, 850]],
    provider = 'mineru',
    interleave = true,
    repeated = false,
    parent = true,
} = {}) {
    const caption = 'Figure 1. Treatment response in four panels.';
    const label = repeated ? 'Accuracy' : 'Time since treatment (days)';
    const bodyText = 'Body text outside the figure. See Fig. 1.'
        + (repeated ? ' Accuracy' : '');
    const blocks = [];
    const assets = [];
    const chunks = [];
    const panelPaths = [];
    const parentId = parent ? `${provider}:p0:b0` : null;
    const addBlock = block => {
        const sourceOrdinal = blocks.length;
        blocks.push({
            id: `${provider}:p0:b${sourceOrdinal}`,
            sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block,
        });
    };
    if (parent) addBlock({ type: 'image', role: 'unknown', bboxKind: 'group',
        bbox: [100, 100, 900, 950] });
    for (const [index, bbox] of boxes.entries()) {
        const path = `images/panel-${index}.png`;
        panelPaths.push(path);
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        addBlock({ type: 'image', role: 'panel', bboxKind: 'visual-body',
            bbox: [...bbox], assetPath: path, parentId });
        chunks.push(`![](${path})`);
        if (interleave && (index === 0 || (repeated && index === 1))) {
            addBlock({ type: 'text', role: 'figure-text', bboxKind: 'text',
                text: label, parentId,
                bbox: [bbox[0] + 10, bbox[1] + 10, bbox[2] - 10, bbox[1] + 30] });
            chunks.push(label);
        }
        if (interleave && index === 0) {
            addBlock({ type: 'text', role: 'body', bboxKind: 'text',
                text: bodyText, bbox: [100, 960, 900, 990] });
            chunks.push(bodyText);
        }
    }
    addBlock({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: caption, parentId, bbox: [100, 880, 900, 950] });
    chunks.push(caption);
    const markdown = chunks.join('\n\n');
    return {
        caption, label, axisLabel: label, bodyText, panelPaths,
        input: {
            provider, markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt',
                dpi: null, coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: blocks.filter(block => block.bboxKind !== 'group'),
            providerState: {},
        },
    };
}
