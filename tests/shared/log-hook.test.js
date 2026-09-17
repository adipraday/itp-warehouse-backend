import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as activityLogsRepository from '../../src/modules/activity-logs/activity-logs.repository.js';
import { registerActivityLog } from '../../src/shared/activity-log/log-hook.js';

vi.mock('../../src/modules/activity-logs/activity-logs.repository.js');

// Fake Fastify app: just enough for registerActivityLog() to attach its
// onSend hook and for that hook to read app.db.
function makeApp(dbRows = []) {
  const hooks = {};
  return {
    db: { execute: vi.fn().mockResolvedValue([dbRows]) },
    addHook: (name, fn) => {
      hooks[name] = fn;
    },
    hooks
  };
}

function makeRequest({ url, method, userContext = null, body = {}, query = {} }) {
  return { url, method, userContext, body, query, log: { error: vi.fn() } };
}

function makeReply(statusCode = 200) {
  return { statusCode };
}

describe('registerActivityLog — bu_id resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves bu_id from the touched warehouse, not the actor\'s home BU', async () => {
    const app = makeApp([{ bu_id: 15 }]); // warehouse 2 belongs to bu_id 15
    await registerActivityLog(app);
    const request = makeRequest({
      url: '/api/inbounds',
      method: 'POST',
      userContext: { userId: 1, buId: 13 }, // actor's home BU is 13 (a grant scenario)
      body: { warehouse_id: 2 }
    });

    await app.hooks.onSend(request, makeReply(201), JSON.stringify({ data: { id: 5 } }));

    expect(activityLogsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ warehouse_id: 2, bu_id: 15 })
    );
  });

  it('falls back to the actor\'s home BU when no warehouse_id is in the request', async () => {
    const app = makeApp([]);
    await registerActivityLog(app);
    const request = makeRequest({
      url: '/api/items',
      method: 'POST',
      userContext: { userId: 1, buId: 13 },
      body: {}
    });

    await app.hooks.onSend(request, makeReply(201), JSON.stringify({ data: { id: 5 } }));

    expect(activityLogsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ warehouse_id: null, bu_id: 13 })
    );
    expect(app.db.execute).not.toHaveBeenCalled(); // no warehouse named — no lookup needed
  });

  it('falls back to the actor\'s home BU when the named warehouse has no bu_id row (edge case)', async () => {
    const app = makeApp([]); // lookup returns no row
    await registerActivityLog(app);
    const request = makeRequest({
      url: '/api/inbounds',
      method: 'POST',
      userContext: { userId: 1, buId: 13 },
      body: { warehouse_id: 999 }
    });

    await app.hooks.onSend(request, makeReply(201), JSON.stringify({ data: { id: 5 } }));

    expect(activityLogsRepository.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bu_id: 13 })
    );
  });

  it('never throws — a logging failure must not affect the real response', async () => {
    const app = makeApp([]);
    activityLogsRepository.create.mockRejectedValue(new Error('db exploded'));
    await registerActivityLog(app);
    const request = makeRequest({ url: '/api/items', method: 'POST', userContext: { userId: 1, buId: 13 } });

    const payload = JSON.stringify({ data: { id: 5 } });
    await expect(app.hooks.onSend(request, makeReply(201), payload)).resolves.toBe(payload);
    expect(request.log.error).toHaveBeenCalled();
  });
});
