import fastifyEnv from '@fastify/env';

const schema = {
  type: 'object',
  required: ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
  properties: {
    NODE_ENV: { type: 'string', default: 'development' },
    HOST: { type: 'string', default: '0.0.0.0' },
    PORT: { type: 'integer', default: 3000 },
    DB_HOST: { type: 'string' },
    DB_PORT: { type: 'integer', default: 3306 },
    DB_NAME: { type: 'string' },
    DB_USER: { type: 'string' },
    DB_PASSWORD: { type: 'string' },
    DB_CONNECTION_LIMIT: { type: 'integer', default: 10 },
    LOG_LEVEL: { type: 'string', default: 'info' },
    CORS_ORIGIN: { type: 'string', default: 'http://localhost:5173' },
    IDEMPOTENCY_TTL_HOURS: { type: 'integer', default: 24 },
    AUTH_JWKS_URL: { type: 'string', default: 'http://localhost:5020/.well-known/jwks.json' },
    AUTH_JWT_ISSUER: { type: 'string', default: 'https://auth.local/' },
    AUTH_JWT_AUDIENCE: { type: 'string', default: 'warehouse-system-api' },
    AUTH_MODE: { type: 'string', default: 'jwt' },
    // Base URL for REST calls to the auth-backend (not just JWKS) — used to resolve/validate
    // business_units by id or code via the trusted service-to-service channel. See
    // src/shared/auth/business-units-client.js.
    AUTH_API_URL: { type: 'string', default: 'http://localhost:5020' },
    // Must match the auth-backend's own SERVICE_API_KEY — sent as `X-Service-Key`.
    SERVICE_API_KEY: { type: 'string', default: 'dev-service-key-local' }
  }
};

export async function registerEnv(app) {
  await app.register(fastifyEnv, { schema, dotenv: true });
}
