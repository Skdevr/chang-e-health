import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Mail,
  Send,
} from 'lucide-react';
import { validateCooldownMinutes } from '../lib/securityAndDocker';
import type {
  AlertChannel,
  AlertConfiguration,
  AlertDispatchRecord,
  ServerEnvironmentCapabilities,
} from '../types/health';

interface AlertsViewProps {
  config: AlertConfiguration;
  dispatches: AlertDispatchRecord[];
  capabilities: ServerEnvironmentCapabilities;
  onSaveConfig: (config: AlertConfiguration) => Promise<void>;
  onSendTest: (channel: AlertChannel) => Promise<void>;
}

const DOCKER_COMPOSE_SNIPPET = `services:
  docker-proxy:
    image: tecnativa/docker-socket-proxy:0.3
    restart: unless-stopped
    environment:
      CONTAINERS: "1"
      EVENTS: "1"
      POST: "0"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - proxy_internal

  health:
    build: .
    restart: unless-stopped
    mem_limit: 256m
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - .env
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      DEMO_MODE: "false"
      ALLOW_ACTIONS: "false"
      DOCKER_HOST: tcp://docker-proxy:2375
      DATA_DIR: /data
    volumes:
      - change_health_data:/data
    depends_on:
      - docker-proxy
    networks:
      - proxy_internal
      - change_app_net

volumes:
  change_health_data:

networks:
  proxy_internal:
    internal: true
  change_app_net:
    external: true`;

function deliveryStatusLabel(status: AlertDispatchRecord['deliveryStatus']) {
  if (status === 'sent_live') {
    return { text: 'Enviado ao vivo', color: 'text-[#34D399]' };
  }
  if (status === 'failed') {
    return { text: 'Falha no envio', color: 'text-[#F87171]' };
  }
  return { text: 'Registrado (aguardando credenciais env)', color: 'text-[#A5A4FF]' };
}

