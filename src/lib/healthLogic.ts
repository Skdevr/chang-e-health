import type {
  AlertDispatchRecord,
  ContainerService,
  IncidentRecord,
  LiveEndpointProbe,
  StackSummary,
} from '../types/health';

export interface InterruptionDiagnosis {
  category: string;
  rootCause: string;
  recommendedAction: string;
  severity: 'critical' | 'warning';
}

export function classifyInterruption(
  exitCode: number,
  reasonHint?: string
): InterruptionDiagnosis {
  const hint = (reasonHint ?? '').toLowerCase();

  if (exitCode === 137 || hint.includes('oom')) {
    return {
      category: 'OOMKilled (Exit 137)',
      rootCause:
        'O kernel Linux encerrou o container via SIGKILL porque o consumo de memória excedeu o limite configurado no Docker.',
      recommendedAction:
        'Aumentar mem_limit no docker-compose.yml, inspecionar vazamentos de heap nos logs e verificar picos de requisições simultâneas.',
      severity: 'critical',
    };
  }

  if (exitCode === 139 || hint.includes('segfault')) {
    return {
      category: 'Falha de Segmentação (Exit 139)',
      rootCause:
        'O processo principal recebeu SIGSEGV devido a acesso inválido de memória ou incompatibilidade de módulo nativo.',
      recommendedAction:
        'Validar versão da imagem base Alpine/Debian, verificar extensões nativas compiladas e reiniciar com dump de diagnóstico.',
      severity: 'critical',
    };
  }

  if (exitCode === 143 || hint.includes('sigterm')) {
    return {
      category: 'Encerramento Gracioso Interrompido (Exit 143)',
      rootCause:
        'O container recebeu SIGTERM durante deploy, escala ou reinício manual do host Docker e não retomou automaticamente.',
      recommendedAction:
        'Confirmar política restart: unless-stopped no Docker Compose e validar se há deploy pendente.',
      severity: 'warning',
    };
  }

  if (hint.includes('timeout') || hint.includes('503') || hint.includes('healthcheck')) {
    return {
      category: 'Falha de Healthcheck HTTP (503 / Timeout)',
      rootCause:
        'O endpoint interno de integridade não respondeu dentro da janela configurada (3 falhas consecutivas).',
      recommendedAction:
        'Verificar travamento de event loop, saturação de conexões downstream e reiniciar o container se o deadlock persistir.',
      severity: 'warning',
    };
  }

  if (hint.includes('pool') || hint.includes('database') || hint.includes('econnrefused')) {
    return {
      category: 'Perda de Conexão com Banco de Dados',
      rootCause:
        'O pool de conexões esgotou o limite máximo ou perdeu conectividade com o serviço PostgreSQL na rede interna.',
      recommendedAction:
        'Verificar saúde do container change-postgres-primary, checar pg_stat_activity e ajustar max_connections.',
      severity: 'critical',
    };
  }

  if (exitCode === 1) {
    return {
      category: 'Erro Fatal de Aplicação (Exit 1)',
      rootCause:
        'Exceção não tratada encerrou o processo principal do container antes da inicialização ou durante o processamento de requisição.',
      recommendedAction:
        'Analisar o stack trace capturado em stderr, conferir variáveis de ambiente obrigatórias e reiniciar após correção.',
      severity: 'critical',
    };
  }

  return {
    category: `Interrupção Inesperada (Exit ${exitCode})`,
    rootCause:
      'O daemon Docker registrou saída anômala do processo principal do container.',
    recommendedAction:
      'Revisar os últimos eventos em stderr e validar recursos de disco, memória e rede do host Docker.',
    severity: 'critical',
  };
}

const PRIVATE_IPV4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

