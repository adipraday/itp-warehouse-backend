const stockProperties = {
  id: { type: 'integer' },
  warehouse_id: { type: 'integer' },
  warehouse_code: { type: 'string' },
  warehouse_name: { type: 'string' },
  item_id: { type: 'integer' },
  sku: { type: 'string' },
  item_name: { type: 'string' },
  unit: { type: 'string' },
  min_stock: { type: 'integer' },
  quantity: { type: 'integer' },
  updated_at: { type: 'string' }
};

const paginationMeta = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    per_page: { type: 'integer' },
    total: { type: 'integer' }
  }
};

const listStocksQuerystring = {
  type: 'object',
  properties: {
    warehouse_id: { type: 'integer' },
    item_id: { type: 'integer' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

const warehouseFilterQuerystring = {
  type: 'object',
  properties: {
    warehouse_id: { type: 'integer' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

const stockListResponse = {
  200: {
    type: 'object',
    properties: {
      data: { type: 'array', items: { type: 'object', properties: stockProperties } },
      meta: paginationMeta
    }
  }
};

export const listStocksSchema = {
  tags: ['stocks'],
  querystring: listStocksQuerystring,
  response: stockListResponse
};

export const lowStockSchema = {
  tags: ['stocks'],
  querystring: warehouseFilterQuerystring,
  response: stockListResponse
};

export const outOfStockSchema = {
  tags: ['stocks'],
  querystring: warehouseFilterQuerystring,
  response: stockListResponse
};
