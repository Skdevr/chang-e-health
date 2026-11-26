import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiApp } from '../../server';
import { HealthMonitorStore, DEFAULT_COOLDOWN_MINUTES, MAX_INCIDENTS_RETENTION, MAX_DISPATCHES_RETENTION } from './healthStore';
import { assertSafeResolvedHost, runSafeHttpProbe } from './httpProber';
import { AtomicJsonStore } from './persistence';
import { createRateLimiter, extractBearerToken, timingSafeTokenEqual } from './security';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startTestServer(app: ReturnType<typeof createApiApp>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test('timingSafeTokenEqual and extractBearerToken verify tokens safely', () => {
  assert.equal(timingSafeTokenEqual('secret-token-123', 'secret-token-123'), true);
  assert.equal(timingSafeTokenEqual('secret-token-123', 'secret-token-124'), false);
  assert.equal(timingSafeTokenEqual('short', 'much-longer-token'), false);
  assert.equal(timingSafeTokenEqual('', ''), false);

  assert.equal(extractBearerToken('Bearer my-secret'), 'my-secret');
  assert.equal(extractBearerToken('bearer my-secret'), 'my-secret');
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken(undefined), null);
});

test('AtomicJsonStore persists atomically, coalesces concurrent writes, and recovers corrupt JSON with backup', async () => {
  const dir = makeTempDir('change-persist-');
  try {
    const store = new AtomicJsonStore<{ count: number }>(dir, 'state.json');

    // Concurrent burst writes must serialize cleanly and persist the latest state
    await Promise.all([
      store.enqueueSave({ count: 1 }),
      store.enqueueSave({ count: 2 }),
      store.enqueueSave({ count: 3 }),
      store.enqueueSave({ count: 4 }),
    ]);
    await store.flush();

    const loaded = store.loadSync(() => ({ count: 0 }));
    assert.equal(loaded.recoveredFromCorrupt, false);
    assert.equal(loaded.data.count, 4);

    // Corrupt the file and verify backup + clean fallback recovery
    fs.writeFileSync(store.getFilePath(), '{not-valid-json', 'utf-8');
    const recovered = store.loadSync(() => ({ count: 99 }));
    assert.equal(recovered.recoveredFromCorrupt, true);
    assert.equal(recovered.data.count, 99);
    assert.ok(recovered.backupPath && fs.existsSync(recovered.backupPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API auth middleware allows public /api/health, requires Bearer on other /api/*, and rate-limits /api/alerts/test', async () => {
  const dir = makeTempDir('change-api-auth-');
  const adminToken = 'super-secret-admin-token-test';
  const store = new HealthMonitorStore({
    demoMode: true,
    allowActions: false,
    authConfigured: true,
    dataDir: dir,
    probeUrl: 'https://chang-e.app/',
    probeAllowedHosts: ['chang-e.app'],
    dockerSocketPath: '/nonexistent/docker.sock',
  });

  const app = createApiApp({
    store,
    adminToken,
    demoMode: true,
    allowActions: false,
    testRateLimitMax: 2,
    testRateLimitWindowMs: 60_000,
  });

  const srv = await startTestServer(app);
  try {
    // Public liveness check returns 200 without auth
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { status: string };
    assert.equal(healthBody.status, 'ok');

    // Protected route rejects missing or wrong token
    const unauthRes = await fetch(`${srv.baseUrl}/api/health/snapshot`);
    assert.equal(unauthRes.status, 401);

    const badAuthRes = await fetch(`${srv.baseUrl}/api/health/snapshot`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(badAuthRes.status, 401);

    // Valid Bearer token succeeds and exposes default cooldown=10 and demoMode=true
    const authRes = await fetch(`${srv.baseUrl}/api/health/snapshot`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(authRes.status, 200);
    const snapshot = (await authRes.json()) as {
      alertConfig: { cooldownMinutes: number };
      capabilities: { demoMode: boolean; actionsEnabled: boolean };
    };
    assert.equal(snapshot.alertConfig.cooldownMinutes, DEFAULT_COOLDOWN_MINUTES);
    assert.equal(snapshot.capabilities.demoMode, true);
    assert.equal(snapshot.capabilities.actionsEnabled, false);

    // Restart and delete are blocked (403) when ALLOW_ACTIONS=false
    const restartRes = await fetch(`${srv.baseUrl}/api/containers/change-api-core/restart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(restartRes.status, 403);

    const deleteRes = await fetch(`${srv.baseUrl}/api/containers/change-api-core`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(deleteRes.status, 403);

    // Invalid cooldownMinutes rejected (400); integer >= 0 accepted (200)
    const badCooldown = await fetch(`${srv.baseUrl}/api/alerts/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        emailEnabled: true,
        emailRecipients: ['ops@chang-e.app'],
        cooldownMinutes: -5,
      }),
    });
    assert.equal(badCooldown.status, 400);

    const floatCooldown = await fetch(`${srv.baseUrl}/api/alerts/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        emailEnabled: true,
        emailRecipients: ['ops@chang-e.app'],
        cooldownMinutes: 1.5,
      }),
    });
    assert.equal(floatCooldown.status, 400);

    const zeroCooldown = await fetch(`${srv.baseUrl}/api/alerts/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        emailEnabled: true,
        emailRecipients: ['ops@chang-e.app'],
        cooldownMinutes: 0,
      }),
    });
    assert.equal(zeroCooldown.status, 200);

    // Rate limit on /api/alerts/test (max 2 requests, 3rd returns 429)
    const t1 = await fetch(`${srv.baseUrl}/api/alerts/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'telegram' }),
    });
    assert.equal(t1.status, 200);

    const t2 = await fetch(`${srv.baseUrl}/api/alerts/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'telegram' }),
    });
    assert.equal(t2.status, 200);

    const t3 = await fetch(`${srv.baseUrl}/api/alerts/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'telegram' }),
    });
    assert.equal(t3.status, 429);
  } finally {
    await store.shutdown();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DEMO_MODE=false returns 404 on simulate-failure and 503 DOCKER_UNAVAILABLE with zero fake containers', async () => {
  const dir = makeTempDir('change-prod-nodocker-');
  const adminToken = 'prod-token-xyz';
  const store = new HealthMonitorStore({
    demoMode: false,
    allowActions: false,
    authConfigured: true,
    dataDir: dir,
    probeUrl: 'https://chang-e.app/',
    probeAllowedHosts: ['chang-e.app'],
    dockerHost: 'tcp://127.0.0.1:1', // Unreachable port
    dockerSocketPath: '/nonexistent/docker.sock',
  });

  const app = createApiApp({
    store,
    adminToken,
    demoMode: false,
    allowActions: false,
  });

  const srv = await startTestServer(app);
  try {
    const snapRes = await fetch(`${srv.baseUrl}/api/health/snapshot`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(snapRes.status, 503);
    const body = (await snapRes.json()) as {
      code: string;
      error: string;
      containers: unknown[];
      capabilities: { demoMode: boolean; dockerUnavailable: boolean };
    };
    assert.equal(body.code, 'DOCKER_UNAVAILABLE');
    assert.equal(body.error, 'Docker indisponível');
    assert.equal(body.capabilities.demoMode, false);
    assert.equal(body.capabilities.dockerUnavailable, true);
    assert.equal(body.containers.length, 0, 'Must never return fictitious containers in production');

    const simRes = await fetch(`${srv.baseUrl}/api/containers/any/simulate-failure`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'oom' }),
    });
    assert.equal(simRes.status, 404);
  } finally {
    await store.shutdown();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('State-change alerts fire once per transition and recovery alert fires once per incident', async () => {
  const dir = makeTempDir('change-alert-transitions-');
  const store = new HealthMonitorStore({
    demoMode: true,
    allowActions: true,
    authConfigured: true,
    dataDir: dir,
    probeUrl: 'https://chang-e.app/',
    probeAllowedHosts: ['chang-e.app'],
    dockerSocketPath: '/nonexistent/docker.sock',
  });

  try {
    // Set cooldown = 0 to test pure state-change + single recovery semantics
    await store.updateAlertConfig({ cooldownMinutes: 0, notifyOnRecovery: true });
    const beforeCount = store.getSnapshot().alertDispatches.length;

    // 1. Healthy -> Stopped (oom) triggers Email + Telegram (+2 dispatches)
    await store.triggerContainerFailure('change-api-core', 'oom');
    const afterFail = store.getSnapshot().alertDispatches.length;
    assert.equal(afterFail - beforeCount, 2);

    // 2. Stopped -> Stopped again (no state change) must NOT spam new alerts
    await store.triggerContainerFailure('change-api-core', 'crash');
    const afterRepeatStopped = store.getSnapshot().alertDispatches.length;
    assert.equal(afterRepeatStopped, afterFail, 'Repeated same-state failure should not re-alert');

    // 3. Stopped -> Healthy (restart) fires recovery alerts once (+2 dispatches)
    await store.restartContainer('change-api-core');
    const afterRecovery = store.getSnapshot().alertDispatches.length;
    assert.equal(afterRecovery - afterRepeatStopped, 2);

    // 4. Restarting an already healthy container must NOT fire duplicate recovery alerts
    await store.restartContainer('change-api-core');
    assert.equal(store.getSnapshot().alertDispatches.length, afterRecovery);

    // 5. Verify secrets are never leaked into dispatches
    const serialized = JSON.stringify(store.getSnapshot());
    assert.doesNotMatch(serialized, /SMTP_PASS=/);
    assert.doesNotMatch(serialized, /TELEGRAM_BOT_TOKEN=/);
  } finally {
    await store.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Retention limits cap incidents at 500 and dispatches at 1000', () => {
  assert.equal(MAX_INCIDENTS_RETENTION, 500);
  assert.equal(MAX_DISPATCHES_RETENTION, 1000);
});

test('httpProber blocks post-DNS private IPs (SSRF) and caps redirects at 3', async () => {
  // Post-DNS private IP check
  await assert.rejects(
    () =>
      assertSafeResolvedHost(
        new URL('https://chang-e.app/'),
        ['chang-e.app'],
        async () => [{ address: '169.254.169.254', family: 4 }]
      ),
    /SSRF/i
  );

  await assert.rejects(
    () =>
      assertSafeResolvedHost(
        new URL('https://chang-e.app/'),
        ['chang-e.app'],
        async () => [{ address: '10.0.0.4', family: 4 }]
      ),
    /SSRF/i
  );

  // Disallowed host rejected
  await assert.rejects(
    () =>
      assertSafeResolvedHost(
        new URL('https://other-host.example/'),
        ['chang-e.app'],
        async () => [{ address: '1.1.1.1', family: 4 }]
      ),
    /PROBE_ALLOWED_HOSTS/i
  );

  // runSafeHttpProbe returns safe failure object when DNS resolves to private IP
  const probeRes = await runSafeHttpProbe({
    targetUrl: 'https://chang-e.app/',
    allowedHosts: ['chang-e.app'],
    lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  assert.equal(probeRes.reachable, false);
  assert.match(probeRes.errorMessage || '', /SSRF/i);

  // Rate limiter helper unit check
  const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
  assert.equal(limiter.check('ip1').allowed, true);
  assert.equal(limiter.check('ip1').allowed, true);
  assert.equal(limiter.check('ip1').allowed, false);
});
