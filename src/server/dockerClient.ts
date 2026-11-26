import http from 'node:http';
import {
  computeBackoffMs,
  computeDockerCpuPercent,
  computeDockerMemoryStats,
  demuxDockerLogs,
  parseDockerHost,
  redactSecrets,
  type DockerConnectionTarget,
} from '../lib/securityAndDocker';

export interface DockerListContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Ports?: Array<{ PrivatePort: number; PublicPort?: number; Type?: string }>;
  NetworkSettings?: { Networks?: Record<string, unknown> };
}

export interface DockerInspectContainer {
  Id: string;
  Name: string;
  Config?: {
    Image?: string;
    Healthcheck?: { Test?: string[] };
  };
  HostConfig?: {
    Memory?: number;
  };
  RestartCount?: number;
  State?: {
    Status?: string;
    Running?: boolean;
    OOMKilled?: boolean;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: {
      Status?: string;
    };
  };
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
  };
}

export interface DockerEventPayload {
  Type?: string;
  Action?: string;
  status?: string;
  id?: string;
  time?: number;
  Actor?: {
    ID?: string;
    Attributes?: Record<string, string>;
  };
}

export class DockerClient {
  private readonly target: DockerConnectionTarget;

  constructor(dockerHostEnv?: string, defaultSocketPath: string = '/var/run/docker.sock') {
    this.target = parseDockerHost(dockerHostEnv, defaultSocketPath);
  }

  public getConnectionSummary(): string {
    return this.target.kind === 'tcp'
      ? `tcp://${this.target.hostname}:${this.target.port}`
      : this.target.socketPath;
  }

  private buildRequestOptions(
    apiPath: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    timeoutMs: number = 4000
  ): http.RequestOptions {
    if (this.target.kind === 'tcp') {
      return {
        hostname: this.target.hostname,
        port: this.target.port,
        path: apiPath,
        method,
        timeout: timeoutMs,
      };
    }
    return {
      socketPath: this.target.socketPath,
      path: apiPath,
      method,
      timeout: timeoutMs,
    };
  }

  private requestRaw(
    apiPath: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    timeoutMs: number = 4000
  ): Promise<{ statusCode: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request(this.buildRequestOptions(apiPath, method, timeoutMs), (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Timeout ao conectar ao Docker em ${this.getConnectionSummary()}.`));
      });
      req.on('error', (err) => {
        reject(err);
      });
      req.end();
    });
  }

  private async requestJson<T>(apiPath: string, timeoutMs: number = 4000): Promise<T> {
    const { statusCode, body } = await this.requestRaw(apiPath, 'GET', timeoutMs);
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Docker API retornou HTTP ${statusCode} em ${apiPath}.`);
    }
    return JSON.parse(body.toString('utf-8')) as T;
  }

  public async listContainers(): Promise<DockerListContainer[]> {
    return this.requestJson<DockerListContainer[]>('/containers/json?all=1', 4000);
  }

  public async inspectContainer(containerId: string): Promise<DockerInspectContainer> {
    return this.requestJson<DockerInspectContainer>(
      `/containers/${encodeURIComponent(containerId)}/json`,
      4000
    );
  }

  public async getContainerStats(
    containerId: string
  ): Promise<{ cpuPercent: number; memoryMb: number; memoryLimitMb: number }> {
    const raw = await this.requestJson<Record<string, unknown>>(
      `/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
      4500
    );
    const cpuPercent = computeDockerCpuPercent(raw as Parameters<typeof computeDockerCpuPercent>[0]);
    const mem = computeDockerMemoryStats(raw as Parameters<typeof computeDockerMemoryStats>[0]);
    return {
      cpuPercent,
      memoryMb: mem.memoryMb,
      memoryLimitMb: mem.memoryLimitMb,
    };
  }

  public async getContainerStderrLogs(containerId: string, tail: number = 50): Promise<string[]> {
    const safeTail = Math.max(1, Math.min(200, Math.floor(tail)));
    const { statusCode, body } = await this.requestRaw(
      `/containers/${encodeURIComponent(containerId)}/logs?stderr=1&tail=${safeTail}`,
      'GET',
      4500
    );
    if (statusCode < 200 || statusCode >= 300) {
      return [];
    }
    const lines = demuxDockerLogs(body);
    return lines.map((line) => redactSecrets(line));
  }

  public async restartContainer(containerId: string): Promise<void> {
    const { statusCode } = await this.requestRaw(
      `/containers/${encodeURIComponent(containerId)}/restart`,
      'POST',
      10_000
    );
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Docker recusou o reinício (HTTP ${statusCode}). Verifique se o proxy permite POST.`
      );
    }
  }

  /**
   * Subscribe to real Docker events (die, oom, health_status) with automatic
   * exponential backoff reconnection. Returns a stop() handle.
   */
  public subscribeEvents(
    onEvent: (event: DockerEventPayload) => void | Promise<void>,
    onConnectionChange?: (connected: boolean, errMsg?: string) => void
  ): { stop: () => void } {
    let stopped = false;
    let attempt = 0;
    let activeReq: http.ClientRequest | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const filters = JSON.stringify({
      type: ['container'],
      event: ['die', 'oom', 'health_status'],
    });
    const eventsPath = `/events?filters=${encodeURIComponent(filters)}`;

    const scheduleReconnect = (errMsg?: string) => {
      if (stopped) return;
      onConnectionChange?.(false, errMsg);
      const delayMs = computeBackoffMs(attempt, 1000, 30_000);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (stopped) return;
      const reqOpts = this.buildRequestOptions(eventsPath, 'GET', 0);
      delete reqOpts.timeout; // Long-lived streaming response

      const req = http.request(reqOpts, (res) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          res.resume();
          scheduleReconnect(`Docker /events retornou HTTP ${res.statusCode}`);
          return;
        }

        attempt = 0;
        onConnectionChange?.(true);

        let buffer = '';
        res.on('data', (chunk: Buffer | string) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed) as DockerEventPayload;
              void Promise.resolve(onEvent(parsed)).catch(() => {
                // Keep event stream alive even if handler fails
              });
            } catch {
              // Ignore malformed JSON chunk
            }
          }
        });

        res.on('end', () => {
          scheduleReconnect('Stream Docker /events encerrado.');
        });

        res.on('error', (err) => {
          scheduleReconnect(err.message);
        });
      });

      req.on('error', (err) => {
        scheduleReconnect(err.message);
      });

      req.end();
      activeReq = req;
    };

    connect();

    return {
      stop: () => {
        stopped = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (activeReq) {
          activeReq.destroy();
          activeReq = null;
        }
      },
    };
  }
}
