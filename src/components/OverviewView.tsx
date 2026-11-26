import { useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  RotateCcw,
  Terminal,
  XCircle,
  Zap,
} from 'lucide-react';
import { formatUptime } from '../lib/healthLogic';
import type { ContainerService, FailureScenario, MonitorSnapshot } from '../types/health';
import { LatencySparkline, OrbitalHealthRing } from './OrbitalTelemetry';
import { TelemetryChart24h } from './TelemetryChart24h';

const LUNAR_HERO_IMAGE = '/src/assets/images/change_lunar_horizon_1795382223636.jpg';

interface OverviewViewProps {
  snapshot: MonitorSnapshot;
  busyContainerId: string | null;
  lastPollAt: string | null;
  isStale: boolean;
  onInspectContainer: (containerId: string) => void;
  onSimulateFailure: (containerId: string, scenario: FailureScenario) => void;
  onRestartContainer: (containerId: string) => void;
  onOpenLogs: () => void;
  onOpenAlerts: () => void;
}

function formatShortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

export function StatusInline({ status }: { status: ContainerService['status'] }) {
  if (status === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#34D399]">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Saudável</span>
      </span>
    );
  }
  if (status === 'degraded' || status === 'restarting') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#FBBF24]">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{status === 'restarting' ? 'Reiniciando' : 'Degradado'}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#F87171]">
      <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Parado</span>
    </span>
  );
}

