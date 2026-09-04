import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** dsh 管理器事件 */
export interface DshManagerEvents {
  /** dsh 服务退出 */
  onExit: (code: number | null) => void;
  /** dsh 服务意外崩溃（非用户主动停止） */
  onCrash: (code: number | null) => void;
  /** 进程存活但服务无响应（连续健康检查失败） */
  onHung: (port: number) => void;
  /** 服务输出一行日志 */
  onLog: (line: string) => void;
}

/** dsh 管理器构造选项 */
export interface DshManagerOptions {
  events?: Partial<DshManagerEvents>;
  /**
   * v0.1.1+：首启从 resources/node-runtime.tar 解压出的内置运行时目录
   * （userData/runtime），解析优先级高于 resources/node-runtime（v0.1.0 旧布局）。
   */
  runtimeDir?: string;
}

/** 从 stdout 解析端口的正则（实测输出：dsh web: http://127.0.0.1:60429） */
const PORT_LINE_RE = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/;

/** 启动后等待端口出现的超时（毫秒） */
const PORT_TIMEOUT_MS = 60_000;

/** 优雅退出等待超时（毫秒），超时后强杀 */
const TERM_TIMEOUT_MS = 5_000;

/** 健康检查轮询间隔（毫秒） */
const HEALTH_INTERVAL_MS = 10_000;

/** 单次健康检查请求超时（毫秒） */
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;

/** 连续失败多少次判定服务挂起 */
const HEALTH_MAX_FAILURES = 2;

/**
 * Electron 主进程的资源目录：
 * - 打包后为 <安装目录>\resources（内置运行时位于 resources\node-runtime）
 * - 开发模式为 node_modules\electron\dist\resources（无内置运行时）
 */
const RESOURCES_DIR: string | undefined = (
  process as unknown as { resourcesPath?: string }
).resourcesPath;

/**
 * dsh 子进程管理器：
 * - 定位 node 与 dsh 入口（userData/runtime 首启解压目录 → resources 旧布局 → 开发模式回退）
 * - 以随机端口启动 dsh web，解析 stdout 拿到实际端口
 * - 优雅退出：先 taskkill（不带 /F），超时后 taskkill /F 强杀整棵进程树
 */
export class DshManager {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private stopping = false; // 用户主动停止中，不算崩溃
  private portResolve: ((port: number) => void) | null = null;
  private portReject: ((err: Error) => void) | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFailures = 0;
  private readonly events: Partial<DshManagerEvents>;
  private readonly runtimeDir: string | undefined;

  constructor(opts: DshManagerOptions = {}) {
    this.events = opts.events ?? {};
    this.runtimeDir = opts.runtimeDir;
  }

  /** dsh 是否已在运行 */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** 当前已解析出的端口（未就绪时为 null） */
  get resolvedPort(): number | null {
    return this.port;
  }

