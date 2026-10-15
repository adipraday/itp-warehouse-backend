// Simple A4 table report (title, subtitle lines, a header row that repeats on every page, zebra
// rows) — pure function, no DB access. Built-in Helvetica only, so no font files are shipped.
import PDFDocument from 'pdfkit';

const MARGIN = 36;
const ROW_HEIGHT = 20;
const HEADER_COLOR = '#3F51B5';
const ZEBRA_COLOR = '#F3F4FA';

// columns: [{ key, label, width, align?: 'left'|'right', color?: (row) => string | undefined }]
// `width` values are relative weights, scaled to the printable width.
export function buildPdfTable({ title, subtitleLines = [], columns, rows, landscape = true }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: MARGIN });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const printableWidth = doc.page.width - MARGIN * 2;
    const totalWeight = columns.reduce((sum, col) => sum + col.width, 0);
    const widths = columns.map((col) => (col.width / totalWeight) * printableWidth);

    const drawHeaderRow = (y) => {
      doc.rect(MARGIN, y, printableWidth, ROW_HEIGHT).fill(HEADER_COLOR);
      let x = MARGIN;
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
      columns.forEach((col, i) => {
        doc.text(col.label, x + 4, y + 6, { width: widths[i] - 8, align: col.align ?? 'left', lineBreak: false });
        x += widths[i];
      });
      return y + ROW_HEIGHT;
    };

    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(16).text(title, MARGIN, MARGIN);
    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    for (const line of subtitleLines) doc.text(line);
    doc.moveDown(0.8);

    let y = drawHeaderRow(doc.y);
    const bottomLimit = doc.page.height - MARGIN - ROW_HEIGHT;

    if (rows.length === 0) {
      doc.fillColor('#777777').font('Helvetica-Oblique').fontSize(10).text('Tidak ada data.', MARGIN + 4, y + 8);
    }

    rows.forEach((row, rowIndex) => {
      if (y > bottomLimit) {
        doc.addPage();
        y = drawHeaderRow(MARGIN);
      }
      if (rowIndex % 2 === 1) doc.rect(MARGIN, y, printableWidth, ROW_HEIGHT).fill(ZEBRA_COLOR);
      let x = MARGIN;
      doc.font('Helvetica').fontSize(9);
      columns.forEach((col, i) => {
        const value = row[col.key] === null || row[col.key] === undefined ? '' : String(row[col.key]);
        doc.fillColor(col.color?.(row) ?? '#222222');
        doc.text(value, x + 4, y + 6, { width: widths[i] - 8, align: col.align ?? 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      y += ROW_HEIGHT;
    });

    doc.end();
  });
}
