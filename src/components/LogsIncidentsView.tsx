import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  RotateCcw,
  Search,
} from 'lucide-react';
import type {
  ContainerLogEntry,
  ContainerService,
  IncidentRecord,
  LogLevel,
} from '../types/health';

interface LogsIncidentsViewProps {
  containers: ContainerService[];
  incidents: IncidentRecord[];
  logs: ContainerLogEntry[];
  initialContainerFilter: string;
  busyContainerId: string | null;
  actionsEnabled: boolean;
  onRestartContainer: (containerId: string) => void;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function LogsIncidentsView({
  containers,
  incidents,
  logs,
  initialContainerFilter,
  busyContainerId,
  actionsEnabled,
  onRestartContainer,
}: LogsIncidentsViewProps) {
  const [containerFilter, setContainerFilter] = useState<string>(initialContainerFilter || 'all');
  const [levelFilter, setLevelFilter] = useState<'ALL' | LogLevel>('ALL');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((entry) => {
      const matchContainer = containerFilter === 'all' || entry.containerId === containerFilter;
      const matchLevel = levelFilter === 'ALL' || entry.level === levelFilter;
      const matchQuery =
        !q ||
        entry.message.toLowerCase().includes(q) ||
        entry.containerName.toLowerCase().includes(q);
      return matchContainer && matchLevel && matchQuery;
    });
  }, [logs, containerFilter, levelFilter, query]);

  const filteredIncidents = useMemo(() => {
    if (containerFilter === 'all') return incidents;
    return incidents.filter((inc) => inc.containerId === containerFilter);
  }, [incidents, containerFilter]);

  function handleCopyLogs() {
    const content = filteredLogs
      .map(
        (l) =>
          `${l.timestamp} [${l.level}] [${l.containerName}/${l.stream}] ${l.message}`
      )
      .join('\n');
    void navigator.clipboard?.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function handleDownloadLogs() {
    const content = filteredLogs
      .map(
        (l) =>
          `${l.timestamp} [${l.level}] [${l.containerName}/${l.stream}] ${l.message}`
      )
      .join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `change-docker-logs-${new Date().toISOString().slice(0, 10)}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#F5F5F7]">
          Logs Detalhados e Diagnóstico de Interrupções
        </h1>
        <p className="mt-1 text-sm text-[#AAB2C0]">
          Acompanhe o motivo exato de cada parada, códigos de saída do Docker e o fluxo de stdout e stderr.
        </p>
      </div>

      {/* Incident Root-Cause Reports */}
      <section className="rounded-xl border border-[#20232B] bg-[#0D0F14]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#20232B] px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#F5F5F7]">
              Relatório de Causa Raiz
            </h2>
            <p className="mt-0.5 text-xs text-[#747E91]">
              Análise automática dos códigos de saída (Exit Code) e logs capturados no momento da falha
            </p>
          </div>
          <span className="font-mono text-xs text-[#AAB2C0] tabular-nums">
            {filteredIncidents.length} ocorrência(s)
          </span>
        </div>

        <div className="divide-y divide-[#20232B]/70">
          {filteredIncidents.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#747E91]">
              Nenhuma interrupção registrada para o filtro selecionado.
            </div>
          ) : (
            filteredIncidents.map((inc) => (
              <article key={inc.id} className="px-6 py-5 space-y-4">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                      <span className="font-mono text-sm font-semibold text-[#F5F5F7]">
                        {inc.containerName}
                      </span>
                      <span aria-hidden="true" className="text-[#747E91]">·</span>
                      <span
                        className={`font-medium ${
                          inc.status === 'active' ? 'text-[#F87171]' : 'text-[#34D399]'
                        }`}
                      >
                        {inc.status === 'active' ? 'Interrupção ativa' : 'Resolvido'}
                      </span>
                      <span aria-hidden="true" className="text-[#747E91]">·</span>
                      <span className="font-mono text-[#A5A4FF]">{inc.category}</span>
                    </div>
                    <p className="text-xs font-mono text-[#747E91] tabular-nums">
                      Início: {formatDateTime(inc.startedAt)}
                      {inc.resolvedAt ? ` · Recuperado: ${formatDateTime(inc.resolvedAt)}` : ''}
                      {' · '}Notificado via:{' '}
                      {inc.notifiedChannels.length > 0
                        ? inc.notifiedChannels
                            .map((c) => (c === 'email' ? 'E-mail' : 'Telegram'))
                            .join(' e ')
                        : 'Nenhum canal ativo'}
                    </p>
                  </div>

                  {inc.status === 'active' && actionsEnabled && (
                    <button
                      type="button"
                      onClick={() => onRestartContainer(inc.containerId)}
                      disabled={busyContainerId === inc.containerId}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#8057FF] px-3.5 py-2 text-xs font-medium text-[#F5F5F7] transition-colors hover:bg-[#936EFF] disabled:opacity-60 whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Reiniciar {inc.containerName}</span>
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-[#F5F5F7]">
                      <AlertTriangle className="h-3.5 w-3.5 text-[#A477FF]" aria-hidden="true" />
                      <span>Motivo identificado</span>
                    </div>
                    <p className="text-xs leading-relaxed text-[#AAB2C0]">{inc.rootCause}</p>
                    <p className="text-xs leading-relaxed text-[#747E91]">
                      <span className="text-[#5CA8FF]">Recomendação: </span>
                      {inc.recommendedAction}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-[#F5F5F7]">
                      Trecho capturado de stderr
                    </div>
                    <pre className="overflow-x-auto rounded-lg border border-[#20232B] bg-[#08090B] p-3 font-mono text-[11px] leading-relaxed text-[#F87171]/90 whitespace-pre-wrap">
                      {inc.logExcerpt.join('\n')}
                    </pre>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      {/* Interactive Stream Log Viewer */}
      <section className="rounded-xl border border-[#20232B] bg-[#0D0F14]">
        <div className="flex flex-col justify-between gap-4 border-b border-[#20232B] px-6 py-4 lg:flex-row lg:items-center">
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Filtrar logs por container"
              value={containerFilter}
              onChange={(e) => setContainerFilter(e.target.value)}
              className="rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-xs text-[#F5F5F7] focus:border-[#8057FF] focus:outline-none"
            >
              <option value="all">Todos os containers</option>
              {containers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>

            <div
              role="group"
              aria-label="Filtrar logs por nível"
              className="inline-flex items-center gap-1 rounded-lg border border-[#20232B] bg-[#08090B] p-1"
            >
              {(['ALL', 'ERROR', 'WARN', 'INFO'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setLevelFilter(lvl)}
                  className={`rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                    levelFilter === lvl
                      ? 'bg-[#1A1D27] text-[#F5F5F7]'
                      : 'text-[#747E91] hover:text-[#F5F5F7]'
                  }`}
                >
                  {lvl === 'ALL' ? 'Todos' : lvl}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[210px]">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[#747E91]"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar nos logs..."
                aria-label="Buscar texto nos logs"
                className="w-full rounded-lg border border-[#20232B] bg-[#08090B] py-1.5 pr-3 pl-8 text-xs text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
              />
            </div>

            <button
              type="button"
              onClick={handleCopyLogs}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#20232B] px-3 py-1.5 text-xs font-medium text-[#AAB2C0] transition-colors hover:border-[#8057FF]/60 hover:text-[#F5F5F7]"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-[#34D399]" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>{copied ? 'Copiado' : 'Copiar'}</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadLogs}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#20232B] px-3 py-1.5 text-xs font-medium text-[#AAB2C0] transition-colors hover:border-[#8057FF]/60 hover:text-[#F5F5F7]"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Exportar .log</span>
            </button>
          </div>
        </div>

        <div className="max-h-[460px] overflow-y-auto bg-[#08090B] px-6 py-4 font-mono text-xs divide-y divide-[#20232B]/40">
          {filteredLogs.length === 0 ? (
            <p className="py-8 text-center text-[#747E91]">
              Nenhum registro de log encontrado com os filtros aplicados.
            </p>
          ) : (
            filteredLogs.map((entry) => (
              <div
                key={entry.id}
                className="grid grid-cols-1 gap-1.5 py-2.5 md:grid-cols-12 md:items-start md:gap-3"
              >
                <span className="md:col-span-2 text-[#747E91] tabular-nums">
                  {formatDateTime(entry.timestamp)}
                </span>
                <span className="md:col-span-2 truncate text-[#A5A4FF]">
                  {entry.containerName}
                </span>
                <span
                  className={`md:col-span-1 font-semibold ${
                    entry.level === 'ERROR'
                      ? 'text-[#F87171]'
                      : entry.level === 'WARN'
                      ? 'text-[#FBBF24]'
                      : 'text-[#5CA8FF]'
                  }`}
                >
                  {entry.level}
                </span>
                <span className="md:col-span-7 leading-relaxed text-[#AAB2C0] break-words">
                  {entry.message}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