  /**
   * 启动 dsh web 并等待端口就绪。
   * @param args 额外命令行参数（如 --no-open，由调用方决定是否兼容传入）
   */
  async start(args: string[] = []): Promise<number> {
    if (this.running) {
      if (this.port !== null) return this.port;
      // 已在启动中：等待同一次端口 Promise
      return this.waitPort();
    }

    const node = this.resolveNode();
    const dshBin = this.resolveDshBin();
    if (!dshBin) {
      throw new Error(
        '未找到 dsh 运行时：安装包应自带内置 dsh，若缺失请重新安装应用；开发模式请先安装（npm i -g @deepseek-ai/dsh）或在本项目内安装。'
      );
    }

    this.stopping = false;
    this.port = null;

    // --no-open：禁止 dsh 拉起系统默认浏览器（桌面端由主窗口呈现同一页面）
    this.child = spawn(
      node,
      [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open', ...args],
      {
        cwd: process.cwd(),
        env: this.buildEnv(),
        windowsHide: true, // 隐藏 Windows 上的控制台窗口
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    const child = this.child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const portPromise = this.waitPort();

    child.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line) this.events.onLog?.(line);
        const m = PORT_LINE_RE.exec(line);
        if (m) {
          this.port = Number(m[1]);
          const r = this.portResolve;
          this.portResolve = null;
          this.portReject = null;
          r?.(this.port);
        }
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line) this.events.onLog?.(`[stderr] ${line}`);
      }
    });

    child.on('error', (err) => {
      this.failPort(new Error(`无法启动 dsh 进程：${err.message}`));
    });
    child.on('exit', (code) => {
      this.stopHealthCheck();
      this.failPort(new Error(`dsh 提前退出（exit code ${code}）。请查看日志排障。`));
      if (this.stopping) {
        this.events.onExit?.(code);
      } else {
        this.events.onCrash?.(code);
      }
      this.child = null;
    });

    // 启动失败已由调用方（bootstrap/handleDshFailure）通过 start() 的 reject 处理，
    // 此处仅负责健康检查，吞掉 rejection 避免 UnhandledPromiseRejection 警告
    void portPromise.then(
      (port) => this.startHealthCheck(port),
      () => {
        /* 启动失败的善后由调用方负责 */
      }
    );
    return portPromise;
  }

  /**
   * 优雅停止 dsh：先温和终止，超时后 taskkill /F 强杀整棵进程树。
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }
    this.stopping = true;
    this.stopHealthCheck();
    const pid = child.pid;
    if (pid === undefined) return;

    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      // Windows 下用 taskkill 温和终止整棵树（dsh 可能再 spawn 子进程）
      spawn('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true }).on('error', () => {
        /* taskkill 不可用时忽略，走超时强杀 */
      });
      setTimeout(() => {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on(
          'close',
          () => resolve()
        );
        setTimeout(resolve, 2_000);
      }, TERM_TIMEOUT_MS);
    });
    this.child = null;
  }

  // ---------- 内部工具 ----------

  /** 启动对根路径的周期性健康检查，连续失败判定挂起 */
  private startHealthCheck(port: number): void {
    this.stopHealthCheck();
    this.healthFailures = 0;
    this.healthTimer = setInterval(() => {
      if (this.resolvedPort !== port) {
        // 已换端口（重启过），旧检查作废
        this.stopHealthCheck();
        return;
      }
      void fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`);
          this.healthFailures = 0;
        })
        .catch(() => {
          this.healthFailures += 1;
          if (this.healthFailures >= HEALTH_MAX_FAILURES) {
            this.stopHealthCheck();
            this.events.onHung?.(port);
          }
        });
    }, HEALTH_INTERVAL_MS);
    // 不阻止进程自然退出
    this.healthTimer.unref?.();
  }

  private stopHealthCheck(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** 等待端口就绪的 Promise（带超时） */
  private waitPort(): Promise<number> {
    if (this.port !== null) return Promise.resolve(this.port);
    return new Promise<number>((resolve, reject) => {
      this.portResolve = resolve;
      this.portReject = reject;
      setTimeout(
        () => this.failPort(new Error(`等待 dsh 输出端口超时（${PORT_TIMEOUT_MS / 1000}s）。`)),
        PORT_TIMEOUT_MS
      );
    });
  }

  private failPort(err: Error): void {
    const r = this.portReject;
    this.portResolve = null;
    this.portReject = null;
    r?.(err);
  }

  /**
   * 解析用于运行 dsh 的 Node 可执行文件：
   * 1. DSH_DESKTOP_NODE_PATH（显式覆盖，测试/特殊部署用）
   * 2. userData/runtime/node.exe（v0.1.1+：首启从内置 tar 解压出的运行时）
   * 3. 打包内置 resources\node-runtime\node.exe（v0.1.0 旧布局，兼容过渡）
   * 4. 系统 PATH 中的 node（开发模式，即 M0 实测所用的系统 Node）
   * 注意：不能用 process.execPath —— 在 Electron 主进程里它是 electron.exe，
   * 且 Electron 内嵌 Node 版本（20.x）低于 dsh 要求（^22.19）。
   */
  private resolveNode(): string {
    const override = process.env.DSH_DESKTOP_NODE_PATH;
    if (override && existsSync(override)) return override;
    if (this.runtimeDir) {
      const node = join(this.runtimeDir, 'node.exe');
      if (existsSync(node)) return node;
    }
    if (RESOURCES_DIR) {
      const bundled = join(RESOURCES_DIR, 'node-runtime', 'node.exe');
      if (existsSync(bundled)) return bundled;
    }
    return 'node';
  }

  /**
   * 解析 dsh 的 JS 入口文件路径：
   * 1. userData/runtime（v0.1.1+：首启从内置 tar 解压出的运行时）
   * 2. 打包内置 resources\node-runtime（v0.1.0 旧布局，兼容过渡）
   * 3. 本项目 node_modules（开发模式）
   * 4. 全局安装位置（开发模式回退）
   */
  private resolveDshBin(): string | null {
    if (this.runtimeDir) {
      const extracted = join(
        this.runtimeDir,
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js'
      );
      if (existsSync(extracted)) return extracted;
    }
    if (RESOURCES_DIR) {
      const bundled = join(RESOURCES_DIR, 'node-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (existsSync(bundled)) return bundled;
    }

    const local = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(local)) return local;

    // 全局：npm root -g 的上级即全局 node_modules
    const globalRoot = join(process.env.APPDATA ?? '', 'npm', 'node_modules');
    const global = join(globalRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(global)) return global;
    return null;
  }

  /** 子进程环境变量：剥离 Electron/Chromium 注入的变量，避免影响 dsh 运行时行为 */
  private buildEnv(): NodeJS.ProcessEnv {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/^(ELECTRON|CHROME|NODE_OPTIONS|npm_)/i.test(k)) continue;
      env[k] = v;
    }
    return env;
  }
}
