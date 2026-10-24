const STATUSES = ['OPEN', 'IN_PROGRESS', 'FULFILLED', 'REJECTED', 'CANCELLED'];

const itemRequestProperties = {
  id: { type: 'integer' },
  request_number: { type: 'string' },
  bu_id: { type: 'integer' },
  warehouse_id: { type: ['integer', 'null'] },
  warehouse_name: { type: ['string', 'null'] },
  requested_by: { type: ['integer', 'null'] },
  requester_name: { type: ['string', 'null'] },
  subject: { type: 'string' },
  description: { type: 'string' },
  status: { type: 'string', enum: STATUSES },
  source: { type: 'string' },
  external_ref: { type: ['string', 'null'] },
  response_note: { type: ['string', 'null'] },
  handled_by: { type: ['integer', 'null'] },
  handled_at: { type: ['string', 'null'] },
  created_at: { type: 'string' },
  updated_at: { type: 'string' }
};

const detailResponse = {
  type: 'object',
  properties: { data: { type: 'object', properties: itemRequestProperties } }
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

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' } }
};

const tags = ['item-requests'];

export const listItemRequestsSchema = {
  tags,
  summary: 'List item requests of your business unit',
  querystring: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'One status or a comma-separated list, e.g. OPEN,IN_PROGRESS'
      },
      warehouse_id: { type: 'integer', minimum: 1 },
      requested_by: { type: 'integer', minimum: 1 },
      mine: { type: 'boolean', description: 'Only requests created by the caller' },
      source: { type: 'string', maxLength: 50 },
      external_ref: { type: 'string', maxLength: 100, description: "The caller's own reference, to look a request up" },
      q: { type: 'string', maxLength: 100, description: 'Search in number, subject, description and requester name' },
      page: { type: 'integer', minimum: 1, default: 1 },
      per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: itemRequestProperties } },
        meta: {
          type: 'object',
          properties: { page: { type: 'integer' }, per_page: { type: 'integer' }, total: { type: 'integer' } }
        }
      }
    }
  }
};

export const getItemRequestSchema = {
  tags,
  params: idParams,
  response: { 200: detailResponse, 404: errorResponse }
};

const createResponse = {
  type: 'object',
  properties: {
    data: { type: 'object', properties: itemRequestProperties },
    meta: { type: 'object', properties: { duplicate: { type: 'boolean' } } }
  }
};

export const createItemRequestSchema = {
  tags,
  summary: 'Create an item request (also the entry point for external systems)',
  description:
    'Only `description` is required. `subject` defaults to the first line of the description. ' +
    '`external_ref` is the caller\'s own id: posting the same one again returns the earlier request (200, meta.duplicate) instead of creating a second.',
  body: {
    type: 'object',
    required: ['description'],
    additionalProperties: false,
    properties: {
      description: { type: 'string', minLength: 1, maxLength: 5000 },
      subject: { type: ['string', 'null'], maxLength: 200 },
      requester_name: { type: ['string', 'null'], maxLength: 150 },
      warehouse_id: { type: ['integer', 'null'], minimum: 1 },
      // Only needed by a super-admin (no home BU) when no warehouse_id is given.
      bu_id: { type: ['integer', 'null'], minimum: 1 },
      source: { type: ['string', 'null'], maxLength: 50 },
      external_ref: { type: ['string', 'null'], maxLength: 100 }
    }
  },
  response: { 200: createResponse, 201: createResponse, 400: errorResponse, 403: errorResponse, 404: errorResponse }
};

export const changeItemRequestStatusSchema = {
  tags,
  summary: 'Move a request forward: IN_PROGRESS, FULFILLED or REJECTED (warehouse side)',
  params: idParams,
  body: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['IN_PROGRESS', 'FULFILLED', 'REJECTED'] },
      note: { type: ['string', 'null'], maxLength: 2000, description: 'Required when status is REJECTED' }
    }
  },
  response: { 200: detailResponse, 400: errorResponse, 403: errorResponse, 404: errorResponse, 409: errorResponse }
};

export const cancelItemRequestSchema = {
  tags,
  summary: 'Cancel a request (the requester while it is OPEN, or the warehouse)',
  params: idParams,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { note: { type: ['string', 'null'], maxLength: 2000 } }
  },
  response: { 200: detailResponse, 403: errorResponse, 404: errorResponse, 409: errorResponse }
};
