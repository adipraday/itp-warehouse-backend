import { EscPosBuilder, center, twoColumns, divider, formatRupiah } from '../../shared/receipt/escpos-builder.js';

const PAPER_WIDTH_BY_MM = { 58: 32, 80: 48 };

// Pure function — no DB/network access, so it's cheap to unit test directly.
// `sale` is a completed SALES invoice with `.details` (from
// sales.repository.js's findByIdWithDetails). `warehouse`/`businessUnit`/
// `customer` are already-fetched rows (any may be null); `payments` is the
// array of payment rows recorded against this invoice so far.
export function buildReceipt(sale, { warehouse, businessUnit, customer, payments, paperWidthMm = 58 }) {
  const width = PAPER_WIDTH_BY_MM[paperWidthMm] ?? 32;
  const amountPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const balanceDue = Number(sale.total_amount) - amountPaid;

  const lines = [];
  const push = (text = '') => lines.push(text);

  push(center(businessUnit?.name ?? 'TOKO', width));
  if (warehouse?.name) push(center(warehouse.name, width));
  if (warehouse?.address) push(center(warehouse.address, width));
  push(divider(width));
  push(`No: ${sale.invoice_number}`);
  push(`Tgl: ${sale.invoice_date}`);
  if (customer?.name) push(`Plgn: ${customer.name}`);
  push(divider(width));

  for (const item of sale.details) {
    push(item.name);
    push(twoColumns(`  ${item.quantity} x ${formatRupiah(item.unit_price)}`, formatRupiah(item.amount), width));
  }
  push(divider(width));

  push(twoColumns('Subtotal', `Rp${formatRupiah(sale.subtotal)}`, width));
  if (Number(sale.discount_amount) > 0) {
    push(twoColumns('Diskon', `-Rp${formatRupiah(sale.discount_amount)}`, width));
  }
  push(twoColumns('Pajak', `Rp${formatRupiah(sale.tax)}`, width));
  push(twoColumns('TOTAL', `Rp${formatRupiah(sale.total_amount)}`, width));
  push(divider(width));

  for (const payment of payments) {
    push(twoColumns(payment.payment_method, `Rp${formatRupiah(payment.amount)}`, width));
    if (Number(payment.change_amount) > 0) {
      push(twoColumns('Kembalian', `Rp${formatRupiah(payment.change_amount)}`, width));
    }
  }
  if (balanceDue > 0) {
    push(twoColumns('Sisa tagihan', `Rp${formatRupiah(balanceDue)}`, width));
  }
  push(divider(width));
  push(center('Terima kasih!', width));

  const escpos = new EscPosBuilder();
  escpos.align('center').line(businessUnit?.name ?? 'TOKO');
  if (warehouse?.name) escpos.line(warehouse.name);
  if (warehouse?.address) escpos.line(warehouse.address);
  escpos.align('left').line(divider(width));
  escpos.line(`No: ${sale.invoice_number}`);
  escpos.line(`Tgl: ${sale.invoice_date}`);
  if (customer?.name) escpos.line(`Plgn: ${customer.name}`);
  escpos.line(divider(width));
  for (const item of sale.details) {
    escpos.line(item.name);
    escpos.line(twoColumns(`  ${item.quantity} x ${formatRupiah(item.unit_price)}`, formatRupiah(item.amount), width));
  }
  escpos.line(divider(width));
  escpos.line(twoColumns('Subtotal', `Rp${formatRupiah(sale.subtotal)}`, width));
  if (Number(sale.discount_amount) > 0) {
    escpos.line(twoColumns('Diskon', `-Rp${formatRupiah(sale.discount_amount)}`, width));
  }
  escpos.line(twoColumns('Pajak', `Rp${formatRupiah(sale.tax)}`, width));
  escpos.bold(true).line(twoColumns('TOTAL', `Rp${formatRupiah(sale.total_amount)}`, width)).bold(false);
  escpos.line(divider(width));
  for (const payment of payments) {
    escpos.line(twoColumns(payment.payment_method, `Rp${formatRupiah(payment.amount)}`, width));
    if (Number(payment.change_amount) > 0) {
      escpos.line(twoColumns('Kembalian', `Rp${formatRupiah(payment.change_amount)}`, width));
    }
  }
  if (balanceDue > 0) {
    escpos.line(twoColumns('Sisa tagihan', `Rp${formatRupiah(balanceDue)}`, width));
  }
  escpos.line(divider(width));
  escpos.align('center').line('Terima kasih!');
  escpos.feedBeforeCut(3).cut();

  return {
    invoice_number: sale.invoice_number,
    invoice_date: sale.invoice_date,
    warehouse: warehouse ? { id: warehouse.id, code: warehouse.code, name: warehouse.name, address: warehouse.address } : null,
    business_unit: businessUnit ? { id: businessUnit.id, name: businessUnit.name } : null,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    cashier_user_id: sale.completed_by ?? sale.created_by ?? null,
    items: sale.details.map((d) => ({
      sku: d.sku,
      name: d.name,
      quantity: d.quantity,
      unit_price: d.unit_price,
      amount: d.amount
    })),
    subtotal: sale.subtotal,
    discount_amount: sale.discount_amount,
    tax: sale.tax,
    total_amount: sale.total_amount,
    payments: payments.map((p) => ({
      method: p.payment_method,
      amount: p.amount,
      amount_tendered: p.amount_tendered,
      change_amount: p.change_amount,
      payment_date: p.payment_date
    })),
    amount_paid: amountPaid.toFixed(2),
    balance_due: balanceDue.toFixed(2),
    paper_width_mm: paperWidthMm,
    text_lines: lines,
    escpos_base64: escpos.toBase64()
  };
}