export function OverviewView({
  snapshot,
  busyContainerId,
  lastPollAt,
  isStale,
  onInspectContainer,
  onSimulateFailure,
  onRestartContainer,
  onOpenLogs,
  onOpenAlerts,
}: OverviewViewProps) {
  const [heroImageError, setHeroImageError] = useState(false);
  const { summary, probe, containers, incidents, capabilities } = snapshot;

  const activeIncidents = incidents.filter((inc) => inc.status === 'active');
  const displayCheckedAt = lastPollAt || snapshot.lastUpdatedAt || probe.checkedAt;
  const dockerModeLabel =
    capabilities.dockerMode === 'docker_live'
      ? 'Docker Conectado'
      : capabilities.dockerMode === 'demo'
      ? 'Stack Docker Simulada (DEMO)'
      : 'Docker Indisponível';

  return (
    <div className="space-y-8">
      {/* Lunar Orbital Hero Panel */}
      <section className="relative overflow-hidden rounded-xl border border-[#20232B] bg-[#0D0F14]">
        {!heroImageError ? (
          <img
            src={LUNAR_HERO_IMAGE}
            alt="Horizonte lunar Chang’e com anéis orbitais em violeta e azul"
            referrerPolicy="no-referrer"
            onError={() => setHeroImageError(true)}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover object-right opacity-55"
          />
        ) : (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_50%,rgba(128,87,255,0.22),rgba(92,168,255,0.08)_38%,transparent_72%)]"
          />
        )}

        {/* Measured readability scrim */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#08090B] via-[#08090B]/88 to-[#08090B]/30"
        />

        <div className="relative z-10 flex flex-col justify-between gap-8 p-6 sm:p-8 lg:flex-row lg:items-center">
          <div className="max-w-2xl space-y-4">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#AAB2C0]">
              <span className="font-mono text-[#A5A4FF]">{probe.targetUrl}</span>
              <span aria-hidden="true" className="text-[#747E91]">·</span>
              <span>{dockerModeLabel}</span>
              <span aria-hidden="true" className="text-[#747E91]">·</span>
              <span data-testid="last-poll-time" className="font-mono tabular-nums">
                Última leitura {formatShortTime(displayCheckedAt)}
              </span>
              {isStale && (
                <>
                  <span aria-hidden="true" className="text-[#747E91]">·</span>
                  <span
                    data-testid="stale-indicator"
                    className="font-medium text-[#FBBF24]"
                  >
                    dados desatualizados
                  </span>
                </>
              )}
            </div>

            <h1 className="text-balance text-2xl font-semibold tracking-tight text-[#F5F5F7] sm:text-3xl">
              Monitoramento de saúde e disponibilidade{' '}
              <span className="change-gradient-text">Chang’e</span>
            </h1>

            <p className="max-w-xl text-sm leading-relaxed text-[#AAB2C0]">
              Verificação contínua dos containers Docker e do endpoint público em produção,
              com diagnóstico automático de interrupções e disparo imediato via E-mail e Telegram.
            </p>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1 text-xs text-[#AAB2C0]">
              <div>
                <span className="text-[#747E91]">Resposta HTTP: </span>
                <span className="font-mono font-medium text-[#F5F5F7] tabular-nums">
                  {probe.reachable ? `${probe.httpStatus ?? 200} OK` : 'Sem resposta'}
                </span>
              </div>
              <div>
                <span className="text-[#747E91]">TLS: </span>
                <span
                  className={`font-mono font-medium tabular-nums ${
                    probe.tlsExpiringSoon ? 'text-[#FBBF24]' : 'text-[#F5F5F7]'
                  }`}
                >
                  {probe.tlsValid
                    ? probe.tlsDaysRemaining !== null && probe.tlsDaysRemaining !== undefined
                      ? probe.tlsExpiringSoon
                        ? `Expira em ${probe.tlsDaysRemaining}d`
                        : `Válido (${probe.tlsDaysRemaining}d)`
                      : 'Válido'
                    : 'Verificar'}
                </span>
              </div>
              <div>
                <span className="text-[#747E91]">Alertas ativos: </span>
                <span className="font-medium text-[#F5F5F7]">
                  E-mail e Telegram
                </span>
              </div>
              <a
                href={probe.targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-[#5CA8FF] transition-colors hover:text-[#A5A4FF]"
              >
                <span>Abrir chang-e.app</span>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="flex items-center gap-6 self-start lg:self-center">
            <OrbitalHealthRing
              healthyCount={summary.healthyCount}
              totalCount={summary.totalCount}
              percentage={capabilities.dockerUnavailable ? 0 : summary.healthPercentage}
              overallStatus={capabilities.dockerUnavailable ? 'outage' : summary.overallStatus}
            />
          </div>
        </div>
      </section>

      {/* Docker Unavailable Banner when DEMO_MODE=false and Docker is unreachable */}
      {capabilities.dockerUnavailable && (
        <section
          role="alert"
          data-testid="docker-unavailable-banner"
          className="rounded-xl border border-[#F87171]/40 bg-[#190F14] px-6 py-4 space-y-1"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-[#F87171]">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Docker indisponível</span>
          </div>
          <p className="text-xs leading-relaxed text-[#AAB2C0]">
            {capabilities.dockerError ||
              'Não foi possível acessar o daemon Docker (DOCKER_HOST ou /var/run/docker.sock). Nenhum dado simulado será exibido fora do modo DEMO.'}
          </p>
        </section>
      )}

      {/* Active Incident Alert Banner (visible immediately when any container stops or degrades) */}
      {activeIncidents.length > 0 && (
        <section
          role="alert"
          className="flex flex-col justify-between gap-4 rounded-xl border border-[#F87171]/35 bg-[#190F14] px-6 py-4 sm:flex-row sm:items-center"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#F87171]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {activeIncidents.length === 1
                  ? `Interrupção ativa em ${activeIncidents[0].containerName}`
                  : `${activeIncidents.length} interrupções ativas na stack Docker`}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-[#AAB2C0]">
              {activeIncidents[0].category} — {activeIncidents[0].rootCause}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onOpenLogs}
              className="rounded-lg border border-[#20232B] bg-[#0D0F14] px-3.5 py-2 text-xs font-medium text-[#F5F5F7] transition-colors hover:border-[#8057FF]/60 whitespace-nowrap"
            >
              Ver logs da falha
            </button>
            {capabilities.actionsEnabled && (
              <button
                type="button"
                onClick={() => onRestartContainer(activeIncidents[0].containerId)}
                disabled={busyContainerId === activeIncidents[0].containerId}
                className="rounded-lg bg-[#8057FF] px-3.5 py-2 text-xs font-medium text-[#F5F5F7] transition-colors hover:bg-[#936EFF] disabled:opacity-60 whitespace-nowrap"
              >
                Reiniciar container
              </button>
            )}
          </div>
        </section>
      )}

      {/* 4-Column Flat KPI Strip */}
      <section
        aria-label="Indicadores principais da infraestrutura"
        className="grid grid-cols-1 divide-y divide-[#20232B] rounded-xl border border-[#20232B] bg-[#0D0F14] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x"
      >
        <div className="p-5">
          <p className="text-xs text-[#747E91]">Containers Saudáveis</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span
              data-testid="kpi-healthy-count"
              className="font-mono text-2xl font-semibold text-[#F5F5F7] tabular-nums"
            >
              {summary.healthyCount} / {summary.totalCount}
            </span>
            <span className="font-mono text-xs text-[#A5A4FF] tabular-nums">
              {summary.healthPercentage.toFixed(0)}%
            </span>
          </div>
          <p className="mt-1.5 text-xs text-[#AAB2C0]">
            {summary.stoppedCount > 0
              ? `${summary.stoppedCount} parado(s) exigindo atenção`
              : summary.degradedCount > 0
              ? `${summary.degradedCount} em estado degradado`
              : 'Todos os serviços respondendo'}
          </p>
        </div>

        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-[#747E91]">Latência chang-e.app</p>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span
                  data-testid="kpi-probe-latency"
                  className="font-mono text-2xl font-semibold text-[#F5F5F7] tabular-nums"
                >
                  {probe.latencyMs}
                </span>
                <span className="font-mono text-xs text-[#747E91]">ms</span>
              </div>
            </div>
            <div className="mt-4 h-7 w-24 shrink-0">
              <LatencySparkline
                values={probe.history.map((h) => h.latencyMs)}
                width={96}
                height={28}
                accent={probe.reachable ? 'purple' : 'error'}
              />
            </div>
          </div>
          <p className="mt-1.5 text-xs text-[#AAB2C0]">
            Probe HTTPS ao vivo · HTTP {probe.httpStatus ?? '—'}
          </p>
        </div>

        <div className="p-5">
          <p className="text-xs text-[#747E91]">Memória da Stack</p>
          {(() => {
            const totalUsed = containers.reduce((acc, c) => acc + c.memoryMb, 0);
            const totalCap = containers.reduce((acc, c) => acc + c.memoryLimitMb, 0);
            const ratio = Math.round((totalUsed / Math.max(1, totalCap)) * 100);
            return (
              <>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-semibold text-[#F5F5F7] tabular-nums">
                    {(totalUsed / 1024).toFixed(2)}
                  </span>
                  <span className="font-mono text-xs text-[#747E91] tabular-nums">
                    / {(totalCap / 1024).toFixed(1)} GB
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-[#AAB2C0]">
                  {ratio}% alocado · latência média interna {summary.averageLatencyMs}ms
                </p>
              </>
            );
          })()}
        </div>

        <div className="p-5">
          <p className="text-xs text-[#747E91]">Alertas Disparados</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span
              data-testid="kpi-alerts-count"
              className="font-mono text-2xl font-semibold text-[#F5F5F7] tabular-nums"
            >
              {summary.alertsSent24h}
            </span>
            <button
              type="button"
              onClick={onOpenAlerts}
              className="text-xs font-medium text-[#5CA8FF] hover:text-[#A5A4FF]"
            >
              Ver histórico
            </button>
          </div>
          <p className="mt-1.5 text-xs text-[#AAB2C0]">
            Canais automáticos: E-mail e Telegram
          </p>
        </div>
      </section>

      {/* 24-Hour Latency & Container Memory Visualization */}
      <TelemetryChart24h data={snapshot.telemetry24h} probeUrl={probe.targetUrl} />

      {/* Main Stack Table + Recent Diagnostics Split */}
      <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
        {/* Docker Stack Status Table */}
        <section className="xl:col-span-8 rounded-xl border border-[#20232B] bg-[#0D0F14]">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#20232B] px-6 py-4">
            <div>
              <h2 className="text-base font-semibold text-[#F5F5F7]">
                Saúde dos Containers Docker
              </h2>
              <p className="mt-0.5 text-xs text-[#747E91]">
                Monitoramento em tempo real da stack chang-e.app com diagnóstico de saída
              </p>
            </div>
            <span className="font-mono text-xs text-[#AAB2C0] tabular-nums">
              {containers.length} serviços monitorados
            </span>
          </div>

          {capabilities.dockerUnavailable ? (
            <div className="px-6 py-10 text-center space-y-2">
              <p className="text-sm font-medium text-[#F87171]">Docker indisponível</p>
              <p className="text-xs text-[#747E91]">
                Verifique a conectividade com o socket ou docker-socket-proxy configurado em DOCKER_HOST.
              </p>
            </div>
          ) : containers.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-[#747E91]">
              Nenhum container encontrado no host Docker conectado.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#20232B] text-xs font-medium text-[#747E91]">
                    <th className="px-5 py-3 font-medium">Container</th>
                    <th className="px-3 py-3 font-medium">Estado</th>
                    <th className="px-3 py-3 font-medium text-right">CPU / RAM</th>
                    <th className="px-3 py-3 font-medium text-right">Latência</th>
                    <th className="px-3 py-3 font-medium text-right">Uptime</th>
                    <th className="px-5 py-3 font-medium text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#20232B]/70 text-sm">
                  {containers.map((container) => {
                    const isBusy = busyContainerId === container.id;
                    const memPct = Math.round(
                      (container.memoryMb / Math.max(1, container.memoryLimitMb)) * 100
                    );

                    return (
                      <tr
                        key={container.id}
                        className="transition-colors duration-150 hover:bg-[#131620]"
                      >
                        <td className="px-5 py-3.5 max-w-[215px]">
                          <button
                            type="button"
                            onClick={() => onInspectContainer(container.id)}
                            className="w-full text-left group focus-visible:outline-2 focus-visible:outline-[#8057FF]"
                          >
                            <div className="truncate font-mono text-[13px] font-medium text-[#F5F5F7] group-hover:text-[#A477FF] transition-colors">
                              {container.name}
                            </div>
                            <div
                              title={`${container.role} · ${container.ports}`}
                              className="mt-0.5 truncate text-xs text-[#747E91]"
                            >
                              {container.role}
                            </div>
                          </button>
                        </td>

                        <td className="px-3 py-3.5 whitespace-nowrap">
                          <StatusInline status={container.status} />
                          {container.status !== 'healthy' && (
                            <div className="mt-0.5 font-mono text-[11px] text-[#747E91]">
                              Exit {container.exitCode}
                            </div>
                          )}
                        </td>

                        <td className="px-3 py-3.5 text-right font-mono text-xs text-[#AAB2C0] tabular-nums whitespace-nowrap">
                          <div>{container.cpuPercent.toFixed(1)}%</div>
                          <div className="text-[#747E91]">
                            {container.memoryMb}MB ({memPct}%)
                          </div>
                        </td>

                        <td className="px-3 py-3.5 text-right font-mono text-xs text-[#F5F5F7] tabular-nums whitespace-nowrap">
                          {container.latencyMs > 0 ? `${container.latencyMs} ms` : '—'}
                        </td>

                        <td className="px-3 py-3.5 text-right font-mono text-xs text-[#AAB2C0] tabular-nums whitespace-nowrap">
                          {container.status === 'stopped'
                            ? 'Parado'
                            : formatUptime(container.uptimeSeconds)}
                        </td>

                        <td className="px-5 py-3.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onInspectContainer(container.id)}
                              aria-label={`Inspecionar logs de ${container.name}`}
                              className="inline-flex items-center gap-1 rounded-md border border-[#20232B] px-2.5 py-1.5 text-xs font-medium text-[#AAB2C0] transition-colors hover:border-[#8057FF]/60 hover:text-[#F5F5F7]"
                            >
                              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Logs</span>
                            </button>

                            {container.status === 'healthy' && capabilities.demoMode && (
                              <button
                                type="button"
                                onClick={() => onSimulateFailure(container.id, 'oom')}
                                disabled={isBusy}
                                aria-label={`Testar alerta de falha em ${container.name}`}
                                className="inline-flex items-center gap-1 rounded-md border border-[#20232B] px-2.5 py-1.5 text-xs font-medium text-[#AAB2C0] transition-colors hover:border-[#F87171]/60 hover:text-[#F87171] disabled:opacity-50"
                              >
                                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Testar falha</span>
                              </button>
                            )}

                            {container.status !== 'healthy' && capabilities.actionsEnabled && (
                              <button
                                type="button"
                                onClick={() => onRestartContainer(container.id)}
                                disabled={isBusy}
                                aria-label={`Reiniciar ${container.name}`}
                                className="inline-flex items-center gap-1 rounded-md bg-[#8057FF] px-2.5 py-1.5 text-xs font-medium text-[#F5F5F7] transition-colors hover:bg-[#936EFF] disabled:opacity-50"
                              >
                                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Reiniciar</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent Interruptions & Alert Confirmations */}
        <section className="xl:col-span-4 rounded-xl border border-[#20232B] bg-[#0D0F14] flex flex-col">
          <div className="flex items-center justify-between border-b border-[#20232B] px-6 py-4">
            <div>
              <h2 className="text-base font-semibold text-[#F5F5F7]">
                Últimas Interrupções
              </h2>
              <p className="mt-0.5 text-xs text-[#747E91]">
                Diagnóstico de causa raiz e notificações
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenLogs}
              className="text-xs font-medium text-[#5CA8FF] hover:text-[#A5A4FF]"
            >
              Ver todos
            </button>
          </div>

          <div className="divide-y divide-[#20232B]/70 flex-1">
            {incidents.length === 0 ? (
              <div className="p-6 text-center text-sm text-[#747E91]">
                Nenhuma interrupção registrada na janela atual.
              </div>
            ) : (
              incidents.slice(0, 4).map((inc) => (
                <div key={inc.id} className="space-y-2 px-6 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-medium text-[#F5F5F7]">
                      {inc.containerName}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        inc.status === 'active' ? 'text-[#F87171]' : 'text-[#34D399]'
                      }`}
                    >
                      {inc.status === 'active' ? 'Ativo' : 'Resolvido'}
                    </span>
                  </div>

                  <p className="text-xs font-medium text-[#A5A4FF]">{inc.category}</p>
                  <p className="text-xs leading-relaxed text-[#AAB2C0]">
                    {inc.rootCause}
                  </p>

                  <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-[#747E91] font-mono tabular-nums">
                    <span>{formatShortTime(inc.startedAt)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Alertas:{' '}
                      {inc.notifiedChannels.length > 0
                        ? inc.notifiedChannels
                            .map((ch) => (ch === 'email' ? 'E-mail' : 'Telegram'))
                            .join(' + ')
                        : 'Aguardando'}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
