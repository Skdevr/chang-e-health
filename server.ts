import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHealthStoreFromEnv, type HealthMonitorStore } from './src/server/healthStore';
import {
  createRateLimiter,
  extractBearerToken,
  timingSafeTokenEqual,
} from './src/server/security';
import type { AlertChannel, FailureScenario } from './src/types/health';

const ALLOWED_SCENARIOS = new Set<FailureScenario>(['oom', 'crash', 'timeout', 'db_pool']);
const ALLOWED_CHANNELS = new Set<AlertChannel>(['email', 'telegram']);

export interface AppServerOptions {
  store: HealthMonitorStore;
  adminToken: string;
  demoMode: boolean;
  allowActions: boolean;
  testRateLimitMax?: number;
  testRateLimitWindowMs?: number;
}

export function createApiApp(options: AppServerOptions): express.Express {
  const { store, adminToken, demoMode, allowActions } = options;
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const testAlertLimiter = createRateLimiter({
    windowMs: options.testRateLimitWindowMs ?? 60_000,
    maxRequests: options.testRateLimitMax ?? 5,
  });

  // Public liveness endpoint (always 200, no sensitive details)
  app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Auth middleware protecting all other /api/* routes when ADMIN_TOKEN is configured
  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!adminToken) {
      next();
      return;
    }
    const provided = extractBearerToken(req.headers.authorization);
    if (!provided || !timingSafeTokenEqual(provided, adminToken)) {
      res.status(401).json({
        error: 'Autenticação necessária. Envie Authorization: Bearer <ADMIN_TOKEN>.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }
    next();
  };

  // Strict guard for administrative container actions (restart / delete)
  const requireActionsEnabled: express.RequestHandler = (req, res, next) => {
    if (!allowActions) {
      res.status(403).json({
        error: 'Ações administrativas desabilitadas (defina ALLOW_ACTIONS=true).',
      });
      return;
    }
    if (!adminToken) {
      res.status(403).json({
        error: 'Ações administrativas exigem ADMIN_TOKEN configurado no servidor.',
      });
      return;
    }
    const provided = extractBearerToken(req.headers.authorization);
    if (!provided || !timingSafeTokenEqual(provided, adminToken)) {
      res.status(401).json({
        error: 'Autenticação necessária para executar esta ação.',
        code: 'AUTH_REQUIRED',
      });
      return;
    }
    next();
  };

  app.use('/api', (req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }
    requireAuth(req, res, next);
  });

  app.get('/api/health/snapshot', async (_req, res) => {
    if (!demoMode) {
      await store.refreshRealDockerContainers();
    }
    const snapshot = store.getSnapshot();
    if (snapshot.capabilities.dockerUnavailable) {
      res.status(503).json({
        ...snapshot,
        error: 'Docker indisponível',
        code: 'DOCKER_UNAVAILABLE',
      });
      return;
    }
    res.json(snapshot);
  });

  app.post('/api/health/probe', async (_req, res) => {
    try {
      const snapshot = await store.runLiveProbe();
      if (snapshot.capabilities.dockerUnavailable) {
        res.status(503).json({
          ...snapshot,
          error: 'Docker indisponível',
          code: 'DOCKER_UNAVAILABLE',
        });
        return;
      }
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Falha ao executar verificação ativa.',
      });
    }
  });

  app.post('/api/containers', async (req, res) => {
    if (!demoMode && !allowActions) {
      res.status(403).json({
        error: 'Cadastro manual de serviços desabilitado em modo Docker real.',
      });
      return;
    }
    try {
      const body = req.body ?? {};
      const snapshot = await store.addContainer({
        name: String(body.name ?? ''),
        role: String(body.role ?? ''),
        image: String(body.image ?? ''),
        ports: String(body.ports ?? ''),
        healthCommand: String(body.healthCommand ?? ''),
        healthEndpoint: body.healthEndpoint ? String(body.healthEndpoint) : undefined,
        memoryLimitMb: body.memoryLimitMb ? Number(body.memoryLimitMb) : undefined,
      });
      res.status(201).json(snapshot);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Dados inválidos para o container.',
      });
    }
  });

  app.delete('/api/containers/:id', requireActionsEnabled, async (req, res) => {
    try {
      const snapshot = await store.removeContainer(String(req.params.id ?? ''));
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Não foi possível remover o container.',
      });
    }
  });

  app.post('/api/containers/:id/simulate-failure', async (req, res) => {
    if (!demoMode) {
      res.status(404).json({ error: 'Rota disponível apenas com DEMO_MODE=true.' });
      return;
    }
    try {
      const scenario = String(req.body?.scenario ?? 'oom') as FailureScenario;
      if (!ALLOWED_SCENARIOS.has(scenario)) {
        res.status(400).json({ error: 'Cenário de falha inválido.' });
        return;
      }
      const snapshot = await store.triggerContainerFailure(
        String(req.params.id ?? ''),
        scenario
      );
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Erro ao simular interrupção.',
      });
    }
  });

  app.post('/api/containers/:id/restart', requireActionsEnabled, async (req, res) => {
    try {
      const snapshot = await store.restartContainer(String(req.params.id ?? ''));
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Erro ao reiniciar container.',
      });
    }
  });

  app.put('/api/alerts/config', async (req, res) => {
    try {
      const body = req.body ?? {};
      const snapshot = await store.updateAlertConfig({
        emailEnabled: Boolean(body.emailEnabled),
        emailRecipients: Array.isArray(body.emailRecipients)
          ? body.emailRecipients.map(String)
          : undefined,
        emailSubjectPrefix:
          typeof body.emailSubjectPrefix === 'string' ? body.emailSubjectPrefix : undefined,
        telegramEnabled: Boolean(body.telegramEnabled),
        telegramChatLabel:
          typeof body.telegramChatLabel === 'string' ? body.telegramChatLabel : undefined,
        notifyOnStop: Boolean(body.notifyOnStop),
        notifyOnUnhealthy: Boolean(body.notifyOnUnhealthy),
        notifyOnHighLatency: Boolean(body.notifyOnHighLatency),
        notifyOnRecovery: Boolean(body.notifyOnRecovery),
        highLatencyThresholdMs:
          body.highLatencyThresholdMs !== undefined
            ? Number(body.highLatencyThresholdMs)
            : undefined,
        cooldownMinutes:
          body.cooldownMinutes !== undefined ? body.cooldownMinutes : undefined,
        probeIntervalSeconds:
          body.probeIntervalSeconds !== undefined
            ? Number(body.probeIntervalSeconds)
            : undefined,
      });
      res.json(snapshot);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Configuração de alertas inválida.',
      });
    }
  });

  app.post('/api/alerts/test', async (req, res) => {
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const rate = testAlertLimiter.check(clientKey);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Limite de envios de teste excedido. Tente novamente em ${rate.retryAfterSeconds}s.`,
      });
      return;
    }

    try {
      const channel = String(req.body?.channel ?? '') as AlertChannel;
      if (!ALLOWED_CHANNELS.has(channel)) {
        res.status(400).json({ error: 'Canal inválido. Use email ou telegram.' });
        return;
      }
      const result = await store.sendTestNotification(channel);
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Falha ao enviar teste de notificação.',
      });
    }
  });

  return app;
}

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const adminToken = process.env.ADMIN_TOKEN?.trim() || '';
  const demoMode = process.env.DEMO_MODE === 'true';
  const allowActions = process.env.ALLOW_ACTIONS === 'true';
  const host = process.env.HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);

  if (isProduction && !adminToken) {
    console.error(
      '[Chang\'e Health] ERRO FATAL: ADMIN_TOKEN é obrigatório em produção (NODE_ENV=production). Encerrando.'
    );
    process.exit(1);
  }

  const store = createHealthStoreFromEnv();
  store.startBackgroundMonitors();

  const app = createApiApp({
    store,
    adminToken,
    demoMode,
    allowActions,
  });

  // Initial background probe without blocking startup
  void store.runLiveProbe().catch(() => {
    // Non-fatal if outbound HTTPS is temporarily unreachable
  });

  const distDir = path.resolve(process.cwd(), 'dist');

  if (isProduction && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    // Dynamic import keeps Vite out of production runtime dependencies
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(port, host, () => {
    console.log(
      `Chang'e Health Monitor listening on http://${host}:${port} (mode=${
        demoMode ? 'DEMO' : 'PRODUCTION_DOCKER'
      }, actions=${allowActions ? 'enabled' : 'disabled'}, auth=${
        adminToken ? 'required' : 'open-dev'
      })`
    );
  });

  const gracefulShutdown = async () => {
    server.close();
    await store.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void gracefulShutdown());
  process.on('SIGINT', () => void gracefulShutdown());
}

// Only start server when executed directly (allows importing createApiApp in tests)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
