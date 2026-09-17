import { describe, it, expect } from 'vitest';
import { EscPosBuilder, center, twoColumns, divider, formatRupiah } from '../../src/shared/receipt/escpos-builder.js';

describe('EscPosBuilder', () => {
  it('starts every stream with the ESC @ init command', () => {
    const buffer = new EscPosBuilder().toBuffer();
    expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
  });

  it('encodes align/bold/line/cut into the expected byte sequences', () => {
    const buffer = new EscPosBuilder().align('center').bold(true).line('HI').bold(false).cut().toBuffer();

    expect(buffer).toEqual(
      Buffer.concat([
        Buffer.from([0x1b, 0x40]), // init
        Buffer.from([0x1b, 0x61, 1]), // align center
        Buffer.from([0x1b, 0x45, 1]), // bold on
        Buffer.from('HI\n', 'utf8'),
        Buffer.from([0x1b, 0x45, 0]), // bold off
        Buffer.from([0x1d, 0x56, 0x00]) // cut
      ])
    );
  });

  it('toBase64 round-trips back to the same bytes', () => {
    const builder = new EscPosBuilder().line('test');
    const decoded = Buffer.from(builder.toBase64(), 'base64');
    expect(decoded).toEqual(builder.toBuffer());
  });
});

describe('center', () => {
  it('pads both sides to reach the target width', () => {
    expect(center('HI', 6)).toBe('  HI  ');
  });

  it('truncates text longer than the width', () => {
    expect(center('TOOLONGTEXT', 5)).toBe('TOOLO');
  });
});

describe('twoColumns', () => {
  it('pads the middle so left+right fill the exact width', () => {
    const result = twoColumns('Total', 'Rp1.000', 20);
    expect(result).toHaveLength(20);
    expect(result.startsWith('Total')).toBe(true);
    expect(result.endsWith('Rp1.000')).toBe(true);
  });

  it('truncates the left side when there is no room for both', () => {
    const result = twoColumns('A very long item name indeed', 'Rp1.000', 20);
    expect(result).toHaveLength(20);
    expect(result.endsWith('Rp1.000')).toBe(true);
  });
});

describe('divider', () => {
  it('repeats the character to fill the width', () => {
    expect(divider(10)).toBe('----------');
    expect(divider(4, '=')).toBe('====');
  });
});

describe('formatRupiah', () => {
  it('adds thousands separators without decimals', () => {
    expect(formatRupiah(1000)).toBe('1.000');
    expect(formatRupiah('1234567.89')).toBe('1.234.568'); // rounds
    expect(formatRupiah(0)).toBe('0');
  });
});
