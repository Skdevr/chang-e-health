import fs from 'node:fs';
import path from 'node:path';

export interface AtomicLoadResult<T> {
  data: T;
  recoveredFromCorrupt: boolean;
  backupPath?: string;
}

/**
 * Atomic JSON file persistence with:
 * - Strict directory confinement inside DATA_DIR
 * - Write queue preventing concurrent write races
 * - Atomic temp-file write + rename
 * - Automatic backup & clean fallback when encountering corrupted JSON on startup
 */
export class AtomicJsonStore<T> {
  private readonly dataDir: string;
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private pendingSnapshot: string | null = null;
  private scheduled = false;

  constructor(dataDir: string, filename: string = 'state.json') {
    const resolvedDir = path.resolve(dataDir);
    const cleanName = path.basename(filename);
    const resolvedFile = path.resolve(resolvedDir, cleanName);

    if (!resolvedFile.startsWith(resolvedDir + path.sep)) {
      throw new Error('Caminho de persistência fora de DATA_DIR não é permitido.');
    }

    this.dataDir = resolvedDir;
    this.filePath = resolvedFile;
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public loadSync(fallbackFactory: () => T, validator?: (parsed: unknown) => parsed is T): AtomicLoadResult<T> {
    fs.mkdirSync(this.dataDir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      return { data: fallbackFactory(), recoveredFromCorrupt: false };
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (validator && !validator(parsed)) {
        throw new Error('Estrutura JSON inválida no arquivo de estado.');
      }
      return { data: parsed as T, recoveredFromCorrupt: false };
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.basename(this.filePath, '.json');
      const backupPath = path.resolve(this.dataDir, `${base}.corrupt.${stamp}.json`);
      try {
        if (backupPath.startsWith(this.dataDir + path.sep)) {
          fs.renameSync(this.filePath, backupPath);
        }
      } catch {
        // Ignore rename failure if file vanished
      }
      return {
        data: fallbackFactory(),
        recoveredFromCorrupt: true,
        backupPath,
      };
    }
  }

  /**
   * Enqueue an atomic write (temp file + rename). Coalesces rapid burst saves
   * while guaranteeing sequential, non-overlapping filesystem writes.
   */
  public enqueueSave(data: T): Promise<void> {
    this.pendingSnapshot = JSON.stringify(data, null, 2);

    if (!this.scheduled) {
      this.scheduled = true;
      this.writeChain = this.writeChain
        .then(async () => {
          while (this.pendingSnapshot !== null) {
            const payload = this.pendingSnapshot;
            this.pendingSnapshot = null;
            await this.writeAtomically(payload);
          }
        })
        .finally(() => {
          this.scheduled = false;
        });
    }

    return this.writeChain;
  }

  public async flush(): Promise<void> {
    await this.writeChain;
  }

  private async writeAtomically(serialized: string): Promise<void> {
    await fs.promises.mkdir(this.dataDir, { recursive: true });
    const tmpName = `.${path.basename(this.filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const tmpPath = path.resolve(this.dataDir, tmpName);

    if (!tmpPath.startsWith(this.dataDir + path.sep)) {
      throw new Error('Caminho temporário fora de DATA_DIR.');
    }

    try {
      await fs.promises.writeFile(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
      await fs.promises.rename(tmpPath, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) {
          await fs.promises.unlink(tmpPath);
        }
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }
}
