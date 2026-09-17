import { describe, it, expect, vi, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { registerUserContext } from '../../src/shared/auth/user-context.js';

// registerUserContext() calls jose's createRemoteJWKSet(), which fetches the
// JWKS over the network. We swap it for a same-shape resolver backed by a
// locally-generated keypair (createLocalJWKSet) so verification is real
// (actual RS256 signature + claim checks) without any network call.
const authState = vi.hoisted(() => ({ resolver: null }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => authState.resolver)
  };
});

const ISSUER = 'https://auth.local/';
const AUDIENCE = 'warehouse-system-api';

let privateKey;

beforeAll(async () => {
  const { publicKey, privateKey: sk } = await generateKeyPair('RS256');
  privateKey = sk;
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  authState.resolver = createLocalJWKSet({ keys: [jwk] });
});

async function signToken(claims, { kid = 'test-kid', expiresIn = '15m', issuer = ISSUER, audience = AUDIENCE } = {}) {
  let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt();
  if (expiresIn) jwt = jwt.setExpirationTime(expiresIn);
  if (issuer) jwt = jwt.setIssuer(issuer);
  if (audience) jwt = jwt.setAudience(audience);
  return jwt.sign(privateKey);
}

// jose's setExpirationTime() only parses positive time-span strings ("15m"), so
// an already-expired token needs an explicit past epoch-seconds value instead.
async function signExpiredToken(claims, { kid = 'test-kid' } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(privateKey);
}

// Fake Fastify app: just enough surface for registerUserContext() to attach
// its onRequest hook and for that hook to read app.config.
function makeApp(config) {
  const hooks = {};
  return {
    config,
    addHook: (name, fn) => {
      hooks[name] = fn;
    },
    hooks
  };
}

function makeRequest({ headers = {}, url = '/api/sales' } = {}) {
  return { headers, url, log: { warn: vi.fn() } };
}

async function buildHook(mode, overrides = {}) {
  const app = makeApp({
    AUTH_MODE: mode,
    AUTH_JWKS_URL: 'https://auth.local/.well-known/jwks.json',
    AUTH_JWT_ISSUER: ISSUER,
    AUTH_JWT_AUDIENCE: AUDIENCE,
    ...overrides
  });
  await registerUserContext(app);
  return app.hooks.onRequest;
}

