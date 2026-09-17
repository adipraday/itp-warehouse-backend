const timestamps = `
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`;

export async function up(knex) {
  const statements = [
    `CREATE TABLE warehouses (
      id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL, address TEXT, ${timestamps}
    ) ENGINE=InnoDB`,
    `CREATE TABLE items (
      id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(150) NOT NULL, unit VARCHAR(20) NOT NULL,
      min_stock INT NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
      selling_price DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0), ${timestamps}
    ) ENGINE=InnoDB`,
    `CREATE TABLE contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(20) NOT NULL CHECK (type IN ('supplier', 'customer', 'both')),
      name VARCHAR(150) NOT NULL, phone VARCHAR(20), email VARCHAR(100), address TEXT, ${timestamps}
    ) ENGINE=InnoDB`,
    `CREATE TABLE stocks (
      id INT AUTO_INCREMENT PRIMARY KEY, warehouse_id INT NOT NULL, item_id INT NOT NULL,
      quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_warehouse_item (warehouse_id, item_id),
      CONSTRAINT fk_stocks_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_stocks_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE idempotency_requests (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, idempotency_key VARCHAR(255) NOT NULL UNIQUE,
      endpoint VARCHAR(150) NOT NULL, request_hash VARCHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
      response_code INT, response_body JSON,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), completed_at DATETIME(3), expires_at DATETIME(3)
    ) ENGINE=InnoDB`,
    `CREATE TABLE inventory_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY, transaction_number VARCHAR(50) NOT NULL UNIQUE,
      warehouse_id INT NOT NULL, contact_id INT,
      type VARCHAR(20) NOT NULL CHECK (type IN ('INBOUND', 'OUTBOUND')),
      status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
      reversal_of_transaction_id INT, reversal_reason TEXT, transaction_date DATE NOT NULL, notes TEXT,
      completed_at DATETIME(3), cancelled_at DATETIME(3), ${timestamps},
      CONSTRAINT fk_inventory_transactions_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_transactions_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
      CONSTRAINT fk_inventory_transactions_reversal FOREIGN KEY (reversal_of_transaction_id) REFERENCES inventory_transactions(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE inventory_transaction_details (
      id INT AUTO_INCREMENT PRIMARY KEY, transaction_id INT NOT NULL, item_id INT NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0), unit_price DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
      total_price DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
      UNIQUE KEY unique_inventory_transaction_item (transaction_id, item_id),
      CONSTRAINT fk_inventory_details_transaction FOREIGN KEY (transaction_id) REFERENCES inventory_transactions(id) ON DELETE CASCADE,
      CONSTRAINT fk_inventory_details_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE stock_transfers (
      id INT AUTO_INCREMENT PRIMARY KEY, transfer_number VARCHAR(50) NOT NULL UNIQUE,
      source_warehouse_id INT NOT NULL, destination_warehouse_id INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'COMPLETED', 'CANCELLED')),
      reversal_of_transfer_id INT, reversal_reason TEXT, transfer_date DATE NOT NULL, notes TEXT,
      approved_at DATETIME(3), completed_at DATETIME(3), cancelled_at DATETIME(3), ${timestamps},
      CHECK (source_warehouse_id <> destination_warehouse_id),
      CONSTRAINT fk_transfers_source FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_transfers_destination FOREIGN KEY (destination_warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_transfers_reversal FOREIGN KEY (reversal_of_transfer_id) REFERENCES stock_transfers(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE stock_transfer_details (
      id INT AUTO_INCREMENT PRIMARY KEY, transfer_id INT NOT NULL, item_id INT NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0), UNIQUE KEY unique_transfer_item (transfer_id, item_id),
      CONSTRAINT fk_transfer_details_transfer FOREIGN KEY (transfer_id) REFERENCES stock_transfers(id) ON DELETE CASCADE,
      CONSTRAINT fk_transfer_details_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE stock_opnames (
      id INT AUTO_INCREMENT PRIMARY KEY, opname_number VARCHAR(50) NOT NULL UNIQUE, warehouse_id INT NOT NULL,
      opname_date DATE NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
      CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED')),
      reversal_of_stock_opname_id INT, reversal_reason TEXT, notes TEXT,
      submitted_at DATETIME(3), approved_at DATETIME(3), cancelled_at DATETIME(3), ${timestamps},
      CONSTRAINT fk_opnames_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_opnames_reversal FOREIGN KEY (reversal_of_stock_opname_id) REFERENCES stock_opnames(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE stock_opname_details (
      id INT AUTO_INCREMENT PRIMARY KEY, stock_opname_id INT NOT NULL, item_id INT NOT NULL,
      system_qty INT NOT NULL CHECK (system_qty >= 0), physical_qty INT NOT NULL CHECK (physical_qty >= 0),
      difference INT GENERATED ALWAYS AS (physical_qty - system_qty) STORED, notes TEXT,
      UNIQUE KEY unique_opname_item (stock_opname_id, item_id),
      CONSTRAINT fk_opname_details_opname FOREIGN KEY (stock_opname_id) REFERENCES stock_opnames(id) ON DELETE CASCADE,
      CONSTRAINT fk_opname_details_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE invoices (
      id INT AUTO_INCREMENT PRIMARY KEY, invoice_number VARCHAR(50) NOT NULL UNIQUE, warehouse_id INT NOT NULL, contact_id INT,
      type VARCHAR(20) NOT NULL CHECK (type IN ('SALES', 'PURCHASE')),
      status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
      reversal_of_invoice_id INT, reversal_reason TEXT, inventory_transaction_id INT UNIQUE,
      invoice_date DATE NOT NULL, due_date DATE, subtotal DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      tax DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (tax >= 0), total_amount DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
      payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID')),
      notes TEXT, completed_at DATETIME(3), cancelled_at DATETIME(3), ${timestamps},
      CONSTRAINT fk_invoices_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_invoices_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
      CONSTRAINT fk_invoices_reversal FOREIGN KEY (reversal_of_invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
      CONSTRAINT fk_invoices_transaction FOREIGN KEY (inventory_transaction_id) REFERENCES inventory_transactions(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE invoice_details (
      id INT AUTO_INCREMENT PRIMARY KEY, invoice_id INT NOT NULL, item_id INT NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0), unit_price DECIMAL(15,2) NOT NULL CHECK (unit_price >= 0),
      amount DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
      unit_cost DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0), cost_amount DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
      UNIQUE KEY unique_invoice_item (invoice_id, item_id),
      CONSTRAINT fk_invoice_details_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      CONSTRAINT fk_invoice_details_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE payments (
      id INT AUTO_INCREMENT PRIMARY KEY, payment_number VARCHAR(50) NOT NULL UNIQUE, invoice_id INT NOT NULL,
      amount DECIMAL(15,2) NOT NULL CHECK (amount > 0), payment_method VARCHAR(50) NOT NULL, payment_date DATE NOT NULL,
      notes TEXT, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE item_returns (
      id INT AUTO_INCREMENT PRIMARY KEY, return_number VARCHAR(50) NOT NULL UNIQUE, warehouse_id INT NOT NULL, contact_id INT NOT NULL,
      type VARCHAR(20) NOT NULL CHECK (type IN ('RETURN_CUSTOMER', 'RETURN_SUPPLIER')),
      original_invoice_id INT, original_inventory_transaction_id INT, replacement_inventory_transaction_id INT UNIQUE,
      status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED')),
      reversal_of_return_id INT, reversal_reason TEXT, return_date DATE NOT NULL, reason TEXT,
      approved_at DATETIME(3), completed_at DATETIME(3), cancelled_at DATETIME(3), ${timestamps},
      CHECK ((original_invoice_id IS NOT NULL AND original_inventory_transaction_id IS NULL) OR (original_invoice_id IS NULL AND original_inventory_transaction_id IS NOT NULL)),
      CONSTRAINT fk_returns_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_returns_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT,
      CONSTRAINT fk_returns_invoice FOREIGN KEY (original_invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
      CONSTRAINT fk_returns_original_transaction FOREIGN KEY (original_inventory_transaction_id) REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
      CONSTRAINT fk_returns_replacement_transaction FOREIGN KEY (replacement_inventory_transaction_id) REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
      CONSTRAINT fk_returns_reversal FOREIGN KEY (reversal_of_return_id) REFERENCES item_returns(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE item_return_details (
      id INT AUTO_INCREMENT PRIMARY KEY, return_id INT NOT NULL, item_id INT NOT NULL, quantity INT NOT NULL CHECK (quantity > 0),
      \`condition\` VARCHAR(20) NOT NULL CHECK (\`condition\` IN ('GOOD', 'DAMAGED')),
      action VARCHAR(20) NOT NULL CHECK (action IN ('RESTOCK', 'SCRAP', 'REPLACE')),
      unit_cost DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
      total_cost DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
      UNIQUE KEY unique_return_item (return_id, item_id), CHECK (\`condition\` <> 'DAMAGED' OR action = 'SCRAP'),
      CONSTRAINT fk_return_details_return FOREIGN KEY (return_id) REFERENCES item_returns(id) ON DELETE CASCADE,
      CONSTRAINT fk_return_details_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE stock_mutations (
      id INT AUTO_INCREMENT PRIMARY KEY, warehouse_id INT NOT NULL, item_id INT NOT NULL,
      type VARCHAR(20) NOT NULL CHECK (type IN ('IN', 'OUT', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT')),
      direction VARCHAR(10) NOT NULL CHECK (direction IN ('IN', 'OUT')), quantity INT NOT NULL CHECK (quantity > 0),
      total_cost DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
      source_type VARCHAR(30) NOT NULL CHECK (source_type IN ('INVENTORY_TRANSACTION', 'RETURN', 'STOCK_OPNAME', 'STOCK_TRANSFER')),
      source_id INT NOT NULL, inventory_transaction_id INT, return_id INT, stock_opname_id INT, stock_transfer_id INT,
      occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_mutation_business_event (source_type, source_id, warehouse_id, item_id, direction),
      CONSTRAINT fk_mutations_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_mutations_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
      CONSTRAINT fk_mutations_transaction FOREIGN KEY (inventory_transaction_id) REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
      CONSTRAINT fk_mutations_return FOREIGN KEY (return_id) REFERENCES item_returns(id) ON DELETE RESTRICT,
      CONSTRAINT fk_mutations_opname FOREIGN KEY (stock_opname_id) REFERENCES stock_opnames(id) ON DELETE RESTRICT,
      CONSTRAINT fk_mutations_transfer FOREIGN KEY (stock_transfer_id) REFERENCES stock_transfers(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE inventory_cost_layers (
      id INT AUTO_INCREMENT PRIMARY KEY, warehouse_id INT NOT NULL, item_id INT NOT NULL, source_stock_mutation_id INT NOT NULL,
      origin_cost_layer_id INT, quantity_received INT NOT NULL CHECK (quantity_received > 0),
      quantity_remaining INT NOT NULL CHECK (quantity_remaining >= 0 AND quantity_remaining <= quantity_received),
      unit_cost DECIMAL(15,2) NOT NULL CHECK (unit_cost >= 0), created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      CONSTRAINT fk_cost_layers_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
      CONSTRAINT fk_cost_layers_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT,
      CONSTRAINT fk_cost_layers_mutation FOREIGN KEY (source_stock_mutation_id) REFERENCES stock_mutations(id) ON DELETE RESTRICT,
      CONSTRAINT fk_cost_layers_origin FOREIGN KEY (origin_cost_layer_id) REFERENCES inventory_cost_layers(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    `CREATE TABLE inventory_cost_allocations (
      id INT AUTO_INCREMENT PRIMARY KEY, consumption_mutation_id INT NOT NULL, cost_layer_id INT NOT NULL,
      quantity INT NOT NULL CHECK (quantity > 0), unit_cost DECIMAL(15,2) NOT NULL CHECK (unit_cost >= 0),
      total_cost DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY unique_consumption_layer (consumption_mutation_id, cost_layer_id),
      CONSTRAINT fk_cost_allocations_mutation FOREIGN KEY (consumption_mutation_id) REFERENCES stock_mutations(id) ON DELETE RESTRICT,
      CONSTRAINT fk_cost_allocations_layer FOREIGN KEY (cost_layer_id) REFERENCES inventory_cost_layers(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`,
    'CREATE INDEX idx_stocks_warehouse_item ON stocks (warehouse_id, item_id)',
    'CREATE INDEX idx_inventory_transactions_filter ON inventory_transactions (warehouse_id, type, status, transaction_date)',
    'CREATE INDEX idx_stock_mutations_filter ON stock_mutations (warehouse_id, item_id, occurred_at)',
    'CREATE INDEX idx_cost_layers_fifo ON inventory_cost_layers (warehouse_id, item_id, quantity_remaining, created_at, id)',
    'CREATE INDEX idx_invoices_filter ON invoices (warehouse_id, type, status, payment_status, invoice_date)',
    'CREATE INDEX idx_payments_invoice ON payments (invoice_id, payment_date)'
  ];

  for (const statement of statements) await knex.raw(statement);
}

export async function down(knex) {
  for (const table of [
    'inventory_cost_allocations', 'inventory_cost_layers', 'stock_mutations', 'item_return_details', 'item_returns',
    'payments', 'invoice_details', 'invoices', 'stock_opname_details', 'stock_opnames', 'stock_transfer_details',
    'stock_transfers', 'inventory_transaction_details', 'inventory_transactions', 'idempotency_requests', 'stocks',
    'contacts', 'items', 'warehouses'
  ]) await knex.raw(`DROP TABLE IF EXISTS ${table}`);
}
