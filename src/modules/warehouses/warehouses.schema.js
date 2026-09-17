const warehouseProperties = {
  id: { type: 'integer' },
  code: { type: 'string' },
  name: { type: 'string' },
  address: { type: ['string', 'null'] },
  bu_id: { type: ['integer', 'null'] },
  // NULL = main warehouse. Set = branch, pointing at its main warehouse's id
  // (which must itself have parent_warehouse_id NULL — depth capped at 2 levels).
  parent_warehouse_id: { type: ['integer', 'null'] },
  created_by: { type: ['integer', 'null'] },
  created_at: { type: 'string' },
  updated_at: { type: 'string' }
};

const paginationQuerystring = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
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

const warehouseBody = {
  type: 'object',
  required: ['code', 'name'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 50 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    address: { type: ['string', 'null'], maxLength: 65535 },
    // Business unit that owns this warehouse. Only super-admin can set it freely;
    // an admin-bu's value is overridden with their own BU by the route.
    bu_id: { type: ['integer', 'null'], minimum: 1 },
    // Omit/null for a main warehouse; set to a main warehouse's id to make this
    // a branch. Validated server-side (same BU, parent must be a main warehouse,
    // no self-reference) — see warehouses.service.js.
    parent_warehouse_id: { type: ['integer', 'null'], minimum: 1 }
  }
};

const provisionDefaultWarehouseBody = {
  type: 'object',
  required: ['bu_id'],
  additionalProperties: false,
  properties: {
    // The BU to provision a main warehouse for. Must be one super-admin may
    // touch freely, or one of the caller's own BUs (home or admin-bu grant).
    bu_id: { type: 'integer', minimum: 1 }
  }
};

export const provisionDefaultWarehouseSchema = {
  tags: ['warehouses'],
  body: provisionDefaultWarehouseBody,
  response: {
    // 201 = a new main warehouse was created; 200 = the BU already had one,
    // returned as-is (idempotent — safe to call more than once).
    200: { type: 'object', properties: { data: { type: 'object', properties: warehouseProperties } } },
    201: { type: 'object', properties: { data: { type: 'object', properties: warehouseProperties } } },
    400: errorResponse, // INVALID_BUSINESS_UNIT
    403: errorResponse, // bu_id outside the caller's own BUs
    502: errorResponse // BUSINESS_UNIT_SERVICE_UNAVAILABLE — auth-backend unreachable
  }
};

export const listWarehousesSchema = {
  tags: ['warehouses'],
  querystring: paginationQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: warehouseProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getWarehouseSchema = {
  tags: ['warehouses'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: warehouseProperties } } },
    404: errorResponse
  }
};

export const createWarehouseSchema = {
  tags: ['warehouses'],
  body: warehouseBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: warehouseProperties } } },
    400: errorResponse, // INVALID_PARENT_WAREHOUSE | INVALID_BUSINESS_UNIT
    409: errorResponse, // WAREHOUSE_CODE_EXISTS | MAIN_WAREHOUSE_EXISTS
    502: errorResponse // BUSINESS_UNIT_SERVICE_UNAVAILABLE — auth-backend unreachable
  }
};

export const updateWarehouseSchema = {
  tags: ['warehouses'],
  params: idParams,
  body: warehouseBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: warehouseProperties } } },
    400: errorResponse, // INVALID_PARENT_WAREHOUSE | INVALID_BUSINESS_UNIT
    404: errorResponse,
    409: errorResponse, // WAREHOUSE_CODE_EXISTS | MAIN_WAREHOUSE_EXISTS | WAREHOUSE_HAS_BRANCHES
    502: errorResponse // BUSINESS_UNIT_SERVICE_UNAVAILABLE — auth-backend unreachable
  }
};

export const deleteWarehouseSchema = {
  tags: ['warehouses'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } } },
    404: errorResponse,
    409: errorResponse // WAREHOUSE_REFERENCED | WAREHOUSE_HAS_BRANCHES
  }
};

export const listWarehouseStocksSchema = {
  tags: ['warehouses'],
  params: idParams,
  querystring: paginationQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'integer' },
              sku: { type: 'string' },
              name: { type: 'string' },
              unit: { type: 'string' },
              quantity: { type: 'integer' },
              min_stock: { type: 'integer' },
              updated_at: { type: 'string' }
            }
          }
        },
        meta: paginationMeta
      }
    },
    404: errorResponse
  }
};

export const warehouseStockSummarySchema = {
  tags: ['warehouses'],
  params: idParams,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            warehouse_id: { type: 'integer' },
            total_items: { type: 'integer' },
            total_quantity: { type: 'integer' },
            low_stock_count: { type: 'integer' },
            out_of_stock_count: { type: 'integer' }
          }
        }
      }
    },
    404: errorResponse
  }
};
