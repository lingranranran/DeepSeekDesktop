#!/usr/bin/env node
/**
 * 修复 electron-builder 26.x 在 CI 上的重复草稿 Release 问题。
 *
 * 背景：electron-builder 并行上传产物时存在竞态，会为同一个 tag 创建
 * 两个草稿 Release，资产（exe / blockmap / latest.yml）被分散到两个草稿，
 * 且两个草稿都停留在 draft 状态不会发布，导致已安装的应用收不到自动更新。
 *
 * 本脚本在发布工作流的 electron-builder 步骤之后运行：
 *   1. 列出该 tag 的所有 Release（含草稿）
 *   2. 选定目标（已有正式 Release 则用它，否则选资产最多的草稿）
 *   3. 把其他 Release 中缺失/更新的资产转移到目标（同名冲突则先删后传）
 *   4. 发布目标（draft=false），删除多余草稿
 * 幂等：Release 已正常发布时直接成功退出。
 *
 * 用法：node scripts/fix-release.mjs --tag v0.2.0
 * 环境变量：GH_TOKEN（repo 权限）；GITHUB_REPOSITORY（owner/repo，缺省用本项目）
 */

// ---------- 参数与环境 ----------

const args = process.argv.slice(2);
const tagIdx = args.indexOf('--tag');
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : '';
if (!TAG) {
  console.error('[fix-release] 缺少 --tag <vX.Y.Z> 参数');
  process.exitCode = 1;
} else if (!process.env.GH_TOKEN) {
  console.error('[fix-release] 缺少 GH_TOKEN 环境变量');
  process.exitCode = 1;
}

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'lingranranran/DeepSeekDesktop';

const API = 'https://api.github.com';
const UPLOAD = 'https://uploads.github.com';
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
};

// ---------- 主流程 ----------
//
// 注意：全脚本只用 exitCode / 抛异常，不直接 process.exit()——
// Windows 上 undici keep-alive socket 未关闭时强退会触发 libuv 断言崩溃

async function main() {
  if (process.exitCode) return; // 参数/环境校验已失败

  const all = await api(`/repos/${REPO}/releases?per_page=100`);
  const matched = all.filter((r) => r.tag_name === TAG);
  if (matched.length === 0) {
    console.error(`[fix-release] 未找到 tag 为 ${TAG} 的 Release`);
    process.exitCode = 1;
    return;
  }

  const published = matched.filter((r) => !r.draft);
  const drafts = matched.filter((r) => r.draft);

  // 目标：优先复用已发布的；否则选资产最多（并列取最早创建）的草稿
  let target;
  if (published.length > 0) {
    target = published[0];
    if (published.length > 1) {
      console.warn(`[fix-release] 警告：存在 ${published.length} 个已发布的同名 Release，仅保留第一个`);
    }
  } else {
    drafts.sort(
      (a, b) => b.assets.length - a.assets.length || new Date(a.created_at) - new Date(b.created_at)
    );
    target = drafts[0];
  }

  const others = matched.filter((r) => r.id !== target.id);
  if (others.length === 0 && !target.draft) {
    console.log(`[fix-release] ${TAG} 已正常发布，无需处理`);
    return;
  }

  // 汇总其他 Release 的资产（同名取最新），并转移到目标
  const targetAssets = new Map(target.assets.map((a) => [a.name, a]));
  const incoming = new Map(); // name -> asset（来自其他 Release）
  for (const r of others) {
    for (const a of r.assets) {
      const prev = incoming.get(a.name);
      if (!prev || new Date(a.created_at) > new Date(prev.created_at)) incoming.set(a.name, a);
    }
  }

  for (const [name, asset] of incoming) {
    const existing = targetAssets.get(name);
    if (existing && new Date(existing.created_at) >= new Date(asset.created_at)) continue;
    if (existing) {
      console.log(`[fix-release] 替换资产 ${name}（目标上的版本更旧）`);
      await api(`/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
    } else {
      console.log(`[fix-release] 转移资产 ${name}（来自 release #${asset.id}）`);
    }
    const buf = Buffer.from(
      await (
        await fetch(asset.url, {
          headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/octet-stream' },
        })
      ).arrayBuffer()
    );
    const up = await fetch(
      `${UPLOAD}/repos/${REPO}/releases/${target.id}/assets?name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: buf }
    );
    if (!up.ok) throw new Error(`上传 ${name} 失败：${up.status} ${(await up.text()).slice(0, 200)}`);
  }

  // 发布目标草稿
  if (target.draft) {
    await api(`/repos/${REPO}/releases/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false, name: TAG }),
    });
    console.log(`[fix-release] 已发布 release #${target.id}`);
  }

  // 删除多余草稿（不动已发布的）
  for (const r of others) {
    if (!r.draft) continue;
    await api(`/repos/${REPO}/releases/${r.id}`, { method: 'DELETE' });
    console.log(`[fix-release] 已删除重复草稿 #${r.id}`);
  }

  console.log(`[fix-release] 完成：${TAG} → https://github.com/${REPO}/releases/tag/${TAG}`);
}

try {
  await main();
} catch (err) {
  console.error(`[fix-release] 失败：${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
