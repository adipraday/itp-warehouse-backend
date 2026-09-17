const mutationProperties = {
  id: { type: 'integer' },
  warehouse_id: { type: 'integer' },
  item_id: { type: 'integer' },
  type: { type: 'string' },
  direction: { type: 'string' },
  quantity: { type: 'integer' },
  total_cost: { type: 'string' },
  source_type: { type: 'string' },
  source_id: { type: 'integer' },
  inventory_transaction_id: { type: ['integer', 'null'] },
  return_id: { type: ['integer', 'null'] },
  stock_opname_id: { type: ['integer', 'null'] },
  stock_transfer_id: { type: ['integer', 'null'] },
  occurred_at: { type: 'string' },
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
    warehouse_id: { type: 'integer' },
    item_id: { type: 'integer' },
    type: { type: 'string', enum: ['IN', 'OUT', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT'] },
    direction: { type: 'string', enum: ['IN', 'OUT'] },
    source_type: { type: 'string', enum: ['INVENTORY_TRANSACTION', 'RETURN', 'STOCK_OPNAME', 'STOCK_TRANSFER'] },
    source_id: { type: 'integer' },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const listStockMutationsSchema = {
  tags: ['stock-mutations'],
  querystring: listQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: mutationProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getStockMutationSchema = {
  tags: ['stock-mutations'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: mutationProperties } } },
    404: errorResponse
  }
};
