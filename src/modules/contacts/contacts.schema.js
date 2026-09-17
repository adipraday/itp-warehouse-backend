const contactProperties = {
  id: { type: 'integer' },
  bu_id: { type: ['integer', 'null'] },
  type: { type: 'string' },
  name: { type: 'string' },
  phone: { type: ['string', 'null'] },
  email: { type: ['string', 'null'] },
  address: { type: ['string', 'null'] },
  created_by: { type: ['integer', 'null'] },
  created_at: { type: 'string' },
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

const listContactsQuerystring = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['supplier', 'customer', 'both'] },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

const contactBody = {
  type: 'object',
  required: ['type', 'name'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['supplier', 'customer', 'both'] },
    name: { type: 'string', minLength: 1, maxLength: 150 },
    phone: { type: ['string', 'null'], maxLength: 20 },
    email: { type: ['string', 'null'], maxLength: 100 },
    address: { type: ['string', 'null'], maxLength: 65535 },
    // Only super-admin can set this freely; anyone else's value is overridden
    // with (one of) their own BU(s) by the route — same pattern as warehouses.
    bu_id: { type: ['integer', 'null'], minimum: 1 }
  }
};

export const listContactsSchema = {
  tags: ['contacts'],
  querystring: listContactsQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: contactProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getContactSchema = {
  tags: ['contacts'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: contactProperties } } },
    404: errorResponse
  }
};

export const createContactSchema = {
  tags: ['contacts'],
  body: contactBody,
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: contactProperties } } }
  }
};

export const updateContactSchema = {
  tags: ['contacts'],
  params: idParams,
  body: contactBody,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: contactProperties } } },
    404: errorResponse
  }
};
