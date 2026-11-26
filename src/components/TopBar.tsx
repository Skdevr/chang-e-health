import { RefreshCw } from 'lucide-react';

export type NavTab = 'overview' | 'containers' | 'logs' | 'alerts';

interface TopBarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onRunProbe: () => void;
  isProbing: boolean;
  activeIncidentCount: number;
  demoMode: boolean;
}

const NAV_ITEMS: Array<{ id: NavTab; label: string }> = [
  { id: 'overview', label: 'Visão Geral' },
  { id: 'containers', label: 'Containers' },
  { id: 'logs', label: 'Logs e Incidentes' },
  { id: 'alerts', label: 'Alertas' },
];

export function TopBar({
  activeTab,
  onSelectTab,
  onRunProbe,
  isProbing,
  activeIncidentCount,
  demoMode,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-[#20232B] bg-[#08090B]/92 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between gap-4 px-4 sm:px-8 md:h-16 md:gap-8">
        {/* Zone 1: Single-line Brand Wordmark (+ visible DEMO indicator when DEMO_MODE=true) */}
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <button
            type="button"
            onClick={() => onSelectTab('overview')}
            className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8057FF]"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="shrink-0"
            >
              <defs>
                <linearGradient id="changeBrandGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#8057FF" />
                  <stop offset="55%" stopColor="#A5A4FF" />
                  <stop offset="100%" stopColor="#5CA8FF" />
                </linearGradient>
              </defs>
              <circle cx="12" cy="12" r="9.5" stroke="url(#changeBrandGrad)" strokeWidth="1.25" strokeOpacity="0.65" />
              <path
                d="M14.8 5.2A7 7 0 1 0 18.8 14.8A5.6 5.6 0 1 1 14.8 5.2Z"
                fill="url(#changeBrandGrad)"
              />
            </svg>
            <span className="text-[17px] font-semibold tracking-tight text-[#F5F5F7]">
              Chang’e
            </span>
          </button>
          {demoMode && (
            <span
              data-testid="demo-mode-badge"
              title="Modo de simulação ativo (DEMO_MODE=true)"
              className="rounded border border-[#8057FF]/45 bg-[#8057FF]/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-[#A5A4FF]"
            >
              DEMO
            </span>
          )}
        </div>

        {/* Zone 2: Clean single-line typography navigation */}
        <nav aria-label="Navegação principal" className="hidden md:flex items-center gap-7">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            const showCount = item.id === 'logs' && activeIncidentCount > 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative py-5 text-sm font-medium transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#8057FF] ${
                  isActive
                    ? 'text-[#F5F5F7]'
                    : 'text-[#AAB2C0] hover:text-[#F5F5F7]'
                }`}
              >
                <span>{item.label}</span>
                {showCount && (
                  <span className="ml-1.5 font-mono text-xs text-[#F87171] tabular-nums">
                    ({activeIncidentCount})
                  </span>
                )}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute right-0 bottom-0 left-0 h-[2px] bg-gradient-to-r from-[#8057FF] via-[#A5A4FF] to-[#5CA8FF]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onRunProbe}
            disabled={isProbing}
            className="inline-flex items-center gap-2 rounded-lg bg-[#8057FF] px-3.5 py-2 text-xs sm:px-4 sm:text-sm font-medium text-[#F5F5F7] transition-all duration-150 hover:bg-[#936EFF] active:scale-[0.99] disabled:opacity-60 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A477FF]"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isProbing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{isProbing ? 'Verificando...' : 'Verificar agora'}</span>
          </button>
        </div>
      </div>

      {/* Mobile compact navigation */}
      <nav
        aria-label="Navegação mobile"
        className="flex md:hidden items-center justify-between gap-1 border-t border-[#20232B] px-3 py-1.5"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                isActive
                  ? 'bg-[#0D0F14] text-[#F5F5F7] ring-1 ring-[#20232B]'
                  : 'text-[#AAB2C0] hover:text-[#F5F5F7]'
              }`}
            >
              {item.id === 'logs' ? 'Logs' : item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
