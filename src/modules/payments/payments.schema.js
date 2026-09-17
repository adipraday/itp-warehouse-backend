// Structured payment methods (2026-09-13) — replaces free text going forward.
// Fixed set covers the common Indonesian retail register; OTHER is the
// deliberate escape hatch rather than letting the set grow unbounded.
// Enforced on write only (createPaymentBody below) — existing rows recorded
// before this enum existed (e.g. "Cash", "transfer") are left as-is and still
// serialize fine, since payment_method in the response stays a plain string.
export const PAYMENT_METHODS = ['CASH', 'QRIS', 'DEBIT', 'CREDIT', 'TRANSFER', 'EWALLET', 'OTHER'];

const paymentProperties = {
  id: { type: 'integer' },
  payment_number: { type: 'string' },
  invoice_id: { type: 'integer' },
  // Server-resolved, never client-supplied — see payments.service.js.
  cash_session_id: { type: ['integer', 'null'] },
  amount: { type: 'string' },
  // Physical cash handed over (only meaningful for CASH) and the change given
  // back — see payments.service.js. amount_tendered === amount and
  // change_amount === "0.00" whenever the client didn't send amount_tendered.
  amount_tendered: { type: 'string' },
  change_amount: { type: 'string' },
  payment_method: { type: 'string' },
  payment_date: { type: 'string' },
  notes: { type: ['string', 'null'] },
  created_by: { type: ['integer', 'null'] },
  created_at: { type: 'string' }
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
    invoice_id: { type: 'integer' },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

const createPaymentBody = {
  type: 'object',
  required: ['invoice_id', 'amount', 'payment_method', 'payment_date'],
  additionalProperties: false,
  properties: {
    invoice_id: { type: 'integer' },
    amount: { type: 'number', exclusiveMinimum: 0 },
    // Optional — physical cash tendered, when it's more than `amount` (the
    // customer pays more than owed and gets change back). Omit for exact
    // payments or non-cash methods; defaults to `amount` (no change).
    amount_tendered: { type: 'number', exclusiveMinimum: 0 },
    payment_method: { type: 'string', enum: PAYMENT_METHODS },
    payment_date: { type: 'string', format: 'date' },
    notes: { type: ['string', 'null'], maxLength: 65535 }
  }
};

export const listPaymentsSchema = {
  tags: ['payments'],
  querystring: listQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: paymentProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getPaymentSchema = {
  tags: ['payments'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: paymentProperties } } },
    404: errorResponse
  }
};

export const createPaymentSchema = {
  tags: ['payments'],
  body: createPaymentBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: paymentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};
