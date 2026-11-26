import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, KeyRound, X, XCircle } from 'lucide-react';
import { AlertsView } from './components/AlertsView';
import { ContainersView } from './components/ContainersView';
import { LogsIncidentsView } from './components/LogsIncidentsView';
import { OverviewView } from './components/OverviewView';
import { TopBar, type NavTab } from './components/TopBar';
import { POLL_INTERVAL_MS, PollScheduler } from './lib/poller';
import type {
  AlertChannel,
  AlertConfiguration,
  FailureScenario,
  MonitorSnapshot,
} from './types/health';

interface FeedbackBanner {
  tone: 'success' | 'error';
  message: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [busyContainerId, setBusyContainerId] = useState<string | null>(null);
  const [selectedContainerId, setSelectedContainerId] = useState<string>('change-api-core');
  const [logFilterContainerId, setLogFilterContainerId] = useState<string>('all');
  const [feedback, setFeedback] = useState<FeedbackBanner | null>(null);

  // Admin token stays strictly in React memory (never localStorage/sessionStorage)
  const [authToken, setAuthToken] = useState<string>('');
  const [authRequired, setAuthRequired] = useState(false);
  const [authInput, setAuthInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const authTokenRef = useRef(authToken);
  authTokenRef.current = authToken;
  const hasSnapshotRef = useRef(false);
  hasSnapshotRef.current = snapshot !== null;
  const pollerRef = useRef<PollScheduler | null>(null);

  const showFeedback = useCallback((tone: 'success' | 'error', message: string) => {
    setFeedback({ tone, message });
  }, []);

  const buildHeaders = useCallback((extra?: Record<string, string>): Record<string, string> => {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (authTokenRef.current.trim()) {
      headers.Authorization = `Bearer ${authTokenRef.current.trim()}`;
    }
    return headers;
  }, []);

  const applySnapshot = useCallback((data: MonitorSnapshot) => {
    setSnapshot(data);
    setLoadError(null);
    setIsStale(false);
    setAuthRequired(false);
    setAuthError(null);
    setLastPollAt(data.lastUpdatedAt || new Date().toISOString());
    if (data.containers.length > 0) {
      setSelectedContainerId((prev) =>
        data.containers.some((c) => c.id === prev) ? prev : data.containers[0].id
      );
    }
  }, []);

  const fetchSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch('/api/health/snapshot', {
          signal,
          headers: buildHeaders(),
        });

        if (response.status === 401) {
          setAuthRequired(true);
          setAuthError(
            authTokenRef.current ? 'Token inválido ou expirado. Informe o ADMIN_TOKEN.' : null
          );
          setLoading(false);
          return;
        }

        if (response.status === 503) {
          const payload = (await response.json().catch(() => null)) as
            | (MonitorSnapshot & { error?: string; code?: string })
            | null;
          if (payload && payload.capabilities?.dockerUnavailable) {
            applySnapshot(payload);
            setLoading(false);
            return;
          }
          throw new Error(payload?.error || 'Docker indisponível.');
        }

        if (!response.ok) {
          throw new Error('Não foi possível carregar o estado do monitor.');
        }

        const data = (await response.json()) as MonitorSnapshot;
        applySnapshot(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        if (hasSnapshotRef.current) {
          // Keep last displayed data and mark discreetly as stale; retry on next poll tick
          setIsStale(true);
        } else {
          setLoadError(err instanceof Error ? err.message : 'Erro de conexão com o servidor.');
        }
      } finally {
        setLoading(false);
      }
    },
    [applySnapshot, buildHeaders]
  );

  useEffect(() => {
    const scheduler = new PollScheduler({
      intervalMs: POLL_INTERVAL_MS,
      isDocumentHidden: () =>
        typeof document !== 'undefined' && document.visibilityState === 'hidden',
      onTick: (signal) => fetchSnapshot(signal),
    });
    pollerRef.current = scheduler;
    scheduler.start();
    void scheduler.triggerNow({ forceWhenHidden: true });

    const onVisibilityChange = () => {
      scheduler.handleVisibilityChange();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      scheduler.stop();
      pollerRef.current = null;
    };
  }, [fetchSnapshot]);

  async function handleUnlockWithToken(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = authInput.trim();
    if (!cleaned) {
      setAuthError('Informe o token de autenticação.');
      return;
    }
    setAuthToken(cleaned);
    authTokenRef.current = cleaned;
    setAuthError(null);
    await fetchSnapshot();
    pollerRef.current?.resetTimer();
  }

  async function handleRunProbe() {
    setIsProbing(true);
    try {
      const response = await fetch('/api/health/probe', {
        method: 'POST',
        headers: buildHeaders(),
      });
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const data = await response.json();
      if (!response.ok && !(response.status === 503 && data?.capabilities?.dockerUnavailable)) {
        throw new Error(data.error || 'Erro ao verificar endpoint.');
      }
      const next = data as MonitorSnapshot;
      applySnapshot(next);
      pollerRef.current?.resetTimer();
      showFeedback(
        next.probe.reachable ? 'success' : 'error',
        next.probe.reachable
          ? `Verificação concluída: ${next.probe.targetUrl} respondeu HTTP ${next.probe.httpStatus} em ${next.probe.latencyMs}ms.`
          : `Falha ao alcançar ${next.probe.targetUrl}: ${next.probe.errorMessage || 'Sem resposta'}.`
      );
    } catch (err) {
      if (hasSnapshotRef.current) {
        setIsStale(true);
      }
      showFeedback('error', err instanceof Error ? err.message : 'Falha na verificação.');
    } finally {
      setIsProbing(false);
    }
  }

  async function handleSimulateFailure(containerId: string, scenario: FailureScenario) {
    setBusyContainerId(containerId);
    try {
      const response = await fetch(
        `/api/containers/${encodeURIComponent(containerId)}/simulate-failure`,
        {
          method: 'POST',
          headers: buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ scenario }),
        }
      );
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao simular falha.');
      applySnapshot(data as MonitorSnapshot);
      showFeedback(
        'error',
        `Interrupção detectada em ${containerId}. Logs de causa raiz gravados e alertas E-mail + Telegram disparados.`
      );
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Erro ao simular falha.');
    } finally {
      setBusyContainerId(null);
    }
  }

  async function handleRestartContainer(containerId: string) {
    setBusyContainerId(containerId);
    try {
      const response = await fetch(`/api/containers/${encodeURIComponent(containerId)}/restart`, {
        method: 'POST',
        headers: buildHeaders(),
      });
      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Erro ao reiniciar container.');
      applySnapshot(data as MonitorSnapshot);
      showFeedback('success', `Container ${containerId} reiniciado e validado como saudável.`);
    } catch (err) {
      showFeedback('error', err instanceof Error ? err.message : 'Erro ao reiniciar container.');
    } finally {
      setBusyContainerId(null);
    }
  }

  async function handleAddContainer(payload: {
    name: string;
    role: string;
    image: string;
    ports: string;
    healthCommand: string;
    healthEndpoint?: string;
    memoryLimitMb: number;
  }) {
    const response = await fetch('/api/containers', {
      method: 'POST',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (response.status === 401) {
      setAuthRequired(true);
      throw new Error('Autenticação obrigatória.');
    }
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Erro ao adicionar serviço.');
    }
    const next = data as MonitorSnapshot;
    applySnapshot(next);
    const created = next.containers[next.containers.length - 1];
    if (created) setSelectedContainerId(created.id);
    showFeedback('success', `Serviço ${payload.name} adicionado ao monitoramento.`);
  }

  async function handleRemoveContainer(containerId: string) {
    const response = await fetch(`/api/containers/${encodeURIComponent(containerId)}`, {
      method: 'DELETE',
      headers: buildHeaders(),
    });
    if (response.status === 401) {
      setAuthRequired(true);
      return;
    }
    const data = await response.json();
    if (!response.ok) {
      showFeedback('error', data.error || 'Erro ao remover container.');
      return;
    }
    const next = data as MonitorSnapshot;
    applySnapshot(next);
    if (next.containers[0]) setSelectedContainerId(next.containers[0].id);
    showFeedback('success', `Serviço ${containerId} removido da stack.`);
  }

  async function handleSaveAlertConfig(nextConfig: AlertConfiguration) {
    const response = await fetch('/api/alerts/config', {
      method: 'PUT',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(nextConfig),
    });
    if (response.status === 401) {
      setAuthRequired(true);
      throw new Error('Autenticação obrigatória.');
    }
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Não foi possível salvar as regras de alerta.');
    }
    applySnapshot(data as MonitorSnapshot);
    showFeedback('success', 'Configurações de alertas E-mail e Telegram salvas.');
  }

  async function handleSendTestAlert(channel: AlertChannel) {
    const response = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ channel }),
    });
    if (response.status === 401) {
      setAuthRequired(true);
      throw new Error('Autenticação obrigatória.');
    }
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Erro ao disparar teste de notificação.');
    }
    applySnapshot(data.snapshot as MonitorSnapshot);
    const label = channel === 'email' ? 'E-mail' : 'Telegram';
    showFeedback(
      data.dispatch?.deliveryStatus === 'failed' ? 'error' : 'success',
      `Teste de alerta via ${label} processado. Consulte o Histórico de Disparos abaixo.`
    );
  }

  const activeIncidentCount = snapshot
    ? snapshot.incidents.filter((inc) => inc.status === 'active').length
    : 0;
  const demoMode = Boolean(snapshot?.capabilities.demoMode);
  const actionsEnabled = Boolean(snapshot?.capabilities.actionsEnabled);
  const dockerUnavailable = Boolean(snapshot?.capabilities.dockerUnavailable);

  return (
    <div className="min-h-screen bg-[#08090B] text-[#F5F5F7] flex flex-col">
      <TopBar
        activeTab={activeTab}
        onSelectTab={(tab) => {
          setActiveTab(tab);
          if (tab === 'logs') setLogFilterContainerId('all');
        }}
        onRunProbe={() => void handleRunProbe()}
        isProbing={isProbing}
        activeIncidentCount={activeIncidentCount}
        demoMode={demoMode}
      />

      <main className="mx-auto w-full max-w-[1320px] flex-1 px-5 py-8 sm:px-8">
        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className={`mb-6 flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-sm ${
              feedback.tone === 'success'
                ? 'border-[#8057FF]/40 bg-[#121020] text-[#F5F5F7]'
                : 'border-[#F87171]/40 bg-[#1B1015] text-[#F5F5F7]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {feedback.tone === 'success' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[#A477FF]" aria-hidden="true" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-[#F87171]" aria-hidden="true" />
              )}
              <span>{feedback.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              aria-label="Fechar aviso"
              className="rounded-md p-1 text-[#AAB2C0] hover:text-[#F5F5F7]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {authRequired ? (
          <section className="mx-auto max-w-md rounded-xl border border-[#20232B] bg-[#0D0F14] p-7 space-y-5">
            <div className="flex items-center gap-2.5">
              <KeyRound className="h-5 w-5 text-[#A477FF]" aria-hidden="true" />
              <h1 className="text-lg font-semibold text-[#F5F5F7]">Autenticação necessária</h1>
            </div>
            <p className="text-xs leading-relaxed text-[#AAB2C0]">
              Esta instância do Chang’e Health exige o cabeçalho{' '}
              <span className="font-mono text-[#F5F5F7]">Authorization: Bearer</span> com o{' '}
              <span className="font-mono text-[#F5F5F7]">ADMIN_TOKEN</span> configurado no servidor.
              O token permanece apenas na memória desta aba.
            </p>
            {authError && (
              <p role="alert" className="text-xs text-[#F87171]">
                {authError}
              </p>
            )}
            <form onSubmit={handleUnlockWithToken} className="space-y-4">
              <div>
                <label htmlFor="admin-token-input" className="block text-xs font-medium text-[#AAB2C0]">
                  ADMIN_TOKEN
                </label>
                <input
                  id="admin-token-input"
                  type="password"
                  autoComplete="off"
                  value={authInput}
                  onChange={(e) => setAuthInput(e.target.value)}
                  placeholder="Cole o token Bearer do servidor"
                  className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="w-full rounded-lg bg-[#8057FF] px-4 py-2 text-sm font-medium text-[#F5F5F7] transition-colors hover:bg-[#936EFF]"
              >
                Autenticar sessão
              </button>
            </form>
          </section>
        ) : loading && !snapshot ? (
          <div className="space-y-6" aria-label="Carregando telemetria">
            <div className="h-52 animate-pulse rounded-xl border border-[#20232B] bg-[#0D0F14]" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              {[0, 1, 2, 3].map((idx) => (
                <div
                  key={idx}
                  className="h-24 animate-pulse rounded-xl border border-[#20232B] bg-[#0D0F14]"
                />
              ))}
            </div>
            <div className="h-72 animate-pulse rounded-xl border border-[#20232B] bg-[#0D0F14]" />
          </div>
        ) : loadError && !snapshot ? (
          <div className="rounded-xl border border-[#F87171]/40 bg-[#0D0F14] p-8 text-center space-y-4">
            <p className="text-base font-medium text-[#F5F5F7]">{loadError}</p>
            <button
              type="button"
              onClick={() => void fetchSnapshot()}
              className="rounded-lg bg-[#8057FF] px-4 py-2 text-sm font-medium text-[#F5F5F7] hover:bg-[#936EFF]"
            >
              Tentar novamente
            </button>
          </div>
        ) : snapshot ? (
          <>
            {activeTab === 'overview' && (
              <OverviewView
                snapshot={snapshot}
                busyContainerId={busyContainerId}
                lastPollAt={lastPollAt}
                isStale={isStale}
                onInspectContainer={(id) => {
                  setSelectedContainerId(id);
                  setActiveTab('containers');
                }}
                onSimulateFailure={(id, scenario) => void handleSimulateFailure(id, scenario)}
                onRestartContainer={(id) => void handleRestartContainer(id)}
                onOpenLogs={() => {
                  setLogFilterContainerId('all');
                  setActiveTab('logs');
                }}
                onOpenAlerts={() => setActiveTab('alerts')}
              />
            )}

            {activeTab === 'containers' && (
              <ContainersView
                containers={snapshot.containers}
                logs={snapshot.logs}
                selectedContainerId={selectedContainerId}
                busyContainerId={busyContainerId}
                demoMode={demoMode}
                actionsEnabled={actionsEnabled}
                dockerUnavailable={dockerUnavailable}
                onSelectContainer={setSelectedContainerId}
                onSimulateFailure={(id, scenario) => void handleSimulateFailure(id, scenario)}
                onRestartContainer={(id) => void handleRestartContainer(id)}
                onAddContainer={handleAddContainer}
                onRemoveContainer={handleRemoveContainer}
                onViewFullLogs={(id) => {
                  setLogFilterContainerId(id);
                  setActiveTab('logs');
                }}
              />
            )}

            {activeTab === 'logs' && (
              <LogsIncidentsView
                containers={snapshot.containers}
                incidents={snapshot.incidents}
                logs={snapshot.logs}
                initialContainerFilter={logFilterContainerId}
                busyContainerId={busyContainerId}
                actionsEnabled={actionsEnabled}
                onRestartContainer={(id) => void handleRestartContainer(id)}
              />
            )}

            {activeTab === 'alerts' && (
              <AlertsView
                config={snapshot.alertConfig}
                dispatches={snapshot.alertDispatches}
                capabilities={snapshot.capabilities}
                onSaveConfig={handleSaveAlertConfig}
                onSendTest={handleSendTestAlert}
              />
            )}
          </>
        ) : null}
      </main>

      <footer className="border-t border-[#20232B] bg-[#08090B]">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-4 px-5 py-5 text-xs text-[#747E91] sm:px-8">
          <span>Chang’e · Monitoramento Docker &amp; Disponibilidade</span>
          <a
            href="https://chang-e.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[#AAB2C0] transition-colors hover:text-[#F5F5F7]"
          >
            chang-e.app
          </a>
        </div>
      </footer>
    </div>
  );
}
