/**
 * 准备运行时（M4 应用打包 / M6 独立运行时构建）：
 * 1. 下载 Node.js v22.23.2 win-x64 zip，校验 sha256 后解压到构建工作区
 * 2. 用内置 npm 安装指定版本的 @deepseek-ai/dsh 到同一运行时
 * 3. 将整个运行时打包为单文件 tar（v0.1.1+ 分发方式：
 *    安装包只需写一个大文件，安装秒级完成；应用首次启动解压到 userData 并显示进度）
 * 4. 输出 runtime.json 元数据（id / dsh / node 版本 / sha256 / 大小，M6 清单用）
 *
 * 无参数：构建应用内置运行时（resources/node-runtime.tar，dsh 版本锁定）
 * 参数化（M6 CI 构建可下载运行时）：
 *   --dsh <version>   指定 dsh 版本（默认内置锁定版本）
 *   --workdir <dir>   构建工作区（默认 resources/node-runtime；--force 会清空重建）
 *   --out <dir>       tar 与 runtime.json 输出目录（默认 resources）
 *   --force           删除工作区后重建
 *
 * 幂等：运行时就绪且 tar 存在时跳过；--force 可删除后重建。
 * 用法：node scripts/prepare-runtime.mjs [--force] [--dsh <v>] [--workdir <dir>] [--out <dir>]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = 'v22.23.2';
/** 应用内置（打包进安装包）的 dsh 锁定版本 */
const BUILTIN_DSH_VERSION = '0.1.0-rc.6';

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const force = argv.includes('--force');
const DSH_VERSION = argValue('--dsh') ?? BUILTIN_DSH_VERSION;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 构建工作区（node + npm + dsh 安装目录） */
const RUNTIME_DIR = resolve(argValue('--workdir') ?? join(ROOT, 'resources', 'node-runtime'));
/** tar 与 runtime.json 输出目录 */
const OUT_DIR = resolve(argValue('--out') ?? join(ROOT, 'resources'));
const NODE_EXE = join(RUNTIME_DIR, 'node.exe');
const NPM_CLI = join(RUNTIME_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const DSH_BIN = join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

/** 单文件分发归档 */
const TAR_PATH = join(OUT_DIR, 'node-runtime.tar');
/** 构建产物元数据（M6 运行时清单用） */
const META_PATH = join(OUT_DIR, 'runtime.json');

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

// ---------- 单文件 tar 打包（v0.1.1+ 分发方式） ----------
// 安装包只携带一个 node-runtime.tar：NSIS 安装时写一个大文件即可（秒级完成，无逐文件
// 解压 + 杀软扫描的"假死"观感），应用首次启动再解压到 userData/runtime 并显示进度。
// 格式：ustar + GNU longname；首条目 .runtime-meta 存储 {id, files, dirs}，
// 应用侧据此判断是否需要重新解压（升级/损坏自愈）并计算进度分母。

const BLOCK = 512;

/** 运行时标识：内容变化（Node/dsh 版本、打包格式）时随之变化，驱动应用侧重新解压 */
const RUNTIME_ID = `runtime-v1-node${NODE_VERSION}-dsh${DSH_VERSION}`;

function octalField(value, len) {
  return Buffer.from(`${value.toString(8).padStart(len - 1, '0')}\0`, 'ascii');
}

/** 构造 512 字节 ustar 头（POSIX ustar，checksum 按规范计算） */
function tarHeader({ name, size, typeflag, mode = 0o644, mtime = 0 }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name.slice(0, 100), 0, 100, 'utf8');
  octalField(mode, 8).copy(h, 100); // mode
  octalField(0, 8).copy(h, 108); // uid
  octalField(0, 8).copy(h, 116); // gid
  octalField(size, 12).copy(h, 124); // size
  octalField(mtime, 12).copy(h, 136); // mtime
  h.write('        ', 148, 8, 'ascii'); // checksum 先以空格占位
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** 递归收集相对路径（POSIX 分隔符）；遇到符号链接等非常规文件直接失败（tar 分发不支持） */
function walkTree(root) {
  const dirs = [];
  const files = [];
  const visit = (rel) => {
    const abs = rel ? join(root, rel) : root;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        dirs.push(relPath);
        visit(relPath);
      } else if (ent.isFile()) {
        files.push(relPath);
      } else {
        fail(`node-runtime 中存在非常规文件（符号链接等），tar 分发不支持：${relPath}`);
      }
    }
  };
  visit('');
  dirs.sort();
  files.sort();
  return { dirs, files };
}

