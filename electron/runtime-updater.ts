/**
 * 运行时下载与安装（M6）：
 * 从 runtime-manifest.json（随 main 分支提交）发现可用运行时 → 流式下载 tar
 * （进度回调）→ sha256 校验 → 复用 ensureRuntime 解压安装到 userData/runtimes/<id>
 * （与首启解压同一套逻辑：staging 原子换入 + 就绪标记 + 损坏自愈）。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readArchiveMeta, ensureRuntime } from './runtime-setup';

/** manifest 中单个可下载运行时的元数据 */
export interface RuntimeManifestEntry {
  id: string;
  dshVersion: string;
  nodeVersion: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

/** 下载/安装进度状态（推送给设置页） */
export interface RuntimeDownloadState {
  phase: 'downloading' | 'extracting' | 'done' | 'error';
  /** 目标运行时 id */
  id: string;
  /** 下载进度（0-100；无 content-length 时可能缺失） */
  percent?: number;
  /** 解压进度（条目数） */
  done?: number;
  total?: number;
  /** phase=error 时的错误信息 */
  message?: string;
}

/** manifest 地址（CI 提交到 main 分支） */
const MANIFEST_URL =
  'https://raw.githubusercontent.com/lingranranran/DeepSeekDesktop/main/runtime-manifest.json';

/** 拉取并校验运行时清单；网络失败/格式不符抛错（调用方转成友好提示） */
export async function fetchRuntimeManifest(): Promise<RuntimeManifestEntry[]> {
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`拉取运行时清单失败：HTTP ${res.status}`);
  const body = (await res.json()) as { runtimes?: Partial<RuntimeManifestEntry>[] };
  if (!Array.isArray(body.runtimes)) throw new Error('运行时清单格式不符（缺少 runtimes 数组）');
  return body.runtimes
    .filter(
      (e): e is RuntimeManifestEntry =>
        typeof e.id === 'string' &&
        typeof e.dshVersion === 'string' &&
        typeof e.url === 'string' &&
        typeof e.sha256 === 'string' &&
        typeof e.sizeBytes === 'number'
    )
    .map((e) => ({ ...e, nodeVersion: e.nodeVersion ?? '' }));
}

export interface DownloadRuntimeOptions {
  entry: RuntimeManifestEntry;
  /** 独立运行时根目录（userData/runtimes） */
  targetRoot: string;
  /** 进度回调（调用方负责节流与转发到渲染层） */
  onState: (state: RuntimeDownloadState) => void;
}

/**
 * 下载并安装一个运行时：
 * 下载 tar 到 <root>/.downloads/<id>.tar → sha256 校验 → ensureRuntime 解压安装
 * → 清理 tar。返回安装目录。任何一步失败都会清理残留 tar 并抛错。
 */
export async function downloadRuntime(opts: DownloadRuntimeOptions): Promise<string> {
  const { entry, targetRoot, onState } = opts;
  const downloads = join(targetRoot, '.downloads');
  mkdirSync(downloads, { recursive: true });
  const tarPath = join(downloads, `${entry.id}.tar`);
  const targetDir = join(targetRoot, entry.id);

  try {
    // 1. 流式下载（边写文件边算 sha256）
    const res = await fetch(entry.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    if (res.body === null) throw new Error('下载失败：响应无内容');
    const total = Number(res.headers.get('content-length') ?? entry.sizeBytes);
    let received = 0;
    const hash = createHash('sha256');
    const file = createWriteStream(tarPath);
    try {
      for await (const chunk of Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])) {
        const buf = chunk as Buffer;
        hash.update(buf);
        await new Promise<void>((resolve, reject) =>
          file.write(buf, (err) => (err ? reject(err) : resolve()))
        );
        received += buf.length;
        onState({
          phase: 'downloading',
          id: entry.id,
          percent: total > 0 ? Math.floor((received / total) * 100) : undefined,
        });
      }
      await new Promise<void>((resolve) => file.end(resolve));
    } catch (err) {
      file.destroy();
      throw err;
    }

    // 2. sha256 校验（对照 manifest）
    const actual = hash.digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`sha256 校验失败：期望 ${entry.sha256.slice(0, 16)}…，实际 ${actual.slice(0, 16)}…`);
    }

    // 3. 读取归档元数据并校验一致性
    const meta = readArchiveMeta(tarPath);
    if (!meta) throw new Error('运行时归档损坏（无法读取元数据）');
    if (meta.id !== entry.id) {
      throw new Error(`运行时归档 id 不符：期望 ${entry.id}，实际 ${meta.id}`);
    }

    // 4. 解压安装（复用首启解压逻辑：staging → 校验 → 原子换入 → 就绪标记）
    await ensureRuntime({
      archive: tarPath,
      runtimeDir: targetDir,
      meta,
      onProgress: (done, totalEntries) =>
        onState({ phase: 'extracting', id: entry.id, done, total: totalEntries }),
    });
  } finally {
    rmSync(tarPath, { force: true });
  }

  onState({ phase: 'done', id: entry.id });
  return targetDir;
}
