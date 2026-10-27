// doc.js - turns a PDF or EPUB into sentences ("chunks") and a chapter list.
// Same approach as the Windows Narrator: paragraphs -> sentences, running
// headers / footers / page numbers removed, chapters from the file's own
// table of contents (or from large headings when it has none).

import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

// ---------------------------------------------------------------- text tools
const ABBREV = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|cf|Fig|Figs|No|Vol|pp|Eq|Ch|Sec|Rev|Gen|Col|Lt|Mt)\.|\be\.g\.|\bi\.e\.|(?:^|\s)[A-Z]\.)$/;
const SENT_END = /[.!?…]+["”’')\]]*(?=\s+["“‘'(\[]?[A-Z0-9])/g;
const PAGE_NUM = /^(page\s*)?[\divxlc]{1,6}(\s*(of|\/)\s*\d+)?\.?$/i;

export function joinLines(lines) {
  let out = lines[0];
  for (const ln of lines.slice(1)) {
    if (/[A-Za-z][-­‐]$/.test(out) && /^[a-z]/.test(ln)) out = out.slice(0, -1) + ln;
    else out = out + ' ' + ln;
  }
  return out.replace(/­/g, '').replace(/\s+/g, ' ').trim();
}

export function splitSentences(text) {
  const out = [];
  let start = 0;
  SENT_END.lastIndex = 0;
  let m;
  while ((m = SENT_END.exec(text))) {
    const end = m.index + m[0].length;
    const seg = text.slice(start, end).trim();
    if (ABBREV.test(seg)) continue;
    out.push(seg);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function splitLong(s, maxlen = 280) {
  if (s.length <= maxlen) return [s];
  const mid = s.length >> 1;
  let best = -1;
  const re = /[;:,]\s|\s[-–—]\s|—/g;
  let m;
  while ((m = re.exec(s))) {
    const pos = m.index + m[0].length;
    if (best < 0 || Math.abs(pos - mid) < Math.abs(best - mid)) best = pos;
  }
  if (best < 40 || best > s.length - 40) {
    best = s.lastIndexOf(' ', mid);
    if (best <= 0) best = mid;
  }
  return [...splitLong(s.slice(0, best).trim(), maxlen), ...splitLong(s.slice(best).trim(), maxlen)];
}

const norm = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');

export function chunkWeight(c) {
  return c.text.length + (c.heading ? 14 : c.paraEnd ? 9 : 3);
}

// blocks: [{page, text, size, top, bottom, heading?}]  ->  chunks
function makeChunks(blocks) {
  const chunks = [];
  blocks.forEach((b, para) => {
    const n0 = chunks.length;
    for (const sent of splitSentences(b.text))
      for (const piece of splitLong(sent))
        if (piece) chunks.push({ text: piece, page: b.page, para, paraEnd: false, heading: !!b.heading });
    if (chunks.length > n0) chunks[chunks.length - 1].paraEnd = true;
  });
  return chunks;
}

function cleanBlocks(raw, npages, isEpub) {
  if (!raw.length) return [];
  // body font size = weighted median
  const sizes = raw.map(r => [r.size, r.text.length]).sort((a, b) => a[0] - b[0]);
  const total = sizes.reduce((s, x) => s + x[1], 0);
  let acc = 0, body = sizes[0][0];
  for (const [s, n] of sizes) { acc += n; if (acc >= total / 2) { body = s; break; } }

  if (!isEpub) {
    const key = t => t.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').trim();
    const inMargin = r => r.bottom < 0.13 || r.top > 0.87;
    const counts = new Map();
    for (const r of raw) if (inMargin(r)) counts.set(key(r.text), (counts.get(key(r.text)) || 0) + 1);
    const thresh = Math.max(3, 0.08 * npages);
    raw = raw.filter(r => !(inMargin(r) && (
      (PAGE_NUM.test(r.text.trim()) && r.size < body * 1.18) ||
      (r.text.length < 100 && (counts.get(key(r.text)) || 0) >= thresh))));
  }
  for (const r of raw) if (r.heading === undefined) r.heading = r.size >= body * 1.18 && r.text.length <= 120;

  // re-join paragraphs split by a page break
  const merged = [];
  for (const r of raw) {
    const p = merged[merged.length - 1];
    if (p && r.page === p.page + 1 && !p.heading && !r.heading &&
        !/[.!?:"”’)]$/.test(p.text) && /^[a-z]/.test(r.text)) {
      p.text = joinLines([p.text, r.text]);
    } else merged.push({ ...r });
  }
  return merged;
}

// ---------------------------------------------------------------- PDF
async function loadPdf(data, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const npages = pdf.numPages;
  const raw = [];
  for (let p = 1; p <= npages; p++) {
    if (onProgress && p % 5 === 0) onProgress(p / npages);
    const page = await pdf.getPage(p);
    const H = page.getViewport({ scale: 1 }).height || 1;
    const tc = await page.getTextContent();
    // 1. lines, in the file's own reading order
    const lines = [];
    let cur = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const x = it.transform[4], y = it.transform[5];
      const size = it.height || Math.hypot(it.transform[2], it.transform[3]) || 10;
      if (!cur || Math.abs(y - cur.y) > Math.max(2, size * 0.5)) {
        if (cur && cur.text.trim()) lines.push(cur);
        cur = { text: '', x, y, x2: x, size: 0 };
      }
      if (it.str) {
        if (cur.text && !/\s$/.test(cur.text) && !/^\s/.test(it.str) && x - cur.x2 > size * 0.15) cur.text += ' ';
        cur.text += it.str;
        if (it.str.trim()) cur.size = Math.max(cur.size, size);
        cur.x2 = x + (it.width || 0);
      }
      if (it.hasEOL) { if (cur.text.trim()) lines.push(cur); cur = null; }
    }
    if (cur && cur.text.trim()) lines.push(cur);
    // 2. paragraphs
    let block = null;
    const flush = () => {
      if (block) raw.push({ page: p - 1, text: joinLines(block.lines), size: block.size,
                            top: 1 - block.maxY / H, bottom: 1 - block.minY / H });
      block = null;
    };
    let prev = null;
    for (const ln of lines) {
      const t = ln.text.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const sz = ln.size || 10;
      let brk = !prev;
      if (prev) {
        const gap = prev.y - ln.y;
        if (Math.abs(sz - prev.size) > 0.15 * prev.size) brk = true;
        else if (gap > prev.size * 1.75 || gap < -prev.size) brk = true;
        else if (ln.x > prev.x + sz && /[.!?:"”]$/.test(prev.text.trim())) brk = true;
      }
      if (brk) { flush(); block = { lines: [], size: 0, minY: ln.y, maxY: ln.y + sz }; }
      block.lines.push(t);
      block.size = Math.max(block.size, sz);
      block.minY = Math.min(block.minY, ln.y);
      block.maxY = Math.max(block.maxY, ln.y + sz);
      prev = { ...ln, size: sz };
    }
    flush();
    page.cleanup();
  }
  const blocks = cleanBlocks(raw, npages, false);
  const chunks = makeChunks(blocks);

  // chapters from the PDF outline
  const toc = [];
  try {
    const outline = await pdf.getOutline();
    const walk = async (items, level) => {
      for (const o of items || []) {
        let pageIndex = -1;
        try {
          let dest = o.dest;
          if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            pageIndex = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          }
        } catch (e) { /* ignore broken links */ }
        if (pageIndex >= 0 && o.title) toc.push({ level, title: o.title.replace(/\s+/g, ' ').trim(), page: pageIndex });
        if (o.items && o.items.length) await walk(o.items, level + 1);
      }
    };
    await walk(outline, 1);
  } catch (e) { /* no outline */ }
  const title = ((await pdf.getMetadata().catch(() => null))?.info?.Title || '').trim();
  pdf.destroy();
  return { chunks, rawToc: toc, npages, title };
}

// ---------------------------------------------------------------- EPUB
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'dt', 'dd',
  'figcaption', 'caption', 'td', 'th', 'address']);
const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'body', 'main', 'aside', 'header', 'footer',
  'ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tr', 'figure', 'hgroup', 'nav']);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'svg', 'math', 'img', 'audio', 'video', 'iframe']);

