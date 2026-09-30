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

/**
 * Groups text fragments into table rows.
 *
 * Exported for tests: the column inference below is the part that silently
 * corrupts a spreadsheet paste, and it can only be regression-tested against
 * real fragment geometry.
 *
 * @param {Array} items PDF.js text items.
 * @param {Object} [stats] Optional out-parameter reporting what was discarded,
 *   so the caller can tell the user that page furniture was ignored.
 */
export function makeRows(items, stats = {}) {
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

  const ordered = lines.sort((a, b) => b.y - a.y);
  const rows = ordered.map((line) => splitLineByGaps(line));
  if (rows.length) {
    const rebuilt = rebuildOnPageWideGrid(rows, ordered);
    if (rebuilt) {
      stats.droppedLines = rebuilt.droppedLines;
      stats.columns = rebuilt.rows[0]?.length || 0;
      return rebuilt.rows;
    }
  }
  stats.droppedLines = 0;
  const fallback = rows.filter((row) => row.cells.some(Boolean)).map((row) => row.cells);
  stats.columns = fallback[0]?.length || 0;
  return fallback;
}

/** Splits one line into cells wherever the horizontal gap is wide enough. */
function splitLineByGaps(line) {
  const sorted = [...line.fragments].sort((a, b) => a.x - b.x);
  const typicalHeight = sorted.map((item) => item.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 8;
  const columnGap = Math.max(9, typicalHeight * 1.25);
  const cells = [];
  const spans = [];
  let current = [];
  let previousRight = null;

  const closeCell = () => {
    if (!current.length) return;
    const text = current.map((item) => item.text).join(' ').trim();
    if (!text) {
      current = [];
      return;
    }
    cells.push(normalizeCell(text));
    // The span must describe the fragments that produced THIS cell, not the
    // one that happened to start the next cell.
    spans.push({
      start: Math.min(...current.map((item) => item.x)),
      end: Math.max(...current.map((item) => item.x + item.width))
    });
    current = [];
  };

  for (const fragment of sorted) {
    if (previousRight !== null && fragment.x - previousRight > columnGap) closeCell();
    current.push(fragment);
    previousRight = Math.max(fragment.x + fragment.width, fragment.x);
  }
  closeCell();
  return { cells, spans };
}

/**
 * Re-assigns every fragment onto one page-wide column grid.
 *
 * Splitting each line by its own pixel gaps cannot describe a table where the
 * cells are not spaced the same way in every row. Numeric columns are usually
 * right-aligned, so their left edges drift by the width of the widest value in
 * the column, while text headers are packed tightly. A single gap threshold
 * therefore splits numeric rows correctly and then merges the entire header
 * row into one cell — which is exactly what happened to a 5-column table whose
 * headers sat 7.9pt apart and whose values sat 42pt apart.
 *
 * The fix derives the columns from the page instead of from each line: the
 * modal cell count across all lines is the real column count, the median
 * horizontal centre of each column index is its anchor, and the midpoints
 * between anchors become the band boundaries. Every fragment is then placed by
 * its own centre, so a row is free to align itself differently.
 *
 * @returns {{rows: string[][], droppedLines: number}|null} null when the page
 *   does not look tabular, so the caller can keep its per-line result.
 */
function rebuildOnPageWideGrid(rows, ordered) {
  const counts = new Map();
  for (const row of rows) counts.set(row.cells.length, (counts.get(row.cells.length) || 0) + 1);
  let columnCount = 0;
  let bestSupport = 0;
  for (const [count, support] of counts) {
    if (count >= 2 && support > bestSupport) {
      columnCount = count;
      bestSupport = support;
    }
  }
  // A single line cannot define a grid; two agreeing lines can.
  if (columnCount < 2 || bestSupport < 2) return null;

  // Median centre per column index, taken only from lines that already have
  // the modal number of cells.
  const anchors = [];
  for (let index = 0; index < columnCount; index += 1) {
    const centres = [];
    for (let lineIndex = 0; lineIndex < rows.length; lineIndex += 1) {
      const row = rows[lineIndex];
      if (row.cells.length !== columnCount) continue;
      const span = row.spans[index];
      const centre = span ? (span.start + span.end) / 2 : null;
      if (Number.isFinite(centre)) centres.push(centre);
    }
    if (!centres.length) return null;
    centres.sort((a, b) => a - b);
    anchors.push(centres[Math.floor(centres.length / 2)]);
  }
  for (let index = 1; index < anchors.length; index += 1) {
    if (!(anchors[index] > anchors[index - 1])) return null;
  }

  const boundaries = anchors.map((anchor, index) => (
    index === 0 ? -Infinity : (anchors[index - 1] + anchor) / 2
  ));
  // boundaries[0] is -Infinity, so the scan starts at the first real midpoint.
  const bandOf = (centre) => {
    let band = 0;
    for (let index = 1; index < boundaries.length; index += 1) {
      if (centre < boundaries[index]) break;
      band = index;
    }
    return band;
  };

  const grid = [];
  let droppedLines = 0;
  for (const line of ordered) {
    const sorted = [...line.fragments].sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
    const cells = new Array(columnCount).fill('');
    const occupied = new Set();
    for (const fragment of sorted) {
      const band = bandOf(fragment.x + fragment.width / 2);
      occupied.add(band);
      cells[band] = cells[band] ? `${cells[band]} ${fragment.text}` : fragment.text;
    }
    // A line that lands in a single column is page furniture — a title, a
    // page number, a running header — not a table row. Keeping it produces a
    // ragged first or last row that breaks the paste into a spreadsheet.
    if (occupied.size < 2) {
      droppedLines += 1;
      continue;
    }
    grid.push(cells.map(normalizeCell));
  }

  if (grid.length < 2) return null;
  return { rows: grid, droppedLines };
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
    let droppedLines = 0;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      onProgress({ page: pageNumber, total: pageLimit, phase: 'Reading PDF text' });
      const page = await documentProxy.getPage(pageNumber);
      try {
        const extracted = await extractPageText(page);
        const stats = {};
        let pageRows = makeRows(extracted.items, stats);
        if (extracted.text.replace(/\s/g, '').length < 20) {
          usedOcr = true;
          onProgress({ page: pageNumber, total: pageLimit, phase: 'Running local OCR' });
          pageRows = rowsFromOcrData(await recognizePage(page, api));
        }
        droppedLines += stats.droppedLines || 0;
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
      usedOcr,
      // Non-tabular lines (titles, page numbers, running headers) that were
      // left out so the rows paste as one clean rectangle.
      droppedLines,
      columnCount: rows[0]?.length || 0
    };
  } finally {
    if (documentProxy) await documentProxy.destroy();
    else await loadingTask.destroy();
    try { bytes.fill(0); } catch { /* PDF.js may already have transferred the buffer to its worker. */ }
  }
}
