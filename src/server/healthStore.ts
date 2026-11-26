import {
  buildTelemetry24hSeries,
  classifyInterruption,
  computeStackSummary,
  formatEmailAlert,
  formatTelegramAlert,
  shouldDispatchAlert,
  updateLatestTelemetryPoint,
  validateEmailList,
} from '../lib/healthLogic';
import {
  redactSecrets,
  validateCooldownMinutes,
  validateProbeUrlWithAllowlist,
} from '../lib/securityAndDocker';
import type {
  AlertChannel,
  AlertConfiguration,
  AlertDispatchRecord,
  ContainerLogEntry,
  ContainerService,
  ContainerStatus,
  FailureScenario,
  IncidentRecord,
  LiveEndpointProbe,
  MonitorSnapshot,
  TelemetryPoint24h,
} from '../types/health';
import {
  DockerClient,
  type DockerEventPayload,
  type DockerInspectContainer,
  type DockerListContainer,
} from './dockerClient';
import { runSafeHttpProbe, TLS_EXPIRY_ALERT_DAYS } from './httpProber';
import {
  isSmtpConfigured,
  isTelegramConfigured,
  sendEmailAlert,
  sendTelegramAlert,
} from './notifiers';
import { AtomicJsonStore } from './persistence';

export const MAX_INCIDENTS_RETENTION = 500;
export const MAX_DISPATCHES_RETENTION = 1000;
export const MAX_LOGS_RETENTION = 500;
export const DEFAULT_COOLDOWN_MINUTES = 10;

interface PersistedState {
  containers: ContainerService[];
  incidents: IncidentRecord[];
  logs: ContainerLogEntry[];
  alertConfig: AlertConfiguration;
  alertDispatches: AlertDispatchRecord[];
  probe: LiveEndpointProbe;
  telemetry24h: TelemetryPoint24h[];
  lastAlertByContainer: Record<string, string>;
  lastTlsAlertAt?: string;
}

