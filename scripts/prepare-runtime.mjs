/**
 * 准备内置运行时（M4 打包用）：
 * 1. 下载 Node.js v22.23.2 win-x64 zip，校验 sha256 后解压到 resources/node-runtime/
 * 2. 用内置 npm 安装锁定版本的 @deepseek-ai/dsh 到同一运行时
 *
 * 幂等：node.exe 与 dsh 均已就位时跳过；--force 可删除后重建。
 * 用法：node scripts/prepare-runtime.mjs [--force]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v22.23.2';
const DSH_VERSION = '0.1.0-rc.6';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = join(ROOT, 'resources', 'node-runtime');
const NODE_EXE = join(RUNTIME_DIR, 'node.exe');
const NPM_CLI = join(RUNTIME_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const DSH_BIN = join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
const SHASUMS_URL = `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`;
const ZIP_PATH = join(RUNTIME_DIR, `node-${NODE_VERSION}-win-x64.zip`);

function log(msg) {
  console.log(`[prepare-runtime] ${msg}`);
}

function fail(msg) {
  console.error(`[prepare-runtime] 错误：${msg}`);
  process.exit(1);
}

/** node + dsh 均就位视为已准备好 */
function isReady() {
  return existsSync(NODE_EXE) && existsSync(DSH_BIN);
}

/** sha256 校验下载的 zip（对照官方 SHASUMS256.txt） */
function verifyZip() {
  const shasums = execFileSync('curl.exe', ['--fail', '--silent', SHASUMS_URL], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const line = shasums
    .split('\n')
    .find((l) => l.trimEnd().endsWith(`node-${NODE_VERSION}-win-x64.zip`));
  if (!line) fail('SHASUMS256.txt 中未找到 win-x64 zip 条目');
  const expected = line.trim().split(/\s+/)[0];

  const hash = createHash('sha256');
  const CHUNK = 4 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  const fd = openSync(ZIP_PATH, 'r');
  try {
    let read;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }

  const actual = hash.digest('hex');
  if (actual !== expected) fail(`zip sha256 校验失败：期望 ${expected}，实际 ${actual}`);
  log(`zip sha256 校验通过（${actual.slice(0, 16)}…）`);
}

/** 解压并展平 zip 内的顶层目录 */
function extract() {
  log('解压 …');
  const ps = [
    `Expand-Archive -LiteralPath '${ZIP_PATH}' -DestinationPath '${RUNTIME_DIR}' -Force`,
    `$src = Join-Path '${RUNTIME_DIR}' 'node-${NODE_VERSION}-win-x64'`,
    `Get-ChildItem -LiteralPath $src -Force | Move-Item -Destination '${RUNTIME_DIR}' -Force`,
    `Remove-Item -LiteralPath $src -Recurse -Force`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  rmSync(ZIP_PATH, { force: true });
}

async function main() {
  const force = process.argv.includes('--force');
  if (force && existsSync(RUNTIME_DIR)) {
    log('--force：删除现有 node-runtime …');
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }
  if (isReady()) {
    log('内置运行时已就绪，跳过（--force 可重建）');
    return;
  }
  mkdirSync(RUNTIME_DIR, { recursive: true });

  // 1. 下载 Node zip（已存在则复用）
  if (!existsSync(ZIP_PATH)) {
    log(`下载 ${NODE_URL} …`);
    execFileSync(
      'curl.exe',
      ['--fail', '--location', '--output', ZIP_PATH, '--silent', '--show-error', NODE_URL],
      { stdio: 'inherit' }
    );
  } else {
    log('已存在下载缓存 zip，跳过下载');
  }
  verifyZip();
  extract();

  if (!existsSync(NODE_EXE)) fail('解压后未找到 node.exe');
  const ver = execFileSync(NODE_EXE, ['-v'], { encoding: 'utf8' }).trim();
  log(`内置 Node 就绪：${ver}`);

  // 2. 安装锁定版本的 dsh（npm 全局 prefix 即 node.exe 所在目录）
  log(`安装 @deepseek-ai/dsh@${DSH_VERSION} …`);
  execFileSync(
    NODE_EXE,
    [NPM_CLI, 'install', '--global', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${DSH_VERSION}`],
    { cwd: RUNTIME_DIR, stdio: 'inherit' }
  );
  if (!existsSync(DSH_BIN)) fail('dsh 安装后未找到 lib/bin.js');

  const dshPkg = JSON.parse(
    readFileSync(join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
  );
  log(`内置 dsh 就绪：${dshPkg.version}`);
  log('完成');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