export function validateMonitorUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
} {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'Informe uma URL válida.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Formato de URL inválido. Use https://exemplo.com/health.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'Apenas protocolos HTTP ou HTTPS são permitidos.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || BLOCKED_HOSTNAMES.has(host)) {
    return { valid: false, error: 'Endereços locais ou de metadados não são permitidos.' };
  }

  if (
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:') ||
    host.includes(':')
  ) {
    return { valid: false, error: 'Endereços internos ou IPv6 privado não são permitidos.' };
  }

  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host))) {
    return { valid: false, error: 'Faixas de IP privado não são permitidas para probes externos.' };
  }

  if (!host.includes('.')) {
    return { valid: false, error: 'Informe um domínio público completo (ex.: https://chang-e.app/).' };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmailList(emails: string[]): {
  valid: boolean;
  cleaned: string[];
  error?: string;
} {
  const cleaned = emails
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  if (cleaned.length === 0) {
    return {
      valid: false,
      cleaned: [],
      error: 'Informe ao menos um destinatário de e-mail.',
    };
  }

  const invalid = cleaned.find((email) => !SIMPLE_EMAIL_REGEX.test(email));
  if (invalid) {
    return {
      valid: false,
      cleaned,
      error: `Endereço de e-mail inválido: ${invalid}`,
    };
  }

  const unique = Array.from(new Set(cleaned));
  return { valid: true, cleaned: unique };
}

export function shouldDispatchAlert(
  lastAlertTimestampIso: string | undefined,
  cooldownMinutes: number,
  nowMs: number = Date.now()
): boolean {
  if (!lastAlertTimestampIso) return true;
  const lastMs = Date.parse(lastAlertTimestampIso);
  if (Number.isNaN(lastMs)) return true;
  const elapsedMs = nowMs - lastMs;
  return elapsedMs >= Math.max(0, cooldownMinutes) * 60 * 1000;
}

export function formatTelegramAlert(
  incident: IncidentRecord,
  container: ContainerService,
  logLines: string[]
): string {
  const statusLabel =
    incident.status === 'resolved'
      ? 'RECUPERADO'
      : incident.severity === 'critical'
      ? 'FALHA CRÍTICA'
      : 'ALERTA DE SAÚDE';

  const excerpt =
    logLines.length > 0
      ? logLines.slice(-4).join('\n')
      : 'Sem linhas recentes capturadas em stderr.';

  return [
    `[Chang'e Health] ${statusLabel}`,
    `Aplicação: https://chang-e.app/`,
    `Container: ${container.name} (${container.image})`,
    `Status: ${container.status.toUpperCase()} | Exit Code: ${incident.exitCode}`,
    `Motivo: ${incident.category}`,
    `Diagnóstico: ${incident.rootCause}`,
    `Ação sugerida: ${incident.recommendedAction}`,
    `Horário: ${incident.startedAt}`,
    `Logs recentes:`,
    excerpt,
  ].join('\n');
}

export function formatEmailAlert(
  incident: IncidentRecord,
  container: ContainerService,
  logLines: string[],
  subjectPrefix: string
): { subject: string; text: string } {
  const prefix = subjectPrefix.trim() || "[Chang'e Health]";
  const stateWord =
    incident.status === 'resolved'
      ? 'Recuperado'
      : incident.severity === 'critical'
      ? 'Interrupção Crítica'
      : 'Saúde Degradada';

  const subject = `${prefix} ${stateWord}: ${container.name} (${incident.category})`;
  const text = formatTelegramAlert(incident, container, logLines);
  return { subject, text };
}

export function computeStackSummary(
  containers: ContainerService[],
  probe: LiveEndpointProbe,
  dispatches: AlertDispatchRecord[]
): StackSummary {
  const totalCount = containers.length;
  const healthyCount = containers.filter((c) => c.status === 'healthy').length;
  const degradedCount = containers.filter(
    (c) => c.status === 'degraded' || c.status === 'restarting'
  ).length;
  const stoppedCount = containers.filter((c) => c.status === 'stopped').length;

  const healthPercentage =
    totalCount === 0
      ? 100
      : Number((((healthyCount + degradedCount * 0.5) / totalCount) * 100).toFixed(2));

  const responsiveContainers = containers.filter((c) => c.latencyMs > 0);
  const averageLatencyMs =
    responsiveContainers.length === 0
      ? probe.latencyMs
      : Math.round(
          responsiveContainers.reduce((acc, c) => acc + c.latencyMs, 0) /
            responsiveContainers.length
        );

  let overallStatus: StackSummary['overallStatus'] = 'operational';
  if (stoppedCount > 0 || !probe.reachable) {
    overallStatus = 'outage';
  } else if (degradedCount > 0) {
    overallStatus = 'degraded';
  }

  return {
    totalCount,
    healthyCount,
    degradedCount,
    stoppedCount,
    healthPercentage,
    averageLatencyMs,
    overallStatus,
    alertsSent24h: dispatches.length,
  };
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '0m';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

export function buildTelemetry24hSeries(
  containers: ContainerService[],
  currentLatencyMs: number,
  nowMs: number = Date.now()
): import('../types/health').TelemetryPoint24h[] {
  const totalLimitMb = Math.max(
    512,
    containers.reduce((acc, c) => acc + c.memoryLimitMb, 0)
  );
  const currentUsedMb = containers.reduce((acc, c) => acc + c.memoryMb, 0);
  const baseLatency = Math.max(25, currentLatencyMs || 48);

  // Deterministic hourly curve across 24 points ending at current hour
  const points: import('../types/health').TelemetryPoint24h[] = [];
  for (let i = 23; i >= 0; i--) {
    const pointDate = new Date(nowMs - i * 3_600_000);
    const hourStr = String(pointDate.getHours()).padStart(2, '0');
    const hourLabel = i === 0 ? 'Agora' : `${hourStr}h`;

    if (i === 0) {
      const memoryPercent = Number(
        Math.min(100, Math.max(0, (currentUsedMb / totalLimitMb) * 100)).toFixed(1)
      );
      points.push({
        timestamp: pointDate.toISOString(),
        hourLabel,
        latencyMs: Math.max(1, Math.round(currentLatencyMs)),
        memoryUsedMb: Math.round(currentUsedMb),
        memoryLimitMb: Math.round(totalLimitMb),
        memoryPercent,
      });
      continue;
    }

    // Subtle circadian load wave + realistic spike around -4h (historical OOM event)
    const phase = (24 - i) / 24;
    const wave = Math.sin(phase * Math.PI * 2 - 0.8);
    const oomSpike = i === 4 ? 1 : i === 5 ? 0.55 : i === 3 ? 0.25 : 0;

    const latencyFactor = 0.84 + wave * 0.14 + oomSpike * 0.42;
    const latencyMs = Math.max(18, Math.round(baseLatency * latencyFactor));

    const baseRatio = currentUsedMb > 0 ? currentUsedMb / totalLimitMb : 0.42;
    const memRatio = Math.min(
      0.94,
      Math.max(0.18, baseRatio + wave * 0.05 + oomSpike * 0.24)
    );
    const memoryUsedMb = Math.round(totalLimitMb * memRatio);
    const memoryPercent = Number(((memoryUsedMb / totalLimitMb) * 100).toFixed(1));

    points.push({
      timestamp: pointDate.toISOString(),
      hourLabel,
      latencyMs,
      memoryUsedMb,
      memoryLimitMb: Math.round(totalLimitMb),
      memoryPercent,
    });
  }

  return points;
}

export function updateLatestTelemetryPoint(
  series: import('../types/health').TelemetryPoint24h[],
  containers: ContainerService[],
  latencyMs: number,
  nowMs: number = Date.now()
): import('../types/health').TelemetryPoint24h[] {
  if (!Array.isArray(series) || series.length === 0) {
    return buildTelemetry24hSeries(containers, latencyMs, nowMs);
  }

  const totalLimitMb = Math.max(
    512,
    containers.reduce((acc, c) => acc + c.memoryLimitMb, 0)
  );
  const currentUsedMb = containers.reduce((acc, c) => acc + c.memoryMb, 0);
  const memoryPercent = Number(
    Math.min(100, Math.max(0, (currentUsedMb / totalLimitMb) * 100)).toFixed(1)
  );

  const updated = series.slice(0, -1);
  updated.push({
    timestamp: new Date(nowMs).toISOString(),
    hourLabel: 'Agora',
    latencyMs: Math.max(1, Math.round(latencyMs)),
    memoryUsedMb: Math.round(currentUsedMb),
    memoryLimitMb: Math.round(totalLimitMb),
    memoryPercent,
  });

  return updated;
}
