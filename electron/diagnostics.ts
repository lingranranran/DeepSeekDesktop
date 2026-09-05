import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import type { Logger } from './logger';

/** 设置页日志尾部查看器返回的行数 */
const TAIL_LINES = 200;

/** 单个日志文件内联进诊断包的最大行数（防异常巨大的日志撑爆导出） */
const EXPORT_MAX_LINES_PER_FILE = 5_000;

/** 当天日志文件名（与 Logger 的按天滚动命名保持一致） */
function todayLogName(d = new Date()): string {
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `main-${stamp}.log`;
}

/**
 * 读取当天日志尾部（设置页诊断区查看器用）。
 * 文件不存在（当天尚未写日志）返回空串。
 */
export function readLogTail(logger: Logger, lines = TAIL_LINES): string {
  try {
    const content = readFileSync(join(logger.logDir, todayLogName()), 'utf-8');
    const arr = content.split('\n');
    if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
    return arr.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** 环境信息条目（由主进程组装：版本 / 系统 / 运行时等） */
export type DiagEnv = Record<string, string>;

/**
 * 导出诊断包：环境信息 + 保留期内全部日志 → 另存为单个 txt。
 * 用户在保存对话框确认后写入，并在资源管理器中定位到该文件。
 */
export async function exportDiagnostics(
  logger: Logger,
  env: DiagEnv,
  parent: BrowserWindow | null
): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> {
  try {
    const d = new Date();
    const stamp = `${todayLogName(d).slice(5)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const opts = {
      title: '导出诊断包',
      defaultPath: join(app.getPath('desktop'), `dsh-desktop-diagnostics-${stamp}.txt`),
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    };
    const save = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };

    writeFileSync(save.filePath, buildReport(logger, env), 'utf-8');
    shell.showItemInFolder(save.filePath);
    return { ok: true, path: save.filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ---------- 内部 ----------

/** 组装诊断报告正文（环境段 + 逐文件日志段） */
function buildReport(logger: Logger, env: DiagEnv): string {
  const parts: string[] = ['DeepSeek Harness Desktop 诊断报告', `导出时间：${new Date().toISOString()}`, '', '== 环境 =='];
  for (const [k, v] of Object.entries(env)) parts.push(`${k}：${v}`);
  parts.push('', '== 日志 ==');

  let files: string[] = [];
  try {
    files = readdirSync(logger.logDir)
      .filter((f) => f.startsWith('main-') && f.endsWith('.log'))
      .sort();
  } catch {
    /* 目录不可读时下面统一提示 */
  }
  if (files.length === 0) {
    parts.push('（无日志文件）');
  }
  for (const f of files) {
    parts.push('', `---- ${f} ----`);
    try {
      const content = readFileSync(join(logger.logDir, f), 'utf-8');
      const arr = content.split('\n');
      if (arr.length > EXPORT_MAX_LINES_PER_FILE) {
        parts.push(`（共 ${arr.length - 1} 行，仅保留最后 ${EXPORT_MAX_LINES_PER_FILE} 行）`);
        parts.push(arr.slice(-EXPORT_MAX_LINES_PER_FILE).join('\n'));
      } else {
        parts.push(content.trimEnd());
      }
    } catch (err) {
      parts.push(`（读取失败：${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  return parts.join('\n') + '\n';
}
