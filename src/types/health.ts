export type ContainerStatus = 'healthy' | 'degraded' | 'stopped' | 'restarting';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export type FailureScenario = 'oom' | 'crash' | 'timeout' | 'db_pool';

export interface ContainerLogEntry {
  id: string;
  containerId: string;
  containerName: string;
  timestamp: string;
  level: LogLevel;
  stream: 'stdout' | 'stderr';
  message: string;
}

export interface ContainerService {
  id: string;
  name: string;
  role: string;
  image: string;
  ports: string;
  network: string;
  healthCommand: string;
  healthEndpoint?: string;
  status: ContainerStatus;
  exitCode: number;
  oomKilled?: boolean;
  restartCount: number;
  uptimeSeconds: number;
  cpuPercent: number;
  memoryMb: number;
  memoryLimitMb: number;
  latencyMs: number;
  latencyHistory: number[];
  lastCheckedAt: string;
  interruptionSummary?: string;
  interruptionCategory?: string;
  recommendedAction?: string;
}

export interface LiveEndpointProbe {
  targetUrl: string;
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number;
  tlsValid: boolean;
  tlsExpiresAt?: string | null;
  tlsDaysRemaining?: number | null;
  tlsExpiringSoon?: boolean;
  serverHeader: string;
  checkedAt: string;
  errorMessage?: string;
  history: Array<{
    checkedAt: string;
    latencyMs: number;
    reachable: boolean;
    httpStatus: number | null;
  }>;
}

export interface IncidentRecord {
  id: string;
  containerId: string;
  containerName: string;
  startedAt: string;
  resolvedAt?: string;
  status: 'active' | 'resolved';
  severity: 'critical' | 'warning';
  exitCode: number;
  category: string;
  rootCause: string;
  recommendedAction: string;
  logExcerpt: string[];
  notifiedChannels: Array<'email' | 'telegram'>;
  recoveryNotified?: boolean;
}

export type AlertChannel = 'email' | 'telegram';

export type AlertDeliveryStatus = 'sent_live' | 'queued_preview' | 'failed';

export interface AlertDispatchRecord {
  id: string;
  incidentId?: string;
  containerName: string;
  channel: AlertChannel;
  recipient: string;
  subject: string;
  messagePreview: string;
  deliveryStatus: AlertDeliveryStatus;
  deliveryNote: string;
  dispatchedAt: string;
  latencyMs: number;
  isTest: boolean;
}

export interface AlertConfiguration {
  emailEnabled: boolean;
  emailRecipients: string[];
  emailSubjectPrefix: string;
  telegramEnabled: boolean;
  telegramChatLabel: string;
  notifyOnStop: boolean;
  notifyOnUnhealthy: boolean;
  notifyOnHighLatency: boolean;
  notifyOnRecovery: boolean;
  highLatencyThresholdMs: number;
  cooldownMinutes: number;
  probeIntervalSeconds: number;
}

export interface ServerEnvironmentCapabilities {
  demoMode: boolean;
  actionsEnabled: boolean;
  authRequired: boolean;
  dockerSocketConnected: boolean;
  dockerUnavailable?: boolean;
  dockerError?: string;
  dockerMode: 'docker_live' | 'demo' | 'unavailable';
  smtpConfigured: boolean;
  telegramConfigured: boolean;
  targetAppUrl: string;
  probeAllowedHosts: string[];
}

export interface StackSummary {
  totalCount: number;
  healthyCount: number;
  degradedCount: number;
  stoppedCount: number;
  healthPercentage: number;
  averageLatencyMs: number;
  overallStatus: 'operational' | 'degraded' | 'outage';
  alertsSent24h: number;
}

export interface TelemetryPoint24h {
  timestamp: string;
  hourLabel: string;
  latencyMs: number;
  memoryUsedMb: number;
  memoryLimitMb: number;
  memoryPercent: number;
}

export interface MonitorSnapshot {
  summary: StackSummary;
  probe: LiveEndpointProbe;
  containers: ContainerService[];
  incidents: IncidentRecord[];
  logs: ContainerLogEntry[];
  alertConfig: AlertConfiguration;
  alertDispatches: AlertDispatchRecord[];
  capabilities: ServerEnvironmentCapabilities;
  telemetry24h: TelemetryPoint24h[];
  lastUpdatedAt: string;
}
