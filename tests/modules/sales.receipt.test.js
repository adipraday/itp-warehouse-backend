import { describe, it, expect } from 'vitest';
import { buildReceipt } from '../../src/modules/sales/sales.receipt.js';

function makeSale(overrides = {}) {
  return {
    invoice_number: 'SAL-000012',
    invoice_date: '2026-09-13',
    contact_id: null,
    completed_by: 501,
    created_by: 500,
    subtotal: '300000.00',
    discount_amount: '0.00',
    tax: '0.00',
    total_amount: '300000.00',
    details: [{ sku: 'SKU-001', name: 'Router TP-Link', quantity: 2, unit_price: '150000.00', amount: '300000.00' }],
    ...overrides
  };
}

const warehouse = { id: 1, code: 'WH-PUSAT', name: 'Gudang Pusat', address: 'Jl. Merdeka No. 1', bu_id: 13 };
const businessUnit = { id: 13, name: 'PT Cakrawala Abadi' };

describe('buildReceipt', () => {
  it('includes store/warehouse header, items, and totals in text_lines', () => {
    const receipt = buildReceipt(makeSale(), { warehouse, businessUnit, customer: null, payments: [] });

    expect(receipt.text_lines.join('\n')).toContain('PT Cakrawala Abadi');
    expect(receipt.text_lines.join('\n')).toContain('Gudang Pusat');
    expect(receipt.text_lines.join('\n')).toContain('Router TP-Link');
    expect(receipt.text_lines.some((l) => l.includes('TOTAL') && l.includes('300.000'))).toBe(true);
  });

  it('every text_line respects the paper width', () => {
    const receipt = buildReceipt(makeSale(), { warehouse, businessUnit, customer: null, payments: [], paperWidthMm: 58 });
    for (const line of receipt.text_lines) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
  });

  it('uses 48 chars/line for 80mm paper', () => {
    const receipt = buildReceipt(makeSale(), { warehouse, businessUnit, customer: null, payments: [], paperWidthMm: 80 });
    expect(receipt.text_lines.some((l) => l.length > 32)).toBe(true);
    for (const line of receipt.text_lines) {
      expect(line.length).toBeLessThanOrEqual(48);
    }
  });

  it('computes amount_paid and balance_due from the payments given', () => {
    const receipt = buildReceipt(makeSale(), {
      warehouse,
      businessUnit,
      customer: null,
      payments: [{ payment_method: 'CASH', amount: '200000.00', payment_date: '2026-09-13' }]
    });

    expect(receipt.amount_paid).toBe('200000.00');
    expect(receipt.balance_due).toBe('100000.00');
    expect(receipt.text_lines.some((l) => l.includes('Sisa tagihan'))).toBe(true);
  });

  it('omits "Sisa tagihan" once fully paid', () => {
    const receipt = buildReceipt(makeSale(), {
      warehouse,
      businessUnit,
      customer: null,
      payments: [{ payment_method: 'CASH', amount: '300000.00', payment_date: '2026-09-13' }]
    });

    expect(receipt.balance_due).toBe('0.00');
    expect(receipt.text_lines.some((l) => l.includes('Sisa tagihan'))).toBe(false);
  });

  it('includes the customer name when a contact is given', () => {
    const receipt = buildReceipt(makeSale({ contact_id: 5 }), {
      warehouse,
      businessUnit,
      customer: { id: 5, name: 'Budi Santoso' },
      payments: []
    });

    expect(receipt.customer).toEqual({ id: 5, name: 'Budi Santoso' });
    expect(receipt.text_lines.some((l) => l.includes('Budi Santoso'))).toBe(true);
  });

  it('handles a null warehouse/business_unit/customer gracefully', () => {
    const receipt = buildReceipt(makeSale(), { warehouse: null, businessUnit: null, customer: null, payments: [] });

    expect(receipt.warehouse).toBeNull();
    expect(receipt.business_unit).toBeNull();
    expect(receipt.customer).toBeNull();
    expect(receipt.text_lines[0]).toContain('TOKO'); // generic fallback header
  });

  it('produces a non-empty base64 ESC/POS byte stream that starts with the init command', () => {
    const receipt = buildReceipt(makeSale(), { warehouse, businessUnit, customer: null, payments: [] });

    const bytes = Buffer.from(receipt.escpos_base64, 'base64');
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(bytes.length).toBeGreaterThan(20);
  });

  it('shows a Diskon line when discount_amount is set, and omits it otherwise', () => {
    const withDiscount = buildReceipt(makeSale({ discount_amount: '50000.00', total_amount: '250000.00' }), {
      warehouse,
      businessUnit,
      customer: null,
      payments: []
    });
    expect(withDiscount.text_lines.some((l) => l.includes('Diskon') && l.includes('50.000'))).toBe(true);

    const withoutDiscount = buildReceipt(makeSale(), { warehouse, businessUnit, customer: null, payments: [] });
    expect(withoutDiscount.text_lines.some((l) => l.includes('Diskon'))).toBe(false);
  });

  it('shows a Kembalian line under a payment that has change_amount, and omits it otherwise', () => {
    const receipt = buildReceipt(makeSale(), {
      warehouse,
      businessUnit,
      customer: null,
      payments: [
        { payment_method: 'CASH', amount: '300000.00', amount_tendered: '350000.00', change_amount: '50000.00', payment_date: '2026-09-13' }
      ]
    });

    expect(receipt.text_lines.some((l) => l.includes('Kembalian') && l.includes('50.000'))).toBe(true);
  });

  it('omits Kembalian for an exact payment (change_amount 0)', () => {
    const receipt = buildReceipt(makeSale(), {
      warehouse,
      businessUnit,
      customer: null,
      payments: [
        { payment_method: 'CASH', amount: '300000.00', amount_tendered: '300000.00', change_amount: '0.00', payment_date: '2026-09-13' }
      ]
    });

    expect(receipt.text_lines.some((l) => l.includes('Kembalian'))).toBe(false);
  });

  it('carries discount_amount through to the structured data', () => {
    const receipt = buildReceipt(makeSale({ discount_amount: '50000.00' }), {
      warehouse,
      businessUnit,
      customer: null,
      payments: []
    });
    expect(receipt.discount_amount).toBe('50000.00');
  });

  it('reports cashier_user_id from completed_by, falling back to created_by', () => {
    const receipt1 = buildReceipt(makeSale({ completed_by: 501, created_by: 500 }), {
      warehouse,
      businessUnit,
      customer: null,
      payments: []
    });
    expect(receipt1.cashier_user_id).toBe(501);

    const receipt2 = buildReceipt(makeSale({ completed_by: null, created_by: 500 }), {
      warehouse,
      businessUnit,
      customer: null,
      payments: []
    });
    expect(receipt2.cashier_user_id).toBe(500);
  });
});
