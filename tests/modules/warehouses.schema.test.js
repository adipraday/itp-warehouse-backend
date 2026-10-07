import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { getWarehouseSchema, listWarehousesSchema } from '../../src/modules/warehouses/warehouses.schema.js';

// Fastify's response schema silently DROPS any property it does not declare, so a
// field added in the service but forgotten in the schema just vanishes from the
// wire. This pins the actual serialized output of the single-read schema.
async function respondWith(schema, payload) {
  const app = Fastify();
  // getWarehouseSchema declares an `id` path param, so the route needs one.
  app.get('/x/:id', { schema }, async () => payload);
  const response = await app.inject({ method: 'GET', url: '/x/3' });
  await app.close();
  return response.json();
}

const row = {
  id: 3,
  code: 'sdm-w-02',
  name: 'Cabang 1',
  address: 'Jl. A',
  bu_id: 1,
  parent_warehouse_id: 2,
  created_by: 3,
  created_at: '2026-09-16 11:06:22.490',
  updated_at: '2026-09-16 11:06:22.490'
};

describe('warehouses response schemas', () => {
  it('single read serializes business_unit as {id, name} only', async () => {
    const body = await respondWith(getWarehouseSchema, {
      data: { ...row, business_unit: { id: 1, name: 'Sawah Dangka Mart', code: 'leak' } }
    });
    expect(body.data.business_unit).toEqual({ id: 1, name: 'Sawah Dangka Mart' });
    expect(body.data.name).toBe('Cabang 1');
  });

  it('single read serializes an unresolvable business unit as null', async () => {
    const body = await respondWith(getWarehouseSchema, { data: { ...row, business_unit: null } });
    expect(body.data.business_unit).toBeNull();
  });

  it('single read without business_unit (no config) simply omits it', async () => {
    const body = await respondWith(getWarehouseSchema, { data: row });
    expect(body.data).not.toHaveProperty('business_unit');
  });

  it('list responses are unchanged (no business_unit field)', async () => {
    const body = await respondWith(listWarehousesSchema, {
      data: [{ ...row, business_unit: { id: 1, name: 'x' } }],
      meta: { page: 1, per_page: 20, total: 1 }
    });
    expect(body.data[0]).not.toHaveProperty('business_unit');
  });
});
