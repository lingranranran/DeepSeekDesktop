/**
 * 构建并发布可下载运行时（M6，CI 专用）：
 * 对每个指定 dsh 版本：
 *   1. prepare-runtime.mjs 构建（独立工作区 out/build-<版本>，产物 out/runtimes/<版本>/）
 *   2. 创建 GitHub prerelease（tag runtime-v<版本>，标记 prerelease 避免干扰
 *      electron-updater 的应用更新发现）并上传 node-runtime.tar + runtime.json
 *   3. 合并条目到 runtime-manifest.json（每版本独立落盘，部分失败不影响已完成版本）
 * 依赖 gh CLI（GH_TOKEN 由 workflow 注入）；产物目录用 out/（不进 asar、已 gitignore）。
 * 用法：node scripts/publish-runtimes.mjs --versions 0.1.0-rc.7,0.1.0-rc.8
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function log(msg) {
  console.log(`[publish-runtimes] ${msg}`);
}

function fail(msg) {
  console.error(`[publish-runtimes] 错误：${msg}`);
  process.exit(1);
}

/** 前台执行（输出直接透传）；quiet = 吞输出（用于探测类调用） */
function run(cmd, args, quiet = false) {
  return execFileSync(cmd, args, {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
}

function releaseExists(tag) {
  try {
    execFileSync('gh', ['release', 'view', tag], { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

const argv = process.argv.slice(2);
const i = argv.indexOf('--versions');
if (i < 0 || !argv[i + 1]) fail('用法：node scripts/publish-runtimes.mjs --versions <v1>,<v2>…');
const versions = argv[i + 1]
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
if (versions.length === 0) fail('版本列表为空');

for (const v of versions) {
  log(`=== dsh ${v}：构建 ===`);
  const out = join('out', 'runtimes', v);
  run('node', [
    'scripts/prepare-runtime.mjs',
    '--dsh',
    v,
    '--workdir',
    join('out', `build-${v}`),
    '--out',
    out,
    '--force',
  ]);

  const metaPath = join(out, 'runtime.json');
  if (!existsSync(metaPath)) fail(`构建产物缺失：${metaPath}`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

  const tag = `runtime-v${v}`;
  const notes = [
    '可下载运行时（DeepSeek Harness Desktop M6）',
    '',
    `- dsh：${meta.dshVersion}`,
    `- Node：${meta.nodeVersion}`,
    `- runtime id：${meta.id}`,
    `- tar sha256：${meta.sha256}`,
    `- 大小：${(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB`,
    '',
    '由 GitHub Actions 自动构建发布；应用通过 runtime-manifest.json 发现并下载。',
  ].join('\n');

  log(`=== dsh ${v}：发布 ${tag} ===`);
  if (releaseExists(tag)) {
    log(`release ${tag} 已存在，覆盖上传资产`);
    run('gh', ['release', 'upload', tag, join(out, 'node-runtime.tar'), metaPath, '--clobber']);
  } else {
    run('gh', ['release', 'create', tag, '--title', `Runtime dsh ${v}`, '--notes', notes, '--prerelease']);
    run('gh', ['release', 'upload', tag, join(out, 'node-runtime.tar'), metaPath]);
  }

  run('node', ['scripts/update-manifest.mjs', '--entry', metaPath]);
  log(`=== dsh ${v}：完成 ===`);
}

log('全部完成');
