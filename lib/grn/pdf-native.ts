import zlib from 'node:zlib';

/**
 * Reading a PDF with no external tools (v2.10.2).
 *
 * The earlier build needed Poppler for the page count, the text layer and the page images, and
 * Tesseract for scans. On a machine with neither, nothing worked at all — the wizard could only
 * report what was missing. This module removes that dependency for everything except the actual
 * character recognition:
 *
 *   - the real page count, from the page tree;
 *   - the embedded text layer, decoded from the content streams (so a digitally produced GRN or
 *     Tally bill is read exactly, with no tools and no recognition);
 *   - the page image of a scan, lifted straight out of the file — a JPEG-compressed page (which
 *     is what the supplied scanner produces) is already a JPEG, and a Flate-compressed one is
 *     re-wrapped as a PNG.
 *
 * So a text PDF is fully imported anywhere, and a scanned PDF can always be read on screen and
 * typed in by hand. Only turning a scan's pixels into characters still needs Tesseract.
 *
 * Node's zlib is the only thing used. Nothing here executes anything or reaches the network.
 */
export type NativePage = { page: number; text: string; width: number; height: number; images: Array<{ ref: string; mime: string; bytes: Buffer; width: number; height: number }>; imageNotes: string[] };
export type NativeDocument = { ok: boolean; pageCount: number; pages: NativePage[]; encrypted: boolean; note: string };

type Obj = { num: number; raw: string; stream: Buffer | null };

const LATIN = 'latin1' as const;

/** Every `N G obj … endobj` in the file, plus any objects inside object streams. */
function scanObjects(buf: Buffer): Map<number, Obj> {
  const s = buf.toString(LATIN);
  const out = new Map<number, Obj>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endIdx = s.indexOf('endobj', bodyStart);
    const streamIdx = s.indexOf('stream', bodyStart);
    let raw: string; let stream: Buffer | null = null;
    if (streamIdx >= 0 && (endIdx < 0 || streamIdx < endIdx)) {
      raw = s.slice(bodyStart, streamIdx);
      let dataStart = streamIdx + 'stream'.length;
      if (s[dataStart] === '\r') dataStart++;
      if (s[dataStart] === '\n') dataStart++;
      const declared = Number(/\/Length\s+(\d+)\b/.exec(raw)?.[1] || 0);
      let dataEnd = declared > 0 ? dataStart + declared : -1;
      // A wrong or indirect /Length is common; fall back to the endstream marker.
      if (dataEnd < 0 || s.slice(dataEnd, dataEnd + 20).indexOf('endstream') < 0) {
        const marker = s.indexOf('endstream', dataStart);
        dataEnd = marker < 0 ? dataStart : marker;
      }
      stream = buf.subarray(dataStart, dataEnd);
    } else {
      raw = s.slice(bodyStart, endIdx < 0 ? bodyStart : endIdx);
    }
    out.set(num, { num, raw, stream });
  }
  // Objects packed into /ObjStm streams (newer producers).
  for (const o of [...out.values()]) {
    if (!o.stream || !/\/Type\s*\/ObjStm/.test(o.raw)) continue;
    let data: Buffer;
    try { data = decodeStream(o.raw, o.stream); } catch { continue; }
    const n = Number(/\/N\s+(\d+)/.exec(o.raw)?.[1] || 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.raw)?.[1] || 0);
    if (!n || !first) continue;
    const header = data.subarray(0, first).toString(LATIN).trim().split(/\s+/).map(Number);
    const body = data.subarray(first).toString(LATIN);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2]; const off = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const next = i + 1 < n ? header[(i + 1) * 2 + 1] : body.length;
      if (!out.has(num)) out.set(num, { num, raw: body.slice(off, next), stream: null });
    }
  }
  return out;
}

