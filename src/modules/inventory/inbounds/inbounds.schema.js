const detailProperties = {
  id: { type: 'integer' },
  item_id: { type: 'integer' },
  sku: { type: 'string' },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  unit_price: { type: 'string' },
  total_price: { type: 'string' }
};

const headerProperties = {
  id: { type: 'integer' },
  transaction_number: { type: 'string' },
  warehouse_id: { type: 'integer' },
  contact_id: { type: ['integer', 'null'] },
  type: { type: 'string' },
  status: { type: 'string' },
  reversal_of_transaction_id: { type: ['integer', 'null'] },
  reversal_reason: { type: ['string', 'null'] },
  transaction_date: { type: 'string' },
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
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
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
  required: ['warehouse_id', 'transaction_date', 'details'],
  additionalProperties: false,
  properties: {
    warehouse_id: { type: 'integer' },
    contact_id: { type: ['integer', 'null'] },
    transaction_date: { type: 'string', format: 'date' },
    notes: { type: ['string', 'null'], maxLength: 65535 },
    reversal_of_transaction_id: { type: ['integer', 'null'] },
    reversal_reason: { type: ['string', 'null'], maxLength: 65535 },
    details: { type: 'array', minItems: 1, items: detailItem }
  }
};

export const listInboundsSchema = {
  tags: ['inbounds'],
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

export const getInboundSchema = {
  tags: ['inbounds'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse
  }
};

export const createInboundSchema = {
  tags: ['inbounds'],
  body: documentBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    400: errorResponse
  }
};

export const updateInboundSchema = {
  tags: ['inbounds'],
  params: idParams,
  body: documentBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const deleteInboundSchema = {
  tags: ['inbounds'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const completeInboundSchema = {
  tags: ['inbounds'],
  params: idParams,
  headers: idempotencyHeaders,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const cancelInboundSchema = {
  tags: ['inbounds'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};
