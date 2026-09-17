import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerSwagger(app) {
  await app.register(swagger, {
    openapi: {
      info: { title: 'Warehouse System API', version: '0.1.0' },
      servers: [{ url: '/api' }]
    }
  });
  await app.register(swaggerUi, { routePrefix: '/documentation' });
}
