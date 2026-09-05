/**
 * 本地运行时注册表（M6）：
 * - 内置运行时：userData/runtime（首启从安装包内 node-runtime.tar 解压）
 * - 独立运行时：userData/runtimes/<runtimeId>/（runtime-updater 从 GitHub 下载安装）
 * settings.activeRuntimeId 指向激活的运行时；null / 缺失 / 损坏时回退内置。
 *
 * 注意：所有路径函数均为惰性求值——app.setPath('userData') 在 main.ts 模块体中
 * 执行，晚于各 import 的模块级代码，模块顶层取 userData 会拿到错误的路径。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** 本地运行时条目（设置页展示与激活判断用） */
export interface LocalRuntimeInfo {
  /** 运行时标识（与 tar 内 .runtime-meta.id 一致；内置无标记时用 'builtin'） */
  id: string;
  /** dsh 版本（读自运行时内 package.json） */
  dshVersion: string;
  /** Node 版本（从运行时 id 解析，解析不出为空） */
  nodeVersion: string;
  /** 安装目录（绝对路径） */
  dir: string;
  /** 是否为应用内置运行时 */
  builtIn: boolean;
  /** 是否完整可用（node.exe + dsh 入口在位） */
  healthy: boolean;
  /** 是否为当前激活运行时 */
  active: boolean;
}

/** 内置运行时目录：userData/runtime（main.ts 的 RUNTIME_DIR 同源） */
export function builtinRuntimeDir(): string {
  return join(app.getPath('userData'), 'runtime');
}

/** 独立运行时根目录：userData/runtimes */
export function runtimesRoot(): string {
  return join(app.getPath('userData'), 'runtimes');
}

/** 运行时目录是否完整可用 */
export function isHealthyRuntime(dir: string): boolean {
  return (
    existsSync(join(dir, 'node.exe')) &&
    existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  );
}

/** 激活解析结果 */
export interface ActiveRuntimeResolution {
  /** 实际使用的运行时目录 */
  dir: string;
  /** 请求的运行时不存在/损坏，已回退内置 */
  fallback: boolean;
}

/**
 * 解析当前应使用的运行时目录：
 * activeRuntimeId 指向的独立运行时健康 → 用它；否则回退内置（首次启动/被删/损坏）。
 */
export function resolveActiveRuntimeDir(activeRuntimeId: string | null): ActiveRuntimeResolution {
  if (activeRuntimeId) {
    const dir = join(runtimesRoot(), activeRuntimeId);
    if (isHealthyRuntime(dir)) return { dir, fallback: false };
    return { dir: builtinRuntimeDir(), fallback: true };
  }
  return { dir: builtinRuntimeDir(), fallback: false };
}

/** 读取运行时目录的关键信息；完全无法识别（既无标记又无 dsh）返回 null */
function probeRuntimeDir(dir: string, id: string, builtIn: boolean): LocalRuntimeInfo | null {
  let dshVersion = '';
  try {
    const pkg = JSON.parse(
      readFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    ) as { version?: string };
    dshVersion = typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    /* dsh 未安装或不完整 */
  }
  // 目录都不存在 → 不列为本地运行时；存在但缺 dsh（如解压中断）→ 列出但标 unhealthy
  if (!existsSync(dir)) return null;

  // Node 版本从运行时 id 解析：runtime-v1-nodev22.23.2-dshX → 22.23.2
  const m = /^runtime-v\d+-nodev([\d.]+)-dsh/.exec(id);
  return {
    id,
    dshVersion,
    nodeVersion: m ? m[1] : '',
    dir,
    builtIn,
    healthy: isHealthyRuntime(dir),
    active: false,
  };
}

/**
 * 列出全部本地运行时（内置 + 独立安装），并标记当前激活项。
 * 内置目录的 id 读自 .runtime-ready.json 标记；独立运行时以目录名为 id
 * （下载安装时按 tar 元数据命名目录，二者天然一致）。
 */
export function listLocalRuntimes(activeRuntimeId: string | null): LocalRuntimeInfo[] {
  const result: LocalRuntimeInfo[] = [];

  const builtinDir = builtinRuntimeDir();
  let builtinId = 'builtin';
  try {
    const marker = JSON.parse(
      readFileSync(join(builtinDir, '.runtime-ready.json'), 'utf8')
    ) as { id?: string };
    if (typeof marker.id === 'string' && marker.id.length > 0) builtinId = marker.id;
  } catch {
    /* 标记缺失（未解压/旧版本）用默认 id */
  }
  const builtin = probeRuntimeDir(builtinDir, builtinId, true);
  if (builtin) result.push(builtin);

  const root = runtimesRoot();
  if (existsSync(root)) {
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name.startsWith('.')) continue; // .downloads 缓存等跳过
      const info = probeRuntimeDir(join(root, name.name), name.name, false);
      if (info) result.push(info);
    }
  }

  for (const r of result) {
    r.active = r.builtIn ? activeRuntimeId === null : activeRuntimeId === r.id;
  }
  return result;
}

/** dsh 版本比较（0.1.0-rc.N 格式）：正式版 > rc，其余按数字段 */
export function compareDshVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], rc: m[4] !== undefined ? +m[4] : null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.rc === null && pb.rc === null) return 0;
  if (pa.rc === null) return 1; // 正式版更高
  if (pb.rc === null) return -1;
  return pa.rc - pb.rc;
}
