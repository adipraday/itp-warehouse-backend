const sessionProperties = {
  id: { type: 'integer' },
  warehouse_id: { type: 'integer' },
  user_id: { type: 'integer' },
  status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
  opening_amount: { type: 'string' },
  closing_amount: { type: ['string', 'null'] },
  expected_cash_amount: { type: ['string', 'null'] },
  cash_difference: { type: ['string', 'null'] },
  opened_at: { type: 'string' },
  closed_at: { type: ['string', 'null'] },
  notes: { type: ['string', 'null'] },
  created_at: { type: 'string' },
  updated_at: { type: 'string' }
};

const summaryProperties = {
  summary: {
    type: 'object',
    properties: {
      by_method: {
        type: 'array',
        items: {
          type: 'object',
          properties: { method: { type: 'string' }, count: { type: 'integer' }, amount: { type: 'string' } }
        }
      },
      total_amount: { type: 'string' },
      total_count: { type: 'integer' },
      expenses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            amount: { type: 'string' },
            description: { type: 'string' },
            created_at: { type: 'string' }
          }
        }
      },
      total_expenses: { type: 'string' },
      live_expected_cash: { type: 'string' }
    }
  }
};

const sessionWithSummaryProperties = { ...sessionProperties, ...summaryProperties };

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
    user_id: { type: 'integer' },
    status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
    page: { type: 'integer', minimum: 1, default: 1 },
    per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
  }
};

export const listCashSessionsSchema = {
  tags: ['cash-sessions'],
  querystring: listQuerystring,
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: sessionProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const getCashSessionSchema = {
  tags: ['cash-sessions'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: sessionWithSummaryProperties } } },
    404: errorResponse
  }
};

export const getCurrentCashSessionSchema = {
  tags: ['cash-sessions'],
  response: {
    200: { type: 'object', properties: { data: { type: ['object', 'null'], properties: sessionWithSummaryProperties } } }
  }
};

export const openCashSessionSchema = {
  tags: ['cash-sessions'],
  body: {
    type: 'object',
    required: ['warehouse_id'],
    additionalProperties: false,
    properties: {
      warehouse_id: { type: 'integer' },
      opening_amount: { type: 'number', minimum: 0, default: 0 },
      notes: { type: ['string', 'null'], maxLength: 65535 }
    }
  },
  response: {
    201: { type: 'object', properties: { data: { type: 'object', properties: sessionProperties } } },
    409: errorResponse
  }
};

export const addExpenseSchema = {
  tags: ['cash-sessions'],
  params: idParams,
  body: {
    type: 'object',
    required: ['amount', 'description'],
    additionalProperties: false,
    properties: {
      amount: { type: 'number', exclusiveMinimum: 0 },
      // Required, not optional — an expense with no reason defeats the point
      // of the audit trail this feature exists for.
      description: { type: 'string', minLength: 1, maxLength: 255 }
    }
  },
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: sessionWithSummaryProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};

export const closeCashSessionSchema = {
  tags: ['cash-sessions'],
  params: idParams,
  body: {
    type: 'object',
    required: ['closing_amount'],
    additionalProperties: false,
    properties: {
      closing_amount: { type: 'number', minimum: 0 },
      notes: { type: ['string', 'null'], maxLength: 65535 }
    }
  },
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: sessionWithSummaryProperties } } },
    404: errorResponse,
    409: errorResponse
  }
};
