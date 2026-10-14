const detailProperties = {
  id: { type: 'integer' },
  item_id: { type: 'integer' },
  sku: { type: 'string' },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  received_quantity: { type: 'integer' },
  closed_quantity: { type: 'integer' },
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
  receipt_status: { type: ['string', 'null'] },
  reversal_of_invoice_id: { type: ['integer', 'null'] },
  reversal_reason: { type: ['string', 'null'] },
  inventory_transaction_id: { type: ['integer', 'null'] },
  invoice_date: { type: 'string' },
  due_date: { type: ['string', 'null'] },
  subtotal: { type: 'string' },
  tax: { type: 'string' },
  tax_rate: { type: 'string' },
  total_amount: { type: 'string' },
  payment_status: { type: 'string' },
  paid_amount: { type: 'string' },
  refunded_amount: { type: 'string' },
  refund_due: { type: 'string' },
  notes: { type: ['string', 'null'] },
  supplier_invoice_number: { type: ['string', 'null'] },
  supplier_invoice_file_name: { type: ['string', 'null'] },
  supplier_invoice_file_size: { type: ['integer', 'null'] },
  supplier_invoice_uploaded_at: { type: ['string', 'null'] },
  has_supplier_invoice_file: { type: 'boolean' },
  cancel_reason: { type: ['string', 'null'] },
  submitted_at: { type: ['string', 'null'] },
  submitted_by: { type: ['integer', 'null'] },
  created_by: { type: ['integer', 'null'] },
  completed_by: { type: ['integer', 'null'] },
  completed_at: { type: ['string', 'null'] },
  cancelled_at: { type: ['string', 'null'] },
  created_at: { type: 'string' },
  updated_at: { type: 'string' }
};

const receiptProperties = {
  id: { type: 'integer' },
  invoice_id: { type: 'integer' },
  inventory_transaction_id: { type: 'integer' },
  received_by: { type: ['integer', 'null'] },
  received_at: { type: 'string' },
  notes: { type: ['string', 'null'] }
};

const refundProperties = {
  id: { type: 'integer' },
  refund_number: { type: 'string' },
  invoice_id: { type: 'integer' },
  amount: { type: 'string' },
  refund_method: { type: 'string' },
  refund_date: { type: 'string' },
  notes: { type: ['string', 'null'] },
  created_by: { type: ['integer', 'null'] },
  created_at: { type: 'string' }
};

const documentProperties = {
  ...headerProperties,
  details: { type: 'array', items: { type: 'object', properties: detailProperties } },
  receipts: { type: 'array', items: { type: 'object', properties: receiptProperties } },
  refunds: { type: 'array', items: { type: 'object', properties: refundProperties } }
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
    receipt_status: { type: 'string', enum: ['PENDING_APPROVAL', 'PARTIALLY_RECEIVED'] },
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
    notes: { type: ['string', 'null'], maxLength: 65535 },
    supplier_invoice_number: { type: ['string', 'null'], maxLength: 100 },
    reversal_of_invoice_id: { type: ['integer', 'null'] },
    reversal_reason: { type: ['string', 'null'], maxLength: 65535 },
    details: { type: 'array', minItems: 1, items: detailItem }
  }
};

export const listPurchasesSchema = {
  tags: ['purchases'],
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

export const getPurchaseSchema = {
  tags: ['purchases'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse
  }
};

export const createPurchaseSchema = {
  tags: ['purchases'],
  body: documentBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    400: errorResponse
  }
};

export const updatePurchaseSchema = {
  tags: ['purchases'],
  params: idParams,
  body: documentBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const deletePurchaseSchema = {
  tags: ['purchases'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } } },
    404: errorResponse,
    409: errorResponse
  }
};

const purchaseResponse = {
  200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
  404: errorResponse,
  409: errorResponse
};

export const submitPurchaseSchema = {
  tags: ['purchases'],
  params: idParams,
  response: purchaseResponse
};

export const receivePurchaseSchema = {
  tags: ['purchases'],
  params: idParams,
  headers: idempotencyHeaders,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Quantities actually received per item; omit to receive everything outstanding. An item that
      // is left out counts as 0 received.
      lines: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['item_id', 'quantity'],
          additionalProperties: false,
          properties: {
            item_id: { type: 'integer' },
            quantity: { type: 'integer', minimum: 0 }
          }
        }
      },
      // Required when something is still missing: WAIT = the supplier replaces it later,
      // REFUND = close the shortfall and have it refunded.
      shortfall_action: { type: 'string', enum: ['WAIT', 'REFUND'] },
      notes: { type: ['string', 'null'], maxLength: 65535 }
    }
  },
  response: { ...purchaseResponse, 400: errorResponse, 403: errorResponse }
};

export const completePurchaseSchema = {
  tags: ['purchases'],
  params: idParams,
  headers: idempotencyHeaders,
  response: { ...purchaseResponse, 403: errorResponse }
};

export const cancelPurchaseSchema = {
  tags: ['purchases'],
  params: idParams,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { reason: { type: ['string', 'null'], maxLength: 65535 } }
  },
  response: { ...purchaseResponse, 400: errorResponse }
};

export const recordRefundSchema = {
  tags: ['purchases'],
  params: idParams,
  body: {
    type: 'object',
    required: ['amount', 'refund_method', 'refund_date'],
    additionalProperties: false,
    properties: {
      amount: { type: 'number', exclusiveMinimum: 0 },
      refund_method: { type: 'string', minLength: 1, maxLength: 50 },
      refund_date: { type: 'string', format: 'date' },
      notes: { type: ['string', 'null'], maxLength: 65535 }
    }
  },
  response: {
    201: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: refundProperties },
        purchase: { type: 'object', properties: documentProperties }
      }
    },
    404: errorResponse,
    409: errorResponse
  }
};

export const updateSupplierInvoiceSchema = {
  tags: ['purchases'],
  params: idParams,
  body: {
    type: 'object',
    required: ['supplier_invoice_number'],
    additionalProperties: false,
    properties: { supplier_invoice_number: { type: ['string', 'null'], maxLength: 100 } }
  },
  response: purchaseResponse
};

export const uploadSupplierInvoiceFileSchema = {
  tags: ['purchases'],
  params: idParams,
  response: { ...purchaseResponse, 400: errorResponse, 503: errorResponse }
};

export const downloadSupplierInvoiceFileSchema = {
  tags: ['purchases'],
  params: idParams,
  response: { 404: errorResponse, 503: errorResponse }
};

export const deleteSupplierInvoiceFileSchema = {
  tags: ['purchases'],
  params: idParams,
  response: { ...purchaseResponse, 503: errorResponse }
};
