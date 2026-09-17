// Shared CSV/XLSX serialization for both the import template (2026-09-14,
// headers only, zero data rows) and the item/stock export — pure functions,
// no DB access, so they're cheap to unit test directly.
import ExcelJS from 'exceljs';

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  // Quote only when necessary (comma, quote, or newline present) — matches
  // how csv-parse (used on the import side) expects a well-formed CSV.
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvBuffer(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export async function buildXlsxBuffer(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Items');
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(headers.map((header) => row[header] ?? ''));
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

// format defaults to csv for anything unrecognized — the route layer already
// validates format against an enum, this is just a safe fallback.
export async function buildFileBuffer(format, headers, rows) {
  if (format === 'xlsx') {
    return { buffer: await buildXlsxBuffer(headers, rows), contentType: CONTENT_TYPES.xlsx, extension: 'xlsx' };
  }
  return { buffer: buildCsvBuffer(headers, rows), contentType: CONTENT_TYPES.csv, extension: 'csv' };
}
