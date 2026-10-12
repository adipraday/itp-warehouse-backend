import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { itemsRoutes } from '../../src/modules/items/items.routes.js';

// Boot-level guard: every route and schema the items module wires up must exist. A missing import
// (e.g. a route using a schema that was never exported) only blows up when the routes register —
// which unit tests of the service never do, and which would crash-loop the real server.
describe('items routes', () => {
  it('registers, including DELETE /:id with the role guard', async () => {
    const app = Fastify({ logger: false });
    app.decorate('db', {});
    app.decorateRequest('userContext', null);
    await app.register(itemsRoutes, { prefix: '/api/items' });
    await app.ready();

    expect(app.hasRoute({ method: 'DELETE', url: '/api/items/:id' })).toBe(true);
    expect(app.hasRoute({ method: 'PUT', url: '/api/items/:id' })).toBe(true);
    await app.close();
  });
});
