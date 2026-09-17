const logProperties = {
  id: { type: 'integer' },
  user_id: { type: ['integer', 'null'] },
  warehouse_id: { type: ['integer', 'null'] },
  bu_id: { type: ['integer', 'null'] },
  action: { type: 'string' },
  entity_type: { type: 'string' },
  entity_id: { type: ['integer', 'null'] },
  method: { type: 'string' },
  endpoint: { type: 'string' },
  status_code: { type: 'integer' },
  metadata: {},
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
    user_id: { type: 'integer' },
    warehouse_id: { type: 'integer' },
    entity_type: { type: 'string' },
    entity_id: { type: 'integer' },
    action: { type: 'string' },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const listActivityLogsSchema = {
  tags: ['activity-logs'],
  querystring: listQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: logProperties } },
        meta: paginationMeta
      }
    },
    403: errorResponse // explicit ?warehouse_id outside the caller's business unit(s)
  }
};

export const getActivityLogSchema = {
  tags: ['activity-logs'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: logProperties } } },
    404: errorResponse
  }
};