function decodeStream(dict: string, data: Buffer): Buffer {
  const filter = /\/Filter\s*\/(\w+)/.exec(dict)?.[1] || (/\/Filter\s*\[\s*\/(\w+)/.exec(dict)?.[1] || '');
  if (!filter || filter === 'DCTDecode' || filter === 'JPXDecode') return data;
  if (filter === 'FlateDecode') {
    try { return zlib.inflateSync(data); } catch { /* try raw deflate below */ }
    try { return zlib.inflateRawSync(data); } catch { return Buffer.alloc(0); }
  }
  if (filter === 'ASCIIHexDecode') return Buffer.from(data.toString(LATIN).replace(/[^0-9a-fA-F]/g, ''), 'hex');
  return Buffer.alloc(0);
}

const refOf = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

/** The pages, in document order: the page tree when it resolves, else file order. */
function orderedPages(objects: Map<number, Obj>): Obj[] {
  const isPage = (o: Obj) => /\/Type\s*\/Page\b/.test(o.raw) && !/\/Type\s*\/Pages\b/.test(o.raw);
  const root = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.raw));
  const pagesRef = root ? refOf(root.raw, 'Pages') : null;
  const out: Obj[] = [];
  const seen = new Set<number>();
  const walk = (num: number | null, depth = 0) => {
    if (num === null || depth > 32 || seen.has(num)) return;
    seen.add(num);
    const node = objects.get(num);
    if (!node) return;
    if (isPage(node)) { out.push(node); return; }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node.raw)?.[1] || '';
    for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), depth + 1);
  };
  walk(pagesRef);
  if (out.length) return out;
  return [...objects.values()].filter(isPage).sort((a, b) => a.num - b.num);
}

/** Text drawn by a content stream: Tj, TJ, ' and " operands, with PDF string escapes. */
function textFromContent(content: string): string {
  const parts: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bTJ\b|\bTj\b|\bT\*\b|\bTD\b|\bTd\b|\bET\b|'|"/g;
  let m: RegExpExecArray | null; let pending: string[] = [];
  const flush = (newline: boolean) => { if (pending.length) { parts.push(pending.join('')); pending = []; } if (newline) parts.push('\n'); };
  while ((m = re.exec(content))) {
    const t = m[0];
    if (t.startsWith('(')) pending.push(unescapePdf(t.slice(1, -1)));
    else if (t.startsWith('<')) pending.push(Buffer.from(t.slice(1, -1).replace(/\s/g, ''), 'hex').toString(LATIN));
    else if (t === 'Tj' || t === 'TJ' || t === "'" || t === '"') flush(t === "'" || t === '"');
    else if (t === 'T*' || t === 'TD' || t === 'Td' || t === 'ET') flush(true);
  }
  flush(false);
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function unescapePdf(s: string) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, g) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as any)[g] || g;
  });
}

