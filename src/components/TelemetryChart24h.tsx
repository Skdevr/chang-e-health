import { useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TelemetryPoint24h } from '../types/health';

type ChartViewMode = 'combined' | 'latency' | 'memory';

interface TelemetryChart24hProps {
  data: TelemetryPoint24h[];
  probeUrl: string;
}

interface CustomTooltipPayloadItem {
  dataKey?: string;
  value?: number;
  payload?: TelemetryPoint24h;
}

function CustomTelemetryTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: CustomTooltipPayloadItem[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  return (
    <div className="rounded-lg border border-[#20232B] bg-[#08090B]/95 px-3.5 py-2.5 text-xs shadow-lg backdrop-blur-sm">
      <div className="mb-1.5 font-mono text-[11px] font-medium text-[#AAB2C0]">
        {label === 'Agora' ? 'Leitura atual' : `Horário ${label}`}
      </div>
      <div className="space-y-1 font-mono tabular-nums">
        <div className="flex items-center justify-between gap-5">
          <span className="text-[#A477FF]">Latência HTTP</span>
          <span className="font-semibold text-[#F5F5F7]">{point.latencyMs} ms</span>
        </div>
        <div className="flex items-center justify-between gap-5">
          <span className="text-[#5CA8FF]">Memória Docker</span>
          <span className="font-semibold text-[#F5F5F7]">
            {point.memoryPercent.toFixed(1)}% ({(point.memoryUsedMb / 1024).toFixed(2)} GB)
          </span>
        </div>
      </div>
    </div>
  );
}

