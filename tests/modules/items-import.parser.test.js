import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseImportFile } from '../../src/modules/items/items-import.parser.js';

function csvBuffer(text) {
  return Buffer.from(text, 'utf8');
}

async function xlsxBuffer(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Items');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return workbook.xlsx.writeBuffer();
}

describe('parseImportFile — CSV', () => {
  it('parses a well-formed CSV into row objects keyed by normalized header', async () => {
    const buffer = csvBuffer('sku,name,unit,quantity\nSKU-1,Router,pcs,10\nSKU-2,Switch,pcs,5\n');

    const rows = await parseImportFile(buffer, { filename: 'items.csv' });

    expect(rows).toEqual([
      { sku: 'SKU-1', name: 'Router', unit: 'pcs', quantity: '10' },
      { sku: 'SKU-2', name: 'Switch', unit: 'pcs', quantity: '5' }
    ]);
  });

  it('normalizes headers with mixed case/whitespace', async () => {
    const buffer = csvBuffer('SKU, Name ,Unit\nSKU-1,Router,pcs\n');

    const rows = await parseImportFile(buffer, { filename: 'items.csv' });

    expect(rows).toEqual([{ sku: 'SKU-1', name: 'Router', unit: 'pcs' }]);
  });

  it('throws MISSING_COLUMNS when a required column is absent', async () => {
    const buffer = csvBuffer('sku,name\nSKU-1,Router\n'); // no "unit"

    await expect(parseImportFile(buffer, { filename: 'items.csv' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MISSING_COLUMNS'
    });
  });

  it('throws EMPTY_FILE when there are headers but no data rows', async () => {
    const buffer = csvBuffer('sku,name,unit\n');

    await expect(parseImportFile(buffer, { filename: 'items.csv' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'EMPTY_FILE'
    });
  });
});

describe('parseImportFile — XLSX', () => {
  it('parses a well-formed .xlsx workbook into row objects', async () => {
    const buffer = await xlsxBuffer(
      ['sku', 'name', 'unit', 'quantity'],
      [
        ['SKU-1', 'Router', 'pcs', 10],
        ['SKU-2', 'Switch', 'pcs', 5]
      ]
    );

    const rows = await parseImportFile(buffer, { filename: 'items.xlsx' });

    expect(rows).toEqual([
      { sku: 'SKU-1', name: 'Router', unit: 'pcs', quantity: 10 },
      { sku: 'SKU-2', name: 'Switch', unit: 'pcs', quantity: 5 }
    ]);
  });

  it('detects xlsx by mimetype even without a .xlsx filename', async () => {
    const buffer = await xlsxBuffer(['sku', 'name', 'unit'], [['SKU-1', 'Router', 'pcs']]);

    const rows = await parseImportFile(buffer, {
      filename: 'upload',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    expect(rows).toEqual([{ sku: 'SKU-1', name: 'Router', unit: 'pcs' }]);
  });

  it('skips fully blank rows', async () => {
    const buffer = await xlsxBuffer(
      ['sku', 'name', 'unit'],
      [
        ['SKU-1', 'Router', 'pcs'],
        [null, null, null],
        ['SKU-2', 'Switch', 'pcs']
      ]
    );

    const rows = await parseImportFile(buffer, { filename: 'items.xlsx' });

    expect(rows).toHaveLength(2);
  });

  it('throws MISSING_COLUMNS when a required column is absent', async () => {
    const buffer = await xlsxBuffer(['sku', 'name'], [['SKU-1', 'Router']]);

    await expect(parseImportFile(buffer, { filename: 'items.xlsx' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MISSING_COLUMNS'
    });
  });
});

describe('parseImportFile — general', () => {
  it('throws UNREADABLE_FILE for garbage bytes claiming to be .xlsx', async () => {
    const buffer = Buffer.from('this is not a real xlsx file');

    await expect(parseImportFile(buffer, { filename: 'items.xlsx' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNREADABLE_FILE'
    });
  });

  it('throws TOO_MANY_ROWS past the row cap', async () => {
    const lines = ['sku,name,unit'];
    for (let i = 0; i < 5001; i += 1) lines.push(`SKU-${i},Item ${i},pcs`);
    const buffer = csvBuffer(lines.join('\n'));

    await expect(parseImportFile(buffer, { filename: 'items.csv' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'TOO_MANY_ROWS'
    });
  });
});
