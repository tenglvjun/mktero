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

export function makeTwoColumnFigureInput({ variant = 'split-caption', axisInMarkdown = true } = {}) {
    const provider = 'mineru';
    const pageIndex = 0;
    const axisText = "'Go' cue at time t = 0 s";
    const bodyText = 'deactivation spreading far from the somatotopic hotspot, overlapping receptive fields and intereffector regions with whole-body intermixing across the cortex.';
    const bodyText2 = 'In previous work using microelectrode arrays capable of recording brain activity at single-neuron resolution, we have shown that a small anatomically distinct area of the cortex contains intermixed representations of the entire body.';
    const bodyText3 = 'Here we revisit the motor representation of the whole body across a wide span of the PCG using microelectrode recordings from eight human participants with paralysis.';
    const captionLeft = variant === 'reversed-caption'
        ? 'Fig. 2 | Regional organization of whole-body movement tuning in the PCG. a, Neural tuning to 46 attempted movements across the body was evaluated for each'
        : 'Fig. 1 | Sampling the length of the PCG to assess whole-body movement representation. a, Diagram of the dorsal, middle and ventral regions of the PCG sampled in this study.';
    const captionRight = variant === 'reversed-caption'
        ? 'multiple arrays from the same participant in a medial-to-lateral sequence. All arrays were placed in the left PCG.'
        : 'participant using an instructed delay task while they were positioned upright, either seated in a chair or in a bed at an incline.';
    const reversed = variant === 'reversed-caption';
    const panelBoxes = reversed
        ? [[[63.9, 65.8, 944.5, 339.2]], [[90.8, 348.1, 255.5, 560.8]], [[255.5, 345.6, 833.6, 564.6]]]
        : [[[60.5, 57.0, 477.3, 227.8]], [[62.2, 248.1, 316.0, 432.9]], [[280.7, 249.4, 507.6, 415.2]],
            [[512.6, 58.2, 912.6, 236.7]], [[504.2, 248.1, 737.8, 417.7]], [[726.1, 248.1, 947.9, 400.0]]];
    const blocks = [];
    const assets = [];
    const chunks = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `${provider}:p${pageIndex}:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    let panelIndex = 0;
    const addPanel = (parentId, type, bbox) => {
        const path = `images/panel-${panelIndex}.png`;
        panelIndex++;
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        add({ type, role: 'panel', bboxKind: 'visual-body', bbox: [...bbox],
            assetPath: path, parentId });
        chunks.push(`![](${path})`);
    };
    if (reversed) {
        add({ type: 'text', role: 'unknown', bboxKind: 'text', text: 'b',
            bbox: [65.5, 344.3, 79.0, 357.0] });
        chunks.push('b');
        const top = add({ type: 'image', role: 'unknown', bboxKind: 'group',
            bbox: [63.9, 65.8, 944.5, 339.2] });
        addPanel(top, 'image', panelBoxes[0][0]);
        const left = add({ type: 'image', role: 'unknown', bboxKind: 'group',
            bbox: [90.8, 348.1, 255.5, 560.8] });
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: captionRight,
            parentId: left, bbox: [507.6, 569.6, 944.5, 672.2] });
        chunks.push(captionRight);
        addPanel(left, 'image', panelBoxes[1][0]);
        const wide = add({ type: 'image', role: 'unknown', bboxKind: 'group',
            bbox: [255.5, 345.6, 833.6, 564.6] });
        addPanel(wide, 'image', panelBoxes[2][0]);
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: captionLeft,
            parentId: wide, bbox: [60.5, 569.6, 490.8, 684.8] });
        chunks.push(captionLeft);
        add({ type: 'text', role: 'unknown', bboxKind: 'text', text: bodyText,
            bbox: [58.8, 711.4, 497.5, 834.2] });
        chunks.push(bodyText);
    }
    else {
        if (axisInMarkdown) {
            add({ type: 'text', role: 'unknown', bboxKind: 'text', text: axisText,
                bbox: [835.3, 427.8, 942.9, 440.5] });
            chunks.push(axisText);
        }
        const a = add({ type: 'image', role: 'unknown', bboxKind: 'group',
            bbox: [60.5, 57.0, 477.3, 227.8] });
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: 'b',
            parentId: a, bbox: [510.9, 59.5, 524.4, 70.9] });
        chunks.push('b');
        addPanel(a, 'image', panelBoxes[0][0]);
        const c1 = add({ type: 'chart', role: 'unknown', bboxKind: 'group',
            bbox: [62.2, 248.1, 316.0, 432.9] });
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: 'c',
            parentId: c1, bbox: [63.9, 238.0, 79.0, 248.1] });
        chunks.push('c');
        addPanel(c1, 'chart', panelBoxes[1][0]);
        const c2 = add({ type: 'chart', role: 'unknown', bboxKind: 'group',
            bbox: [280.7, 249.4, 507.6, 415.2] });
        addPanel(c2, 'chart', panelBoxes[2][0]);
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: captionLeft,
            parentId: c2, bbox: [58.8, 446.8, 484.0, 562.0] });
        chunks.push(captionLeft);
        for (const [text, bbox] of [
            [bodyText, [58.8, 588.6, 497.5, 751.9]],
            [bodyText2, [58.8, 751.9, 497.5, 902.5]],
            [bodyText3, [60.5, 902.5, 497.5, 944.3]],
        ]) {
            add({ type: 'text', role: 'unknown', bboxKind: 'text', text, bbox });
            chunks.push(text);
        }
        const b = add({ type: 'image', role: 'unknown', bboxKind: 'group',
            bbox: [512.6, 58.2, 912.6, 236.7] });
        addPanel(b, 'image', panelBoxes[3][0]);
        const c3 = add({ type: 'chart', role: 'unknown', bboxKind: 'group',
            bbox: [504.2, 248.1, 737.8, 417.7] });
        addPanel(c3, 'chart', panelBoxes[4][0]);
        const c4 = add({ type: 'chart', role: 'unknown', bboxKind: 'group',
            bbox: [726.1, 248.1, 947.9, 400.0] });
        addPanel(c4, 'chart', panelBoxes[5][0]);
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: captionRight,
            parentId: c4, bbox: [507.6, 446.8, 934.5, 562.0] });
        chunks.push(captionRight);
    }
    const markdown = chunks.join('\n\n');
    return {
        axisText, bodyText, captionLeft, captionRight,
        panelPaths: assets.map(asset => asset.path),
        crop: createTestPNG(800, 750),
        input: {
            provider, markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex, width: 595, height: 790, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: blocks.filter(block => block.bboxKind !== 'group'),
            providerState: {},
        },
    };
}
