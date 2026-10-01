const notificationProperties = {
  id: { type: 'integer' },
  user_id: { type: 'integer' },
  title: { type: 'string' },
  body: { type: 'string' },
  type: { type: 'string' },
  data: {},
  is_read: { type: 'boolean' },
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

export const listNotificationsSchema = {
  tags: ['notifications'],
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: notificationProperties } },
        meta: paginationMeta
      }
    }
  }
};

export const unreadCountSchema = {
  tags: ['notifications'],
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: { count: { type: 'integer' } } } } }
  }
};

export const markNotificationReadSchema = {
  tags: ['notifications'],
  params: idParams,
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: notificationProperties } } },
    404: errorResponse
  }
};

export const markAllNotificationsReadSchema = {
  tags: ['notifications'],
  response: {
    200: {
      type: 'object',
      properties: { data: { type: 'object', properties: { updated_count: { type: 'integer' } } } }
    }
  }
};
