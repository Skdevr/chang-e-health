import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { formatUptime } from '../lib/healthLogic';
import type {
  ContainerLogEntry,
  ContainerService,
  ContainerStatus,
  FailureScenario,
} from '../types/health';
import { LatencySparkline } from './OrbitalTelemetry';
import { StatusInline } from './OverviewView';

interface ContainersViewProps {
  containers: ContainerService[];
  logs: ContainerLogEntry[];
  selectedContainerId: string;
  busyContainerId: string | null;
  demoMode: boolean;
  actionsEnabled: boolean;
  dockerUnavailable: boolean;
  onSelectContainer: (id: string) => void;
  onSimulateFailure: (id: string, scenario: FailureScenario) => void;
  onRestartContainer: (id: string) => void;
  onAddContainer: (payload: {
    name: string;
    role: string;
    image: string;
    ports: string;
    healthCommand: string;
    healthEndpoint?: string;
    memoryLimitMb: number;
  }) => Promise<void>;
  onRemoveContainer: (id: string) => Promise<void>;
  onViewFullLogs: (containerId: string) => void;
}

const SCENARIO_OPTIONS: Array<{ value: FailureScenario; label: string }> = [
  { value: 'oom', label: 'OOMKilled (Exit 137)' },
  { value: 'crash', label: 'Exceção Fatal (Exit 1)' },
  { value: 'timeout', label: 'Healthcheck Timeout (503)' },
  { value: 'db_pool', label: 'Falha de Conexão DB' },
];

