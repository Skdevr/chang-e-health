interface OrbitalHealthRingProps {
  healthyCount: number;
  totalCount: number;
  percentage: number;
  overallStatus: 'operational' | 'degraded' | 'outage';
}

export function OrbitalHealthRing({
  healthyCount,
  totalCount,
  percentage,
  overallStatus,
}: OrbitalHealthRingProps) {
  const size = 148;
  const center = size / 2;
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (Math.max(0, Math.min(100, percentage)) / 100) * circumference;

  const statusText =
    overallStatus === 'operational'
      ? 'Nominal'
      : overallStatus === 'degraded'
      ? 'Degradado'
      : 'Interrupção';

  const statusColor =
    overallStatus === 'operational'
      ? '#34D399'
      : overallStatus === 'degraded'
      ? '#FBBF24'
      : '#F87171';

  return (
    <div className="relative flex flex-col items-center justify-center shrink-0">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Saúde da stack Docker: ${healthyCount} de ${totalCount} containers saudáveis (${percentage}%)`}
      >
        <defs>
          <linearGradient id="orbitalRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#8057FF" />
            <stop offset="52%" stopColor="#A5A4FF" />
            <stop offset="100%" stopColor="#5CA8FF" />
          </linearGradient>
        </defs>

        {/* Outer geometric orbit hairline */}
        <circle
          cx={center}
          cy={center}
          r={68}
          fill="none"
          stroke="#20232B"
          strokeWidth="1"
          strokeDasharray="2 5"
        />

        {/* Track circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#181B24"
          strokeWidth="6"
        />

        {/* Progress arc */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={overallStatus === 'outage' ? '#F87171' : 'url(#orbitalRingGrad)'}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${center} ${center})`}
          className="transition-all duration-300"
        />

        {/* Inner hairline */}
        <circle
          cx={center}
          cy={center}
          r={43}
          fill="none"
          stroke="#20232B"
          strokeWidth="1"
          strokeOpacity="0.7"
        />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="font-mono text-2xl font-semibold tracking-tight text-[#F5F5F7] tabular-nums">
          {healthyCount}/{totalCount}
        </span>
        <span
          className="mt-0.5 text-xs font-medium"
          style={{ color: statusColor }}
        >
          {statusText}
        </span>
      </div>
    </div>
  );
}

interface LatencySparklineProps {
  values: number[];
  height?: number;
  width?: number;
  accent?: 'purple' | 'error';
}

export function LatencySparkline({
  values,
  height = 44,
  width = 220,
  accent = 'purple',
}: LatencySparklineProps) {
  const safeValues = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const maxVal = Math.max(50, ...safeValues);
  const minVal = 0;
  const range = Math.max(1, maxVal - minVal);

  const points = safeValues
    .map((val, idx) => {
      const x = (idx / (safeValues.length - 1)) * width;
      const y = height - 4 - ((val - minVal) / range) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const areaPoints = `0,${height} ${points} ${width},${height}`;
  const gradId = accent === 'error' ? 'sparkErrGrad' : 'sparkPurpleGrad';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="w-full overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor={accent === 'error' ? '#F87171' : '#8057FF'}
            stopOpacity="0.28"
          />
          <stop
            offset="100%"
            stopColor={accent === 'error' ? '#F87171' : '#5CA8FF'}
            stopOpacity="0"
          />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradId})`} />
      <polyline
        fill="none"
        stroke={accent === 'error' ? '#F87171' : '#A477FF'}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}
