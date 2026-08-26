"use strict";

// =====================================================================================
// 小说文件解析（.txt / .mobi）与分段工具
// =====================================================================================

// =====================================================================================
// 分段
// =====================================================================================

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

// 从上一段"已生成的摘要"里取"最后一整块"衔接参考：定位最后一个"## 章节名"标题，
// 连同其下方的事件行一起整块取出，不再按字符数硬切——避免把"年份/月份：事件"这样的
// 一行摘要从中间截断。如果摘要文本里没有"## "标题（比如用户自定义了别的输出格式），
// 就把整段摘要原样返回，交给上层再自行决定是否要处理过长的情况。
export function summaryTailSection(summaryText) {
    const text = String(summaryText || '').trim();
    if (!text) return '';
    const lastHeadingIdx = text.lastIndexOf('## ');
    if (lastHeadingIdx === -1) return text;
    return text.slice(lastHeadingIdx).trim();
}

// =====================================================================================
// 文件类型 / 编码
// =====================================================================================

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

// =====================================================================================
// MOBI 解析
// =====================================================================================

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
