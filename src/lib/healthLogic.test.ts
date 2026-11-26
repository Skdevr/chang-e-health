import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTelemetry24hSeries,
  classifyInterruption,
  computeStackSummary,
  formatEmailAlert,
  formatTelegramAlert,
  formatUptime,
  shouldDispatchAlert,
  updateLatestTelemetryPoint,
  validateEmailList,
  validateMonitorUrl,
} from './healthLogic';
import type { ContainerService, IncidentRecord, LiveEndpointProbe } from '../types/health';

test('classifyInterruption identifies OOMKilled exit 137 with critical severity', () => {
  const diag = classifyInterruption(137);
  assert.equal(diag.severity, 'critical');
  assert.match(diag.category, /137|OOMKilled/i);
  assert.match(diag.rootCause, /memória/i);
});

test('classifyInterruption identifies HTTP 503 healthcheck timeout as warning', () => {
  const diag = classifyInterruption(0, 'healthcheck timeout 503');
  assert.equal(diag.severity, 'warning');
  assert.match(diag.category, /Healthcheck/i);
});

test('classifyInterruption identifies unhandled application error exit 1', () => {
  const diag = classifyInterruption(1);
  assert.equal(diag.severity, 'critical');
  assert.match(diag.category, /Exit 1/);
});

test('validateMonitorUrl allows public chang-e.app URL and blocks private/loopback SSRF targets', () => {
  assert.equal(validateMonitorUrl('https://chang-e.app/').valid, true);
  assert.equal(validateMonitorUrl('https://chang-e.app/api/health').valid, true);
  assert.equal(validateMonitorUrl('http://127.0.0.1:8080/health').valid, false);
  assert.equal(validateMonitorUrl('http://localhost:3000').valid, false);
  assert.equal(validateMonitorUrl('http://169.254.169.254/latest/meta-data/').valid, false);
  assert.equal(validateMonitorUrl('http://10.0.0.12/status').valid, false);
  assert.equal(validateMonitorUrl('http://192.168.1.10/status').valid, false);
  assert.equal(validateMonitorUrl('javascript:alert(1)').valid, false);
});

test('validateEmailList deduplicates valid emails and rejects malformed ones', () => {
  const ok = validateEmailList(['ops@chang-e.app', 'OPS@chang-e.app', 'dev@chang-e.app']);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.cleaned, ['ops@chang-e.app', 'dev@chang-e.app']);

  const bad = validateEmailList(['not-an-email']);
  assert.equal(bad.valid, false);

  const empty = validateEmailList(['   ']);
  assert.equal(empty.valid, false);
});

test('shouldDispatchAlert respects cooldown window', () => {
  const now = Date.parse('2026-11-22T15:00:00.000Z');
  assert.equal(shouldDispatchAlert(undefined, 5, now), true);
  assert.equal(shouldDispatchAlert('2026-11-22T14:58:00.000Z', 5, now), false);
  assert.equal(shouldDispatchAlert('2026-11-22T14:54:00.000Z', 5, now), true);
});