const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf: Buffer) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Wrap raw 8-bit samples as a PNG, so a Flate-compressed scan can still be shown. */
function samplesToPng(samples: Buffer, width: number, height: number, channels: 1 | 3) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    samples.copy(raw, y * (stride + 1) + 1, y * stride, Math.min((y + 1) * stride, samples.length));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Read the document: page count, page text, and a displayable image per page where there is one. */
export function readPdf(buf: Buffer, opts: { maxPages?: number; withImages?: boolean } = {}): NativeDocument {
  const head = buf.subarray(0, 1024).toString(LATIN);
  if (!head.startsWith('%PDF-')) return { ok: false, pageCount: 0, pages: [], encrypted: false, note: 'This file is not a PDF.' };
  const whole = buf.toString(LATIN);
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(whole.slice(-8192)) || /trailer[\s\S]{0,400}\/Encrypt/.test(whole);
  if (encrypted) return { ok: false, pageCount: 0, pages: [], encrypted: true, note: 'This PDF is password-protected.' };

  let objects: Map<number, Obj>;
  try { objects = scanObjects(buf); } catch (e: any) { return { ok: false, pageCount: 0, pages: [], encrypted: false, note: `The PDF structure could not be read (${String(e?.message || e).slice(0, 80)}).` }; }
  const pageObjs = orderedPages(objects);
  if (!pageObjs.length) return { ok: false, pageCount: 0, pages: [], encrypted: false, note: 'No pages were found in this PDF; the file may be damaged.' };

  const limit = Math.max(1, Math.min(opts.maxPages ?? 50, pageObjs.length));
  const pages: NativePage[] = [];
  for (let i = 0; i < limit; i++) {
    const page = pageObjs[i];
    const box = /\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)/.exec(page.raw);
    const width = box ? Math.abs(Number(box[3]) - Number(box[1])) : 595;
    const height = box ? Math.abs(Number(box[4]) - Number(box[2])) : 842;

    // Text: /Contents may be one stream or an array of them.
    let text = '';
    const contentRefs: number[] = [];
    const single = refOf(page.raw, 'Contents');
    if (single !== null) contentRefs.push(single);
    else {
      const arr = /\/Contents\s*\[([^\]]*)\]/.exec(page.raw)?.[1] || '';
      for (const k of arr.matchAll(/(\d+)\s+\d+\s+R/g)) contentRefs.push(Number(k[1]));
    }
    for (const ref of contentRefs) {
      const obj = objects.get(ref);
      if (!obj?.stream) continue;
      try { text += (text ? '\n' : '') + textFromContent(decodeStream(obj.raw, obj.stream).toString(LATIN)); } catch { /* unreadable stream */ }
    }

    const images: NativePage['images'] = [];
    const imageNotes: string[] = [];
    if (opts.withImages !== false) {
      const xobjects = /\/XObject\s*<<([\s\S]*?)>>/.exec(page.raw)?.[1] || '';
      let inherited = xobjects;
      if (!inherited) {
        const resRef = refOf(page.raw, 'Resources');
        const res = resRef !== null ? objects.get(resRef) : null;
        inherited = res ? (/\/XObject\s*<<([\s\S]*?)>>/.exec(res.raw)?.[1] || '') : '';
      }
      for (const entry of inherited.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
        const obj = objects.get(Number(entry[2]));
        if (!obj?.stream || !/\/Subtype\s*\/Image/.test(obj.raw)) continue;
        const w = Number(/\/Width\s+(\d+)/.exec(obj.raw)?.[1] || 0);
        const h = Number(/\/Height\s+(\d+)/.exec(obj.raw)?.[1] || 0);
        const filter = /\/Filter\s*\/?\[?\s*\/(\w+)/.exec(obj.raw)?.[1] || '';
        const bpc = Number(/\/BitsPerComponent\s+(\d+)/.exec(obj.raw)?.[1] || 8);
        if (filter === 'DCTDecode') { images.push({ ref: entry[1], mime: 'image/jpeg', bytes: obj.stream, width: w, height: h }); continue; }
        if (filter === 'FlateDecode' && bpc === 8 && w && h) {
          const colour = /\/ColorSpace\s*\/Device(RGB|Gray)/.exec(obj.raw)?.[1];
          if (colour) {
            try {
              const samples = decodeStream(obj.raw, obj.stream);
              images.push({ ref: entry[1], mime: 'image/png', bytes: samplesToPng(samples, w, h, colour === 'RGB' ? 3 : 1), width: w, height: h });
              continue;
            } catch { /* fall through to the note */ }
          }
        }
        imageNotes.push(`Page ${i + 1} holds a ${filter || 'compressed'} image this build cannot convert for display.`);
      }
    }
    pages.push({ page: i + 1, text, width, height, images, imageNotes });
  }
  return { ok: true, pageCount: pageObjs.length, pages, encrypted: false, note: pageObjs.length > limit ? `Only the first ${limit} of ${pageObjs.length} pages were read.` : '' };
}

/** The largest image on a page — for a scan that is the page itself. */
export function pageImage(buf: Buffer, page: number): { mime: string; bytes: Buffer } | null {
  const doc = readPdf(buf, { maxPages: Math.max(1, page), withImages: true });
  const p = doc.pages.find((x) => x.page === page);
  if (!p || !p.images.length) return null;
  const best = [...p.images].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return { mime: best.mime, bytes: best.bytes };
}
