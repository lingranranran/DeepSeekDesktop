/**
 * 合并运行时构建产物元数据到 runtime-manifest.json（M6，CI 用）。
 *
 * 输入：prepare-runtime.mjs 生成的 runtime.json（含 id/dshVersion/nodeVersion/sha256/sizeBytes），
 *       下载 URL 按 GitHub Release 命名规则拼接（tag runtime-v<dshVersion>）。
 * 行为：按 dshVersion 去重合并（后写覆盖先写），更新 generatedAt，写回仓库根目录。
 *
 * 用法：node scripts/update-manifest.mjs --entry dist/runtimes/0.1.0-rc.8/runtime.json [--entry ...]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'runtime-manifest.json');

/** GitHub Release 下载地址（tag 命名规则与 runtime.yml 保持一致） */
const RELEASE_BASE = 'https://github.com/lingranranran/DeepSeekDesktop/releases/download';

function log(msg) {
  console.log(`[update-manifest] ${msg}`);
}

function fail(msg) {
  console.error(`[update-manifest] 错误：${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const entries = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--entry') continue;
  const path = argv[i + 1];
  if (!path) fail('--entry 缺少路径参数');
  if (!existsSync(path)) fail(`runtime.json 不存在：${path}`);
  try {
    entries.push(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    fail(`runtime.json 解析失败（${path}）：${err.message}`);
  }
}
if (entries.length === 0) fail('未提供 --entry 参数');

let manifest = { generatedAt: '', runtimes: [] };
if (existsSync(MANIFEST_PATH)) {
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    if (!Array.isArray(manifest.runtimes)) manifest.runtimes = [];
  } catch (err) {
    fail(`runtime-manifest.json 解析失败：${err.message}`);
  }
}

for (const e of entries) {
  if (!e.dshVersion || !e.id || !e.sha256 || !e.sizeBytes) {
    fail(`runtime.json 字段不完整：${JSON.stringify(e)}`);
  }
  const entry = {
    id: e.id,
    dshVersion: e.dshVersion,
    nodeVersion: e.nodeVersion ?? '',
    url: `${RELEASE_BASE}/runtime-v${e.dshVersion}/node-runtime.tar`,
    sha256: e.sha256,
    sizeBytes: e.sizeBytes,
  };
  const idx = manifest.runtimes.findIndex((r) => r.dshVersion === e.dshVersion);
  if (idx >= 0) {
    manifest.runtimes[idx] = entry;
    log(`更新条目：dsh ${e.dshVersion}`);
  } else {
    manifest.runtimes.push(entry);
    log(`新增条目：dsh ${e.dshVersion}`);
  }
}

manifest.generatedAt = new Date().toISOString();
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
log(`runtime-manifest.json 已写入（共 ${manifest.runtimes.length} 条）`);