export interface HealthStoreConfig {
  demoMode: boolean;
  allowActions: boolean;
  authConfigured: boolean;
  dataDir: string;
  probeUrl: string;
  probeAllowedHosts: string[];
  dockerHost?: string;
  dockerSocketPath: string;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function defaultAlertConfig(): AlertConfiguration {
  return {
    emailEnabled: true,
    emailRecipients: ['ops@chang-e.app'],
    emailSubjectPrefix: '[Chang’e Health]',
    telegramEnabled: true,
    telegramChatLabel: '@change_ops_alerts',
    notifyOnStop: true,
    notifyOnUnhealthy: true,
    notifyOnHighLatency: true,
    notifyOnRecovery: true,
    highLatencyThresholdMs: 600,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    probeIntervalSeconds: 30,
  };
}

function createInitialProductionState(probeUrl: string): PersistedState {
  const nowIso = new Date().toISOString();
  return {
    containers: [],
    incidents: [],
    logs: [],
    alertConfig: defaultAlertConfig(),
    alertDispatches: [],
    probe: {
      targetUrl: probeUrl,
      reachable: false,
      httpStatus: null,
      latencyMs: 0,
      tlsValid: false,
      tlsExpiresAt: null,
      tlsDaysRemaining: null,
      tlsExpiringSoon: false,
      serverHeader: 'aguardando',
      checkedAt: nowIso,
      history: [],
    },
    telemetry24h: [],
    lastAlertByContainer: {},
  };
}

function createInitialDemoState(probeUrl: string): PersistedState {
  const now = new Date();
  const iso = (minutesAgo: number) =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  const containers: ContainerService[] = [
    {
      id: 'change-edge-gateway',
      name: 'change-edge-gateway',
      role: 'Proxy Reverso & Terminação TLS',
      image: 'nginx:1.27-alpine',
      ports: '443:443, 80:80',
      network: 'change_edge_net',
      healthCommand: 'curl -fsS https://chang-e.app/ || exit 1',
      healthEndpoint: probeUrl,
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 1_248_600,
      cpuPercent: 4.2,
      memoryMb: 94,
      memoryLimitMb: 512,
      latencyMs: 42,
      latencyHistory: [46, 41, 44, 39, 43, 40, 45, 42, 38, 42],
      lastCheckedAt: iso(0),
    },
    {
      id: 'change-web-app',
      name: 'change-web-app',
      role: 'Aplicação Frontend Chang’e',
      image: 'ghcr.io/change-app/web:2.4.1',
      ports: '3000:3000',
      network: 'change_app_net',
      healthCommand: 'wget -qO- http://127.0.0.1:3000/api/health || exit 1',
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 892_400,
      cpuPercent: 11.8,
      memoryMb: 318,
      memoryLimitMb: 1024,
      latencyMs: 28,
      latencyHistory: [31, 29, 27, 30, 26, 28, 32, 29, 27, 28],
      lastCheckedAt: iso(0),
    },
    {
      id: 'change-api-core',
      name: 'change-api-core',
      role: 'API Principal & Autenticação',
      image: 'ghcr.io/change-app/api:2.4.1',
      ports: '8080:8080',
      network: 'change_app_net',
      healthCommand: 'curl -fsS http://127.0.0.1:8080/healthz || exit 1',
      status: 'healthy',
      exitCode: 0,
      restartCount: 1,
      uptimeSeconds: 412_900,
      cpuPercent: 18.4,
      memoryMb: 512,
      memoryLimitMb: 1024,
      latencyMs: 36,
      latencyHistory: [34, 39, 35, 38, 41, 37, 35, 34, 38, 36],
      lastCheckedAt: iso(0),
    },
    {
      id: 'change-worker-queue',
      name: 'change-worker-queue',
      role: 'Processador de Filas & Webhooks',
      image: 'ghcr.io/change-app/worker:2.4.1',
      ports: 'interno',
      network: 'change_app_net',
      healthCommand: 'node scripts/healthcheck.mjs',
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 618_200,
      cpuPercent: 9.1,
      memoryMb: 246,
      memoryLimitMb: 768,
      latencyMs: 19,
      latencyHistory: [21, 18, 20, 22, 19, 17, 19, 20, 18, 19],
      lastCheckedAt: iso(0),
    },
    {
      id: 'change-postgres-primary',
      name: 'change-postgres-primary',
      role: 'Banco Relacional Principal',
      image: 'postgres:16.4-alpine',
      ports: '5432:5432',
      network: 'change_data_net',
      healthCommand: 'pg_isready -U change_prod -d change_db',
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 2_419_200,
      cpuPercent: 14.6,
      memoryMb: 1180,
      memoryLimitMb: 2048,
      latencyMs: 9,
      latencyHistory: [8, 9, 10, 9, 8, 9, 11, 9, 8, 9],
      lastCheckedAt: iso(0),
    },
    {
      id: 'change-redis-cache',
      name: 'change-redis-cache',
      role: 'Cache de Sessões & Rate Limit',
      image: 'redis:7.4-alpine',
      ports: '6379:6379',
      network: 'change_data_net',
      healthCommand: 'redis-cli ping | grep PONG',
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 2_419_200,
      cpuPercent: 2.3,
      memoryMb: 142,
      memoryLimitMb: 512,
      latencyMs: 4,
      latencyHistory: [4, 3, 4, 5, 4, 4, 3, 4, 5, 4],
      lastCheckedAt: iso(0),
    },
  ];

  const logs: ContainerLogEntry[] = [
    {
      id: makeId('log'),
      containerId: 'change-edge-gateway',
      containerName: 'change-edge-gateway',
      timestamp: iso(1),
      level: 'INFO',
      stream: 'stdout',
      message: 'TLS 1.3 handshake nominal em https://chang-e.app/ — upstream change-web-app:3000 respondeu HTTP 200.',
    },
    {
      id: makeId('log'),
      containerId: 'change-api-core',
      containerName: 'change-api-core',
      timestamp: iso(3),
      level: 'INFO',
      stream: 'stdout',
      message: 'Healthcheck /healthz aprovado (db_pool=ok, redis=ok, mem=512MB/1024MB).',
    },
    {
      id: makeId('log'),
      containerId: 'change-worker-queue',
      containerName: 'change-worker-queue',
      timestamp: iso(6),
      level: 'INFO',
      stream: 'stdout',
      message: 'Fila webhooks-outbound sincronizada: 0 jobs atrasados, 48 processados nos últimos 5m.',
    },
    {
      id: makeId('log'),
      containerId: 'change-postgres-primary',
      containerName: 'change-postgres-primary',
      timestamp: iso(11),
      level: 'INFO',
      stream: 'stdout',
      message: 'checkpoint complete: wrote 118 buffers (0.7%); 0 WAL file(s) added, 0 removed.',
    },
    {
      id: makeId('log'),
      containerId: 'change-api-core',
      containerName: 'change-api-core',
      timestamp: iso(260),
      level: 'ERROR',
      stream: 'stderr',
      message: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory (container encerrado com Exit 137).',
    },
  ];

  const incidents: IncidentRecord[] = [
    {
      id: 'inc-hist-01',
      containerId: 'change-api-core',
      containerName: 'change-api-core',
      startedAt: iso(260),
      resolvedAt: iso(258),
      status: 'resolved',
      severity: 'critical',
      exitCode: 137,
      category: 'OOMKilled (Exit 137)',
      rootCause:
        'O kernel Linux encerrou o container via SIGKILL porque o consumo de memória excedeu o limite configurado no Docker.',
      recommendedAction:
        'Aumentar mem_limit no docker-compose.yml, inspecionar vazamentos de heap nos logs e verificar picos de requisições simultâneas.',
      logExcerpt: [
        'WARN  Heap usage atingiu 96.4% (987MB / 1024MB) durante lote de sincronização.',
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
        'dockerd: container change-api-core exited with code 137 (OOMKilled=true)',
      ],
      notifiedChannels: ['email', 'telegram'],
      recoveryNotified: true,
    },
  ];

  const alertConfig = defaultAlertConfig();

  const alertDispatches: AlertDispatchRecord[] = [
    {
      id: 'disp-hist-telegram',
      incidentId: 'inc-hist-01',
      containerName: 'change-api-core',
      channel: 'telegram',
      recipient: alertConfig.telegramChatLabel,
      subject: '[Chang’e Health] Falha Crítica: change-api-core',
      messagePreview:
        "[Chang'e Health] FALHA CRÍTICA\nAplicação: https://chang-e.app/\nContainer: change-api-core\nStatus: STOPPED | Exit Code: 137\nMotivo: OOMKilled (Exit 137)",
      deliveryStatus: isTelegramConfigured() ? 'sent_live' : 'queued_preview',
      deliveryNote: 'Alerta histórico registrado na interrupção anterior do container.',
      dispatchedAt: iso(260),
      latencyMs: 184,
      isTest: false,
    },
    {
      id: 'disp-hist-email',
      incidentId: 'inc-hist-01',
      containerName: 'change-api-core',
      channel: 'email',
      recipient: 'ops@chang-e.app',
      subject: '[Chang’e Health] Interrupção Crítica: change-api-core (OOMKilled (Exit 137))',
      messagePreview:
        'Container change-api-core foi encerrado com Exit 137 (OOMKilled). Última linha em stderr: JavaScript heap out of memory.',
      deliveryStatus: isSmtpConfigured() ? 'sent_live' : 'queued_preview',
      deliveryNote: 'Alerta histórico registrado na interrupção anterior do container.',
      dispatchedAt: iso(260),
      latencyMs: 262,
      isTest: false,
    },
  ];

  const probe: LiveEndpointProbe = {
    targetUrl: probeUrl,
    reachable: true,
    httpStatus: 200,
    latencyMs: 42,
    tlsValid: true,
    tlsExpiresAt: null,
    tlsDaysRemaining: null,
    tlsExpiringSoon: false,
    serverHeader: 'edge-proxy',
    checkedAt: iso(0),
    history: [
      { checkedAt: iso(15), latencyMs: 49, reachable: true, httpStatus: 200 },
      { checkedAt: iso(12), latencyMs: 44, reachable: true, httpStatus: 200 },
      { checkedAt: iso(9), latencyMs: 41, reachable: true, httpStatus: 200 },
      { checkedAt: iso(6), latencyMs: 45, reachable: true, httpStatus: 200 },
      { checkedAt: iso(3), latencyMs: 39, reachable: true, httpStatus: 200 },
      { checkedAt: iso(0), latencyMs: 42, reachable: true, httpStatus: 200 },
    ],
  };

  return {
    containers,
    incidents,
    logs,
    alertConfig,
    alertDispatches,
    probe,
    telemetry24h: buildTelemetry24hSeries(containers, probe.latencyMs, now.getTime()),
    lastAlertByContainer: {},
  };
}

function mapDockerStateToStatus(inspect: DockerInspectContainer | null, listItem: DockerListContainer): ContainerStatus {
  const running = inspect?.State?.Running ?? listItem.State === 'running';
  const statusStr = (inspect?.State?.Status || listItem.State || '').toLowerCase();
  if (statusStr === 'restarting') return 'restarting';
  if (!running) return 'stopped';
  const healthStatus = (inspect?.State?.Health?.Status || '').toLowerCase();
  if (healthStatus === 'unhealthy' || listItem.Status.toLowerCase().includes('unhealthy')) {
    return 'degraded';
  }
  return 'healthy';
}

function formatDockerPorts(ports?: DockerListContainer['Ports']): string {
  if (!ports || ports.length === 0) return 'interno';
  const unique = Array.from(
    new Set(
      ports
        .map((p) => (p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`))
        .filter(Boolean)
    )
  );
  return unique.slice(0, 3).join(', ') || 'interno';
}

function parseUptimeSeconds(startedAt?: string, running?: boolean): number {
  if (!running || !startedAt) return 0;
  const ms = Date.parse(startedAt);
  if (Number.isNaN(ms) || ms <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

export class HealthMonitorStore {
  private readonly config: HealthStoreConfig;
  private readonly persistence: AtomicJsonStore<PersistedState>;
  private readonly dockerClient: DockerClient;
  private state: PersistedState;
  private dockerConnected = false;
  private dockerError: string | undefined;
  private lastUpdatedAt: string = new Date().toISOString();
  private previousStatusByContainer = new Map<string, ContainerStatus>();
  private eventStreamHandle: { stop: () => void } | null = null;

  constructor(config: HealthStoreConfig) {
    this.config = config;
    const filename = config.demoMode ? 'state-demo.json' : 'state.json';
    this.persistence = new AtomicJsonStore<PersistedState>(config.dataDir, filename);
    this.dockerClient = new DockerClient(config.dockerHost, config.dockerSocketPath);

    const loaded = this.persistence.loadSync(
      () =>
        config.demoMode
          ? createInitialDemoState(config.probeUrl)
          : createInitialProductionState(config.probeUrl),
      (parsed): parsed is PersistedState =>
        Boolean(
          parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as PersistedState).containers) &&
            (parsed as PersistedState).alertConfig
        )
    );

    this.state = loaded.data;
    this.state.probe.targetUrl = config.probeUrl;

    if (config.demoMode && (!Array.isArray(this.state.telemetry24h) || this.state.telemetry24h.length === 0)) {
      this.state.telemetry24h = buildTelemetry24hSeries(
        this.state.containers,
        this.state.probe?.latencyMs ?? 48
      );
    }

    if (!config.demoMode) {
      // Never load fictitious demo containers when DEMO_MODE=false
      this.state.containers = [];
    }

    for (const c of this.state.containers) {
      this.previousStatusByContainer.set(c.id, c.status);
    }

    if (loaded.recoveredFromCorrupt) {
      console.warn(
        `[Chang'e Health] Arquivo de estado corrompido movido para backup (${loaded.backupPath}). Estado reiniciado.`
      );
      void this.saveState();
    }
  }

  public startBackgroundMonitors(): void {
    if (!this.config.demoMode) {
      this.eventStreamHandle = this.dockerClient.subscribeEvents(
        (event) => this.handleDockerEvent(event),
        (connected, errMsg) => {
          this.dockerConnected = connected;
          this.dockerError = connected ? undefined : errMsg;
        }
      );
    }
  }

  public async shutdown(): Promise<void> {
    if (this.eventStreamHandle) {
      this.eventStreamHandle.stop();
      this.eventStreamHandle = null;
    }
    await this.persistence.flush();
  }

  private saveState(): Promise<void> {
    this.state.incidents = this.state.incidents.slice(0, MAX_INCIDENTS_RETENTION);
    this.state.alertDispatches = this.state.alertDispatches.slice(0, MAX_DISPATCHES_RETENTION);
    this.state.logs = this.state.logs.slice(0, MAX_LOGS_RETENTION);
    return this.persistence.enqueueSave(this.state).catch((err) => {
      console.error('[Chang\'e Health] Erro na persistência atômica:', err instanceof Error ? err.message : err);
    });
  }

  public getConfig(): HealthStoreConfig {
    return this.config;
  }

  public isDockerUnavailable(): boolean {
    return !this.config.demoMode && !this.dockerConnected;
  }

  public getSnapshot(): MonitorSnapshot {
    const dockerUnavailable = this.isDockerUnavailable();
    const summary = computeStackSummary(
      this.state.containers,
      this.state.probe,
      this.state.alertDispatches
    );

    return {
      summary,
      probe: this.state.probe,
      containers: this.state.containers,
      incidents: this.state.incidents,
      logs: this.state.logs,
      alertConfig: this.state.alertConfig,
      alertDispatches: this.state.alertDispatches,
      capabilities: {
        demoMode: this.config.demoMode,
        actionsEnabled: Boolean(this.config.allowActions && this.config.authConfigured),
        authRequired: this.config.authConfigured,
        dockerSocketConnected: this.dockerConnected,
        dockerUnavailable,
        dockerError: dockerUnavailable
          ? this.dockerError || `Docker inacessível em ${this.dockerClient.getConnectionSummary()}.`
          : undefined,
        dockerMode: this.config.demoMode
          ? 'demo'
          : this.dockerConnected
          ? 'docker_live'
          : 'unavailable',
        smtpConfigured: isSmtpConfigured(),
        telegramConfigured: isTelegramConfigured(),
        targetAppUrl: this.config.probeUrl,
        probeAllowedHosts: this.config.probeAllowedHosts,
      },
      telemetry24h: this.state.telemetry24h,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  public async refreshRealDockerContainers(): Promise<boolean> {
    if (this.config.demoMode) return true;

    try {
      const listed = await this.dockerClient.listContainers();
      const nowIso = new Date().toISOString();
      const updatedContainers: ContainerService[] = [];

      for (const item of listed) {
        const shortId = item.Id.slice(0, 12);
        const cleanName = (item.Names?.[0] || shortId).replace(/^\//, '');
        let inspect: DockerInspectContainer | null = null;
        try {
          inspect = await this.dockerClient.inspectContainer(item.Id);
        } catch {
          inspect = null;
        }

        const status = mapDockerStateToStatus(inspect, item);
        let stats = { cpuPercent: 0, memoryMb: 0, memoryLimitMb: 512 };
        if (status !== 'stopped') {
          try {
            stats = await this.dockerClient.getContainerStats(item.Id);
          } catch {
            stats = {
              cpuPercent: 0,
              memoryMb: 0,
              memoryLimitMb: inspect?.HostConfig?.Memory
                ? Math.max(128, Math.round(inspect.HostConfig.Memory / (1024 * 1024)))
                : 512,
            };
          }
        }

        const exitCode = inspect?.State?.ExitCode ?? (status === 'stopped' ? 1 : 0);
        const oomKilled = Boolean(inspect?.State?.OOMKilled);
        const existing = this.state.containers.find((c) => c.id === shortId);
        const networks = Object.keys(
          inspect?.NetworkSettings?.Networks || item.NetworkSettings?.Networks || {}
        );
        const healthTest = inspect?.Config?.Healthcheck?.Test?.join(' ') || 'Docker HEALTHCHECK';

        let interruptionCategory = existing?.interruptionCategory;
        let interruptionSummary = existing?.interruptionSummary;
        let recommendedAction = existing?.recommendedAction;

        if (status !== 'healthy') {
          const diag = classifyInterruption(
            oomKilled ? 137 : exitCode,
            oomKilled ? 'oom' : status === 'degraded' ? 'healthcheck' : undefined
          );
          interruptionCategory = diag.category;
          interruptionSummary = diag.rootCause;
          recommendedAction = diag.recommendedAction;
        } else {
          interruptionCategory = undefined;
          interruptionSummary = undefined;
          recommendedAction = undefined;
        }

        const containerObj: ContainerService = {
          id: shortId,
          name: cleanName,
          role: 'Container Docker',
          image: inspect?.Config?.Image || item.Image,
          ports: formatDockerPorts(item.Ports),
          network: networks[0] || 'bridge',
          healthCommand: healthTest,
          status,
          exitCode,
          oomKilled,
          restartCount: inspect?.RestartCount ?? 0,
          uptimeSeconds: parseUptimeSeconds(inspect?.State?.StartedAt, inspect?.State?.Running),
          cpuPercent: stats.cpuPercent,
          memoryMb: stats.memoryMb,
          memoryLimitMb: stats.memoryLimitMb,
          latencyMs: status === 'stopped' ? 0 : existing?.latencyMs ?? this.state.probe.latencyMs,
          latencyHistory: existing?.latencyHistory ?? [this.state.probe.latencyMs || 0],
          lastCheckedAt: nowIso,
          interruptionCategory,
          interruptionSummary,
          recommendedAction,
        };

        updatedContainers.push(containerObj);
        await this.evaluateStateTransition(containerObj, item.Id);
      }

      this.state.containers = updatedContainers;
      this.dockerConnected = true;
      this.dockerError = undefined;
      this.lastUpdatedAt = nowIso;
      this.state.telemetry24h = updateLatestTelemetryPoint(
        this.state.telemetry24h,
        this.state.containers,
        this.state.probe.latencyMs
      );
      await this.saveState();
      return true;
    } catch (error) {
      this.dockerConnected = false;
      this.dockerError =
        error instanceof Error
          ? redactSecrets(error.message)
          : 'Não foi possível conectar ao daemon Docker.';
      this.state.containers = [];
      return false;
    }
  }

  private async evaluateStateTransition(
    container: ContainerService,
    fullDockerId?: string
  ): Promise<void> {
    const prev = this.previousStatusByContainer.get(container.id);
    this.previousStatusByContainer.set(container.id, container.status);

    // First observation establishes baseline without spamming alerts
    if (!prev || prev === container.status) return;

    const nowIso = new Date().toISOString();

    if (container.status === 'stopped' || container.status === 'degraded') {
      const stderrLines = fullDockerId
        ? await this.dockerClient.getContainerStderrLogs(fullDockerId, 50)
        : [];
      const diag = classifyInterruption(
        container.oomKilled ? 137 : container.exitCode,
        container.oomKilled ? 'oom' : container.status === 'degraded' ? 'healthcheck' : undefined
      );

      for (const line of stderrLines.slice(-10)) {
        this.state.logs.unshift({
          id: makeId('log'),
          containerId: container.id,
          containerName: container.name,
          timestamp: nowIso,
          level: 'ERROR',
          stream: 'stderr',
          message: redactSecrets(line),
        });
      }

      const incident: IncidentRecord = {
        id: makeId('inc'),
        containerId: container.id,
        containerName: container.name,
        startedAt: nowIso,
        status: 'active',
        severity: diag.severity,
        exitCode: container.oomKilled ? 137 : container.exitCode,
        category: diag.category,
        rootCause: diag.rootCause,
        recommendedAction: diag.recommendedAction,
        logExcerpt: stderrLines.length > 0 ? stderrLines.slice(-12) : ['Sem linhas em stderr capturadas.'],
        notifiedChannels: [],
        recoveryNotified: false,
      };

      const shouldNotify =
        (container.status === 'stopped' && this.state.alertConfig.notifyOnStop) ||
        (container.status === 'degraded' && this.state.alertConfig.notifyOnUnhealthy);

      const cooldownReady = shouldDispatchAlert(
        this.state.lastAlertByContainer[container.id],
        this.state.alertConfig.cooldownMinutes
      );

      if (shouldNotify && cooldownReady) {
        incident.notifiedChannels = await this.dispatchIncidentAlerts(
          incident,
          container,
          incident.logExcerpt
        );
        this.state.lastAlertByContainer[container.id] = nowIso;
      }

      this.state.incidents.unshift(incident);
    } else if (container.status === 'healthy' && (prev === 'stopped' || prev === 'degraded' || prev === 'restarting')) {
      await this.resolveActiveIncidentsAndNotifyOnce(container, nowIso);
    }
  }

  private async handleDockerEvent(event: DockerEventPayload): Promise<void> {
    if (this.config.demoMode) return;
    const action = (event.Action || event.status || '').toLowerCase();
    const containerId = event.Actor?.ID || event.id;
    if (!containerId) return;

    const isFailureEvent =
      action === 'die' || action === 'oom' || action.includes('unhealthy');
    const isHealthyEvent = action.includes('healthy') && !action.includes('unhealthy');

    if (!isFailureEvent && !isHealthyEvent) return;

    // Refresh container metadata & capture 50 redacted stderr lines immediately on failure
    const nowIso = new Date().toISOString();
    let inspect: DockerInspectContainer | null = null;
    try {
      inspect = await this.dockerClient.inspectContainer(containerId);
    } catch {
      inspect = null;
    }

    const shortId = containerId.slice(0, 12);
    const name = (inspect?.Name || event.Actor?.Attributes?.name || shortId).replace(/^\//, '');
    const exitCode = inspect?.State?.ExitCode ?? (action === 'oom' ? 137 : 1);
    const oomKilled = Boolean(inspect?.State?.OOMKilled || action === 'oom');

    if (isFailureEvent) {
      const stderrLines = await this.dockerClient.getContainerStderrLogs(containerId, 50);
      const diag = classifyInterruption(
        oomKilled ? 137 : exitCode,
        oomKilled ? 'oom' : action.includes('unhealthy') ? 'healthcheck' : undefined
      );

      for (const line of stderrLines.slice(-12)) {
        this.state.logs.unshift({
          id: makeId('log'),
          containerId: shortId,
          containerName: name,
          timestamp: nowIso,
          level: 'ERROR',
          stream: 'stderr',
          message: redactSecrets(line),
        });
      }

      const existing = this.state.containers.find((c) => c.id === shortId);
      const targetContainer: ContainerService = existing || {
        id: shortId,
        name,
        role: 'Container Docker',
        image: inspect?.Config?.Image || event.Actor?.Attributes?.image || 'unknown',
        ports: 'docker',
        network: 'bridge',
        healthCommand: inspect?.Config?.Healthcheck?.Test?.join(' ') || 'Docker HEALTHCHECK',
        status: action.includes('unhealthy') ? 'degraded' : 'stopped',
        exitCode: oomKilled ? 137 : exitCode,
        oomKilled,
        restartCount: inspect?.RestartCount ?? 0,
        uptimeSeconds: 0,
        cpuPercent: 0,
        memoryMb: 0,
        memoryLimitMb: 512,
        latencyMs: 0,
        latencyHistory: [0],
        lastCheckedAt: nowIso,
      };

      targetContainer.status = action.includes('unhealthy') ? 'degraded' : 'stopped';
      targetContainer.exitCode = oomKilled ? 137 : exitCode;
      targetContainer.oomKilled = oomKilled;
      targetContainer.interruptionCategory = diag.category;
      targetContainer.interruptionSummary = diag.rootCause;
      targetContainer.recommendedAction = diag.recommendedAction;
      this.previousStatusByContainer.set(shortId, targetContainer.status);

      const incident: IncidentRecord = {
        id: makeId('inc'),
        containerId: shortId,
        containerName: name,
        startedAt: nowIso,
        status: 'active',
        severity: diag.severity,
        exitCode: targetContainer.exitCode,
        category: diag.category,
        rootCause: diag.rootCause,
        recommendedAction: diag.recommendedAction,
        logExcerpt: stderrLines.length > 0 ? stderrLines : [`Evento Docker recebido: ${action}`],
        notifiedChannels: [],
        recoveryNotified: false,
      };

      const cooldownReady = shouldDispatchAlert(
        this.state.lastAlertByContainer[shortId],
        this.state.alertConfig.cooldownMinutes
      );

      if (cooldownReady) {
        incident.notifiedChannels = await this.dispatchIncidentAlerts(
          incident,
          targetContainer,
          incident.logExcerpt
        );
        this.state.lastAlertByContainer[shortId] = nowIso;
      }

      this.state.incidents.unshift(incident);
      this.lastUpdatedAt = nowIso;
      await this.saveState();
    } else if (isHealthyEvent) {
      const existing = this.state.containers.find((c) => c.id === shortId);
      if (existing) {
        existing.status = 'healthy';
        this.previousStatusByContainer.set(shortId, 'healthy');
        await this.resolveActiveIncidentsAndNotifyOnce(existing, nowIso);
        this.lastUpdatedAt = nowIso;
        await this.saveState();
      }
    }
  }

  private async resolveActiveIncidentsAndNotifyOnce(
    container: ContainerService,
    nowIso: string
  ): Promise<void> {
    const activeIncidents = this.state.incidents.filter(
      (inc) => inc.containerId === container.id && inc.status === 'active'
    );

    let unnotifiedIncident: IncidentRecord | undefined;
    for (const inc of activeIncidents) {
      inc.status = 'resolved';
      inc.resolvedAt = nowIso;
      if (!inc.recoveryNotified && !unnotifiedIncident) {
        unnotifiedIncident = inc;
      }
      inc.recoveryNotified = true;
    }

    if (unnotifiedIncident && this.state.alertConfig.notifyOnRecovery) {
      await this.dispatchIncidentAlerts(unnotifiedIncident, container, [
        `[INFO] Container ${container.name} recuperado e respondendo normalmente.`,
      ]);
    }
  }

  public async runLiveProbe(): Promise<MonitorSnapshot> {
    const nowIso = new Date().toISOString();

    const probeResult = await runSafeHttpProbe({
      targetUrl: this.config.probeUrl,
      allowedHosts: this.config.probeAllowedHosts,
    });

    this.state.probe = {
      targetUrl: this.config.probeUrl,
      reachable: probeResult.reachable,
      httpStatus: probeResult.httpStatus,
      latencyMs: probeResult.latencyMs,
      tlsValid: probeResult.tlsValid,
      tlsExpiresAt: probeResult.tlsExpiresAt,
      tlsDaysRemaining: probeResult.tlsDaysRemaining,
      tlsExpiringSoon: probeResult.tlsExpiringSoon,
      serverHeader: probeResult.serverHeader,
      checkedAt: nowIso,
      errorMessage: probeResult.errorMessage,
      history: [
        ...this.state.probe.history.slice(-11),
        {
          checkedAt: nowIso,
          latencyMs: probeResult.latencyMs,
          reachable: probeResult.reachable,
          httpStatus: probeResult.httpStatus,
        },
      ],
    };

    // Emit TLS expiry warning alert if < 14 days remaining (respecting cooldown)
    if (
      probeResult.tlsExpiringSoon &&
      probeResult.tlsDaysRemaining !== null &&
      shouldDispatchAlert(this.state.lastTlsAlertAt, Math.max(60, this.state.alertConfig.cooldownMinutes))
    ) {
      await this.dispatchTlsExpiryAlert(probeResult.tlsDaysRemaining, probeResult.tlsExpiresAt);
      this.state.lastTlsAlertAt = nowIso;
    }

    if (!this.config.demoMode) {
      await this.refreshRealDockerContainers();
    } else {
      for (const container of this.state.containers) {
        container.lastCheckedAt = nowIso;
        if (container.id === 'change-edge-gateway' && container.status !== 'stopped') {
          container.latencyMs = probeResult.latencyMs;
          container.latencyHistory = [...container.latencyHistory.slice(-9), probeResult.latencyMs];
          container.status = probeResult.reachable ? 'healthy' : 'degraded';
        } else if (container.status === 'healthy') {
          const jitter = Math.floor(Math.random() * 5) - 2;
          const nextLatency = Math.max(3, container.latencyMs + jitter);
          container.latencyMs = nextLatency;
          container.latencyHistory = [...container.latencyHistory.slice(-9), nextLatency];
          container.uptimeSeconds += 30;
        }
      }
    }

    this.state.logs.unshift({
      id: makeId('log'),
      containerId: 'change-edge-gateway',
      containerName: 'change-edge-gateway',
      timestamp: nowIso,
      level: probeResult.reachable ? 'INFO' : 'ERROR',
      stream: probeResult.reachable ? 'stdout' : 'stderr',
      message: probeResult.reachable
        ? `Verificação ativa em ${this.config.probeUrl}: HTTP ${probeResult.httpStatus} em ${probeResult.latencyMs}ms (TLS ${
            probeResult.tlsDaysRemaining !== null
              ? `válido · ${probeResult.tlsDaysRemaining}d`
              : 'verificado'
          }).`
        : `Falha na verificação ativa em ${this.config.probeUrl}: ${redactSecrets(
            probeResult.errorMessage || 'Sem resposta'
          )} (${probeResult.latencyMs}ms).`,
    });

    const prevProbeCount = this.state.probe.history.length;
    if (prevProbeCount <= 7 && this.state.telemetry24h.length === 24) {
      const avgHistoricalLatency =
        this.state.telemetry24h.slice(0, -1).reduce((acc, p) => acc + p.latencyMs, 0) / 23;
      if (Math.abs(avgHistoricalLatency - probeResult.latencyMs) > Math.max(80, probeResult.latencyMs * 0.45)) {
        this.state.telemetry24h = buildTelemetry24hSeries(
          this.state.containers,
          probeResult.latencyMs
        );
      } else {
        this.state.telemetry24h = updateLatestTelemetryPoint(
          this.state.telemetry24h,
          this.state.containers,
          probeResult.latencyMs
        );
      }
    } else if (this.state.containers.length > 0) {
      this.state.telemetry24h = updateLatestTelemetryPoint(
        this.state.telemetry24h,
        this.state.containers,
        probeResult.latencyMs
      );
    }

    this.lastUpdatedAt = nowIso;
    await this.saveState();
    return this.getSnapshot();
  }

  private async dispatchTlsExpiryAlert(
    daysRemaining: number,
    expiresAt: string | null
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const msg = [
      `[Chang'e Health] ALERTA DE CERTIFICADO TLS`,
      `Aplicação: ${this.config.probeUrl}`,
      `Certificado expira em ${daysRemaining} dia(s) (limite: ${TLS_EXPIRY_ALERT_DAYS} dias).`,
      expiresAt ? `Data de expiração: ${expiresAt}` : '',
      `Ação sugerida: Renovar certificado TLS imediatamente.`,
    ]
      .filter(Boolean)
      .join('\n');

    const subject = `${this.state.alertConfig.emailSubjectPrefix} Certificado TLS expira em ${daysRemaining} dia(s)`;

    if (this.state.alertConfig.emailEnabled && this.state.alertConfig.emailRecipients.length > 0) {
      const emailRes = await sendEmailAlert({
        recipients: this.state.alertConfig.emailRecipients,
        subject,
        text: msg,
      });
      this.state.alertDispatches.unshift({
        id: makeId('disp'),
        containerName: 'tls-certificate',
        channel: 'email',
        recipient: this.state.alertConfig.emailRecipients.join(', '),
        subject,
        messagePreview: msg,
        deliveryStatus: emailRes.deliveryStatus,
        deliveryNote: emailRes.deliveryNote,
        dispatchedAt: nowIso,
        latencyMs: emailRes.latencyMs,
        isTest: false,
      });
    }

    if (this.state.alertConfig.telegramEnabled) {
      const tgRes = await sendTelegramAlert({ message: msg });
      this.state.alertDispatches.unshift({
        id: makeId('disp'),
        containerName: 'tls-certificate',
        channel: 'telegram',
        recipient: this.state.alertConfig.telegramChatLabel || '@change_ops_alerts',
        subject,
        messagePreview: msg,
        deliveryStatus: tgRes.deliveryStatus,
        deliveryNote: tgRes.deliveryNote,
        dispatchedAt: nowIso,
        latencyMs: tgRes.latencyMs,
        isTest: false,
      });
    }
  }

  public async triggerContainerFailure(
    containerId: string,
    scenario: FailureScenario
  ): Promise<MonitorSnapshot> {
    if (!this.config.demoMode) {
      throw new Error('Simulação de falha disponível apenas em DEMO_MODE=true.');
    }

    const container = this.state.containers.find((c) => c.id === containerId);
    if (!container) {
      throw new Error('Container não encontrado.');
    }

    const prevStatus = container.status;
    const nowIso = new Date().toISOString();
    let exitCode = 137;
    let reasonHint = 'oom';
    let newStatus: ContainerStatus = 'stopped';
    let crashLogs: Array<{ level: 'WARN' | 'ERROR'; message: string }> = [];

    if (scenario === 'oom') {
      exitCode = 137;
      reasonHint = 'oom';
      newStatus = 'stopped';
      crashLogs = [
        {
          level: 'WARN',
          message: `Uso de memória atingiu 99.1% (${container.memoryLimitMb - 9}MB / ${container.memoryLimitMb}MB) em ${container.name}.`,
        },
        {
          level: 'ERROR',
          message: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory.',
        },
        {
          level: 'ERROR',
          message: `dockerd: container ${container.name} encerrado pelo kernel OOM Killer (Exit Code 137 / SIGKILL).`,
        },
      ];
    } else if (scenario === 'crash') {
      exitCode = 1;
      reasonHint = 'unhandled exception';
      newStatus = 'stopped';
      crashLogs = [
        {
          level: 'ERROR',
          message: `UnhandledPromiseRejection em ${container.name}: TypeError: Cannot read properties of undefined (reading 'sessionToken').`,
        },
        {
          level: 'ERROR',
          message: 'at AuthMiddleware.verify (/app/dist/middleware/auth.js:84:19) -> processo encerrado com Exit Code 1.',
        },
      ];
    } else if (scenario === 'timeout') {
      exitCode = 0;
      reasonHint = 'healthcheck timeout 503';
      newStatus = 'degraded';
      crashLogs = [
        {
          level: 'WARN',
          message: `Healthcheck '${container.healthCommand}' excedeu limite de 5000ms (tentativa 3/3).`,
        },
        {
          level: 'ERROR',
          message: `Container ${container.name} marcado como UNHEALTHY pelo daemon Docker (HTTP 503 Service Unavailable).`,
        },
      ];
    } else {
      exitCode = 1;
      reasonHint = 'database pool econnrefused';
      newStatus = 'stopped';
      crashLogs = [
        {
          level: 'WARN',
          message: 'Pool de conexões PostgreSQL saturado (100/100 conexões ativas) há 15s.',
        },
        {
          level: 'ERROR',
          message: 'Error: connect ECONNREFUSED 172.20.0.5:5432 — falha crítica de persistência, encerrando processo.',
        },
      ];
    }

    const diagnosis = classifyInterruption(exitCode, reasonHint);

    container.status = newStatus;
    container.exitCode = exitCode;
    container.oomKilled = scenario === 'oom';
    container.lastCheckedAt = nowIso;
    container.interruptionCategory = diagnosis.category;
    container.interruptionSummary = diagnosis.rootCause;
    container.recommendedAction = diagnosis.recommendedAction;

    if (newStatus === 'stopped') {
      container.cpuPercent = 0;
      container.memoryMb = 0;
      container.uptimeSeconds = 0;
      container.latencyMs = 0;
      container.latencyHistory = [...container.latencyHistory.slice(-9), 0];
    } else {
      container.cpuPercent = 88.4;
      container.latencyMs = 940;
      container.latencyHistory = [...container.latencyHistory.slice(-9), 940];
    }

    this.previousStatusByContainer.set(container.id, newStatus);

    const logLines: string[] = [];
    for (const entry of crashLogs) {
      const safeLine = redactSecrets(entry.message);
      logLines.push(`[${entry.level}] ${safeLine}`);
      this.state.logs.unshift({
        id: makeId('log'),
        containerId: container.id,
        containerName: container.name,
        timestamp: nowIso,
        level: entry.level,
        stream: 'stderr',
        message: safeLine,
      });
    }

    const incident: IncidentRecord = {
      id: makeId('inc'),
      containerId: container.id,
      containerName: container.name,
      startedAt: nowIso,
      status: 'active',
      severity: diagnosis.severity,
      exitCode,
      category: diagnosis.category,
      rootCause: diagnosis.rootCause,
      recommendedAction: diagnosis.recommendedAction,
      logExcerpt: logLines,
      notifiedChannels: [],
      recoveryNotified: false,
    };

    const stateChanged = prevStatus !== newStatus;
    const shouldNotify =
      stateChanged &&
      ((newStatus === 'stopped' && this.state.alertConfig.notifyOnStop) ||
        (newStatus === 'degraded' && this.state.alertConfig.notifyOnUnhealthy));

    const cooldownReady = shouldDispatchAlert(
      this.state.lastAlertByContainer[container.id],
      this.state.alertConfig.cooldownMinutes
    );

    if (shouldNotify && cooldownReady) {
      const channelsSent = await this.dispatchIncidentAlerts(incident, container, logLines);
      incident.notifiedChannels = channelsSent;
      this.state.lastAlertByContainer[container.id] = nowIso;
    }

    this.state.incidents.unshift(incident);
    this.state.telemetry24h = updateLatestTelemetryPoint(
      this.state.telemetry24h,
      this.state.containers,
      this.state.probe.latencyMs
    );
    this.lastUpdatedAt = nowIso;
    await this.saveState();
    return this.getSnapshot();
  }

  public async restartContainer(containerId: string): Promise<MonitorSnapshot> {
    if (!this.config.demoMode) {
      await this.dockerClient.restartContainer(containerId);
      await this.refreshRealDockerContainers();
      return this.getSnapshot();
    }

    const container = this.state.containers.find((c) => c.id === containerId);
    if (!container) {
      throw new Error('Container não encontrado.');
    }

    const nowIso = new Date().toISOString();

    container.status = 'healthy';
    container.exitCode = 0;
    container.oomKilled = false;
    container.restartCount += 1;
    container.uptimeSeconds = 12;
    container.cpuPercent = Number((6 + Math.random() * 10).toFixed(1));
    container.memoryMb = Math.round(container.memoryLimitMb * 0.28);
    container.latencyMs = Math.round(14 + Math.random() * 24);
    container.latencyHistory = [...container.latencyHistory.slice(-9), container.latencyMs];
    container.lastCheckedAt = nowIso;
    container.interruptionCategory = undefined;
    container.interruptionSummary = undefined;
    container.recommendedAction = undefined;
    this.previousStatusByContainer.set(container.id, 'healthy');

    this.state.logs.unshift({
      id: makeId('log'),
      containerId: container.id,
      containerName: container.name,
      timestamp: nowIso,
      level: 'INFO',
      stream: 'stdout',
      message: `Container ${container.name} reiniciado com sucesso (restart #${container.restartCount}). Healthcheck validado em ${container.latencyMs}ms.`,
    });

    await this.resolveActiveIncidentsAndNotifyOnce(container, nowIso);

    this.state.telemetry24h = updateLatestTelemetryPoint(
      this.state.telemetry24h,
      this.state.containers,
      this.state.probe.latencyMs
    );

    this.lastUpdatedAt = nowIso;
    await this.saveState();
    return this.getSnapshot();
  }

  public async addContainer(input: {
    name: string;
    role: string;
    image: string;
    ports: string;
    healthCommand: string;
    healthEndpoint?: string;
    memoryLimitMb?: number;
  }): Promise<MonitorSnapshot> {
    const cleanName = input.name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!cleanName || cleanName.length < 3) {
      throw new Error('Informe um nome de container válido (mínimo 3 caracteres alfanuméricos).');
    }
    if (this.state.containers.some((c) => c.name === cleanName)) {
      throw new Error(`Já existe um container monitorado chamado "${cleanName}".`);
    }
    if (!input.image.trim()) {
      throw new Error('Informe a imagem Docker (ex.: ghcr.io/change-app/service:latest).');
    }

    let normalizedEndpoint: string | undefined;
    if (input.healthEndpoint && input.healthEndpoint.trim().length > 0) {
      const urlCheck = validateProbeUrlWithAllowlist(
        input.healthEndpoint,
        this.config.probeAllowedHosts
      );
      if (!urlCheck.valid) {
        throw new Error(urlCheck.error || 'URL de healthcheck inválida.');
      }
      normalizedEndpoint = urlCheck.normalizedUrl;
    }

    const nowIso = new Date().toISOString();
    const limitMb = Math.min(16384, Math.max(128, Number(input.memoryLimitMb || 512)));
    const newContainer: ContainerService = {
      id: cleanName,
      name: cleanName,
      role: input.role.trim() || 'Serviço Docker Customizado',
      image: input.image.trim(),
      ports: input.ports.trim() || 'interno',
      network: 'change_app_net',
      healthCommand: input.healthCommand.trim() || 'curl -fsS http://127.0.0.1:8080/health || exit 1',
      healthEndpoint: normalizedEndpoint,
      status: 'healthy',
      exitCode: 0,
      restartCount: 0,
      uptimeSeconds: 60,
      cpuPercent: 3.4,
      memoryMb: Math.round(limitMb * 0.22),
      memoryLimitMb: limitMb,
      latencyMs: 18,
      latencyHistory: [18, 19, 17, 18, 18],
      lastCheckedAt: nowIso,
    };

    this.state.containers.push(newContainer);
    this.previousStatusByContainer.set(newContainer.id, 'healthy');
    this.state.logs.unshift({
      id: makeId('log'),
      containerId: newContainer.id,
      containerName: newContainer.name,
      timestamp: nowIso,
      level: 'INFO',
      stream: 'stdout',
      message: `Serviço ${newContainer.name} (${newContainer.image}) registrado no monitoramento contínuo da Chang’e.`,
    });

    this.lastUpdatedAt = nowIso;
    await this.saveState();
    return this.getSnapshot();
  }

  public async removeContainer(containerId: string): Promise<MonitorSnapshot> {
    if (containerId === 'change-edge-gateway') {
      throw new Error('O gateway principal de chang-e.app não pode ser removido.');
    }
    const index = this.state.containers.findIndex((c) => c.id === containerId);
    if (index === -1) {
      throw new Error('Container não encontrado.');
    }
    const [removed] = this.state.containers.splice(index, 1);
    this.previousStatusByContainer.delete(removed.id);
    this.state.logs.unshift({
      id: makeId('log'),
      containerId: removed.id,
      containerName: removed.name,
      timestamp: new Date().toISOString(),
      level: 'WARN',
      stream: 'stdout',
      message: `Serviço ${removed.name} removido da lista de monitoramento.`,
    });
    this.lastUpdatedAt = new Date().toISOString();
    await this.saveState();
    return this.getSnapshot();
  }

  public async updateAlertConfig(patch: Partial<AlertConfiguration>): Promise<MonitorSnapshot> {
    const nextConfig: AlertConfiguration = {
      ...this.state.alertConfig,
      ...patch,
    };

    if (nextConfig.emailEnabled) {
      const check = validateEmailList(nextConfig.emailRecipients);
      if (!check.valid) {
        throw new Error(check.error || 'Lista de e-mails inválida.');
      }
      nextConfig.emailRecipients = check.cleaned;
    }

    if (patch.cooldownMinutes !== undefined) {
      const cooldownCheck = validateCooldownMinutes(patch.cooldownMinutes);
      if (!cooldownCheck.valid) {
        throw new Error(cooldownCheck.error);
      }
      nextConfig.cooldownMinutes = cooldownCheck.value!;
    }

    nextConfig.highLatencyThresholdMs = Math.min(
      10_000,
      Math.max(50, Number(nextConfig.highLatencyThresholdMs || 600))
    );
    nextConfig.probeIntervalSeconds = Math.min(
      300,
      Math.max(10, Number(nextConfig.probeIntervalSeconds || 30))
    );
    nextConfig.emailSubjectPrefix =
      (nextConfig.emailSubjectPrefix || '[Chang’e Health]').trim().slice(0, 48);
    nextConfig.telegramChatLabel =
      (nextConfig.telegramChatLabel || '@change_ops_alerts').trim().slice(0, 64);

    this.state.alertConfig = nextConfig;
    this.lastUpdatedAt = new Date().toISOString();
    await this.saveState();
    return this.getSnapshot();
  }

  public async sendTestNotification(channel: AlertChannel): Promise<{
    snapshot: MonitorSnapshot;
    dispatch: AlertDispatchRecord;
  }> {
    const nowIso = new Date().toISOString();
    const subject = `${this.state.alertConfig.emailSubjectPrefix} Teste de Conectividade (${channel === 'email' ? 'E-mail' : 'Telegram'})`;
    const body = [
      `[Chang'e Health] TESTE DE NOTIFICAÇÃO`,
      `Aplicação monitorada: ${this.config.probeUrl}`,
      `Status atual da stack: ${this.state.containers.filter((c) => c.status === 'healthy').length}/${this.state.containers.length} containers saudáveis`,
      `Canal testado: ${channel === 'email' ? 'SMTP E-mail' : 'Telegram Bot API'}`,
      `Horário: ${nowIso}`,
    ].join('\n');

    let result;
    let recipient = '';

    if (channel === 'email') {
      const emailValidation = validateEmailList(this.state.alertConfig.emailRecipients);
      if (!emailValidation.valid) {
        throw new Error(emailValidation.error || 'Informe um destinatário de e-mail válido.');
      }
      recipient = emailValidation.cleaned.join(', ');
      result = await sendEmailAlert({
        recipients: emailValidation.cleaned,
        subject,
        text: body,
      });
    } else {
      recipient = this.state.alertConfig.telegramChatLabel || '@change_ops_alerts';
      result = await sendTelegramAlert({ message: body });
    }

    const dispatch: AlertDispatchRecord = {
      id: makeId('disp'),
      containerName: 'change-edge-gateway',
      channel,
      recipient,
      subject,
      messagePreview: redactSecrets(body),
      deliveryStatus: result.deliveryStatus,
      deliveryNote: redactSecrets(result.deliveryNote),
      dispatchedAt: nowIso,
      latencyMs: result.latencyMs,
      isTest: true,
    };

    this.state.alertDispatches.unshift(dispatch);
    this.lastUpdatedAt = nowIso;
    await this.saveState();

    return {
      snapshot: this.getSnapshot(),
      dispatch,
    };
  }

  private async dispatchIncidentAlerts(
    incident: IncidentRecord,
    container: ContainerService,
    logLines: string[]
  ): Promise<AlertChannel[]> {
    const channelsSent: AlertChannel[] = [];
    const nowIso = new Date().toISOString();
    const safeLines = logLines.map((line) => redactSecrets(line));

    if (this.state.alertConfig.emailEnabled && this.state.alertConfig.emailRecipients.length > 0) {
      const formatted = formatEmailAlert(
        incident,
        container,
        safeLines,
        this.state.alertConfig.emailSubjectPrefix
      );
      const emailResult = await sendEmailAlert({
        recipients: this.state.alertConfig.emailRecipients,
        subject: formatted.subject,
        text: formatted.text,
      });

      this.state.alertDispatches.unshift({
        id: makeId('disp'),
        incidentId: incident.id,
        containerName: container.name,
        channel: 'email',
        recipient: this.state.alertConfig.emailRecipients.join(', '),
        subject: formatted.subject,
        messagePreview: redactSecrets(formatted.text),
        deliveryStatus: emailResult.deliveryStatus,
        deliveryNote: redactSecrets(emailResult.deliveryNote),
        dispatchedAt: nowIso,
        latencyMs: emailResult.latencyMs,
        isTest: false,
      });
      channelsSent.push('email');
    }

    if (this.state.alertConfig.telegramEnabled) {
      const telegramText = formatTelegramAlert(incident, container, safeLines);
      const tgResult = await sendTelegramAlert({ message: telegramText });

      this.state.alertDispatches.unshift({
        id: makeId('disp'),
        incidentId: incident.id,
        containerName: container.name,
        channel: 'telegram',
        recipient: this.state.alertConfig.telegramChatLabel || '@change_ops_alerts',
        subject: `${this.state.alertConfig.emailSubjectPrefix} ${container.name} — ${incident.category}`,
        messagePreview: redactSecrets(telegramText),
        deliveryStatus: tgResult.deliveryStatus,
        deliveryNote: redactSecrets(tgResult.deliveryNote),
        dispatchedAt: nowIso,
        latencyMs: tgResult.latencyMs,
        isTest: false,
      });
      channelsSent.push('telegram');
    }

    return channelsSent;
  }
}

function parseAllowedHosts(probeUrl: string, rawList?: string): string[] {
  const fromEnv = (rawList || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return Array.from(new Set(fromEnv));

  try {
    const parsed = new URL(probeUrl);
    return [parsed.hostname.toLowerCase()];
  } catch {
    return ['chang-e.app'];
  }
}

export function createHealthStoreFromEnv(): HealthMonitorStore {
  const demoMode = process.env.DEMO_MODE === 'true';
  const allowActions = process.env.ALLOW_ACTIONS === 'true';
  const authConfigured = Boolean(process.env.ADMIN_TOKEN?.trim());
  const probeUrl =
    process.env.PROBE_URL?.trim() ||
    process.env.TARGET_APP_URL?.trim() ||
    'https://chang-e.app/';
  const probeAllowedHosts = parseAllowedHosts(probeUrl, process.env.PROBE_ALLOWED_HOSTS);

  return new HealthMonitorStore({
    demoMode,
    allowActions,
    authConfigured,
    dataDir: process.env.DATA_DIR?.trim() || './data',
    probeUrl,
    probeAllowedHosts,
    dockerHost: process.env.DOCKER_HOST?.trim() || undefined,
    dockerSocketPath: process.env.DOCKER_SOCKET_PATH?.trim() || '/var/run/docker.sock',
  });
}
