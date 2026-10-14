// Purchase approval flow (2026-10-14, requested): a purchase is paid first, then submitted to the
// destination warehouse's admin-warehouse, and stock only increases when that admin approves what was
// actually received. Anything not received can wait for a replacement (retur/penggantian), or be
// closed out and refunded by the supplier (pembatalan / kekurangan).
//
// invoices.status keeps its DRAFT/COMPLETED/CANCELLED CHECK untouched — the in-flight approval state
// lives in `receipt_status` instead (NULL = not submitted yet), so nothing that filters on status
// (stuck-queue, dashboards, the generic invoices list) changes behaviour:
//   DRAFT + NULL                = being prepared / paid
//   DRAFT + PENDING_APPROVAL    = submitted, nothing received yet
//   DRAFT + PARTIALLY_RECEIVED  = some lines received, the rest still awaited
//   COMPLETED                   = everything received or closed out
//   CANCELLED                   = cancelled before anything was received
//
// invoice_details gets received_quantity (stock already added) and closed_quantity (the part that will
// never arrive and is refunded). quantity - closed_quantity is what was finally bought, so a closed-out
// purchase's totals are recomputed from that and every report that reads total_amount stays correct.
//
// Supplier's own invoice (number + PDF) is stored per purchase; the PDF itself lives in object storage
// (Cloudflare R2), only its key and metadata are kept here.
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE invoices
      ADD COLUMN receipt_status VARCHAR(20) NULL AFTER status,
      ADD COLUMN tax_rate DECIMAL(7,6) NOT NULL DEFAULT 0 AFTER tax,
      ADD COLUMN submitted_at DATETIME(3) NULL,
      ADD COLUMN submitted_by INT NULL,
      ADD COLUMN cancel_reason TEXT NULL,
      ADD COLUMN supplier_invoice_number VARCHAR(100) NULL,
      ADD COLUMN supplier_invoice_file_key VARCHAR(255) NULL,
      ADD COLUMN supplier_invoice_file_name VARCHAR(255) NULL,
      ADD COLUMN supplier_invoice_file_size INT NULL,
      ADD COLUMN supplier_invoice_uploaded_at DATETIME(3) NULL,
      ADD CONSTRAINT chk_invoices_receipt_status
        CHECK (receipt_status IS NULL OR receipt_status IN ('PENDING_APPROVAL', 'PARTIALLY_RECEIVED'))
  `);
  await knex.raw('UPDATE invoices SET tax_rate = IF(subtotal > 0, ROUND(tax / subtotal, 6), 0)');

  await knex.raw(`
    ALTER TABLE invoice_details
      ADD COLUMN received_quantity INT NOT NULL DEFAULT 0,
      ADD COLUMN closed_quantity INT NOT NULL DEFAULT 0,
      ADD CONSTRAINT chk_invoice_details_received CHECK (received_quantity >= 0 AND closed_quantity >= 0)
  `);
  // Purchases completed under the old flow were received in full.
  await knex.raw(`
    UPDATE invoice_details d JOIN invoices i ON i.id = d.invoice_id
    SET d.received_quantity = d.quantity
    WHERE i.type = 'PURCHASE' AND i.status = 'COMPLETED'
  `);

  // One row per approval: a purchase can be received in several goes (replacement arrives later).
  await knex.raw(`
    CREATE TABLE purchase_receipts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      inventory_transaction_id INT NOT NULL UNIQUE,
      received_by INT NULL,
      received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      notes TEXT NULL,
      KEY idx_purchase_receipts_invoice (invoice_id),
      CONSTRAINT fk_purchase_receipts_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
      CONSTRAINT fk_purchase_receipts_transaction FOREIGN KEY (inventory_transaction_id) REFERENCES inventory_transactions(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);
  // Existing completed purchases already point at their single inbound transaction.
  await knex.raw(`
    INSERT INTO purchase_receipts (invoice_id, inventory_transaction_id, received_by, received_at)
    SELECT id, inventory_transaction_id, completed_by, COALESCE(completed_at, CURRENT_TIMESTAMP(3))
    FROM invoices WHERE type = 'PURCHASE' AND status = 'COMPLETED' AND inventory_transaction_id IS NOT NULL
  `);

  // Money coming BACK from the supplier (cancelled purchase / shortfall). Kept apart from `payments`
  // so payment reports and the cash-session reconciliation never see negative or foreign amounts.
  await knex.raw(`
    CREATE TABLE purchase_refunds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      refund_number VARCHAR(50) NOT NULL UNIQUE,
      invoice_id INT NOT NULL,
      amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
      refund_method VARCHAR(50) NOT NULL,
      refund_date DATE NOT NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_purchase_refunds_invoice (invoice_id),
      CONSTRAINT fk_purchase_refunds_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE purchase_refunds');
  await knex.raw('DROP TABLE purchase_receipts');
  await knex.raw('ALTER TABLE invoice_details DROP CONSTRAINT chk_invoice_details_received');
  await knex.raw('ALTER TABLE invoice_details DROP COLUMN closed_quantity, DROP COLUMN received_quantity');
  await knex.raw('ALTER TABLE invoices DROP CONSTRAINT chk_invoices_receipt_status');
  await knex.raw(`
    ALTER TABLE invoices
      DROP COLUMN supplier_invoice_uploaded_at, DROP COLUMN supplier_invoice_file_size,
      DROP COLUMN supplier_invoice_file_name, DROP COLUMN supplier_invoice_file_key,
      DROP COLUMN supplier_invoice_number, DROP COLUMN cancel_reason, DROP COLUMN submitted_by,
      DROP COLUMN submitted_at, DROP COLUMN tax_rate, DROP COLUMN receipt_status
  `);
}
