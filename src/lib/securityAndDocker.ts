const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // Authorization headers (Bearer, Basic, Token)
  {
    regex: /(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s"',;]+/gi,
    replacement: '$1[REDACTED]',
  },
  // Standalone Bearer tokens
  {
    regex: /(\bbearer\s+)[a-z0-9._~+/-]{12,}=*/gi,
    replacement: '$1[REDACTED]',
  },
  // Telegram bot tokens (both standalone and inside /bot<id>:<token>/ URLs)
  {
    regex: /(\bbot)?\d{6,12}:[A-Za-z0-9_-]{12,}/g,
    replacement: '$1[REDACTED_TELEGRAM_TOKEN]',
  },
  // JWTs
  {
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  // URLs with embedded credentials (http, https, postgres, redis, amqp, mongodb, etc.)
  {
    regex: /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi,
    replacement: '$1[REDACTED]$2',
  },
  // Key=value / JSON secrets (password, passwd, secret, token, api_key, apikey, smtp_pass, admin_token)
  {
    regex: /(["']?(?:password|passwd|pwd|secret|token|api[_-]?key|smtp[_-]?pass|admin[_-]?token|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi,
    replacement: '$1[REDACTED]',
  },
];

export function redactSecrets(input: string): string {
  let output = input;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    output = output.replace(regex, replacement);
  }
  return output;
}

export function validateCooldownMinutes(value: unknown): {
  valid: boolean;
  value?: number;
  error?: string;
} {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return { valid: false, error: 'Informe um número inteiro >= 0 para o intervalo mínimo entre alertas.' };
  }
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    return {
      valid: false,
      error: 'O intervalo mínimo entre alertas deve ser um número inteiro maior ou igual a 0.',
    };
  }
  if (num > 1440) {
    return {
      valid: false,
      error: 'O intervalo mínimo entre alertas deve ser no máximo 1440 minutos (24h).',
    };
  }
  return { valid: true, value: num };
}

export function isPrivateOrBlockedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;

  // Handle IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice('::ffff:'.length);
    if (tail.includes('.')) {
      return isPrivateOrBlockedIp(tail);
    }
    // Hex form ::ffff:7f00:0001
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateOrBlockedIp(ipv4);
      }
    }
    return true;
  }

  // IPv6 checks
  if (ip.includes(':')) {
    if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') {
      return true;
    }
    // Unique local fc00::/7 (fc.. or fd..) and link-local fe80::/10 (fe8, fe9, fea, feb) and multicast ff..
    if (
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('fe8') ||
      ip.startsWith('fe9') ||
      ip.startsWith('fea') ||
      ip.startsWith('feb') ||
      ip.startsWith('ff')
    ) {
      return true;
    }
    return false;
  }

  // IPv4 checks
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true; // Multicast & reserved

  return false;
}

export function validateProbeUrlWithAllowlist(
  rawUrl: string,
  allowedHosts: string[]
): { valid: boolean; normalizedUrl?: string; error?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Informe uma URL HTTPS válida.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Formato de URL inválido.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Apenas URLs HTTPS são permitidas para probes.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Credenciais embutidas na URL não são permitidas.' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { valid: false, error: 'Endereços locais ou internos não são permitidos.' };
  }

  // If hostname is an IP literal, reject private/loopback immediately
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateOrBlockedIp(hostname)) {
      return { valid: false, error: 'Endereços IP privados ou loopback não são permitidos.' };
    }
  }

  const normalizedAllowed = allowedHosts
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (normalizedAllowed.length > 0 && !normalizedAllowed.includes(hostname)) {
    return {
      valid: false,
      error: `Host "${hostname}" fora da lista permitida (PROBE_ALLOWED_HOSTS).`,
    };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

export type DockerConnectionTarget =
  | { kind: 'tcp'; hostname: string; port: number }
  | { kind: 'socket'; socketPath: string };

export function parseDockerHost(
  dockerHostEnv?: string,
  defaultSocketPath: string = '/var/run/docker.sock'
): DockerConnectionTarget {
  const raw = (dockerHostEnv || '').trim();
  if (!raw) {
    return { kind: 'socket', socketPath: defaultSocketPath };
  }

  if (raw.startsWith('unix://')) {
    return { kind: 'socket', socketPath: raw.slice('unix://'.length) || defaultSocketPath };
  }

  if (raw.startsWith('/')) {
    return { kind: 'socket', socketPath: raw };
  }

  const normalized = raw.startsWith('tcp://') ? `http://${raw.slice('tcp://'.length)}` : raw;
  try {
    const parsed = new URL(normalized);
    return {
      kind: 'tcp',
      hostname: parsed.hostname,
      port: Number(parsed.port || 2375),
    };
  } catch {
    return { kind: 'socket', socketPath: defaultSocketPath };
  }
}

/**
 * Demultiplex Docker container log stream (8-byte header format:
 * byte 0 = stream type 0|1|2, bytes 1..3 = 0, bytes 4..7 = big-endian payload length).
 * Falls back cleanly to plain UTF-8 text when container runs with TTY enabled.
 */
export function demuxDockerLogs(buffer: Uint8Array): string[] {
  if (!buffer || buffer.length === 0) return [];

  const isMultiplexed =
    buffer.length >= 8 &&
    (buffer[0] === 0 || buffer[0] === 1 || buffer[0] === 2) &&
    buffer[1] === 0 &&
    buffer[2] === 0 &&
    buffer[3] === 0;

  let text = '';
  if (isMultiplexed) {
    const decoder = new TextDecoder('utf-8');
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const payloadLen = view.getUint32(offset + 4, false);
      offset += 8;
      if (offset + payloadLen > buffer.length) {
        text += decoder.decode(buffer.subarray(offset));
        break;
      }
      text += decoder.decode(buffer.subarray(offset, offset + payloadLen));
      offset += payloadLen;
    }
  } else {
    text = new TextDecoder('utf-8').decode(buffer);
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function computeDockerCpuPercent(stats: {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
}): number {
  const cpuTotal = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const preCpuTotal = stats.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const systemTotal = stats.cpu_stats?.system_cpu_usage ?? 0;
  const preSystemTotal = stats.precpu_stats?.system_cpu_usage ?? 0;

  const cpuDelta = cpuTotal - preCpuTotal;
  const systemDelta = systemTotal - preSystemTotal;
  const onlineCpus =
    stats.cpu_stats?.online_cpus ||
    stats.cpu_stats?.cpu_usage?.percpu_usage?.length ||
    1;

  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  const pct = (cpuDelta / systemDelta) * onlineCpus * 100;
  return Number(Math.min(100 * onlineCpus, Math.max(0, pct)).toFixed(1));
}

export function computeDockerMemoryStats(stats: {
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
}): { memoryMb: number; memoryLimitMb: number } {
  const rawUsage = stats.memory_stats?.usage ?? 0;
  const cache =
    stats.memory_stats?.stats?.inactive_file ??
    stats.memory_stats?.stats?.cache ??
    0;
  const effectiveBytes = Math.max(0, rawUsage - cache);
  const limitBytes = stats.memory_stats?.limit ?? 0;

  return {
    memoryMb: Math.round(effectiveBytes / (1024 * 1024)),
    memoryLimitMb: Math.max(128, Math.round(limitBytes / (1024 * 1024))),
  };
}

export function computeBackoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, baseMs * Math.pow(2, safeAttempt));
}