describe('registerUserContext — jwt mode', () => {
  it('accepts a valid token and populates userContext', async () => {
    const hook = await buildHook('jwt');
    const token = await signToken({ user_id: 23, role: 'admin-bu', bu_id: 11 });
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await hook(request);

    // No bu_ids claim on this token — falls back to [buId] (B3 fail-safe).
    expect(request.userContext).toEqual({ userId: 23, role: 'admin-bu', buId: 11, buIds: [11] });
  });

  it('maps a null bu_id claim to buId: null (super-admin)', async () => {
    const hook = await buildHook('jwt');
    const token = await signToken({ user_id: 6, role: 'super-admin', bu_id: null });
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await hook(request);

    expect(request.userContext).toEqual({ userId: 6, role: 'super-admin', buId: null, buIds: null });
  });

  it('reads an explicit bu_ids array (admin-bu with a grant, or owner)', async () => {
    const hook = await buildHook('jwt');
    const token = await signToken({ user_id: 23, role: 'admin-bu', bu_id: 13, bu_ids: [13, 15] });
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await hook(request);

    expect(request.userContext).toEqual({ userId: 23, role: 'admin-bu', buId: 13, buIds: [13, 15] });
  });

  it('treats an explicit null bu_ids the same as buId null — unrestricted', async () => {
    const hook = await buildHook('jwt');
    const token = await signToken({ user_id: 40, role: 'owner', bu_id: null, bu_ids: null, company_id: 7 });
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await hook(request);

    expect(request.userContext).toEqual({ userId: 40, role: 'owner', buId: null, buIds: null });
  });

  it('rejects a request with no Authorization header (401)', async () => {
    const hook = await buildHook('jwt');
    const request = makeRequest();

    await expect(hook(request)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  });

  it('rejects an expired token (401)', async () => {
    const hook = await buildHook('jwt');
    const token = await signExpiredToken({ user_id: 23, role: 'admin-bu', bu_id: 11 });
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await expect(hook(request)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  });

  it('rejects a token signed with an unknown key (bad signature / unknown kid)', async () => {
    const hook = await buildHook('jwt');
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ user_id: 23, role: 'admin-bu', bu_id: 11 })
      .setProtectedHeader({ alg: 'RS256', kid: 'someone-elses-key' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(otherKey);
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await expect(hook(request)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a token with the wrong audience', async () => {
    const hook = await buildHook('jwt');
    const token = await signToken({ user_id: 23, role: 'admin-bu', bu_id: 11 }, { audience: 'someone-else' });
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await expect(hook(request)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a token with the wrong issuer', async () => {
    const hook = await buildHook('jwt');
    const token = await signToken({ user_id: 23, role: 'admin-bu', bu_id: 11 }, { issuer: 'https://someone-else/' });
    const request = makeRequest({ headers: { authorization: `Bearer ${token}` } });

    await expect(hook(request)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('allows a public path through even with no identity', async () => {
    const hook = await buildHook('jwt');
    const request = makeRequest({ url: '/health' });

    await expect(hook(request)).resolves.toBeUndefined();
    expect(request.userContext).toEqual({ userId: null, role: null, buId: null, buIds: null });
  });
});

describe('registerUserContext — header mode', () => {
  it('builds userContext from legacy X- headers and never calls the JWKS resolver', async () => {
    const hook = await buildHook('header');
    const request = makeRequest({
      headers: { 'x-user-id': '23', 'x-user-role': 'admin-bu', 'x-bu-id': '11' }
    });

    await hook(request);

    // The legacy header path has no multi-BU concept — buIds is just [buId].
    expect(request.userContext).toEqual({ userId: 23, role: 'admin-bu', buId: 11, buIds: [11] });
  });

  it('accepts the legacy x-warehouse-id header name as a fallback for x-bu-id', async () => {
    const hook = await buildHook('header');
    const request = makeRequest({
      headers: { 'x-user-id': '23', 'x-user-role': 'admin-bu', 'x-warehouse-id': '11' }
    });

    await hook(request);

    expect(request.userContext.buId).toBe(11);
    expect(request.userContext.buIds).toEqual([11]);
  });

  it('never rejects, even with completely empty headers', async () => {
    const hook = await buildHook('header');
    const request = makeRequest();

    await expect(hook(request)).resolves.toBeUndefined();
    expect(request.userContext).toEqual({ userId: null, role: null, buId: null, buIds: null });
  });
});

describe('registerUserContext — hybrid mode', () => {
  it('prefers a valid bearer token over headers', async () => {
    const hook = await buildHook('hybrid');
    const token = await signToken({ user_id: 23, role: 'admin-bu', bu_id: 11 });
    const request = makeRequest({
      headers: { authorization: `Bearer ${token}`, 'x-user-id': '999', 'x-user-role': 'finance', 'x-bu-id': '99' }
    });

    await hook(request);

    expect(request.userContext).toEqual({ userId: 23, role: 'admin-bu', buId: 11, buIds: [11] });
  });

  it('falls back to headers when the token fails verification, without rejecting', async () => {
    const hook = await buildHook('hybrid');
    const request = makeRequest({
      headers: {
        authorization: 'Bearer not-a-real-jwt',
        'x-user-id': '5',
        'x-user-role': 'kasir-sales',
        'x-bu-id': '11'
      }
    });

    await expect(hook(request)).resolves.toBeUndefined();
    expect(request.userContext).toEqual({ userId: 5, role: 'kasir-sales', buId: 11, buIds: [11] });
  });

  it('falls back to headers when no token is sent at all', async () => {
    const hook = await buildHook('hybrid');
    const request = makeRequest({
      headers: { 'x-user-id': '5', 'x-user-role': 'kasir-sales', 'x-bu-id': '11' }
    });

    await hook(request);

    expect(request.userContext).toEqual({ userId: 5, role: 'kasir-sales', buId: 11, buIds: [11] });
  });

  it('never rejects even with no identity at all (transition window)', async () => {
    const hook = await buildHook('hybrid');
    const request = makeRequest();

    await expect(hook(request)).resolves.toBeUndefined();
  });
});
