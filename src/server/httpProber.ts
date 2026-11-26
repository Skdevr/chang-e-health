import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { isPrivateOrBlockedIp } from '../lib/securityAndDocker';

export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_MAX_REDIRECTS = 3;
export const TLS_EXPIRY_ALERT_DAYS = 14;

export interface SafeProbeResult {
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number;
  tlsValid: boolean;
  tlsExpiresAt: string | null;
  tlsDaysRemaining: number | null;
  tlsExpiringSoon: boolean;
  serverHeader: string;
  errorMessage?: string;
}

export type LookupFn = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results;
};

export async function assertSafeResolvedHost(
  urlObj: URL,
  allowedHosts: string[],
  lookupFn: LookupFn = defaultLookup
): Promise<{ address: string; family: number }> {
  if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
    throw new Error('Protocolo não permitido para verificação HTTP.');
  }

  const host = urlObj.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Host local ou interno bloqueado por proteção SSRF.');
  }

  const normalizedAllowed = allowedHosts
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (normalizedAllowed.length > 0 && !normalizedAllowed.includes(host)) {
    throw new Error(`Host "${host}" não autorizado em PROBE_ALLOWED_HOSTS.`);
  }

  const resolved = await lookupFn(host);
  if (!resolved || resolved.length === 0) {
    throw new Error(`Não foi possível resolver DNS para ${host}.`);
  }

  for (const record of resolved) {
    if (isPrivateOrBlockedIp(record.address)) {
      throw new Error(
        `Endereço IP resolvido (${record.address}) bloqueado por proteção SSRF.`
      );
    }
  }

  return resolved[0];
}

function singleHopRequest(
  urlObj: URL,
  resolvedIp: { address: string; family: number },
  remainingTimeoutMs: number
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  tlsValid: boolean;
  tlsExpiresAt: string | null;
  tlsDaysRemaining: number | null;
}> {
  return new Promise((resolve, reject) => {
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port = urlObj.port ? Number(urlObj.port) : isHttps ? 443 : 80;

    let settled = false;
    const finish = (err: Error | null, value?: {
      statusCode: number;
      headers: http.IncomingHttpHeaders;
      tlsValid: boolean;
      tlsExpiresAt: string | null;
      tlsDaysRemaining: number | null;
    }) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else if (value) resolve(value);
    };

    const req = transport.request(
      {
        hostname: urlObj.hostname,
        port,
        path: `${urlObj.pathname || '/'}${urlObj.search || ''}`,
        method: 'GET',
        timeout: Math.max(250, remainingTimeoutMs),
        headers: {
          Host: urlObj.host,
          'User-Agent': 'Change-Health-Monitor/1.0',
          Accept: '*/*',
        },
        // Pin socket lookup to the already SSRF-validated IP to prevent DNS rebinding
        lookup: (_host, _opts, cb) => {
          cb(null, resolvedIp.address, resolvedIp.family);
        },
        ...(isHttps ? { servername: urlObj.hostname, rejectUnauthorized: true } : {}),
      },
      (res) => {
        let tlsValid = false;
        let tlsExpiresAt: string | null = null;
        let tlsDaysRemaining: number | null = null;

        if (isHttps) {
          const tlsSocket = res.socket as TLSSocket;
          tlsValid = Boolean(tlsSocket.authorized);
          const cert = tlsSocket.getPeerCertificate?.();
          if (cert && cert.valid_to) {
            const expMs = Date.parse(cert.valid_to);
            if (!Number.isNaN(expMs)) {
              tlsExpiresAt = new Date(expMs).toISOString();
              tlsDaysRemaining = Math.floor((expMs - Date.now()) / 86_400_000);
            }
          }
        }

        // Drain body cleanly without buffering huge payloads
        res.resume();
        finish(null, {
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          tlsValid,
          tlsExpiresAt,
          tlsDaysRemaining,
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout de ${PROBE_TIMEOUT_MS}ms excedido na verificação HTTP.`));
    });
    req.on('error', (err) => {
      finish(err);
    });
    req.end();
  });
}

export async function runSafeHttpProbe(options: {
  targetUrl: string;
  allowedHosts?: string[];
  maxRedirects?: number;
  timeoutMs?: number;
  lookupFn?: LookupFn;
}): Promise<SafeProbeResult> {
  const startedAt = Date.now();
  const maxRedirects = options.maxRedirects ?? PROBE_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const allowedHosts = options.allowedHosts ?? [];
  const lookupFn = options.lookupFn ?? defaultLookup;

  let currentUrl: URL;
  try {
    currentUrl = new URL(options.targetUrl);
  } catch {
    return {
      reachable: false,
      httpStatus: null,
      latencyMs: Math.max(1, Date.now() - startedAt),
      tlsValid: false,
      tlsExpiresAt: null,
      tlsDaysRemaining: null,
      tlsExpiringSoon: false,
      serverHeader: 'desconhecido',
      errorMessage: 'URL de probe inválida.',
    };
  }

  let redirects = 0;

  try {
    while (true) {
      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        throw new Error(`Timeout de ${timeoutMs}ms excedido na verificação HTTP.`);
      }

      const resolvedIp = await assertSafeResolvedHost(
        currentUrl,
        redirects === 0 ? allowedHosts : [],
        lookupFn
      );

      const hop = await singleHopRequest(currentUrl, resolvedIp, remaining);

      const isRedirect =
        hop.statusCode >= 300 &&
        hop.statusCode < 400 &&
        typeof hop.headers.location === 'string' &&
        hop.headers.location.trim().length > 0;

      if (isRedirect) {
        if (redirects >= maxRedirects) {
          throw new Error(`Limite máximo de ${maxRedirects} redirecionamentos excedido.`);
        }
        redirects += 1;
        currentUrl = new URL(hop.headers.location!, currentUrl);
        continue;
      }

      const latencyMs = Math.max(1, Date.now() - startedAt);
      const reachable = hop.statusCode >= 200 && hop.statusCode < 500;
      const tlsExpiringSoon =
        hop.tlsDaysRemaining !== null && hop.tlsDaysRemaining < TLS_EXPIRY_ALERT_DAYS;

      return {
        reachable,
        httpStatus: hop.statusCode,
        latencyMs,
        tlsValid: hop.tlsValid,
        tlsExpiresAt: hop.tlsExpiresAt,
        tlsDaysRemaining: hop.tlsDaysRemaining,
        tlsExpiringSoon,
        serverHeader: String(hop.headers.server || 'https-edge'),
      };
    }
  } catch (error) {
    return {
      reachable: false,
      httpStatus: null,
      latencyMs: Math.max(1, Date.now() - startedAt),
      tlsValid: false,
      tlsExpiresAt: null,
      tlsDaysRemaining: null,
      tlsExpiringSoon: false,
      serverHeader: 'desconhecido',
      errorMessage:
        error instanceof Error ? error.message : 'Falha ao executar verificação HTTP.',
    };
  }
}