/** 生成 node-runtime.tar（确定性输出：同内容产出同字节，便于比对与排障） */
function createRuntimeTar() {
  const { dirs, files } = walkTree(RUNTIME_DIR);
  log(`打包 node-runtime.tar：${files.length} 文件 / ${dirs.length} 目录 …`);
  const fd = openSync(TAR_PATH, 'w');
  try {
    const writeEntry = (name, data, typeflag, mode) => {
      const size = data ? data.length : 0;
      // 超长路径：先写 GNU longname 条目，再写真实条目（名字可为截断占位）
      if (Buffer.byteLength(name, 'utf8') > 99) {
        const long = Buffer.from(`${name}\0`, 'utf8');
        writeSync(fd, tarHeader({ name: '././@LongLink', size: long.length, typeflag: 'L' }));
        writeSync(fd, long);
        const pad1 = (BLOCK - (long.length % BLOCK)) % BLOCK;
        if (pad1) writeSync(fd, Buffer.alloc(pad1));
      }
      writeSync(fd, tarHeader({ name, size, typeflag, mode }));
      if (size > 0) {
        writeSync(fd, data);
        const pad2 = (BLOCK - (size % BLOCK)) % BLOCK;
        if (pad2) writeSync(fd, Buffer.alloc(pad2));
      }
    };

    // 首条目：元信息（应用侧读取 id 与总量，无需遍历归档）
    const meta = Buffer.from(
      JSON.stringify({ id: RUNTIME_ID, files: files.length, dirs: dirs.length }),
      'utf8'
    );
    writeEntry('.runtime-meta', meta, '0', 0o444);
    for (const d of dirs) writeEntry(d, null, '5', 0o755);
    for (const f of files) writeEntry(f, readFileSync(join(RUNTIME_DIR, f)), '0', 0o644);
    writeSync(fd, Buffer.alloc(BLOCK * 2)); // 归档结束标记（两个全零块）
  } finally {
    closeSync(fd);
  }
  log(`node-runtime.tar 生成完毕（${(statSync(TAR_PATH).size / 1024 / 1024).toFixed(1)} MB）`);
}

/** 用系统 tar（bsdtar）交叉校验：条目数一致 + 最大文件内容逐字节一致 */
function verifyTar() {
  const { dirs, files } = walkTree(RUNTIME_DIR);
  const listing = execFileSync('tar.exe', ['-tf', TAR_PATH], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const expected = 1 + dirs.length + files.length; // meta + 目录 + 文件
  if (listing.length !== expected) {
    fail(`tar 校验失败：条目数 ${listing.length} ≠ 期望 ${expected}`);
  }
  // 抽样：node.exe（最大文件）内容逐字节比对
  const probe = files.includes('node.exe') ? 'node.exe' : files[0];
  const original = readFileSync(join(RUNTIME_DIR, probe));
  const extracted = execFileSync('tar.exe', ['-xOf', TAR_PATH, probe], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!original.equals(extracted)) fail(`tar 内容校验失败：${probe} 与源不一致`);
  log(`tar 校验通过（${expected} 条目，抽查 ${probe}）`);
}

/** 安装异常诊断：打印 npm 全局 prefix 与关键目录内容，便于 CI 排障 */
function dumpDshDiagnostics() {
  try {
    const prefix = execFileSync(NODE_EXE, [NPM_CLI, 'prefix', '-g'], {
      cwd: RUNTIME_DIR,
      encoding: 'utf8',
    }).trim();
    log(`诊断：npm 全局 prefix = ${prefix}`);
  } catch (err) {
    log(`诊断：npm prefix 查询失败：${err.message}`);
  }
  const list = (label, dir) => {
    try {
      const names = readdirSync(dir);
      log(`诊断：${label}（${names.length} 项）：${names.slice(0, 40).join(', ')}${names.length > 40 ? ' …' : ''}`);
    } catch (err) {
      log(`诊断：${label} 不可读：${err.message}`);
    }
  };
  list('node_modules', join(RUNTIME_DIR, 'node_modules'));
  list('@deepseek-ai', join(RUNTIME_DIR, 'node_modules', '@deepseek-ai'));
  list('dsh', join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh'));
  const pkgPath = join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      log(`诊断：dsh package.json version=${pkg.version} bin=${JSON.stringify(pkg.bin)}`);
    } catch (err) {
      log(`诊断：dsh package.json 解析失败：${err.message}`);
    }
  }
}

