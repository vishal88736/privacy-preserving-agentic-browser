import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRows } from '../../extension/perception/pdf-table-extractor.js';

/**
 * PDF table column inference.
 *
 * The geometry here is copied from a real 5x5 random-CSV PDF: a title line, a
 * tight header row, five right-aligned numeric rows, and a page-number footer.
 * The numeric columns are right-aligned, so their left edges drift with the
 * width of the widest value, while the text headers are packed tightly. That
 * combination is what a single per-line pixel-gap threshold cannot describe.
 */

/** Builds a PDF.js-shaped text item. */
const item = (str, x, y, width, height = 10) => ({
  str,
  width,
  height,
  transform: [1, 0, 0, height, x, y]
});

// Measured from random_5x5.pdf: headers 7.9pt apart, values 42pt apart.
const HEADER_Y = 754.3;
const ROW_YS = [741.5, 728.7, 715.9, 703.1, 690.3];
const HEADER_X = [57.7, 111.2, 164.7, 218.2, 271.6];
const HEADER_W = 45.6;
const VALUE_ROWS = [
  [[98.0, 11.1], [151.5, 11.1], [210.6, 5.6], [258.5, 11.1], [312.0, 11.1]],
  [[98.0, 11.1], [151.5, 11.1], [205.0, 11.1], [258.5, 11.1], [312.0, 11.1]],
  [[98.0, 11.1], [151.5, 11.1], [205.0, 11.1], [258.5, 11.1], [312.0, 11.1]],
  [[98.0, 11.1], [157.1, 5.6], [210.6, 5.6], [258.5, 11.1], [312.0, 11.1]],
  [[98.0, 11.1], [151.5, 11.1], [205.0, 11.1], [258.5, 11.1], [312.0, 11.1]]
];

const random5x5Items = () => [
  item('91288e16-fb58-4d34-bb57-7fb793aa0ccd', 205.4, 774.6, 184.4),
  ...HEADER_X.map((x, index) => item(`Column_${index + 1}`, x, HEADER_Y, HEADER_W)),
  ...ROW_YS.flatMap((y, rowIndex) => (
    VALUE_ROWS[rowIndex].map(([x, w], columnIndex) => item(String(rowIndex * 10 + columnIndex + 1), x, y, w))
  )),
  item('Page 1', 281.8, 60.3, 31.7)
];

test('a right-aligned numeric table keeps its header row as real columns', () => {
  // The regression: the header labels sit 7.9pt apart, under the old 12.5pt
  // gap threshold, so all five collapsed into "Column_1 Column_2 ...".
  const rows = makeRows(random5x5Items());
  assert.equal(rows[0].length, 5);
  assert.deepEqual(rows[0], ['Column_1', 'Column_2', 'Column_3', 'Column_4', 'Column_5']);
});

test('every extracted row has the same column count', () => {
  const rows = makeRows(random5x5Items());
  // A ragged paste is what breaks a spreadsheet import: Sheets fills the short
  // rows from the neighbouring column instead of leaving them empty.
  for (const row of rows) assert.equal(row.length, 5, `ragged row: ${JSON.stringify(row)}`);
  assert.equal(rows.length, 6);
});

test('right-aligned values land in the column their header names', () => {
  const rows = makeRows(random5x5Items());
  const header = rows[0];
  const first = rows[1];
  // Column 3 of row 1 is a single narrow digit right-aligned under Column_3.
  assert.equal(first.length, header.length);
  assert.notEqual(first[2], '');
  assert.match(first[2], /^\d+$/);
  for (let column = 0; column < header.length; column += 1) {
    assert.match(first[column], /^\d+$/, `column ${column} of ${header[column]} is not the numeric value`);
  }
});

test('a title and a page number are reported as dropped, not pasted as rows', () => {
  const stats = {};
  const rows = makeRows(random5x5Items(), stats);
  assert.equal(stats.droppedLines, 2);
  assert.equal(stats.columns, 5);
  const flat = rows.flat().join(' ');
  assert.doesNotMatch(flat, /91288e16/, 'the UUID title must not become a data row');
  assert.doesNotMatch(flat, /Page 1/, 'the page-number footer must not become a data row');
});

test('a plain evenly-spaced table is still extracted unchanged', () => {
  // The grid rebuild must not regress the simple case it already handled.
  const items = [];
  const headers = ['Name', 'City', 'Age'];
  headers.forEach((text, index) => items.push(item(text, 40 + index * 80, 700, 30)));
  [['Ada', 'Delhi', '36'], ['Ravi', 'Pune', '41']].forEach((row, rowIndex) => {
    row.forEach((text, index) => items.push(item(text, 40 + index * 80, 680 - rowIndex * 14, 30)));
  });
  const stats = {};
  const rows = makeRows(items, stats);
  assert.deepEqual(rows, [headers, ['Ada', 'Delhi', '36'], ['Ravi', 'Pune', '41']]);
  assert.equal(stats.droppedLines, 0);
});

test('prose lines are left alone rather than forced into a grid', () => {
  // A page with no repeated tabular shape must not be mangled into columns.
  const items = [
    item('Quarterly revenue grew across every region this period.', 40, 700, 300),
    item('Costs rose slightly in the northern territories.', 40, 686, 300)
  ];
  const stats = {};
  const rows = makeRows(items, stats);
  assert.equal(stats.columns, 1);
  assert.equal(stats.droppedLines, 0);
  for (const row of rows) assert.equal(row.length, 1);
});