test('formatTelegramAlert and formatEmailAlert include container details and error logs', () => {
  const container: ContainerService = {
    id: 'c-api',
    name: 'change-api-core',
    role: 'API Principal',
    image: 'ghcr.io/change-app/api:2.4.1',
    ports: '8080:8080',
    network: 'change_net',
    healthCommand: 'curl -f http://localhost:8080/health',
    status: 'stopped',
    exitCode: 137,
    restartCount: 2,
    uptimeSeconds: 0,
    cpuPercent: 0,
    memoryMb: 0,
    memoryLimitMb: 1024,
    latencyMs: 0,
    latencyHistory: [24, 29, 0],
    lastCheckedAt: '2026-11-22T15:00:00.000Z',
  };
  const incident: IncidentRecord = {
    id: 'inc-1',
    containerId: 'c-api',
    containerName: 'change-api-core',
    startedAt: '2026-11-22T15:00:00.000Z',
    status: 'active',
    severity: 'critical',
    exitCode: 137,
    category: 'OOMKilled (Exit 137)',
    rootCause: 'Limite de memória excedido.',
    recommendedAction: 'Aumentar mem_limit.',
    logExcerpt: ['FATAL ERROR: JavaScript heap out of memory'],
    notifiedChannels: ['email', 'telegram'],
  };

  const telegramText = formatTelegramAlert(incident, container, incident.logExcerpt);
  assert.match(telegramText, /change-api-core/);
  assert.match(telegramText, /137/);
  assert.match(telegramText, /heap out of memory/);

  const email = formatEmailAlert(incident, container, incident.logExcerpt, "[Chang'e]");
  assert.match(email.subject, /change-api-core/);
  assert.match(email.text, /https:\/\/chang-e\.app\//);
});

test('computeStackSummary reports outage when any container is stopped', () => {
  const probe: LiveEndpointProbe = {
    targetUrl: 'https://chang-e.app/',
    reachable: true,
    httpStatus: 200,
    latencyMs: 85,
    tlsValid: true,
    serverHeader: 'nginx',
    checkedAt: '2026-11-22T15:00:00.000Z',
    history: [],
  };
  const base: ContainerService = {
    id: '1',
    name: 'c1',
    role: 'Web',
    image: 'img:1',
    ports: '80',
    network: 'net',
    healthCommand: 'curl',
    status: 'healthy',
    exitCode: 0,
    restartCount: 0,
    uptimeSeconds: 3600,
    cpuPercent: 12,
    memoryMb: 200,
    memoryLimitMb: 512,
    latencyMs: 30,
    latencyHistory: [30],
    lastCheckedAt: '2026-11-22T15:00:00.000Z',
  };

  const summary = computeStackSummary(
    [base, { ...base, id: '2', name: 'c2', status: 'stopped', latencyMs: 0 }],
    probe,
    []
  );
  assert.equal(summary.totalCount, 2);
  assert.equal(summary.healthyCount, 1);
  assert.equal(summary.stoppedCount, 1);
  assert.equal(summary.overallStatus, 'outage');
  assert.equal(summary.healthPercentage, 50);
  assert.equal(formatUptime(90060), '1d 1h');
});

test('buildTelemetry24hSeries produces 24 hourly points and updateLatestTelemetryPoint reflects live changes', () => {
  const containers: ContainerService[] = [
    {
      id: 'c1',
      name: 'change-web-app',
      role: 'Web',
      image: 'img:1',
      ports: '3000:3000',
      network: 'net',
      healthCommand: 'curl',
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 3600,
      cpuPercent: 10,
      memoryMb: 512,
      memoryLimitMb: 1024,
      latencyMs: 40,
      latencyHistory: [40],
      lastCheckedAt: '2026-11-22T15:00:00.000Z',
    },
    {
      id: 'c2',
      name: 'change-api-core',
      role: 'API',
      image: 'img:2',
      ports: '8080:8080',
      network: 'net',
      healthCommand: 'curl',
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 3600,
      cpuPercent: 15,
      memoryMb: 512,
      memoryLimitMb: 1024,
      latencyMs: 50,
      latencyHistory: [50],
      lastCheckedAt: '2026-11-22T15:00:00.000Z',
    },
  ];

  const now = Date.parse('2026-11-22T16:00:00.000Z');
  const series = buildTelemetry24hSeries(containers, 210, now);
  assert.equal(series.length, 24);
  assert.equal(series[23].hourLabel, 'Agora');
  assert.equal(series[23].latencyMs, 210);
  assert.equal(series[23].memoryUsedMb, 1024);
  assert.equal(series[23].memoryPercent, 50);

  // Simulate one container stopping (memory drops to 512 / 2048 = 25%)
  const updated = updateLatestTelemetryPoint(
    series,
    [containers[0], { ...containers[1], status: 'stopped', memoryMb: 0 }],
    340,
    now + 60_000
  );
  assert.equal(updated.length, 24);
  assert.equal(updated[23].latencyMs, 340);
  assert.equal(updated[23].memoryUsedMb, 512);
  assert.equal(updated[23].memoryPercent, 25);
});