/** 流式计算文件 sha256 */
function sha256File(p) {
  const hash = createHash('sha256');
  const CHUNK = 4 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  const fd = openSync(p, 'r');
  try {
    let read;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

async function main() {
  log(`目标：dsh ${DSH_VERSION}，工作区 ${RUNTIME_DIR}，输出 ${OUT_DIR}`);
  if (force && existsSync(RUNTIME_DIR)) {
    log('--force：删除现有工作区 …');
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }

  if (isReady()) {
    log('运行时已就绪，跳过下载与安装（--force 可重建）');
  } else {
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

    // 2. 安装指定版本的 dsh（显式 --prefix 钉死安装位置：
    //    GitHub Windows runner 的 runneradmin .npmrc 预置 prefix=C:\npm\prefix，
    //    会把全局安装劫持到别处；命令行 --prefix 优先级最高，可覆盖任何配置）
    const dshInstall = () =>
      execFileSync(
        NODE_EXE,
        [
          NPM_CLI,
          'install',
          '--global',
          '--prefix',
          RUNTIME_DIR,
          '--no-audit',
          '--no-fund',
          `@deepseek-ai/dsh@${DSH_VERSION}`,
        ],
        { cwd: RUNTIME_DIR, stdio: 'inherit' }
      );
    log(`安装 @deepseek-ai/dsh@${DSH_VERSION} …`);
    dshInstall();
    if (!existsSync(DSH_BIN)) {
      // CI 曾观测到安装退出码 0 但文件缺失（疑似瞬时问题）：重试一次
      log('安装后未找到 lib/bin.js，重试一次 …');
      dshInstall();
    }
    if (!existsSync(DSH_BIN)) {
      dumpDshDiagnostics();
      fail('dsh 安装后未找到 lib/bin.js（详见上方诊断输出）');
    }

    const dshPkg = JSON.parse(
      readFileSync(join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    );
    log(`内置 dsh 就绪：${dshPkg.version}`);
  }

  // 3. 生成单文件 tar（与运行时目录独立幂等；--force 时重建）
  if (force || !existsSync(TAR_PATH)) {
    createRuntimeTar();
  } else {
    log('node-runtime.tar 已存在，跳过（--force 可重建）');
  }
  verifyTar();

  // 4. 输出元数据（M6：运行时清单与应用侧 sha256 校验用）
  const meta = {
    id: RUNTIME_ID,
    dshVersion: DSH_VERSION,
    nodeVersion: NODE_VERSION.replace(/^v/, ''),
    sha256: sha256File(TAR_PATH),
    sizeBytes: statSync(TAR_PATH).size,
  };
  writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  log(`runtime.json 已生成（sha256=${meta.sha256.slice(0, 16)}…，${(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB）`);
  log('完成');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
