import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildCsvBuffer, buildXlsxBuffer, buildFileBuffer } from '../../src/modules/items/items-export.file.js';

describe('buildCsvBuffer', () => {
  it('writes a header row followed by one row per data object', () => {
    const buffer = buildCsvBuffer(['sku', 'name'], [{ sku: 'SKU-1', name: 'Router' }]);

    expect(buffer.toString('utf8')).toBe('sku,name\nSKU-1,Router\n');
  });

  it('writes just the header row when there are no data rows (the import template case)', () => {
    const buffer = buildCsvBuffer(['sku', 'name', 'unit'], []);

    expect(buffer.toString('utf8')).toBe('sku,name,unit\n');
  });

  it('quotes a value containing a comma, quote, or newline', () => {
    const buffer = buildCsvBuffer(['name'], [{ name: 'Router, 2.4GHz "Pro"' }]);

    expect(buffer.toString('utf8')).toBe('name\n"Router, 2.4GHz ""Pro"""\n');
  });

  it('renders null/undefined as an empty field', () => {
    const buffer = buildCsvBuffer(['sku', 'barcode'], [{ sku: 'SKU-1', barcode: null }]);

    expect(buffer.toString('utf8')).toBe('sku,barcode\nSKU-1,\n');
  });
});

describe('buildXlsxBuffer', () => {
  it('produces a workbook whose first row is the header and second row is the data', async () => {
    const buffer = await buildXlsxBuffer(['sku', 'name'], [{ sku: 'SKU-1', name: 'Router' }]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];

    expect(sheet.getRow(1).values.slice(1)).toEqual(['sku', 'name']);
    expect(sheet.getRow(2).values.slice(1)).toEqual(['SKU-1', 'Router']);
  });

  it('produces a header-only workbook when there are no data rows', async () => {
    const buffer = await buildXlsxBuffer(['sku', 'name'], []);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];

    expect(sheet.rowCount).toBe(1);
  });
});

describe('buildFileBuffer', () => {
  it('returns CSV content-type/extension for format "csv"', async () => {
    const file = await buildFileBuffer('csv', ['sku'], [{ sku: 'SKU-1' }]);

    expect(file.contentType).toBe('text/csv');
    expect(file.extension).toBe('csv');
    expect(file.buffer.toString('utf8')).toContain('SKU-1');
  });

  it('returns XLSX content-type/extension for format "xlsx"', async () => {
    const file = await buildFileBuffer('xlsx', ['sku'], [{ sku: 'SKU-1' }]);

    expect(file.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(file.extension).toBe('xlsx');
  });

  it('defaults to CSV for an unrecognized format', async () => {
    const file = await buildFileBuffer('pdf', ['sku'], [{ sku: 'SKU-1' }]);

    expect(file.extension).toBe('csv');
  });
});