export function AlertsView({
  config,
  dispatches,
  capabilities,
  onSaveConfig,
  onSendTest,
}: AlertsViewProps) {
  const [emailEnabled, setEmailEnabled] = useState(config.emailEnabled);
  const [emailInput, setEmailInput] = useState(config.emailRecipients.join(', '));
  const [subjectPrefix, setSubjectPrefix] = useState(config.emailSubjectPrefix);
  const [telegramEnabled, setTelegramEnabled] = useState(config.telegramEnabled);
  const [telegramChatLabel, setTelegramChatLabel] = useState(config.telegramChatLabel);
  const [notifyOnStop, setNotifyOnStop] = useState(config.notifyOnStop);
  const [notifyOnUnhealthy, setNotifyOnUnhealthy] = useState(config.notifyOnUnhealthy);
  const [notifyOnHighLatency, setNotifyOnHighLatency] = useState(config.notifyOnHighLatency);
  const [notifyOnRecovery, setNotifyOnRecovery] = useState(config.notifyOnRecovery);
  const [highLatencyThresholdMs, setHighLatencyThresholdMs] = useState(
    String(config.highLatencyThresholdMs)
  );
  const [cooldownMinutes, setCooldownMinutes] = useState(String(config.cooldownMinutes));

  const [saving, setSaving] = useState(false);
  const [testingChannel, setTestingChannel] = useState<AlertChannel | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [expandedDispatchId, setExpandedDispatchId] = useState<string | null>(null);
  const [copiedCompose, setCopiedCompose] = useState(false);

  useEffect(() => {
    setEmailEnabled(config.emailEnabled);
    setEmailInput(config.emailRecipients.join(', '));
    setSubjectPrefix(config.emailSubjectPrefix);
    setTelegramEnabled(config.telegramEnabled);
    setTelegramChatLabel(config.telegramChatLabel);
    setNotifyOnStop(config.notifyOnStop);
    setNotifyOnUnhealthy(config.notifyOnUnhealthy);
    setNotifyOnHighLatency(config.notifyOnHighLatency);
    setNotifyOnRecovery(config.notifyOnRecovery);
    setHighLatencyThresholdMs(String(config.highLatencyThresholdMs));
    setCooldownMinutes(String(config.cooldownMinutes));
  }, [config]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const parsedEmails = emailInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (emailEnabled && parsedEmails.length === 0) {
      setFormError('Informe pelo menos um destinatário de e-mail para alertas SMTP.');
      return;
    }

    const cooldownCheck = validateCooldownMinutes(Number(cooldownMinutes));
    if (!cooldownCheck.valid || cooldownCheck.value === undefined || cooldownMinutes.trim() === '') {
      setFormError(cooldownCheck.error || 'O intervalo mínimo entre alertas deve ser um inteiro >= 0.');
      return;
    }

    const parsedLatency = Number(highLatencyThresholdMs);
    if (!Number.isInteger(parsedLatency) || parsedLatency < 50 || parsedLatency > 30000) {
      setFormError('O limite de latência deve ser um inteiro entre 50 e 30000 ms.');
      return;
    }

    setSaving(true);
    try {
      await onSaveConfig({
        ...config,
        emailEnabled,
        emailRecipients: parsedEmails,
        emailSubjectPrefix: subjectPrefix,
        telegramEnabled,
        telegramChatLabel,
        notifyOnStop,
        notifyOnUnhealthy,
        notifyOnHighLatency,
        notifyOnRecovery,
        highLatencyThresholdMs: parsedLatency,
        cooldownMinutes: cooldownCheck.value,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erro ao salvar preferências.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(channel: AlertChannel) {
    setFormError(null);
    setTestingChannel(channel);
    try {
      await onSendTest(channel);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Erro ao enviar teste.');
    } finally {
      setTestingChannel(null);
    }
  }

  function handleCopyCompose() {
    void navigator.clipboard?.writeText(DOCKER_COMPOSE_SNIPPET);
    setCopiedCompose(true);
    setTimeout(() => setCopiedCompose(false), 1800);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#F5F5F7]">
          Alertas Automáticos — E-mail e Telegram
        </h1>
        <p className="mt-1 text-sm text-[#AAB2C0]">
          Configure destinatários, regras de disparo imediato em quedas de container e acompanhe cada notificação enviada.
        </p>
      </div>

      <form onSubmit={handleSave} noValidate className="space-y-6">
        {formError && (
          <div
            role="alert"
            className="rounded-xl border border-[#F87171]/40 bg-[#1B1015] px-5 py-3.5 text-sm text-[#F87171]"
          >
            {formError}
          </div>
        )}

        {/* Two Channel Panels */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Email SMTP Panel */}
          <section className="rounded-xl border border-[#20232B] bg-[#0D0F14] p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-base font-semibold text-[#F5F5F7]">
                  <Mail className="h-4 w-4 text-[#A477FF]" aria-hidden="true" />
                  <h2>Notificações por E-mail (SMTP)</h2>
                </div>
                <p className="text-xs text-[#747E91]">
                  {capabilities.smtpConfigured
                    ? 'Servidor SMTP ativo via variáveis de ambiente.'
                    : 'Modo de auditoria local · Defina SMTP_HOST, SMTP_USER e SMTP_PASS no servidor para envio real.'}
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-[#AAB2C0] cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={emailEnabled}
                  onChange={(e) => setEmailEnabled(e.target.checked)}
                  className="h-4 w-4 accent-[#8057FF]"
                />
                <span>Ativo</span>
              </label>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="email-recipients" className="block text-xs font-medium text-[#AAB2C0]">
                  Destinatários (separados por vírgula)
                </label>
                <input
                  id="email-recipients"
                  type="text"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="ops@chang-e.app, devops@chang-e.app"
                  className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="email-prefix" className="block text-xs font-medium text-[#AAB2C0]">
                  Prefixo do assunto
                </label>
                <input
                  id="email-prefix"
                  type="text"
                  value={subjectPrefix}
                  onChange={(e) => setSubjectPrefix(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 text-sm text-[#F5F5F7] focus:border-[#8057FF] focus:outline-none"
                />
              </div>
            </div>

            <div className="pt-1">
              <button
                type="button"
                onClick={() => void handleTest('email')}
                disabled={testingChannel === 'email'}
                className="inline-flex items-center gap-2 rounded-lg border border-[#20232B] bg-[#08090B] px-3.5 py-2 text-xs font-medium text-[#F5F5F7] transition-colors hover:border-[#8057FF]/60 disabled:opacity-50"
              >
                <Mail className="h-3.5 w-3.5 text-[#A477FF]" aria-hidden="true" />
                <span>
                  {testingChannel === 'email' ? 'Enviando teste...' : 'Enviar teste por E-mail'}
                </span>
              </button>
            </div>
          </section>

          {/* Telegram Bot API Panel */}
          <section className="rounded-xl border border-[#20232B] bg-[#0D0F14] p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-base font-semibold text-[#F5F5F7]">
                  <Send className="h-4 w-4 text-[#5CA8FF]" aria-hidden="true" />
                  <h2>Notificações via Telegram</h2>
                </div>
                <p className="text-xs text-[#747E91]">
                  {capabilities.telegramConfigured
                    ? 'Bot Telegram conectado via variáveis de ambiente.'
                    : 'Modo de auditoria local · Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no servidor para envio real.'}
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-xs font-medium text-[#AAB2C0] cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={telegramEnabled}
                  onChange={(e) => setTelegramEnabled(e.target.checked)}
                  className="h-4 w-4 accent-[#8057FF]"
                />
                <span>Ativo</span>
              </label>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="tg-chat-label" className="block text-xs font-medium text-[#AAB2C0]">
                  Rótulo do canal/grupo (exibição na UI)
                </label>
                <input
                  id="tg-chat-label"
                  type="text"
                  value={telegramChatLabel}
                  onChange={(e) => setTelegramChatLabel(e.target.value)}
                  placeholder="@change_ops_alerts"
                  className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] placeholder:text-[#747E91] focus:border-[#8057FF] focus:outline-none"
                />
              </div>

              <div className="rounded-lg border border-[#20232B] bg-[#08090B] p-3 text-xs text-[#747E91] leading-relaxed">
                O destino real das mensagens é o ID numérico definido em{' '}
                <span className="font-mono text-[#AAB2C0]">TELEGRAM_CHAT_ID</span> no servidor. O campo
                acima serve apenas como rótulo visual. Credenciais do Bot (
                <span className="font-mono text-[#AAB2C0]">TELEGRAM_BOT_TOKEN</span>) permanecem
                exclusivamente em variáveis de ambiente e nunca aparecem no payload.
              </div>
            </div>

            <div className="pt-1">
              <button
                type="button"
                onClick={() => void handleTest('telegram')}
                disabled={testingChannel === 'telegram'}
                className="inline-flex items-center gap-2 rounded-lg border border-[#20232B] bg-[#08090B] px-3.5 py-2 text-xs font-medium text-[#F5F5F7] transition-colors hover:border-[#5CA8FF]/60 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5 text-[#5CA8FF]" aria-hidden="true" />
                <span>
                  {testingChannel === 'telegram' ? 'Enviando teste...' : 'Enviar teste no Telegram'}
                </span>
              </button>
            </div>
          </section>
        </div>

        {/* Trigger Rules & Save */}
        <section className="rounded-xl border border-[#20232B] bg-[#0D0F14] p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#20232B] pb-4">
            <div>
              <h2 className="text-base font-semibold text-[#F5F5F7]">
                Regras de Disparo Automático
              </h2>
              <p className="mt-0.5 text-xs text-[#747E91]">
                Defina quais eventos de saúde acionam notificações imediatas
              </p>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-[#8057FF] px-4 py-2 text-sm font-medium text-[#F5F5F7] transition-colors hover:bg-[#936EFF] disabled:opacity-60 whitespace-nowrap"
            >
              {saving ? 'Salvando...' : 'Salvar configurações'}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex items-start gap-2.5 text-xs text-[#AAB2C0] cursor-pointer">
              <input
                type="checkbox"
                checked={notifyOnStop}
                onChange={(e) => setNotifyOnStop(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#8057FF]"
              />
              <span>
                <strong className="block text-[#F5F5F7] font-medium">Container parado</strong>
                Dispara em Exit 1, 137 (OOM) ou queda abrupta
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-xs text-[#AAB2C0] cursor-pointer">
              <input
                type="checkbox"
                checked={notifyOnUnhealthy}
                onChange={(e) => setNotifyOnUnhealthy(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#8057FF]"
              />
              <span>
                <strong className="block text-[#F5F5F7] font-medium">Healthcheck com erro</strong>
                Dispara quando o serviço fica degradado ou 503
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-xs text-[#AAB2C0] cursor-pointer">
              <input
                type="checkbox"
                checked={notifyOnHighLatency}
                onChange={(e) => setNotifyOnHighLatency(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#8057FF]"
              />
              <span>
                <strong className="block text-[#F5F5F7] font-medium">Alta latência</strong>
                Alerta acima do limite de resposta configurado
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-xs text-[#AAB2C0] cursor-pointer">
              <input
                type="checkbox"
                checked={notifyOnRecovery}
                onChange={(e) => setNotifyOnRecovery(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[#8057FF]"
              />
              <span>
                <strong className="block text-[#F5F5F7] font-medium">Notificar recuperação</strong>
                Confirma quando o container volta ao estado saudável
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2 max-w-lg">
            <div>
              <label htmlFor="latency-limit" className="block text-xs font-medium text-[#AAB2C0]">
                Limite de latência (ms)
              </label>
              <input
                id="latency-limit"
                type="number"
                min={50}
                max={10000}
                value={highLatencyThresholdMs}
                onChange={(e) => setHighLatencyThresholdMs(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] focus:border-[#8057FF] focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="cooldown-min" className="block text-xs font-medium text-[#AAB2C0]">
                Intervalo mínimo entre alertas (min)
              </label>
              <input
                id="cooldown-min"
                type="number"
                step={1}
                min={0}
                max={1440}
                value={cooldownMinutes}
                onChange={(e) => setCooldownMinutes(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[#20232B] bg-[#08090B] px-3 py-2 font-mono text-sm text-[#F5F5F7] focus:border-[#8057FF] focus:outline-none"
              />
            </div>
          </div>
        </section>
      </form>

      {/* Dispatch History Table */}
      <section className="rounded-xl border border-[#20232B] bg-[#0D0F14]">
        <div className="flex items-center justify-between border-b border-[#20232B] px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#F5F5F7]">
              Histórico de Disparos
            </h2>
            <p className="mt-0.5 text-xs text-[#747E91]">
              Auditoria completa dos alertas enviados via E-mail e Telegram com prévia do payload
            </p>
          </div>
          <span className="font-mono text-xs text-[#AAB2C0] tabular-nums">
            {dispatches.length} registro(s)
          </span>
        </div>

        <div className="divide-y divide-[#20232B]/70">
          {dispatches.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#747E91]">
              Nenhum alerta disparado até o momento.
            </div>
          ) : (
            dispatches.map((item) => {
              const statusMeta = deliveryStatusLabel(item.deliveryStatus);
              const isExpanded = expandedDispatchId === item.id;
              return (
                <div key={item.id} className="px-6 py-4 space-y-3">
                  <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                        <span className="font-medium text-[#F5F5F7]">
                          {item.channel === 'email' ? 'E-mail' : 'Telegram'}
                        </span>
                        <span aria-hidden="true" className="text-[#747E91]">·</span>
                        <span className="font-mono text-[#A5A4FF]">{item.containerName}</span>
                        <span aria-hidden="true" className="text-[#747E91]">·</span>
                        <span className={statusMeta.color}>{statusMeta.text}</span>
                      </div>
                      <p className="text-xs text-[#AAB2C0]">
                        {item.subject} — Destino: <span className="font-mono">{item.recipient}</span>
                      </p>
                    </div>

                    <div className="flex items-center gap-4 shrink-0">
                      <span className="font-mono text-xs text-[#747E91] tabular-nums">
                        {new Date(item.dispatchedAt).toLocaleString('pt-BR')} · {item.latencyMs}ms
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedDispatchId(isExpanded ? null : item.id)
                        }
                        aria-expanded={isExpanded}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#5CA8FF] hover:text-[#A5A4FF]"
                      >
                        <span>{isExpanded ? 'Ocultar payload' : 'Ver payload'}</span>
                        {isExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="space-y-2 rounded-lg border border-[#20232B] bg-[#08090B] p-4">
                      <p className="text-xs text-[#747E91]">{item.deliveryNote}</p>
                      <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-[#AAB2C0] whitespace-pre-wrap">
                        {item.messagePreview}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* Production Docker Compose Integration Guide */}
      <section className="rounded-xl border border-[#20232B] bg-[#0D0F14] p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#F5F5F7]">
              Integração Docker em Produção (chang-e.app)
            </h2>
            <p className="mt-0.5 text-xs text-[#747E91]">
              Monte o socket somente-leitura do Docker no servidor para inspecionar containers reais automaticamente
            </p>
          </div>
          <button
            type="button"
            onClick={handleCopyCompose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#20232B] px-3 py-1.5 text-xs font-medium text-[#AAB2C0] transition-colors hover:border-[#8057FF]/60 hover:text-[#F5F5F7]"
          >
            {copiedCompose ? (
              <Check className="h-3.5 w-3.5 text-[#34D399]" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{copiedCompose ? 'YAML copiado' : 'Copiar docker-compose.yml'}</span>
          </button>
        </div>

        <pre className="overflow-x-auto rounded-lg border border-[#20232B] bg-[#08090B] p-4 font-mono text-xs leading-relaxed text-[#AAB2C0]">
          {DOCKER_COMPOSE_SNIPPET}
        </pre>
      </section>
    </div>
  );
}
