const detailProperties = {
  id: { type: 'integer' },
  item_id: { type: 'integer' },
  sku: { type: 'string' },
  name: { type: 'string' },
  system_qty: { type: 'integer' },
  physical_qty: { type: 'integer' },
  difference: { type: 'integer' },
  notes: { type: ['string', 'null'] }
};

const headerProperties = {
  id: { type: 'integer' },
  opname_number: { type: 'string' },
  warehouse_id: { type: 'integer' },
  opname_date: { type: 'string' },
  status: { type: 'string' },
  reversal_of_stock_opname_id: { type: ['integer', 'null'] },
  reversal_reason: { type: ['string', 'null'] },
  notes: { type: ['string', 'null'] },
  created_by: { type: ['integer', 'null'] },
  approved_by: { type: ['integer', 'null'] },
  submitted_at: { type: ['string', 'null'] },
  approved_at: { type: ['string', 'null'] },
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
    status: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED'] },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

const detailItem = {
  type: 'object',
  required: ['item_id', 'physical_qty'],
  additionalProperties: false,
  properties: {
    item_id: { type: 'integer' },
    physical_qty: { type: 'integer', minimum: 0 },
    notes: { type: ['string', 'null'], maxLength: 65535 }
  }
};

const documentBody = {
  type: 'object',
  required: ['warehouse_id', 'opname_date', 'details'],
  additionalProperties: false,
  properties: {
    warehouse_id: { type: 'integer' },
    opname_date: { type: 'string', format: 'date' },
    notes: { type: ['string', 'null'], maxLength: 65535 },
    reversal_of_stock_opname_id: { type: ['integer', 'null'] },
    reversal_reason: { type: ['string', 'null'], maxLength: 65535 },
    details: { type: 'array', minItems: 1, items: detailItem }
  }
};

export const listStockOpnamesSchema = {
  tags: ['stock-opnames'],
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

export const getStockOpnameSchema = {
  tags: ['stock-opnames'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse
  }
};

export const createStockOpnameSchema = {
  tags: ['stock-opnames'],
  body: documentBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    400: errorResponse
  }
};

export const updateStockOpnameSchema = {
  tags: ['stock-opnames'],
  params: idParams,
  body: documentBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const deleteStockOpnameSchema = {
  tags: ['stock-opnames'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const submitStockOpnameSchema = {
  tags: ['stock-opnames'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const approveStockOpnameSchema = {
  tags: ['stock-opnames'],
  params: idParams,
  headers: idempotencyHeaders,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const cancelStockOpnameSchema = {
  tags: ['stock-opnames'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};
