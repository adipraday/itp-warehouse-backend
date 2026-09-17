const costLayerProperties = {
  id: { type: 'integer' },
  warehouse_id: { type: 'integer' },
  item_id: { type: 'integer' },
  source_stock_mutation_id: { type: 'integer' },
  origin_cost_layer_id: { type: ['integer', 'null'] },
  quantity_received: { type: 'integer' },
  quantity_remaining: { type: 'integer' },
  unit_cost: { type: 'string' },
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

const listCostLayersQuerystring = {
  type: 'object',
  properties: {
    warehouse_id: { type: 'integer' },
    item_id: { type: 'integer' },
    remaining_only: { type: 'boolean' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const listCostLayersSchema = {
  tags: ['cost-layers'],
  querystring: listCostLayersQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: costLayerProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getCostLayerSchema = {
  tags: ['cost-layers'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: costLayerProperties } } },
    404: errorResponse
  }
};

const costSummaryQuerystring = {
  type: 'object',
  properties: {
    warehouse_id: { type: 'integer' },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' }
  }
};

export const costSummarySchema = {
  tags: ['cost-summary'],
  querystring: costSummaryQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            quantity_remaining: { type: 'integer' },
            total_value: { type: 'string' }
          }
        }
      }
    }
  }
};
