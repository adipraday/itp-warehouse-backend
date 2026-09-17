const detailProperties = {
  id: { type: 'integer' },
  item_id: { type: 'integer' },
  sku: { type: 'string' },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  unit_price: { type: 'string' },
  amount: { type: 'string' },
  unit_cost: { type: 'string' },
  cost_amount: { type: 'string' }
};

const headerProperties = {
  id: { type: 'integer' },
  invoice_number: { type: 'string' },
  warehouse_id: { type: 'integer' },
  contact_id: { type: ['integer', 'null'] },
  type: { type: 'string' },
  status: { type: 'string' },
  held_at: { type: ['string', 'null'] },
  hold_label: { type: ['string', 'null'] },
  reversal_of_invoice_id: { type: ['integer', 'null'] },
  reversal_reason: { type: ['string', 'null'] },
  inventory_transaction_id: { type: ['integer', 'null'] },
  invoice_date: { type: 'string' },
  due_date: { type: ['string', 'null'] },
  subtotal: { type: 'string' },
  discount_amount: { type: 'string' },
  tax: { type: 'string' },
  total_amount: { type: 'string' },
  payment_status: { type: 'string' },
  notes: { type: ['string', 'null'] },
  created_by: { type: ['integer', 'null'] },
  completed_by: { type: ['integer', 'null'] },
  completed_at: { type: ['string', 'null'] },
  cancelled_at: { type: ['string', 'null'] },
  created_at: { type: 'string' },
  updated_at: { type: 'string' }
};

const documentProperties = {
  ...headerProperties,
  details: { type: 'array', items: { type: 'object', properties: detailProperties } }
};

const paginationMeta = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    per_page: { type: 'integer' },
    total: { type: 'integer' }
  }
};

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' } }
};

const errorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'array' }
      }
    }
  }
};

const idempotencyHeaders = {
  type: 'object',
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 }
  }
};

const listQuerystring = {
  type: 'object',
  properties: {
    warehouse_id: { type: 'integer' },
    status: { type: 'string', enum: ['DRAFT', 'COMPLETED', 'CANCELLED'] },
    // true = only currently-held (parked) DRAFTs; false = only non-held.
    // Omit for no filter on hold state at all (existing default behavior).
    held: { type: 'boolean' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

const detailItem = {
  type: 'object',
  required: ['item_id', 'quantity'],
  additionalProperties: false,
  properties: {
    item_id: { type: 'integer' },
    quantity: { type: 'integer', minimum: 1 },
    unit_price: { type: 'number', minimum: 0, default: 0 }
  }
};

const documentBody = {
  type: 'object',
  required: ['warehouse_id', 'invoice_date', 'details'],
  additionalProperties: false,
  properties: {
    warehouse_id: { type: 'integer' },
    contact_id: { type: ['integer', 'null'] },
    invoice_date: { type: 'string', format: 'date' },
    due_date: { type: ['string', 'null'], format: 'date' },
    tax_rate: { type: 'number', minimum: 0, maximum: 1, default: 0 },
    // Flat transaction-level discount, applied BEFORE tax. Must not exceed
    // the subtotal derived from `details` — 400 DISCOUNT_EXCEEDS_SUBTOTAL.
    discount_amount: { type: 'number', minimum: 0, default: 0 },
    notes: { type: ['string', 'null'], maxLength: 65535 },
    reversal_of_invoice_id: { type: ['integer', 'null'] },
    reversal_reason: { type: ['string', 'null'], maxLength: 65535 },
    details: { type: 'array', minItems: 1, items: detailItem }
  }
};

export const listSalesSchema = {
  tags: ['sales'],
  querystring: listQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: headerProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getSaleSchema = {
  tags: ['sales'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse
  }
};

export const createSaleSchema = {
  tags: ['sales'],
  body: documentBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    400: errorResponse
  }
};

export const updateSaleSchema = {
  tags: ['sales'],
  params: idParams,
  body: documentBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const deleteSaleSchema = {
  tags: ['sales'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } } },
    404: errorResponse,
    409: errorResponse
  }
};

const receiptQuerystring = {
  type: 'object',
  properties: {
    // 58mm (32 chars/line) or 80mm (48 chars/line) thermal paper. Defaults to
    // 58mm — the more common size for small/medium cash registers.
    paper_width_mm: { type: 'integer', enum: [58, 80], default: 58 }
  }
};

export const getSaleReceiptSchema = {
  tags: ['sales'],
  params: idParams,
  querystring: receiptQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            invoice_number: { type: 'string' },
            invoice_date: { type: 'string' },
            warehouse: {
              type: ['object', 'null'],
              properties: {
                id: { type: 'integer' },
                code: { type: 'string' },
                name: { type: 'string' },
                address: { type: ['string', 'null'] }
              }
            },
            business_unit: {
              type: ['object', 'null'],
              properties: { id: { type: 'integer' }, name: { type: 'string' } }
            },
            customer: {
              type: ['object', 'null'],
              properties: { id: { type: 'integer' }, name: { type: 'string' } }
            },
            cashier_user_id: { type: ['integer', 'null'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sku: { type: 'string' },
                  name: { type: 'string' },
                  quantity: { type: 'integer' },
                  unit_price: { type: 'string' },
                  amount: { type: 'string' }
                }
              }
            },
            subtotal: { type: 'string' },
            discount_amount: { type: 'string' },
            tax: { type: 'string' },
            total_amount: { type: 'string' },
            payments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  method: { type: 'string' },
                  amount: { type: 'string' },
                  amount_tendered: { type: 'string' },
                  change_amount: { type: 'string' },
                  payment_date: { type: 'string' }
                }
              }
            },
            amount_paid: { type: 'string' },
            balance_due: { type: 'string' },
            paper_width_mm: { type: 'integer' },
            text_lines: { type: 'array', items: { type: 'string' } },
            escpos_base64: { type: 'string' }
          }
        }
      }
    },
    404: errorResponse,
    409: errorResponse
  }
};

export const holdSaleSchema = {
  tags: ['sales'],
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Friendly identifier for the "Held Transactions" screen, e.g. "Meja 5"
      // or a customer's name. Optional.
      hold_label: { type: ['string', 'null'], maxLength: 100 }
    }
  },
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const resumeSaleSchema = {
  tags: ['sales'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const completeSaleSchema = {
  tags: ['sales'],
  params: idParams,
  headers: idempotencyHeaders,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const cancelSaleSchema = {
  tags: ['sales'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};
