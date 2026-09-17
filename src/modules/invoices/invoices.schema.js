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

const listQuerystring = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['SALES', 'PURCHASE'] },
    status: { type: 'string', enum: ['DRAFT', 'COMPLETED', 'CANCELLED'] },
    payment_status: { type: 'string', enum: ['UNPAID', 'PARTIAL', 'PAID'] },
    warehouse_id: { type: 'integer' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const listInvoicesSchema = {
  tags: ['invoices'],
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

export const getInvoiceSchema = {
  tags: ['invoices'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse
  }
};

const paymentProperties = {
  id: { type: 'integer' },
  payment_number: { type: 'string' },
  invoice_id: { type: 'integer' },
  amount: { type: 'string' },
  payment_method: { type: 'string' },
  payment_date: { type: 'string' },
  notes: { type: ['string', 'null'] },
  created_by: { type: ['integer', 'null'] },
  created_at: { type: 'string' }
};

const paginationQuerystring = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const listInvoicePaymentsSchema = {
  tags: ['invoices'],
  params: idParams,
  querystring: paginationQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: paymentProperties } },
        meta: paginationMeta
      }
    },
    404: errorResponse
  }
};