export function TelemetryChart24h({ data, probeUrl }: TelemetryChart24hProps) {
  const [mode, setMode] = useState<ChartViewMode>('combined');

  const stats = useMemo(() => {
    if (!data || data.length === 0) {
      return { avgLatency: 0, peakLatency: 0, avgMemoryPct: 0, peakMemoryPct: 0 };
    }
    const avgLatency = Math.round(
      data.reduce((acc, p) => acc + p.latencyMs, 0) / data.length
    );
    const peakLatency = Math.max(...data.map((p) => p.latencyMs));
    const avgMemoryPct = Number(
      (data.reduce((acc, p) => acc + p.memoryPercent, 0) / data.length).toFixed(1)
    );
    const peakMemoryPct = Number(
      Math.max(...data.map((p) => p.memoryPercent)).toFixed(1)
    );
    return { avgLatency, peakLatency, avgMemoryPct, peakMemoryPct };
  }, [data]);

  const showLatency = mode === 'combined' || mode === 'latency';
  const showMemory = mode === 'combined' || mode === 'memory';

  return (
    <section
      aria-label="Gráfico de latência e memória nas últimas 24 horas"
      data-testid="telemetry-24h-chart"
      className="rounded-xl border border-[#20232B] bg-[#0D0F14]"
    >
      <div className="flex flex-col justify-between gap-4 border-b border-[#20232B] px-6 py-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-base font-semibold text-[#F5F5F7]">
            Telemetria das últimas 24 horas
          </h2>
          <p className="mt-0.5 text-xs text-[#747E91]">
            Latência HTTPS em {probeUrl} e utilização consolidada de memória dos containers Docker
          </p>
        </div>

        <div
          role="group"
          aria-label="Selecionar métrica do gráfico 24h"
          className="inline-flex items-center gap-1 self-start rounded-lg border border-[#20232B] bg-[#08090B] p-1 sm:self-auto shrink-0"
        >
          {(
            [
              { id: 'combined', label: 'Combinado' },
              { id: 'latency', label: 'Latência (ms)' },
              { id: 'memory', label: 'Memória (%)' },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMode(option.id)}
              aria-pressed={mode === option.id}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                mode === option.id
                  ? 'bg-[#1A1D27] text-[#F5F5F7]'
                  : 'text-[#747E91] hover:text-[#F5F5F7]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pt-4 pb-4 sm:px-6">
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs font-mono tabular-nums text-[#AAB2C0]">
          {showLatency && (
            <span>
              <span className="text-[#A477FF]">Latência 24h</span> · média {stats.avgLatency}ms · pico{' '}
              {stats.peakLatency}ms
            </span>
          )}
          {showLatency && showMemory && (
            <span aria-hidden="true" className="hidden sm:inline text-[#20232B]">|</span>
          )}
          {showMemory && (
            <span>
              <span className="text-[#5CA8FF]">Memória 24h</span> · média {stats.avgMemoryPct}% · pico{' '}
              {stats.peakMemoryPct}%
            </span>
          )}
        </div>

        {data.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-[#747E91]">
            Sem amostras históricas disponíveis nas últimas 24 horas.
          </div>
        ) : (
          <div className="h-[260px] w-full min-w-0 sm:h-[290px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <ComposedChart
                data={data}
                margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
              >
                <defs>
                  <linearGradient id="changeLatencyFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#8057FF" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#8057FF" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="changeMemoryFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5CA8FF" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#5CA8FF" stopOpacity={0.0} />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  stroke="#20232B"
                  strokeDasharray="3 4"
                  vertical={false}
                />

                <XAxis
                  dataKey="hourLabel"
                  stroke="#747E91"
                  tick={{ fill: '#747E91', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
                  tickLine={false}
                  axisLine={{ stroke: '#20232B' }}
                  minTickGap={28}
                  interval="preserveStartEnd"
                />

                {showLatency && (
                  <YAxis
                    yAxisId="latency"
                    orientation="left"
                    stroke="#747E91"
                    tick={{ fill: '#A5A4FF', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${v}ms`}
                    width={56}
                  />
                )}

                {showMemory && (
                  <YAxis
                    yAxisId="memory"
                    orientation={mode === 'memory' ? 'left' : 'right'}
                    domain={[0, 100]}
                    stroke="#747E91"
                    tick={{ fill: '#5CA8FF', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                    width={46}
                  />
                )}

                <Tooltip
                  content={<CustomTelemetryTooltip />}
                  cursor={{ stroke: '#A5A4FF', strokeOpacity: 0.35, strokeDasharray: '3 3' }}
                />

                {showLatency && (
                  <Area
                    yAxisId="latency"
                    type="monotone"
                    dataKey="latencyMs"
                    name="Latência (ms)"
                    stroke="#8057FF"
                    strokeWidth={2}
                    fill="url(#changeLatencyFill)"
                    activeDot={{ r: 4, fill: '#A477FF', stroke: '#08090B', strokeWidth: 2 }}
                    isAnimationActive={false}
                  />
                )}

                {showMemory &&
                  (mode === 'memory' ? (
                    <Area
                      yAxisId="memory"
                      type="monotone"
                      dataKey="memoryPercent"
                      name="Memória (%)"
                      stroke="#5CA8FF"
                      strokeWidth={2}
                      fill="url(#changeMemoryFill)"
                      activeDot={{ r: 4, fill: '#5CA8FF', stroke: '#08090B', strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  ) : (
                    <Line
                      yAxisId="memory"
                      type="monotone"
                      dataKey="memoryPercent"
                      name="Memória (%)"
                      stroke="#5CA8FF"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: '#5CA8FF', stroke: '#08090B', strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Crisp minimal legend strip */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#20232B]/70 pt-3 text-xs text-[#747E91]">
          <div className="flex flex-wrap items-center gap-5">
            {showLatency && (
              <span className="inline-flex items-center gap-2 text-[#AAB2C0]">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-4 rounded-full bg-[#8057FF]"
                />
                <span>Latência da aplicação (ms)</span>
              </span>
            )}
            {showMemory && (
              <span className="inline-flex items-center gap-2 text-[#AAB2C0]">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-4 rounded-full bg-[#5CA8FF]"
                />
                <span>Utilização de memória dos containers (%)</span>
              </span>
            )}
          </div>
          <span className="font-mono text-[11px] tabular-nums">
            Janela móvel · 24 amostras horárias
          </span>
        </div>
      </div>
    </section>
  );
}
