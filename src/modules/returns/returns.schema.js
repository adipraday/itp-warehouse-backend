const detailProperties = {
  id: { type: 'integer' },
  item_id: { type: 'integer' },
  sku: { type: 'string' },
  name: { type: 'string' },
  quantity: { type: 'integer' },
  condition: { type: 'string' },
  action: { type: 'string' },
  unit_cost: { type: 'string' },
  total_cost: { type: 'string' }
};

const headerProperties = {
  id: { type: 'integer' },
  return_number: { type: 'string' },
  warehouse_id: { type: 'integer' },
  contact_id: { type: 'integer' },
  type: { type: 'string' },
  original_invoice_id: { type: ['integer', 'null'] },
  original_inventory_transaction_id: { type: ['integer', 'null'] },
  replacement_inventory_transaction_id: { type: ['integer', 'null'] },
  status: { type: 'string' },
  reversal_of_return_id: { type: ['integer', 'null'] },
  reversal_reason: { type: ['string', 'null'] },
  return_date: { type: 'string' },
  reason: { type: ['string', 'null'] },
  created_by: { type: ['integer', 'null'] },
  approved_by: { type: ['integer', 'null'] },
  completed_by: { type: ['integer', 'null'] },
  approved_at: { type: ['string', 'null'] },
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
    type: { type: 'string', enum: ['RETURN_CUSTOMER', 'RETURN_SUPPLIER'] },
    status: { type: 'string', enum: ['DRAFT', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'] },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

const detailItem = {
  type: 'object',
  required: ['item_id', 'quantity', 'condition', 'action'],
  additionalProperties: false,
  properties: {
    item_id: { type: 'integer' },
    quantity: { type: 'integer', minimum: 1 },
    condition: { type: 'string', enum: ['GOOD', 'DAMAGED'] },
    action: { type: 'string', enum: ['RESTOCK', 'SCRAP', 'REPLACE'] }
  }
};

const createBody = {
  type: 'object',
  required: ['warehouse_id', 'contact_id', 'type', 'return_date', 'details'],
  additionalProperties: false,
  properties: {
    warehouse_id: { type: 'integer' },
    contact_id: { type: 'integer' },
    type: { type: 'string', enum: ['RETURN_CUSTOMER', 'RETURN_SUPPLIER'] },
    original_invoice_id: { type: ['integer', 'null'] },
    original_inventory_transaction_id: { type: ['integer', 'null'] },
    return_date: { type: 'string', format: 'date' },
    reason: { type: ['string', 'null'], maxLength: 65535 },
    reversal_of_return_id: { type: ['integer', 'null'] },
    reversal_reason: { type: ['string', 'null'], maxLength: 65535 },
    details: { type: 'array', minItems: 1, items: detailItem }
  }
};

// type and the original document reference are immutable after creation.
const updateBody = {
  type: 'object',
  required: ['warehouse_id', 'contact_id', 'return_date', 'details'],
  additionalProperties: false,
  properties: {
    warehouse_id: { type: 'integer' },
    contact_id: { type: 'integer' },
    return_date: { type: 'string', format: 'date' },
    reason: { type: ['string', 'null'], maxLength: 65535 },
    details: { type: 'array', minItems: 1, items: detailItem }
  }
};

export const listItemReturnsSchema = {
  tags: ['returns'],
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

export const getItemReturnSchema = {
  tags: ['returns'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse
  }
};

export const createItemReturnSchema = {
  tags: ['returns'],
  body: createBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    400: errorResponse,
    409: errorResponse
  }
};

export const updateItemReturnSchema = {
  tags: ['returns'],
  params: idParams,
  body: updateBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    400: errorResponse,
    404: errorResponse,
    409: errorResponse
  }
};

export const deleteItemReturnSchema = {
  tags: ['returns'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const approveItemReturnSchema = {
  tags: ['returns'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const completeItemReturnSchema = {
  tags: ['returns'],
  params: idParams,
  headers: idempotencyHeaders,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const rejectItemReturnSchema = {
  tags: ['returns'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const cancelItemReturnSchema = {
  tags: ['returns'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: documentProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};
