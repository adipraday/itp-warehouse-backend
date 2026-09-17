// CSV/XLSX parsing for bulk item+stock import (2026-09-14). Pure parsing only
// — no DB access, no business validation (that's items-import.service.js) —
// so this stays cheap to unit test directly with real file buffers.
import { parse as parseCsvSync } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { BadRequestError } from '../../shared/errors/app-error.js';

// sku/name/unit are the only truly required columns — everything else
// (barcode, min_stock, selling_price, warehouse_code, quantity, unit_cost)
// is optional at the file-structure level; per-row business rules (e.g.
// "unit_cost required when quantity > 0") are enforced in the service.
const REQUIRED_HEADERS = ['sku', 'name', 'unit'];

// A single import is capped to keep the whole thing inside one DB
// transaction (2026-09-14 decision: reject-all-on-error, so it either
// commits completely or not at all) from running unreasonably long.
const MAX_ROWS = 5000;

function normalizeHeader(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function isXlsxFile(filename, mimetype) {
  if (filename && /\.xlsx$/i.test(filename)) return true;
  return mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new BadRequestError('EMPTY_FILE', 'The uploaded .xlsx file has no worksheet');

  let headers = [];
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    // exceljs's row.values is 1-indexed (values[0] is always undefined) —
    // slice it off so column 1 in the file lines up with array index 0.
    const values = row.values.slice(1);
    if (rowNumber === 1) {
      headers = values.map(normalizeHeader);
      return;
    }
    if (values.every((v) => v == null || v === '')) return; // skip a fully blank row
    const record = {};
    headers.forEach((header, i) => {
      record[header] = values[i] ?? null;
    });
    rows.push(record);
  });

  return { headers, rows };
}

function parseCsv(buffer) {
  // Capture the normalized header list from the columns() callback itself —
  // it fires even when the file has zero data rows, unlike deriving headers
  // from rows[0] (which would be undefined in that case).
  let headers = [];
  const rows = parseCsvSync(buffer, {
    columns: (headerRow) => {
      headers = headerRow.map(normalizeHeader);
      return headers;
    },
    skip_empty_lines: true,
    trim: true
  });
  return { headers, rows };
}

// Throws BadRequestError for anything structurally wrong with the file
// itself (wrong/missing columns, unreadable format, too many rows) — this
// runs BEFORE any per-row business validation, so a malformed file never
// gets as far as touching the database at all.
export async function parseImportFile(buffer, { filename, mimetype } = {}) {
  let parsed;
  try {
    parsed = isXlsxFile(filename, mimetype) ? await parseXlsx(buffer) : parseCsv(buffer);
  } catch (cause) {
    throw new BadRequestError('UNREADABLE_FILE', `Could not read the uploaded file: ${cause.message}`);
  }

  const missing = REQUIRED_HEADERS.filter((header) => !parsed.headers.includes(header));
  if (missing.length > 0) {
    throw new BadRequestError('MISSING_COLUMNS', `File is missing required column(s): ${missing.join(', ')}`);
  }
  if (parsed.rows.length === 0) {
    throw new BadRequestError('EMPTY_FILE', 'The file has no data rows');
  }
  if (parsed.rows.length > MAX_ROWS) {
    throw new BadRequestError('TOO_MANY_ROWS', `A single import is limited to ${MAX_ROWS} rows (file has ${parsed.rows.length})`);
  }

  return parsed.rows;
}
