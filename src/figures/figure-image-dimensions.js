export function figureImageDimensions(asset) {
    const bytes = asset?.data;
    if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (asset.mimeType === 'image/png') {
        if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
            || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return null;
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (asset.mimeType !== 'image/jpeg' || view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    let segments = 0;
    while (offset + 4 <= bytes.length && ++segments <= 4096) {
        if (bytes[offset++] !== 0xff) return null;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return null;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        const length = view.getUint16(offset);
        if (length < 2 || offset + length > bytes.length) return null;
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            if (length < 8) return null;
            return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
        }
        offset += length;
    }
    return null;
}
