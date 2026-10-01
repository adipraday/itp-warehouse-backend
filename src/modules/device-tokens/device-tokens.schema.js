const deviceTokenProperties = {
  id: { type: 'integer' },
  user_id: { type: 'integer' },
  fcm_token: { type: 'string' },
  role: { type: 'string' },
  bu_id: { type: ['integer', 'null'] },
  platform: { type: ['string', 'null'] },
  created_at: { type: 'string' },
  updated_at: { type: 'string' }
};

export const registerDeviceTokenSchema = {
  body: {
    type: 'object',
    required: ['fcm_token'],
    additionalProperties: false,
    properties: {
      fcm_token: { type: 'string', minLength: 1, maxLength: 255 },
      platform: { type: 'string', maxLength: 20 }
    }
  },
  response: {
    200: { type: 'object', properties: { data: { type: 'object', properties: deviceTokenProperties } } }
  }
};

export const unregisterDeviceTokenSchema = {
  body: {
    type: 'object',
    required: ['fcm_token'],
    additionalProperties: false,
    properties: { fcm_token: { type: 'string', minLength: 1, maxLength: 255 } }
  },
  response: {
    200: {
      type: 'object',
      properties: { data: { type: 'object', properties: { fcm_token: { type: 'string' } } } }
    }
  }
};
