import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBackoffMs,
  computeDockerCpuPercent,
  computeDockerMemoryStats,
  demuxDockerLogs,
  isPrivateOrBlockedIp,
  parseDockerHost,
  redactSecrets,
  validateCooldownMinutes,
  validateProbeUrlWithAllowlist,
} from './securityAndDocker';

test('redactSecrets masks bearer tokens, passwords, connection strings, and Telegram bot tokens', () => {
  const raw =
    'Authorization: Bearer sk_live_abc123456789 password=SuperSecret99! https://api.telegram.org/bot123456789:AAH_secret_token_XYZ/sendMessage postgres://admin:p4ssw0rd@db:5432/app';
  const cleaned = redactSecrets(raw);

  assert.doesNotMatch(cleaned, /sk_live_abc123456789/);
  assert.doesNotMatch(cleaned, /SuperSecret99!/);
  assert.doesNotMatch(cleaned, /AAH_secret_token_XYZ/);
  assert.doesNotMatch(cleaned, /p4ssw0rd/);
  assert.match(cleaned, /\[REDACTED\]/);
});

test('validateCooldownMinutes allows integers >= 0 and rejects negatives, floats, and NaN', () => {
  assert.deepEqual(validateCooldownMinutes(0), { valid: true, value: 0 });
  assert.deepEqual(validateCooldownMinutes(10), { valid: true, value: 10 });
  assert.deepEqual(validateCooldownMinutes('15'), { valid: true, value: 15 });

  assert.equal(validateCooldownMinutes(-1).valid, false);
  assert.equal(validateCooldownMinutes(2.5).valid, false);
  assert.equal(validateCooldownMinutes('abc').valid, false);
  assert.equal(validateCooldownMinutes(null).valid, false);
});

test('isPrivateOrBlockedIp blocks loopback, private RFC1918, link-local, IPv6 ULA, and IPv4-mapped IPv6', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.10',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.8',
    '::ffff:169.254.169.254',
  ];

  for (const ip of blocked) {
    assert.equal(isPrivateOrBlockedIp(ip), true, `Expected ${ip} to be blocked`);
  }

  const allowed = ['1.1.1.1', '8.8.8.8', '104.21.42.10', '172.32.0.1', '2606:4700:4700::1111'];
  for (const ip of allowed) {
    assert.equal(isPrivateOrBlockedIp(ip), false, `Expected ${ip} to be allowed`);
  }
});

test('validateProbeUrlWithAllowlist restricts to https and configured allowlist', () => {
  assert.equal(
    validateProbeUrlWithAllowlist('https://chang-e.app/health', ['chang-e.app']).valid,
    true
  );
  assert.equal(
    validateProbeUrlWithAllowlist('http://chang-e.app/health', ['chang-e.app']).valid,
    false
  );
  assert.equal(
    validateProbeUrlWithAllowlist('https://evil.example.com/', ['chang-e.app']).valid,
    false
  );
  assert.equal(
    validateProbeUrlWithAllowlist('https://127.0.0.1/', ['127.0.0.1']).valid,
    false
  );
});

test('parseDockerHost handles tcp://docker-proxy:2375 and unix socket fallback', () => {
  const tcp = parseDockerHost('tcp://docker-proxy:2375', '/var/run/docker.sock');
  assert.deepEqual(tcp, { kind: 'tcp', hostname: 'docker-proxy', port: 2375 });

  const unix = parseDockerHost(undefined, '/var/run/docker.sock');
  assert.deepEqual(unix, { kind: 'socket', socketPath: '/var/run/docker.sock' });

  const explicitUnix = parseDockerHost('unix:///tmp/custom-docker.sock');
  assert.deepEqual(explicitUnix, { kind: 'socket', socketPath: '/tmp/custom-docker.sock' });
});

test('demuxDockerLogs strips 8-byte multiplexed Docker stream headers cleanly', () => {
  const msg1 = Buffer.from('FATAL: heap out of memory\n', 'utf-8');
  const header1 = Buffer.alloc(8);
  header1[0] = 2; // stderr
  header1.writeUInt32BE(msg1.length, 4);

  const msg2 = Buffer.from('Exit code 137\n', 'utf-8');
  const header2 = Buffer.alloc(8);
  header2[0] = 2;
  header2.writeUInt32BE(msg2.length, 4);

  const combined = Buffer.concat([header1, msg1, header2, msg2]);
  const lines = demuxDockerLogs(combined);
  assert.deepEqual(lines, ['FATAL: heap out of memory', 'Exit code 137']);
});

test('computeDockerCpuPercent, computeDockerMemoryStats, and computeBackoffMs compute expected bounds', () => {
  const cpu = computeDockerCpuPercent({
    cpu_stats: {
      cpu_usage: { total_usage: 500_000_000 },
      system_cpu_usage: 2_000_000_000,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 300_000_000 },
      system_cpu_usage: 1_000_000_000,
    },
  });
  assert.equal(cpu, 40);

  const mem = computeDockerMemoryStats({
    memory_stats: {
      usage: 300 * 1024 * 1024,
      stats: { cache: 44 * 1024 * 1024 },
      limit: 1024 * 1024 * 1024,
    },
  });
  assert.deepEqual(mem, { memoryMb: 256, memoryLimitMb: 1024 });

  assert.equal(computeBackoffMs(0, 1000, 30000), 1000);
  assert.equal(computeBackoffMs(1, 1000, 30000), 2000);
  assert.equal(computeBackoffMs(10, 1000, 30000), 30000);
});
