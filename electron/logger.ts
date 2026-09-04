import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** 保留最近多少个日志文件（按天滚动） */
const KEEP_LOG_FILES = 7;

/** 主进程文件日志：写入 userData/logs，按天滚动，自动清理旧文件 */
export class Logger {
  private readonly dir: string;

  constructor() {
    this.dir = join(app.getPath('userData'), 'logs');
    // 目录创建失败（如无写权限）时静默降级为仅终端输出
    try {
      mkdirSync(this.dir, { recursive: true });
      this.prune();
    } catch {
      /* ignore */
    }
  }

  /** 日志目录（错误页提示用） */
  get logDir(): string {
    return this.dir;
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  error(message: string): void {
    this.write('ERROR', message);
  }

  // ---------- 内部 ----------

  private write(level: 'INFO' | 'ERROR', message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message.replace(/\r?\n/g, ' ')}\n`;
    // 文件写失败不应影响主流程，静默忽略（如无写权限的环境）
    try {
      appendFileSync(this.file(), line);
    } catch {
      /* ignore */
    }
    // 同步输出到终端，便于开发与排障
    (level === 'ERROR' ? console.error : console.log)(line.trimEnd());
  }

  private file(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return join(this.dir, `main-${stamp}.log`);
  }

  /** 清理超出保留数量的旧日志 */
  private prune(): void {
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.startsWith('main-') && f.endsWith('.log'))
        .sort();
      for (const f of files.slice(0, -KEEP_LOG_FILES)) {
        rmSync(join(this.dir, f), { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}