function resolvePath(base, href) {
  const parts = (base ? base.split('/') : []).filter(Boolean);
  for (const seg of decodeURIComponent(href).split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';

function parseXml(text, type = 'application/xhtml+xml') {
  let d = new DOMParser().parseFromString(text, type);
  if (d.getElementsByTagName('parsererror').length) d = new DOMParser().parseFromString(text, 'text/html');
  return d;
}

async function loadEpub(data) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(data);
  const read = async p => { const f = zip.file(p); return f ? f.async('text') : null; };
  const container = parseXml(await read('META-INF/container.xml'), 'application/xml');
  const opfPath = container.getElementsByTagName('rootfile')[0].getAttribute('full-path');
  const opfDir = dirOf(opfPath);
  const opf = parseXml(await read(opfPath), 'application/xml');
  const title = (opf.getElementsByTagName('dc:title')[0] || opf.getElementsByTagNameNS('*', 'title')[0])?.textContent?.trim() || '';
  const manifest = new Map();
  for (const it of opf.getElementsByTagName('item'))
    manifest.set(it.getAttribute('id'), { href: resolvePath(opfDir, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  const spineEl = opf.getElementsByTagName('spine')[0];
  const spine = [...spineEl.getElementsByTagName('itemref')]
    .map(r => manifest.get(r.getAttribute('idref'))).filter(Boolean)
    .filter(m => /html|xml/.test(m.type));

  const raw = [];
  const anchors = new Map();           // "path#id" or "path" -> raw block index
  for (let s = 0; s < spine.length; s++) {
    const path = spine[s].href;
    const html = await read(path);
    if (!html) continue;
    const doc = parseXml(html);
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.documentElement;
    anchors.set(path, raw.length);
    let pendingIds = [];
    const addBlock = (el, text, heading) => {
      const t = text.replace(/\s+/g, ' ').trim();
      if (!t) return;
      for (const id of pendingIds) anchors.set(`${path}#${id}`, raw.length);
      pendingIds = [];
      raw.push({ page: s, text: t, size: heading ? 14 : 10, top: 0.5, bottom: 0.5, heading });
    };
    const collectIds = el => {
      if (el.id) pendingIds.push(el.id);
      for (const a of el.querySelectorAll ? el.querySelectorAll('[id]') : []) pendingIds.push(a.id);
    };
    const walk = el => {
      for (const node of el.childNodes) {
        if (node.nodeType !== 1) continue;
        const tag = (node.localName || node.nodeName).toLowerCase();
        if (SKIP_TAGS.has(tag)) { if (node.id) pendingIds.push(node.id); continue; }
        if (BLOCK_TAGS.has(tag)) {
          collectIds(node);
          addBlock(node, node.textContent || '', /^h[1-6]$/.test(tag));
        } else if (CONTAINER_TAGS.has(tag)) {
          if (node.id) pendingIds.push(node.id);
          const hasBlockChild = [...node.children].some(c => {
            const t = (c.localName || '').toLowerCase();
            return BLOCK_TAGS.has(t) || CONTAINER_TAGS.has(t);
          });
          if (hasBlockChild) walk(node);
          else { collectIds(node); addBlock(node, node.textContent || '', false); }
        } else {
          collectIds(node);
          addBlock(node, node.textContent || '', false);
        }
      }
    };
    walk(body);
  }
  const blocks = cleanBlocks(raw, spine.length, true);
  // cleanBlocks may merge blocks; keep a map from raw index -> merged index
  // (EPUB: no page-break merging happens, since pages are whole sections)
  const chunks = makeChunks(blocks);
  const firstChunkOfPara = new Map();
  chunks.forEach((c, i) => { if (!firstChunkOfPara.has(c.para)) firstChunkOfPara.set(c.para, i); });
  const rawToChunk = k => {
    for (let p = k; p < blocks.length; p++) if (firstChunkOfPara.has(p)) return firstChunkOfPara.get(p);
    return -1;
  };

  // table of contents: EPUB3 nav document, else EPUB2 NCX
  const toc = [];
  const navItem = [...manifest.values()].find(m => /\bnav\b/.test(m.props));
  const pushEntry = (level, title, href, baseDir) => {
    if (!title || !href) return;
    const [p, frag] = href.split('#');
    const full = resolvePath(baseDir, p);
    const k = frag && anchors.has(`${full}#${frag}`) ? anchors.get(`${full}#${frag}`) : anchors.get(full);
    if (k === undefined) return;
    const ci = rawToChunk(k);
    if (ci >= 0) toc.push({ level, title: title.replace(/\s+/g, ' ').trim(), chunk: ci });
  };
  if (navItem) {
    const nav = parseXml(await read(navItem.href));
    const navs = [...nav.getElementsByTagName('nav')];
    const tocNav = navs.find(n => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || n.getAttribute('role') || '')) || navs[0];
    const walkOl = (ol, level) => {
      for (const li of ol.children) {
        if ((li.localName || '').toLowerCase() !== 'li') continue;
        const a = [...li.children].find(c => /^(a|span)$/i.test(c.localName));
        if (a) pushEntry(level, a.textContent, a.getAttribute('href'), dirOf(navItem.href));
        const sub = [...li.children].find(c => /^ol$/i.test(c.localName));
        if (sub) walkOl(sub, level + 1);
      }
    };
    const ol = tocNav && [...tocNav.getElementsByTagName('ol')][0];
    if (ol) walkOl(ol, 1);
  }
  if (!toc.length) {
    const ncxId = spineEl.getAttribute('toc');
    const ncx = ncxId && manifest.get(ncxId);
    if (ncx) {
      const doc = parseXml(await read(ncx.href), 'application/xml');
      const walkNp = (el, level) => {
        for (const np of el.children) {
          if ((np.localName || '') !== 'navPoint') continue;
          const label = np.getElementsByTagName('text')[0]?.textContent;
          const src = np.getElementsByTagName('content')[0]?.getAttribute('src');
          pushEntry(level, label, src, dirOf(ncx.href));
          walkNp(np, level + 1);
        }
      };
      const navMap = doc.getElementsByTagName('navMap')[0];
      if (navMap) walkNp(navMap, 1);
    }
  }
  return { chunks, toc, npages: spine.length, title, pageLabel: 'Section' };
}

let _jszip = null;
async function loadJSZip() {
  if (_jszip) return _jszip;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('./lib/jszip.min.js', import.meta.url).href;
    s.onload = res; s.onerror = () => rej(new Error('Could not load the EPUB reader'));
    document.head.appendChild(s);
  });
  _jszip = window.JSZip;
  return _jszip;
}

// ---------------------------------------------------------------- public
export async function loadBook(arrayBuffer, fileName, onProgress) {
  const isEpub = /\.epub$/i.test(fileName) ||
    new Uint8Array(arrayBuffer.slice(0, 4)).join(',') === '80,75,3,4';
  let res;
  if (isEpub) res = await loadEpub(arrayBuffer);
  else res = await loadPdf(new Uint8Array(arrayBuffer), onProgress);
  const { chunks } = res;
  if (!chunks.length) throw new Error('No readable text was found. It may be a scanned (image-only) file.');

  const pageFirst = new Map();
  chunks.forEach((c, i) => { if (!pageFirst.has(c.page)) pageFirst.set(c.page, i); });

  let toc = res.toc || [];
  if (!isEpub) {
    for (const e of res.rawToc) {
      let p = e.page;
      while (p < res.npages && !pageFirst.has(p)) p++;
      if (p >= res.npages) continue;
      const start = pageFirst.get(p);
      let idx = start;
      const t1 = norm(e.title).slice(0, 25);
      const t2 = norm(e.title.replace(/^\s*(chapter|part|section)?\s*[\divxlc]+[.:)]?\s+/i, '')).slice(0, 25);
      for (let k = start; k < Math.min(start + 60, chunks.length); k++) {
        if (chunks[k].page > p + 1) break;
        const nc = norm(chunks[k].text);
        if ((t1 && (nc.startsWith(t1) || nc.includes(t1))) || (t2.length > 3 && nc.startsWith(t2))) { idx = k; break; }
      }
      toc.push({ level: e.level, title: e.title, chunk: idx });
    }
  }
  if (!toc.length) {
    chunks.forEach((c, i) => {
      if (c.heading && (i === 0 || chunks[i - 1].para !== c.para)) toc.push({ level: 1, title: c.text.slice(0, 80), chunk: i });
    });
    if (toc.length < 2 || toc.length > 400) {
      toc = [];
      for (let p = 0; p < res.npages; p += 10) {
        let q = p;
        while (q < res.npages && !pageFirst.has(q)) q++;
        if (q < res.npages) toc.push({ level: 1, title: `${res.pageLabel || 'Page'} ${q + 1}`, chunk: pageFirst.get(q) });
      }
    }
  }
  const weights = chunks.map(chunkWeight);
  const prefix = new Float64Array(chunks.length + 1);
  for (let i = 0; i < chunks.length; i++) prefix[i + 1] = prefix[i] + weights[i];
  const tocStarts = toc.map((e, k) => [e.chunk, k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    title: res.title || fileName.replace(/\.(pdf|epub)$/i, ''),
    chunks, toc, tocStarts, pageFirst, weights, prefix,
    npages: res.npages, pageLabel: res.pageLabel || 'Page',
  };
}

export function chapterIndex(book, chunk) {
  const s = book.tocStarts;
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (s[m][0] <= chunk) { ans = s[m][1]; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}
