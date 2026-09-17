const assignmentProperties = {
  id: { type: 'integer' },
  user_id: { type: 'integer' },
  warehouse_id: { type: 'integer' },
  assigned_by: { type: ['integer', 'null'] },
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

export const listAssignmentsSchema = {
  querystring: {
    type: 'object',
    properties: {
      user_id: { type: 'integer' },
      warehouse_id: { type: 'integer' },
      page: { type: 'integer', minimum: 1, default: 1 },
      per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: assignmentProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const createAssignmentSchema = {
  body: {
    type: 'object',
    required: ['user_id', 'warehouse_id'],
    properties: {
      user_id: { type: 'integer' },
      warehouse_id: { type: 'integer' }
    }
  },
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: assignmentProperties } } }
  }
};

export const deleteAssignmentSchema = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  response: {
    200: {
      type: 'object',
      properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } }
    }
  }
};
