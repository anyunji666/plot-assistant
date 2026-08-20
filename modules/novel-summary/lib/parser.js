// ============================================================
// 小说文件解析（.txt / .mobi）与分段工具
// ============================================================

const NI_SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function niRotateRight(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
}

function niSha256HexFallback(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(input);
    padded[input.length] = 0x80;

    const bitLength = input.length * 8;
    const paddedView = new DataView(padded.buffer);
    paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    paddedView.setUint32(paddedLength - 4, bitLength >>> 0);

    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const words = new Uint32Array(64);

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = paddedView.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const x = words[i - 15];
            const y = words[i - 2];
            const sigma0 = niRotateRight(x, 7) ^ niRotateRight(x, 18) ^ (x >>> 3);
            const sigma1 = niRotateRight(y, 17) ^ niRotateRight(y, 19) ^ (y >>> 10);
            words[i] = (words[i - 16] + sigma0 + words[i - 7] + sigma1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = hash;
        for (let i = 0; i < 64; i++) {
            const sum1 = niRotateRight(e, 6) ^ niRotateRight(e, 11) ^ niRotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choose + NI_SHA256_CONSTANTS[i] + words[i]) >>> 0;
            const sum0 = niRotateRight(a, 2) ^ niRotateRight(a, 13) ^ niRotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }

        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }

    return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
}

export async function fingerprintArrayBuffer(buffer, subtle = globalThis.crypto?.subtle) {
    const bytes = buffer instanceof ArrayBuffer
        ? buffer
        : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    if (typeof subtle?.digest === 'function') {
        try {
            const digest = await subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        } catch (error) {
            console.warn('[NS] 浏览器 SHA-256 不可用，改用兼容实现:', error);
        }
    }
    return niSha256HexFallback(new Uint8Array(bytes));
}

// ============================================================
// 分段
// ============================================================

export function splitNovelText(text, kb, charsPerByte = 0.5) {
    const safeText = String(text || '');
    const ratio = Number(charsPerByte) > 0 ? Number(charsPerByte) : 0.5;
    const targetChars = Math.max(1, Math.round(Number(kb) * 1024 * ratio));
    const chunks = [];
    let start = 0;

    while (start < safeText.length) {
        let end = start + targetChars;
        if (end >= safeText.length) {
            chunks.push(safeText.slice(start));
            break;
        }
        const lookAhead = safeText.indexOf('\n', end);
        if (lookAhead !== -1 && lookAhead - end < 500) end = lookAhead + 1;
        chunks.push(safeText.slice(start, end));
        start = end;
    }
    return chunks;
}

// 取一段原文末尾的"衔接参考"文本：从目标长度处开始，向后找最近的句末标点/换行，
// 让参考内容从整句开头开始，而不是从半句中间硬切。
export function tailContext(text, targetChars = 60, lookAheadChars = 40) {
    const safeText = String(text || '');
    if (safeText.length <= targetChars) return safeText.trim();

    const rawStart = safeText.length - targetChars;
    const window = safeText.slice(rawStart, rawStart + lookAheadChars);
    const match = window.match(/[。！？!?\n]/);
    const start = match ? rawStart + match.index + 1 : rawStart;
    return safeText.slice(start).trim();
}

// ============================================================
// 文件类型 / 编码
// ============================================================

export function detectEncoding(buf) {
    const b = new Uint8Array(buf);
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return 'utf-8';
    if (b[0] === 0xFF && b[1] === 0xFE) return 'utf-16le';
    if (b[0] === 0xFE && b[1] === 0xFF) return 'utf-16be';
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return 'utf-8';
    } catch (_) {
        return 'gb18030';
    }
}

export function niNovelFileExt(fileName = '') {
    const match = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? `.${match[1]}` : '';
}

export function niIsSupportedNovelFile(file) {
    return ['.txt', '.mobi'].includes(niNovelFileExt(file?.name || ''));
}

// ============================================================
// MOBI 解析
// ============================================================

function niReadAscii(u8, start, len) {
    let text = '';
    for (let i = 0; i < len && start + i < u8.length; i++) text += String.fromCharCode(u8[start + i]);
    return text;
}

function niConcatBytes(parts, limit = 0) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const outLen = limit > 0 ? Math.min(limit, total) : total;
    const out = new Uint8Array(outLen);
    let pos = 0;
    for (const part of parts) {
        if (pos >= outLen) break;
        out.set(part.slice(0, outLen - pos), pos);
        pos += Math.min(part.length, outLen - pos);
    }
    return out;
}

function niPalmDocDecompress(input, opts = {}) {
    const out = [];
    for (let i = 0; i < input.length;) {
        const c = input[i++];
        if (c === 0) {
            out.push(0);
        } else if (c <= 8) {
            for (let j = 0; j < c && i < input.length; j++) out.push(input[i++]);
        } else if (c <= 0x7f) {
            out.push(c);
        } else if (c <= 0xbf) {
            if (i >= input.length) break;
            const c2 = input[i++];
            const pair = ((c & 0x3f) << 8) | c2;
            const distance = pair >> 3;
            const length = (c2 & 0x07) + 3;
            if (distance <= 0 || distance > out.length) {
                if (!opts.tolerant) throw new Error('MOBI 解压失败：压缩引用无效');
                continue;
            }
            for (let j = 0; j < length; j++) out.push(out[out.length - distance]);
        } else {
            out.push(0x20, c ^ 0x80);
        }
    }
    return new Uint8Array(out);
}

