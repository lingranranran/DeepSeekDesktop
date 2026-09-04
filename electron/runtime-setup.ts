/**
 * 内置运行时首启解压（v0.1.1+）：
 * 安装包只携带单文件 resources/node-runtime.tar（scripts/prepare-runtime.mjs 生成，
 * 首条目 .runtime-meta = {id, files, dirs}），应用首次启动时解压到 userData/runtime。
 * - 进度回调驱动加载页进度条
 * - 先解压到 staging，校验通过后原子换入并写标记
 * - 解压被中断（断电/强杀/升级换代）→ 下次启动检测标记不匹配自动重做（自愈）
 */
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  promises as fsp,
} from 'node:fs';
import { dirname, join } from 'node:path';

const BLOCK = 512;

/** 归档元信息（tar 首条目） */
export interface RuntimeMeta {
  id: string;
  files: number;
  dirs: number;
}

export interface EnsureRuntimeOptions {
  /** 安装目录内的 node-runtime.tar */
  archive: string;
  /** 解压目标：userData/runtime */
  runtimeDir: string;
  meta: RuntimeMeta;
  /** 解压进度（已完成条目数 / 总条目数） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 读取归档首条目 .runtime-meta（未压缩 tar，直接按字节读取，无需流式解析）。
 * 归档损坏/格式不符返回 null。
 */
export function readArchiveMeta(archive: string): RuntimeMeta | null {
  let fd: number | undefined;
  try {
    fd = openSync(archive, 'r');
    const head = Buffer.alloc(BLOCK);
    if (readSync(fd, head, 0, BLOCK, null) !== BLOCK) return null;
    const entry = parseHeader(head);
    if (entry.name !== '.runtime-meta' || (entry.typeflag !== '0' && entry.typeflag !== '\0')) {
      return null;
    }
    const body = Buffer.alloc(entry.size);
    if (readSync(fd, body, 0, entry.size, null) !== entry.size) return null;
    return JSON.parse(body.toString('utf8')) as RuntimeMeta;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** ensureRuntime 结果：extracted = 本次完成了解压；reused = 复用了已有运行时 */
export type EnsureRuntimeResult = 'extracted' | 'reused';

/**
 * 确保 userData/runtime 就绪：
 * 标记匹配且关键文件在位 → 直接复用；否则完整解压（自愈幂等）。
 */
export async function ensureRuntime(opts: EnsureRuntimeOptions): Promise<EnsureRuntimeResult> {
  const { archive, runtimeDir, meta, onProgress } = opts;
  const marker = join(runtimeDir, '.runtime-ready.json');
  const nodeExe = join(runtimeDir, 'node.exe');
  const dshBin = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  // 快速路径：二次启动直接复用，无解压开销
  if (existsSync(marker) && existsSync(nodeExe) && existsSync(dshBin)) {
    try {
      const m = JSON.parse(readFileSync(marker, 'utf8')) as RuntimeMeta;
      if (m.id === meta.id && m.files === meta.files) return 'reused';
    } catch {
      /* 标记损坏 → 走完整解压 */
    }
  }

  // 完整解压：staging → 校验 → 原子换入
  const staging = join(dirname(runtimeDir), 'runtime-staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const written = await extractTar(archive, staging, meta, onProgress);
  if (
    written.files !== meta.files ||
    !existsSync(join(staging, 'node.exe')) ||
    !existsSync(join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  ) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `内置运行时解压不完整（${written.files}/${meta.files} 文件），已自动重置，请重启应用重试`
    );
  }
  rmSync(runtimeDir, { recursive: true, force: true });
  renameSync(staging, runtimeDir);
  writeFileSync(marker, JSON.stringify({ id: meta.id, files: meta.files }));
  return 'extracted';
}

// ---------- 内部：tar 流式解析（ustar + GNU longname） ----------

interface TarHeader {
  name: string;
  size: number;
  typeflag: string;
}

function cstr(b: Buffer): string {
  const i = b.indexOf(0);
  return (i === -1 ? b : b.subarray(0, i)).toString('utf8').replace(/\s+$/, '');
}

function octal(b: Buffer): number {
  return parseInt(cstr(b), 8) || 0;
}

function parseHeader(h: Buffer): TarHeader {
  const name = cstr(h.subarray(0, 100));
  const prefix = cstr(h.subarray(345, 500));
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: octal(h.subarray(124, 136)),
    typeflag: String.fromCharCode(h[156]),
  };
}

function isZeroBlock(b: Buffer): boolean {
  for (const v of b) if (v !== 0) return false;
  return true;
}

/** 流式解压归档到 dest；返回实际写入的文件/目录数 */
async function extractTar(
  archive: string,
  dest: string,
  meta: RuntimeMeta,
  onProgress?: (done: number, total: number) => void
): Promise<{ files: number; dirs: number }> {
  const stream = createReadStream(archive, { highWaterMark: 4 * 1024 * 1024 });
  let buf: Buffer = Buffer.alloc(0);
  let longName: string | null = null;
  let files = 0;
  let dirs = 0;
  let done = 0;
  const total = meta.files + meta.dirs;

  const handleEntry = async (name: string, size: number, typeflag: string, data: Buffer): Promise<void> => {
    if (typeflag === 'L') {
      // GNU longname：下一个条目的真实名字
      longName = data.toString('utf8').replace(/\0+$/, '');
      return;
    }
    const realName = longName ?? name;
    longName = null;
    if (realName === '.runtime-meta') return; // 元信息不落盘
    if (realName.split('/').some((seg) => seg === '..' || seg === '')) {
      throw new Error(`归档包含非法路径：${realName}`);
    }
    const target = join(dest, ...realName.split('/'));
    if (typeflag === '5') {
      mkdirSync(target, { recursive: true });
      dirs += 1;
    } else if (typeflag === '0' || typeflag === '\0') {
      mkdirSync(dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
      files += 1;
    } else {
      throw new Error(`不支持的 tar 条目类型 "${typeflag}"：${realName}`);
    }
    done += 1;
    onProgress?.(done, total);
  };

  for await (const chunk of stream) {
    buf = buf.length === 0 ? (chunk as Buffer) : Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= BLOCK) {
      const head = buf.subarray(0, BLOCK);
      if (isZeroBlock(head)) {
        return { files, dirs }; // 归档结束标记
      }
      const entry = parseHeader(head);
      const need = BLOCK + BLOCK * Math.ceil(entry.size / BLOCK);
      if (buf.length < need) break; // 当前条目数据不足，等待后续 chunk
      const data = buf.subarray(BLOCK, BLOCK + entry.size);
      buf = buf.subarray(need);
      await handleEntry(entry.name, entry.size, entry.typeflag, data);
    }
  }
  return { files, dirs };
}
