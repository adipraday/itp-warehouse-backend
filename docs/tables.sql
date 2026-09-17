-- Warehouse schema (PostgreSQL)
--
-- Business invariants enforced by the service in one DB transaction:
-- * completed/approved documents are immutable;
-- * no negative stock or cost-layer balance;
-- * every stock-out has FIFO allocations whose quantities equal its mutation quantity;
-- * an idempotent completion may write each mutation only once.

CREATE TABLE warehouses (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(150) NOT NULL,
    unit VARCHAR(20) NOT NULL,
    min_stock INT NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    selling_price DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contacts (
    id SERIAL PRIMARY KEY,
    type VARCHAR(20) NOT NULL CHECK (type IN ('supplier', 'customer', 'both')),
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(100),
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Current balance/read model. It is never directly mutated by a public API.
CREATE TABLE stocks (
    id SERIAL PRIMARY KEY,
    warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_warehouse_item UNIQUE (warehouse_id, item_id)
);

-- Persists completion/approval retries so the same client request has one result.
CREATE TABLE idempotency_requests (
    id BIGSERIAL PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    endpoint VARCHAR(150) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING'
        CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
    response_code INT,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

-- Canonical inbound/outbound document. A completed sales/purchase invoice links here.
CREATE TABLE inventory_transactions (
    id SERIAL PRIMARY KEY,
    transaction_number VARCHAR(50) NOT NULL UNIQUE,
    warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    contact_id INT REFERENCES contacts(id) ON DELETE RESTRICT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('INBOUND', 'OUTBOUND')),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
    reversal_of_transaction_id INT REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
    reversal_reason TEXT,
    transaction_date DATE NOT NULL,
    notes TEXT,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE inventory_transaction_details (
    id SERIAL PRIMARY KEY,
    transaction_id INT NOT NULL REFERENCES inventory_transactions(id) ON DELETE CASCADE,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    total_price DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    CONSTRAINT unique_inventory_transaction_item UNIQUE (transaction_id, item_id)
);

CREATE TABLE item_returns (
    id SERIAL PRIMARY KEY,
    return_number VARCHAR(50) NOT NULL UNIQUE,
    warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    contact_id INT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('RETURN_CUSTOMER', 'RETURN_SUPPLIER')),
    -- Customer returns reference a SALES invoice; supplier returns reference the inbound/purchase receipt.
    original_invoice_id INT,
    original_inventory_transaction_id INT REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
    -- Created only for a completed customer return that has a REPLACE detail.
    replacement_inventory_transaction_id INT UNIQUE REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED')),
    reversal_of_return_id INT REFERENCES item_returns(id) ON DELETE RESTRICT,
    reversal_reason TEXT,
    return_date DATE NOT NULL,
    reason TEXT,
    approved_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT return_exactly_one_original_document CHECK (
        (original_invoice_id IS NOT NULL AND original_inventory_transaction_id IS NULL)
        OR (original_invoice_id IS NULL AND original_inventory_transaction_id IS NOT NULL)
    )
);

CREATE TABLE item_return_details (
    id SERIAL PRIMARY KEY,
    return_id INT NOT NULL REFERENCES item_returns(id) ON DELETE CASCADE,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    condition VARCHAR(20) NOT NULL CHECK (condition IN ('GOOD', 'DAMAGED')),
    action VARCHAR(20) NOT NULL CHECK (action IN ('RESTOCK', 'SCRAP', 'REPLACE')),
    -- Copied by backend from the original document; never supplied as an arbitrary client value.
    unit_cost DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    total_cost DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    CONSTRAINT unique_return_item UNIQUE (return_id, item_id),
    CONSTRAINT damaged_items_must_be_scrapped
        CHECK (condition <> 'DAMAGED' OR action = 'SCRAP')
);

CREATE TABLE stock_opnames (
    id SERIAL PRIMARY KEY,
    opname_number VARCHAR(50) NOT NULL UNIQUE,
    warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    opname_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED')),
    reversal_of_stock_opname_id INT REFERENCES stock_opnames(id) ON DELETE RESTRICT,
    reversal_reason TEXT,
    notes TEXT,
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE stock_opname_details (
    id SERIAL PRIMARY KEY,
    stock_opname_id INT NOT NULL REFERENCES stock_opnames(id) ON DELETE CASCADE,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    system_qty INT NOT NULL CHECK (system_qty >= 0),
    physical_qty INT NOT NULL CHECK (physical_qty >= 0),
    difference INT GENERATED ALWAYS AS (physical_qty - system_qty) STORED,
    notes TEXT,
    CONSTRAINT unique_opname_item UNIQUE (stock_opname_id, item_id)
);

CREATE TABLE stock_transfers (
    id SERIAL PRIMARY KEY,
    transfer_number VARCHAR(50) NOT NULL UNIQUE,
    source_warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    destination_warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'COMPLETED', 'CANCELLED')),
    reversal_of_transfer_id INT REFERENCES stock_transfers(id) ON DELETE RESTRICT,
    reversal_reason TEXT,
    transfer_date DATE NOT NULL,
    notes TEXT,
    approved_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT different_transfer_warehouses CHECK (source_warehouse_id <> destination_warehouse_id)
);

CREATE TABLE stock_transfer_details (
    id SERIAL PRIMARY KEY,
    transfer_id INT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    -- Cost is derived from FIFO allocations during complete; never a client-entered price.
    CONSTRAINT unique_transfer_item UNIQUE (transfer_id, item_id)
);

CREATE TABLE invoices (
    id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) NOT NULL UNIQUE,
    warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    contact_id INT REFERENCES contacts(id) ON DELETE RESTRICT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('SALES', 'PURCHASE')),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'COMPLETED', 'CANCELLED')),
    reversal_of_invoice_id INT REFERENCES invoices(id) ON DELETE RESTRICT,
    reversal_reason TEXT,
    -- Created/linked once when this invoice is completed.
    inventory_transaction_id INT UNIQUE REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
    invoice_date DATE NOT NULL,
    due_date DATE,
    subtotal DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    tax DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
    total_amount DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID'
        CHECK (payment_status IN ('UNPAID', 'PARTIAL', 'PAID')),
    notes TEXT,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE invoice_details (
    id SERIAL PRIMARY KEY,
    invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(15,2) NOT NULL CHECK (unit_price >= 0),
    amount DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    -- For SALES, backend freezes the final FIFO-derived HPP at complete.
    unit_cost DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    cost_amount DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
    CONSTRAINT unique_invoice_item UNIQUE (invoice_id, item_id)
);

CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    payment_number VARCHAR(50) NOT NULL UNIQUE,
    invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(50) NOT NULL,
    payment_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE item_returns
    ADD CONSTRAINT fk_item_returns_original_invoice
    FOREIGN KEY (original_invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT;

-- Immutable inventory ledger. The service creates these rows and updates stocks atomically.
CREATE TABLE stock_mutations (
    id SERIAL PRIMARY KEY,
    warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    type VARCHAR(20) NOT NULL CHECK (type IN ('IN', 'OUT', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT')),
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('IN', 'OUT')),
    quantity INT NOT NULL CHECK (quantity > 0),
    -- Always persist total cost because one OUT can consume several FIFO layers.
    total_cost DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
    source_type VARCHAR(30) NOT NULL CHECK (source_type IN ('INVENTORY_TRANSACTION', 'RETURN', 'STOCK_OPNAME', 'STOCK_TRANSFER')),
    source_id INT NOT NULL,
    inventory_transaction_id INT REFERENCES inventory_transactions(id) ON DELETE RESTRICT,
    return_id INT REFERENCES item_returns(id) ON DELETE RESTRICT,
    stock_opname_id INT REFERENCES stock_opnames(id) ON DELETE RESTRICT,
    stock_transfer_id INT REFERENCES stock_transfers(id) ON DELETE RESTRICT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Prevents a completed business event from being posted twice for the same stock direction.
    CONSTRAINT unique_mutation_business_event UNIQUE (source_type, source_id, warehouse_id, item_id, direction)
);

-- FIFO layers created by an IN/RETURN_IN/ADJUSTMENT-IN mutation.
CREATE TABLE inventory_cost_layers (
    id SERIAL PRIMARY KEY,
    warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
    item_id INT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    source_stock_mutation_id INT NOT NULL REFERENCES stock_mutations(id) ON DELETE RESTRICT,
    -- For transfer/return, preserves the layer from which this layer originated.
    origin_cost_layer_id INT REFERENCES inventory_cost_layers(id) ON DELETE RESTRICT,
    quantity_received INT NOT NULL CHECK (quantity_received > 0),
    quantity_remaining INT NOT NULL CHECK (quantity_remaining >= 0 AND quantity_remaining <= quantity_received),
    unit_cost DECIMAL(15,2) NOT NULL CHECK (unit_cost >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One OUT/RETURN_OUT/ADJUSTMENT-OUT mutation may consume many FIFO layers.
CREATE TABLE inventory_cost_allocations (
    id SERIAL PRIMARY KEY,
    consumption_mutation_id INT NOT NULL REFERENCES stock_mutations(id) ON DELETE RESTRICT,
    cost_layer_id INT NOT NULL REFERENCES inventory_cost_layers(id) ON DELETE RESTRICT,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_cost DECIMAL(15,2) NOT NULL CHECK (unit_cost >= 0),
    total_cost DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_consumption_layer UNIQUE (consumption_mutation_id, cost_layer_id)
);

-- Service-level constraints (must run in the same transaction as document completion):
-- * RETURN_CUSTOMER -> original_invoice_id references an invoice with type SALES.
-- * RETURN_SUPPLIER -> original_inventory_transaction_id references a transaction with type INBOUND.
-- * Each return item exists on its source document and does not exceed its remaining eligible quantity.
-- * REPLACE is allowed only for RETURN_CUSTOMER with condition GOOD. Completion returns the item to stock at its historical cost and creates replacement_inventory_transaction_id of type OUTBOUND.
-- * For the MVP, the replacement outbound uses the same item and quantity as the returned item.
-- * SUM(inventory_cost_allocations.quantity) equals stock_mutations.quantity for every OUT mutation.
-- * subtotal, tax, total_amount, and payment_status are calculated by the service, not trusted from the client.

CREATE INDEX idx_stocks_warehouse_item ON stocks (warehouse_id, item_id);
CREATE INDEX idx_inventory_transactions_filter ON inventory_transactions (warehouse_id, type, status, transaction_date);
CREATE INDEX idx_stock_mutations_filter ON stock_mutations (warehouse_id, item_id, occurred_at);
CREATE INDEX idx_cost_layers_fifo ON inventory_cost_layers (warehouse_id, item_id, created_at) WHERE quantity_remaining > 0;
CREATE INDEX idx_invoices_filter ON invoices (warehouse_id, type, status, payment_status, invoice_date);
CREATE INDEX idx_payments_invoice ON payments (invoice_id, payment_date);