function niMobiTrailingEntrySize(u8, end) {
    let pos = end;
    let value = 0;
    let shift = 0;
    while (pos > 0 && shift < 28) {
        const byte = u8[--pos];
        value |= (byte & 0x7f) << shift;
        shift += 7;
        if (byte & 0x80) return Math.min(value, end);
    }
    return 0;
}

function niStripMobiTrailingData(u8, extraFlags = 0) {
    let end = u8.length;
    let flags = extraFlags >> 1;
    while (flags && end > 0) {
        if (flags & 1) {
            const size = niMobiTrailingEntrySize(u8, end);
            if (!size || size > end) break;
            end -= size;
        }
        flags >>= 1;
    }
    if ((extraFlags & 1) && end > 0) {
        const overlap = u8[end - 1] & 0x03;
        if (overlap <= end) end -= overlap;
    }
    return end < u8.length ? u8.slice(0, end) : u8;
}

function niMobiTextEncoding(code) {
    if (code === 65001) return 'utf-8';
    if (code === 1252) return 'windows-1252';
    if (code === 932) return 'shift_jis';
    if (code === 936) return 'gb18030';
    if (code === 949) return 'euc-kr';
    if (code === 950) return 'big5';
    if (code === 1200) return 'utf-16le';
    if (code === 54936) return 'gb18030';
    return 'utf-8';
}

function niMobiCompressionName(code) {
    if (code === 1) return '无压缩';
    if (code === 2) return 'PalmDOC';
    if (code === 17480) return 'Huff/CDIC';
    return `未知类型 ${code}`;
}

function niDecodeHtmlEntities(text) {
    const el = document.createElement('textarea');
    el.innerHTML = text;
    return el.value;
}

function niMobiHtmlToText(html) {
    const text = String(html || '')
        .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '\n')
        .replace(/<!--[\s\S]*?-->/g, '\n')
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\s*\/\s*(p|div|h[1-6]|li|blockquote|section|article|tr)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, '');
    return niDecodeHtmlEntities(text)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function niExtractMobiText(buf) {
    const u8 = new Uint8Array(buf);
    const view = new DataView(buf);
    if (u8.length < 86) throw new Error('MOBI 文件过小或格式不完整');

    const recordCount = view.getUint16(76, false);
    if (!recordCount || 78 + recordCount * 8 > u8.length) throw new Error('MOBI 记录表损坏');

    const records = [];
    for (let i = 0; i < recordCount; i++) {
        const pos = 78 + i * 8;
        const start = view.getUint32(pos, false);
        const end = i + 1 < recordCount ? view.getUint32(pos + 8, false) : u8.length;
        if (start >= u8.length || end > u8.length || end < start) throw new Error('MOBI 记录偏移异常');
        records.push({ start, end });
    }

    const header = records[0];
    if (header.end - header.start < 32) throw new Error('MOBI 头部不完整');

    const compression = view.getUint16(header.start, false);
    const textLength = view.getUint32(header.start + 4, false);
    const textRecords = view.getUint16(header.start + 8, false);
    const encryption = view.getUint16(header.start + 12, false);
    if (encryption) throw new Error('这是加密/DRM MOBI，浏览器插件无法直接读取正文；请先用你有权限的工具导出为 TXT 后再上传。');
    if (compression === 17480) throw new Error('这是 Huff/CDIC 压缩 MOBI，当前浏览器端解析器暂不支持；请先转换为 TXT 后上传。');
    if (compression !== 1 && compression !== 2) throw new Error(`暂不支持此 MOBI 压缩类型：${niMobiCompressionName(compression)}。`);

    const mobiHeader = header.start + 16;
    if (niReadAscii(u8, mobiHeader, 4) !== 'MOBI') throw new Error('未找到 MOBI 头部');
    const mobiHeaderLen = view.getUint32(mobiHeader + 4, false);
    const encodingCode = view.getUint32(mobiHeader + 12, false);
    const encoding = niMobiTextEncoding(encodingCode);
    const extraFlags = mobiHeaderLen >= 244 && mobiHeader + 0xf4 <= header.end
        ? view.getUint16(mobiHeader + 0xf2, false)
        : 0;

    const parts = [];
    const lastTextRecord = Math.min(textRecords, records.length - 1);
    let tolerantUsed = false;
    for (let i = 1; i <= lastTextRecord; i++) {
        const record = records[i];
        const raw = niStripMobiTrailingData(u8.slice(record.start, record.end), extraFlags);
        if (compression === 2) {
            try {
                parts.push(niPalmDocDecompress(raw));
            } catch (error) {
                if (!tolerantUsed) console.warn('[NS] MOBI 严格解压失败，已切换容错提取。');
                tolerantUsed = true;
                parts.push(niPalmDocDecompress(raw, { tolerant: true }));
            }
        } else {
            parts.push(raw);
        }
    }

    const textBytes = niConcatBytes(parts, textLength);
    let html;
    try {
        html = new TextDecoder(encoding).decode(textBytes);
    } catch (_) {
        html = new TextDecoder('utf-8').decode(textBytes);
    }

    const text = niMobiHtmlToText(html);
    if (!text) throw new Error('MOBI 中没有提取到可用正文');
    return { text, sourceBytes: textBytes.length };
}

export function niExtractNovelText(buf, fileName) {
    const ext = niNovelFileExt(fileName);
    if (ext === '.mobi') return niExtractMobiText(buf);

    const encoding = detectEncoding(buf);
    const text = new TextDecoder(encoding).decode(buf);
    return { text, sourceBytes: new Uint8Array(buf).length };
}
