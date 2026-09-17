const itemProperties = {
  id: { type: 'integer' },
  bu_id: { type: ['integer', 'null'] },
  sku: { type: 'string' },
  barcode: { type: ['string', 'null'] },
  name: { type: 'string' },
  unit: { type: 'string' },
  min_stock: { type: 'integer' },
  selling_price: { type: 'string' },
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

const itemBody = {
  type: 'object',
  required: ['sku', 'name', 'unit'],
  additionalProperties: false,
  properties: {
    sku: { type: 'string', minLength: 1, maxLength: 50 },
    // Optional — the printed/scanned barcode, distinct from `sku` (a supplier's
    // barcode rarely matches a shop's own internal product code).
    barcode: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 150 },
    unit: { type: 'string', minLength: 1, maxLength: 20 },
    min_stock: { type: 'integer', minimum: 0, default: 0 },
    selling_price: { type: 'number', minimum: 0, default: 0 },
    // Only super-admin can set this freely; anyone else's value is overridden
    // with (one of) their own BU(s) by the route — same pattern as warehouses.
    bu_id: { type: ['integer', 'null'], minimum: 1 }
  }
};

export const listItemsSchema = {
  tags: ['items'],
  querystring: paginationQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: itemProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getItemSchema = {
  tags: ['items'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: itemProperties } } },
    404: errorResponse
  }
};

export const createItemSchema = {
  tags: ['items'],
  body: itemBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: itemProperties } } },
    409: errorResponse
  }
};

export const updateItemSchema = {
  tags: ['items'],
  params: idParams,
  body: itemBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: itemProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

const searchQuerystring = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1 },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const searchItemsSchema = {
  tags: ['items'],
  querystring: searchQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: itemProperties } },
        meta: paginationMeta
      }
    }
  }
};

const barcodeParams = {
  type: 'object',
  required: ['barcode'],
  properties: { barcode: { type: 'string', minLength: 1 } }
};

const getItemByBarcodeQuerystring = {
  type: 'object',
  properties: {
    // Optional — when given, the response is enriched with that warehouse's
    // current stock quantity for the item (one round trip per scan at the POS).
    warehouse_id: { type: 'integer' }
  }
};

export const getItemByBarcodeSchema = {
  tags: ['items'],
  params: barcodeParams,
  querystring: getItemByBarcodeQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            ...itemProperties,
            stock: {
              type: 'object',
              properties: { warehouse_id: { type: 'integer' }, quantity: { type: 'integer' } }
            }
          }
        }
      }
    },
    404: errorResponse
  }
};

// No `body` schema — this route takes multipart/form-data (a file upload),
// which Fastify JSON-schema validation doesn't cover; @fastify/multipart
// handles that part. This schema exists for the response shape / Swagger docs.
export const importItemsSchema = {
  tags: ['items'],
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            rows_processed: { type: 'integer' },
            items_created: { type: 'integer' },
            items_updated: { type: 'integer' },
            warehouses_stocked: { type: 'integer' },
            inbound_ids: { type: 'array', items: { type: 'integer' } }
          }
        }
      }
    },
    400: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: { row: { type: 'integer' }, message: { type: 'string' } }
              }
            }
          }
        }
      }
    }
  }
};

// Both template/export routes send raw file bytes (reply.send(buffer)), not
// JSON — no response schema needed/possible for those; these only validate
// the querystring.
export const importTemplateSchema = {
  tags: ['items'],
  querystring: {
    type: 'object',
    properties: { format: { type: 'string', enum: ['csv', 'xlsx'], default: 'csv' } }
  }
};

export const exportItemsSchema = {
  tags: ['items'],
  querystring: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['csv', 'xlsx'], default: 'csv' },
      // Omit for one row per item (master data only, safe to re-import
      // as-is). Give it for one row per item AT that warehouse, including
      // current stock for reference — see items-export.service.js.
      warehouse_id: { type: 'integer' }
    }
  }
};

const itemStockProperties = {
  warehouse_id: { type: 'integer' },
  warehouse_code: { type: 'string' },
  warehouse_name: { type: 'string' },
  quantity: { type: 'integer' },
  updated_at: { type: 'string' }
};

const itemStocksQuerystring = {
  type: 'object',
  properties: {
    warehouse_id: { type: 'integer' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const listItemStocksSchema = {
  tags: ['items'],
  params: idParams,
  querystring: itemStocksQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: itemStockProperties } },
        meta: paginationMeta
      }
    },
    404: errorResponse
  }
};

const warehouseIdRequiredQuerystring = {
  type: 'object',
  required: ['warehouse_id'],
  properties: { warehouse_id: { type: 'integer' } }
};

export const itemCostSchema = {
  tags: ['items'],
  params: idParams,
  querystring: warehouseIdRequiredQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            item_id: { type: 'integer' },
            warehouse_id: { type: 'integer' },
            quantity_remaining: { type: 'integer' },
            total_value: { type: 'string' },
            average_unit_cost: { type: 'string' }
          }
        }
      }
    },
    404: errorResponse
  }
};

const costHistoryQuerystring = {
  type: 'object',
  required: ['warehouse_id'],
  properties: {
    warehouse_id: { type: 'integer' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const itemCostHistorySchema = {
  tags: ['items'],
  params: idParams,
  querystring: costHistoryQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              quantity_received: { type: 'integer' },
              quantity_remaining: { type: 'integer' },
              unit_cost: { type: 'string' },
              origin_cost_layer_id: { type: ['integer', 'null'] },
              created_at: { type: 'string' }
            }
          }
        },
        meta: paginationMeta
      }
    },
    404: errorResponse
  }
};
