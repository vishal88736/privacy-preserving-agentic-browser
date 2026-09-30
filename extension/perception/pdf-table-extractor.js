/**
 * Local PDF table extraction. PDF bytes, extracted text, and OCR results stay
 * in the side panel; this module has no backend, network, storage, or logging
 * calls. The returned rows are intended for an explicit user-reviewed export.
 */

import { recognizeLocalPage } from './ocr/local-ocr.js';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 40;

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

async function loadPdfJs() {
  // PDF.js 4 uses Promise.withResolvers; load its main module only after the
  // compatibility shim so the supported Chrome 114 floor remains functional.
  await import('../vendor/pdfjs/promise-compat.mjs');
  return import('../vendor/pdfjs/pdf.mjs');
}

function normalizeCell(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function makeRows(items) {
  const fragments = (items || []).filter((item) => typeof item?.str === 'string' && item.str.trim() && item.transform?.length >= 6)
    .map((item) => ({
      text: normalizeCell(item.str),
      x: Number(item.transform[4]) || 0,
      y: Number(item.transform[5]) || 0,
      width: Math.max(0, Number(item.width) || 0),
      height: Math.max(1, Number(item.height) || Math.abs(Number(item.transform[3])) || 1)
    }))
    .filter((item) => item.text);

  const lines = [];
  for (const fragment of fragments) {
    const tolerance = Math.max(2, Math.min(5, fragment.height * 0.4));
    let line = lines.find((candidate) => Math.abs(candidate.y - fragment.y) <= Math.max(tolerance, candidate.tolerance));
    if (!line) {
      line = { y: fragment.y, tolerance, height: fragment.height, fragments: [] };
      lines.push(line);
    }
    line.fragments.push(fragment);
    line.y = (line.y * (line.fragments.length - 1) + fragment.y) / line.fragments.length;
    line.height = Math.max(line.height, fragment.height);
    line.tolerance = Math.max(line.tolerance, tolerance);
  }

  return lines.sort((a, b) => b.y - a.y).map((line) => {
    const sorted = line.fragments.sort((a, b) => a.x - b.x);
    const typicalHeight = sorted.map((item) => item.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 8;
    const columnGap = Math.max(9, typicalHeight * 1.25);
    const cells = [];
    let cell = '';
    let previousRight = null;
    for (const fragment of sorted) {
      if (previousRight !== null && fragment.x - previousRight > columnGap) {
        if (cell.trim()) cells.push(cell.trim());
        cell = fragment.text;
      } else {
        cell += `${cell ? ' ' : ''}${fragment.text}`;
      }
      previousRight = Math.max(fragment.x + fragment.width, fragment.x);
    }
    if (cell.trim()) cells.push(cell.trim());
    return cells.map(normalizeCell);
  }).filter((row) => row.some(Boolean));
}

function rowsFromOcrText(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const clean = normalizeCell(line);
    if (!clean) return [];
    // Tesseract preserves horizontal spacing in some scanned tables. Split on
    // two or more spaces; keep ordinary spaces inside a cell intact.
    const columns = line.trim().split(/\s{2,}/).map(normalizeCell).filter(Boolean);
    return columns.length ? columns : [clean];
  }).filter((row) => row.length);
}

function rowsFromOcrData(data) {
  const rows = [];
  for (const line of data?.lines || []) {
    const words = (line.words || []).filter((word) =>
      typeof word?.text === 'string' && word.text.trim() && Number.isFinite(word?.bbox?.x0) && Number.isFinite(word?.bbox?.x1)
    ).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (!words.length) continue;
    const heights = words.map((word) => Math.max(1, (word.bbox.y1 || word.bbox.y0 + 1) - word.bbox.y0)).sort((a, b) => a - b);
    const columnGap = Math.max(12, (heights[Math.floor(heights.length / 2)] || 10) * 1.5);
    const cells = [];
    let cell = '';
    let previousRight = null;
    for (const word of words) {
      if (previousRight !== null && word.bbox.x0 - previousRight > columnGap) {
        if (cell) cells.push(cell);
        cell = normalizeCell(word.text);
      } else {
        cell += `${cell ? ' ' : ''}${normalizeCell(word.text)}`;
      }
      previousRight = word.bbox.x1;
    }
    if (cell) cells.push(cell);
    if (cells.length) rows.push(cells);
  }
  return rows.length ? rows : rowsFromOcrText(data?.text);
}

async function extractPageText(page) {
  const content = await page.getTextContent({ includeMarkedContent: false });
  return { items: content.items || [], text: (content.items || []).map((item) => item.str || '').join(' ').trim() };
}

async function recognizePage(page, api) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.4, Math.min(2, 1600 / base.width, 2200 / base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Local PDF rendering is unavailable.');
  await page.render({ canvasContext: context, viewport }).promise;
  try {
    return await recognizeLocalPage(canvas, api);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function extractPdfTableRows(file, { onProgress = () => {}, api = extensionApi() } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose a PDF file first.');
  if (!/\.pdf$/i.test(file.name || '') && file.type !== 'application/pdf') throw new Error('Choose a PDF file.');
  if (file.size > MAX_PDF_BYTES) throw new Error('This PDF is larger than the 20 MB local processing limit.');
  if (!api?.runtime?.getURL) throw new Error('Extension PDF assets are unavailable.');

  const pdfjs = await loadPdfJs();
  pdfjs.GlobalWorkerOptions.workerSrc = api.runtime.getURL('vendor/pdfjs/pdf.worker.compat.mjs');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    cMapUrl: api.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    isEvalSupported: false
  });

  let documentProxy;
  try {
    documentProxy = await loadingTask.promise;
    if (!documentProxy.numPages) throw new Error('This PDF has no pages.');
    const pageLimit = Math.min(documentProxy.numPages, MAX_PDF_PAGES);
    const rows = [];
    let usedOcr = false;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      onProgress({ page: pageNumber, total: pageLimit, phase: 'Reading PDF text' });
      const page = await documentProxy.getPage(pageNumber);
      try {
        const extracted = await extractPageText(page);
        let pageRows = makeRows(extracted.items);
        if (extracted.text.replace(/\s/g, '').length < 20) {
          usedOcr = true;
          onProgress({ page: pageNumber, total: pageLimit, phase: 'Running local OCR' });
          pageRows = rowsFromOcrData(await recognizePage(page, api));
        }
        for (const row of pageRows) {
          if (row.some(Boolean)) rows.push(row);
        }
      } finally {
        page.cleanup();
      }
    }

    if (!rows.length) throw new Error('No readable text or tables were found in this PDF.');
    return {
      rows,
      pageCount: documentProxy.numPages,
      processedPages: pageLimit,
      truncated: documentProxy.numPages > pageLimit,
      usedOcr
    };
  } finally {
    if (documentProxy) await documentProxy.destroy();
    else await loadingTask.destroy();
    try { bytes.fill(0); } catch { /* PDF.js may already have transferred the buffer to its worker. */ }
  }
}