export function ContainersView({
  containers,
  logs,
  selectedContainerId,
  busyContainerId,
  demoMode,
  actionsEnabled,
  dockerUnavailable,
  onSelectContainer,
  onSimulateFailure,
  onRestartContainer,
  onAddContainer,
  onRemoveContainer,
  onViewFullLogs,
}: ContainersViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ContainerStatus>('all');
  const [selectedScenario, setSelectedScenario] = useState<FailureScenario>('oom');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Add service form state
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState('');
  const [formImage, setFormImage] = useState('');
  const [formPorts, setFormPorts] = useState('');
  const [formHealthCmd, setFormHealthCmd] = useState('curl -fsS http://127.0.0.1:8080/health || exit 1');
  const [formEndpoint, setFormEndpoint] = useState('');
  const [formMemoryLimit, setFormMemoryLimit] = useState('512');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const filteredContainers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return containers.filter((c) => {
      const matchesStatus = statusFilter === 'all' || c.status === statusFilter;
      const matchesText =
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.role.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q);
      return matchesStatus && matchesText;
    });
  }, [containers, searchQuery, statusFilter]);

  const activeContainer =
    containers.find((c) => c.id === selectedContainerId) ||
    filteredContainers[0] ||
    containers[0];

  const containerLogs = useMemo(() => {
    if (!activeContainer) return [];
    return logs.filter((entry) => entry.containerId === activeContainer.id).slice(0, 8);
  }, [logs, activeContainer]);

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!formName.trim()) {
      setFormError('Informe o nome do container (ex.: change-metrics-exporter).');
      return;
    }
    if (!formImage.trim()) {
      setFormError('Informe a imagem Docker do serviço.');
      return;
    }

    setIsSubmitting(true);
    try {
      await onAddContainer({
        name: formName,
        role: formRole || 'Microserviço Chang’e',
        image: formImage,
        ports: formPorts || 'interno',
        healthCommand: formHealthCmd,
        healthEndpoint: formEndpoint.trim() || undefined,
        memoryLimitMb: Number(formMemoryLimit) || 512,
      });
      setFormName('');
      setFormRole('');
      setFormImage('');
      setFormPorts('');
      setFormEndpoint('');
      setFormMemoryLimit('512');
      setIsAddModalOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erro ao adicionar serviço.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#F5F5F7]">
            Containers da Stack Docker
          </h1>
          <p className="mt-1 text-sm text-[#AAB2C0]">
            Inspecione métricas de cada container, simule cenários de interrupção e valide alertas automáticos.
          </p>
        </div>

        {(demoMode || actionsEnabled) && (
          <button
            type="button"
            onClick={() => {
              setFormError(null);
              setIsAddModalOpen(true);
            }}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#8057FF] px-4 py-2 text-sm font-medium text-[#F5F5F7] transition-colors hover:bg-[#936EFF] whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Adicionar serviço</span>
          </button>
        )}
      </div>

      {dockerUnavailable && (
        <div
          role="alert"
          className="rounded-xl border border-[#F87171]/40 bg-[#190F14] px-6 py-4 text-sm text-[#F87171]"
        >
          Docker indisponível — conecte o daemon Docker via DOCKER_HOST ou socket Unix.
        </div>
      )}

      {/* Filter & Search Bar */}
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-md">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#747E91]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filtrar por nome, função ou imagem..."
            aria-label="Filtrar containers"
            className="w-full rounded-lg border border-[#20232B] bg-[#0D0F14] py-2 pr-3 pl-9 text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
          />
        </div>

        <div
          role="group"
          aria-label="Filtrar por estado"
          className="inline-flex items-center gap-1 rounded-lg border border-[#20232B] bg-[#0D0F14] p-1 self-start"
        >
          {(
            [
              { id: 'all', label: 'Todos' },
              { id: 'healthy', label: 'Saudáveis' },
              { id: 'degraded', label: 'Degradados' },
              { id: 'stopped', label: 'Parados' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                statusFilter === tab.id
                  ? 'bg-[#1A1D27] text-[#F5F5F7]'
                  : 'text-[#AAB2C0] hover:text-[#F5F5F7]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Master-Detail Split */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: Container List */}
        <div className="lg:col-span-5 rounded-xl border border-[#20232B] bg-[#0D0F14] divide-y divide-[#20232B]/70">
          {filteredContainers.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#747E91]">
              Nenhum container corresponde ao filtro atual.
            </div>
          ) : (
            filteredContainers.map((container) => {
              const isSelected = activeContainer?.id === container.id;
              return (
                <button
                  key={container.id}
                  type="button"
                  onClick={() => onSelectContainer(container.id)}
                  className={`w-full px-5 py-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#8057FF] ${
                    isSelected ? 'bg-[#141724]' : 'hover:bg-[#11141E]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-medium text-[#F5F5F7]">
                      {container.name}
                    </span>
                    <StatusInline status={container.status} />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-[#747E91]">
                    <span className="truncate">{container.role}</span>
                    <span className="font-mono tabular-nums shrink-0">
                      {container.latencyMs > 0 ? `${container.latencyMs} ms` : `Exit ${container.exitCode}`}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Right: Container Detail Inspector */}
        {activeContainer && (
          <section className="lg:col-span-7 rounded-xl border border-[#20232B] bg-[#0D0F14]">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#20232B] px-6 py-5">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="font-mono text-lg font-semibold text-[#F5F5F7]">
                    {activeContainer.name}
                  </h2>
                  <StatusInline status={activeContainer.status} />
                </div>
                <p className="mt-1 text-xs text-[#AAB2C0]">
                  {activeContainer.role} · <span className="font-mono text-[#747E91]">{activeContainer.image}</span>
                </p>
              </div>

              {actionsEnabled && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onRestartContainer(activeContainer.id)}
                    disabled={busyContainerId === activeContainer.id}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#8057FF] px-3.5 py-2 text-xs font-medium text-[#F5F5F7] transition-colors hover:bg-[#936EFF] disabled:opacity-60 whitespace-nowrap"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Reiniciar container</span>
                  </button>
                  {activeContainer.id !== 'change-edge-gateway' && (
                    <button
                      type="button"
                      onClick={() => void onRemoveContainer(activeContainer.id)}
                      aria-label={`Remover serviço ${activeContainer.name}`}
                      className="inline-flex items-center justify-center rounded-lg border border-[#20232B] p-2 text-[#747E91] transition-colors hover:border-[#F87171]/60 hover:text-[#F87171]"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Interruption Root Cause Box (only shown when stopped or degraded) */}
            {activeContainer.status !== 'healthy' && activeContainer.interruptionSummary && (
              <div className="border-b border-[#20232B] bg-[#181016] px-6 py-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#F87171]">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Motivo da interrupção: {activeContainer.interruptionCategory}</span>
                </div>
                <p className="text-xs leading-relaxed text-[#F5F5F7]">
                  {activeContainer.interruptionSummary}
                </p>
                {activeContainer.recommendedAction && (
                  <p className="text-xs leading-relaxed text-[#AAB2C0]">
                    <span className="text-[#A5A4FF] font-medium">Ação recomendada: </span>
                    {activeContainer.recommendedAction}
                  </p>
                )}
              </div>
            )}

            {/* Telemetry Grid */}
            <div className="grid grid-cols-2 divide-y divide-[#20232B] border-b border-[#20232B] sm:grid-cols-4 sm:divide-y-0 sm:divide-x">
              <div className="p-4">
                <span className="text-xs text-[#747E91]">CPU</span>
                <div className="mt-1 font-mono text-lg font-semibold text-[#F5F5F7] tabular-nums">
                  {activeContainer.cpuPercent.toFixed(1)}%
                </div>
              </div>
              <div className="p-4">
                <span className="text-xs text-[#747E91]">Memória</span>
                <div className="mt-1 font-mono text-lg font-semibold text-[#F5F5F7] tabular-nums">
                  {activeContainer.memoryMb}
                  <span className="ml-1 text-xs font-normal text-[#747E91]">
                    / {activeContainer.memoryLimitMb}MB
                  </span>
                </div>
              </div>
              <div className="p-4">
                <span className="text-xs text-[#747E91]">Reinícios</span>
                <div className="mt-1 font-mono text-lg font-semibold text-[#F5F5F7] tabular-nums">
                  {activeContainer.restartCount}
                </div>
              </div>
              <div className="p-4">
                <span className="text-xs text-[#747E91]">Uptime</span>
                <div className="mt-1 font-mono text-lg font-semibold text-[#F5F5F7] tabular-nums">
                  {activeContainer.status === 'stopped'
                    ? '0m'
                    : formatUptime(activeContainer.uptimeSeconds)}
                </div>
              </div>
            </div>

            {/* Latency Chart & Docker Spec */}
            <div className="grid grid-cols-1 gap-6 border-b border-[#20232B] px-6 py-5 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#747E91]">Histórico de latência</span>
                  <span className="font-mono text-[#F5F5F7] tabular-nums">
                    {activeContainer.latencyMs} ms atual
                  </span>
                </div>
                <LatencySparkline
                  values={activeContainer.latencyHistory}
                  height={56}
                  width={260}
                  accent={activeContainer.status === 'stopped' ? 'error' : 'purple'}
                />
              </div>

              <div className="space-y-2 text-xs">
                <div className="flex justify-between gap-2">
                  <span className="text-[#747E91]">Portas</span>
                  <span className="font-mono text-[#F5F5F7]">{activeContainer.ports}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#747E91]">Rede Docker</span>
                  <span className="font-mono text-[#F5F5F7]">{activeContainer.network}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#747E91]">Exit Code</span>
                  <span className="font-mono text-[#F5F5F7] tabular-nums">
                    {activeContainer.exitCode}
                  </span>
                </div>
                <div className="pt-1">
                  <span className="text-[#747E91]">Healthcheck:</span>
                  <div className="mt-1 break-all rounded-md bg-[#08090B] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[#AAB2C0]">
                    {activeContainer.healthCommand}
                  </div>
                </div>
              </div>
            </div>

            {/* Failure Simulation Control (DEMO_MODE=true only) */}
            {demoMode && (
              <div className="flex flex-col justify-between gap-3 border-b border-[#20232B] px-6 py-4 sm:flex-row sm:items-center">
                <div className="space-y-0.5">
                  <p className="text-xs font-medium text-[#F5F5F7]">
                    Validar resposta a falhas e disparo de alertas
                  </p>
                  <p className="text-xs text-[#747E91]">
                    Simula uma interrupção real, grava logs em stderr e dispara E-mail e Telegram.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    aria-label="Cenário de falha"
                    value={selectedScenario}
                    onChange={(e) => setSelectedScenario(e.target.value as FailureScenario)}
                    className="rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 text-xs text-[#F5F5F7] focus:border-[#8057FF] focus:outline-none"
                  >
                    {SCENARIO_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => onSimulateFailure(activeContainer.id, selectedScenario)}
                    disabled={busyContainerId === activeContainer.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[#F87171]/45 bg-[#1B1015] px-3.5 py-2 text-xs font-medium text-[#F87171] transition-colors hover:bg-[#27131C] disabled:opacity-50 whitespace-nowrap"
                  >
                    <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Simular falha</span>
                  </button>
                </div>
              </div>
            )}

            {/* Recent Container Logs */}
            <div className="px-6 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-[#F5F5F7]">
                  Logs recentes de {activeContainer.name}
                </h3>
                <button
                  type="button"
                  onClick={() => onViewFullLogs(activeContainer.id)}
                  className="text-xs font-medium text-[#5CA8FF] hover:text-[#A5A4FF]"
                >
                  Abrir console completo
                </button>
              </div>

              <div className="rounded-lg border border-[#20232B] bg-[#08090B] p-3 font-mono text-xs space-y-2 max-h-56 overflow-y-auto">
                {containerLogs.length === 0 ? (
                  <p className="text-[#747E91]">Sem eventos registrados para este container.</p>
                ) : (
                  containerLogs.map((log) => (
                    <div key={log.id} className="flex items-start gap-2.5 leading-relaxed">
                      <span className="text-[#747E91] shrink-0 tabular-nums">
                        {new Date(log.timestamp).toLocaleTimeString('pt-BR')}
                      </span>
                      <span
                        className={`shrink-0 font-semibold ${
                          log.level === 'ERROR'
                            ? 'text-[#F87171]'
                            : log.level === 'WARN'
                            ? 'text-[#FBBF24]'
                            : 'text-[#5CA8FF]'
                        }`}
                      >
                        {log.level}
                      </span>
                      <span className="text-[#AAB2C0] break-words">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Add Service Modal */}
      {isAddModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-service-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-lg rounded-xl border border-[#20232B] bg-[#0D0F14]">
            <div className="flex items-center justify-between border-b border-[#20232B] px-6 py-4">
              <h2 id="add-service-title" className="text-base font-semibold text-[#F5F5F7]">
                Adicionar container ao monitoramento
              </h2>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                aria-label="Fechar janela"
                className="rounded-md p-1 text-[#747E91] hover:text-[#F5F5F7]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} noValidate className="space-y-4 p-6">
              {formError && (
                <div
                  role="alert"
                  className="rounded-lg border border-[#F87171]/40 bg-[#1B1015] px-3.5 py-2.5 text-xs text-[#F87171]"
                >
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="svc-name" className="block text-xs font-medium text-[#AAB2C0]">
                    Nome do container
                  </label>
                  <input
                    id="svc-name"
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="change-metrics-exporter"
                    className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="svc-role" className="block text-xs font-medium text-[#AAB2C0]">
                    Função na stack
                  </label>
                  <input
                    id="svc-role"
                    type="text"
                    value={formRole}
                    onChange={(e) => setFormRole(e.target.value)}
                    placeholder="Exportador Prometheus"
                    className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="svc-image" className="block text-xs font-medium text-[#AAB2C0]">
                    Imagem Docker
                  </label>
                  <input
                    id="svc-image"
                    type="text"
                    value={formImage}
                    onChange={(e) => setFormImage(e.target.value)}
                    placeholder="prom/node-exporter:v1.8.2"
                    className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="svc-ports" className="block text-xs font-medium text-[#AAB2C0]">
                    Portas / Limite RAM (MB)
                  </label>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      id="svc-ports"
                      type="text"
                      value={formPorts}
                      onChange={(e) => setFormPorts(e.target.value)}
                      placeholder="9100:9100"
                      className="w-1/2 rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                    />
                    <input
                      aria-label="Limite de memória em MB"
                      type="number"
                      min={128}
                      max={16384}
                      value={formMemoryLimit}
                      onChange={(e) => setFormMemoryLimit(e.target.value)}
                      className="w-1/2 rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] focus:border-[#8057FF] focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor="svc-cmd" className="block text-xs font-medium text-[#AAB2C0]">
                  Comando Docker HEALTHCHECK
                </label>
                <input
                  id="svc-cmd"
                  type="text"
                  value={formHealthCmd}
                  onChange={(e) => setFormHealthCmd(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-xs text-[#F5F5F7] focus:border-[#8057FF] focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="svc-url" className="block text-xs font-medium text-[#AAB2C0]">
                  Endpoint HTTPS público (opcional)
                </label>
                <input
                  id="svc-url"
                  type="url"
                  value={formEndpoint}
                  onChange={(e) => setFormEndpoint(e.target.value)}
                  placeholder="https://chang-e.app/health"
                  className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="rounded-lg border border-[#20232B] px-4 py-2 text-sm font-medium text-[#AAB2C0] hover:text-[#F5F5F7]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-[#8057FF] px-4 py-2 text-sm font-medium text-[#F5F5F7] hover:bg-[#936EFF] disabled:opacity-60"
                >
                  {isSubmitting ? 'Salvando...' : 'Salvar serviço'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
