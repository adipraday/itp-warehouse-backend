// Permintaan barang ke gudang (2026-10-24, requested): anyone in a business unit can ask the
// warehouse for something by writing what they need in free text. It is deliberately NOT tied to
// item master data or stock — a request is a note ("butuh 20 dus kardus ukuran L untuk acara
// Jumat"), which the warehouse then picks up, fulfils or declines. Fulfilling it is done with the
// normal outbound / transfer documents, not here.
//
// Scope is the business unit (bu_id), not a warehouse: `warehouse_id` is only the warehouse the
// request is addressed to, and is optional (NULL = "any warehouse of this BU").
//
// Lifecycle (status, VARCHAR + CHECK like the rest of the schema):
//   OPEN -> IN_PROGRESS -> FULFILLED
//   OPEN | IN_PROGRESS -> REJECTED (needs a response note) | CANCELLED
//
// External systems create requests through the same REST API. `source` records where a request came
// from ('app' for the web/Android app, anything else for an integration) and `external_ref` is the
// caller's own id for it: unique per BU, so retrying the same POST never creates a duplicate.
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE item_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      request_number VARCHAR(50) NOT NULL UNIQUE,
      bu_id INT NOT NULL,
      warehouse_id INT NULL,
      requested_by INT NULL,
      requester_name VARCHAR(150) NULL,
      subject VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      source VARCHAR(50) NOT NULL DEFAULT 'app',
      external_ref VARCHAR(100) NULL,
      response_note TEXT NULL,
      handled_by INT NULL,
      handled_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_item_requests_external_ref (bu_id, external_ref),
      KEY idx_item_requests_bu_status (bu_id, status, created_at),
      KEY idx_item_requests_warehouse (warehouse_id),
      KEY idx_item_requests_requested_by (requested_by),
      CONSTRAINT fk_item_requests_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT chk_item_requests_status CHECK (status IN ('OPEN', 'IN_PROGRESS', 'FULFILLED', 'REJECTED', 'CANCELLED'))
    ) ENGINE=InnoDB
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS item_requests');
}
