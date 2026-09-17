export const accessStatusSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            role: { type: ['string', 'null'] },
            // false only for a STAFF_ROLES user with zero warehouse
            // assignments — always true for admin-bu/owner/super-admin, who
            // are exempt from this feature entirely.
            assigned: { type: 'boolean' },
            // The specific warehouse(s) a staff user was assigned to. null
            // for an exempt role (not applicable — they aren't restricted to
            // specific warehouses in the first place).
            warehouse_ids: { type: ['array', 'null'], items: { type: 'integer' } }
          }
        }
      }
    }
  }
};
