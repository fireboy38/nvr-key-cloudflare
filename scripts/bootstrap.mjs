#!/usr/bin/env node
/**
 * 部署前置脚本：自动创建 D1 + KV 并把真实 ID 写回 wrangler.toml
 *
 * 在 Cloudflare Workers Build (CI) 或本地首次部署时运行:
 *   node scripts/bootstrap.mjs
 *
 * 之后再执行 wrangler deploy。
 *
 * 该脚本幂等：
 *   - 如果 wrangler.toml 中 ID 仍是占位符，就创建资源并替换
 *   - 如果 ID 已是真实值，跳过创建
 *
 * 在 CI 中需要设置环境变量:
 *   CLOUDFLARE_API_TOKEN  - Cloudflare API token (Workers Builds 默认提供)
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare 账户 ID (Workers Builds 默认提供)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WRANGLER_TOML = join(__dirname, "..", "wrangler.toml");

const PLACEHOLDER_D1 = "REPLACE_WITH_YOUR_D1_ID";
const PLACEHOLDER_KV = "REPLACE_WITH_YOUR_KV_ID";

function log(msg) {
  console.log(`[bootstrap] ${msg}`);
}

function warn(msg) {
  console.warn(`[bootstrap] ⚠️  ${msg}`);
}

function fail(msg) {
  console.error(`[bootstrap] ✘ ${msg}`);
  process.exit(1);
}

/** 执行 wrangler 命令，返回 stdout 字符串 */
function wrangler(args) {
  const cmd = `npx wrangler ${args}`;
  log(`$ ${cmd}`);
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

/** 解析 wrangler d1 create 的输出，提取 database_id */
function parseD1CreateOutput(stdout) {
  // 输出形如:
  //   ✅ Successfully created DB 'nvr-key-db'
  //   [[d1_databases]]
  //   binding = "DB"
  //   database_name = "nvr-key-db"
  //   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  const m = stdout.match(/database_id\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("无法从 wrangler d1 create 输出中解析 database_id");
  return m[1];
}

/** 解析 wrangler kv namespace create 的输出，提取 id */
function parseKvCreateOutput(stdout) {
  // 输出形如:
  //   ⛅️ wrangler 3.x
  //   ...
  //   [[kv_namespaces]]
  //   binding = "SESSIONS"
  //   id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  const m = stdout.match(/\bid\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("无法从 wrangler kv namespace create 输出中解析 id");
  return m[1];
}

/** 列出已存在的 D1 数据库，返回 [{name, uuid}]；找不到时返回 [] */
function listD1Databases() {
  try {
    const out = wrangler("d1 list --json");
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 列出已存在的 KV 命名空间，返回 [{id, title}] */
function listKvNamespaces() {
  try {
    const out = wrangler("kv namespace list --json");
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 把 toml 中指定的占位符替换为真实 ID */
function patchWranglerToml(replacements) {
  let content = readFileSync(WRANGLER_TOML, "utf8");
  for (const [placeholder, realId] of Object.entries(replacements)) {
    if (!content.includes(placeholder)) {
      log(`toml 中已不含占位符 ${placeholder}，跳过`);
      continue;
    }
    content = content.split(placeholder).join(realId);
    log(`替换 ${placeholder} -> ${realId}`);
  }
  writeFileSync(WRANGLER_TOML, content, "utf8");
}

function main() {
  log(`开始 (cwd=${process.cwd()})`);

  // 检查环境
  if (!process.env.CLOUDFLARE_API_TOKEN && !process.env.CF_API_TOKEN) {
    warn("未检测到 CLOUDFLARE_API_TOKEN / CF_API_TOKEN");
    warn("如果是本地运行，请先 `wrangler login` 或设置环境变量");
  }

  // 读当前 wrangler.toml
  const toml = readFileSync(WRANGLER_TOML, "utf8");
  const needsD1 = toml.includes(PLACEHOLDER_D1);
  const needsKV = toml.includes(PLACEHOLDER_KV);

  if (!needsD1 && !needsKV) {
    log("wrangler.toml 中 D1 / KV ID 均已是真实值，无需 bootstrap");
    return;
  }

  const replacements = {};

  // ---- D1 ----
  if (needsD1) {
    log("需要创建或复用 D1 数据库 nvr-key-db ...");
    let dbId = null;

    // 先尝试找已存在的
    const dbs = listD1Databases();
    const existing = dbs.find((d) => d.name === "nvr-key-db");
    if (existing) {
      dbId = existing.uuid;
      log(`找到已存在的 D1: ${dbId}`);
    } else {
      // 创建新的
      try {
        const out = wrangler("d1 create nvr-key-db");
        dbId = parseD1CreateOutput(out);
        log(`已创建 D1: ${dbId}`);
      } catch (e) {
        fail(`D1 创建失败: ${e.message}`);
      }
    }
    replacements[PLACEHOLDER_D1] = dbId;
  }

  // ---- KV ----
  if (needsKV) {
    log("需要创建或复用 KV 命名空间 SESSIONS ...");
    let kvId = null;

    const kvs = listKvNamespaces();
    const existingKv = kvs.find((k) => k.title === "SESSIONS");
    if (existingKv) {
      kvId = existingKv.id;
      log(`找到已存在的 KV: ${kvId}`);
    } else {
      try {
        const out = wrangler("kv namespace create SESSIONS");
        kvId = parseKvCreateOutput(out);
        log(`已创建 KV: ${kvId}`);
      } catch (e) {
        fail(`KV 创建失败: ${e.message}`);
      }
    }
    replacements[PLACEHOLDER_KV] = kvId;
  }

  // ---- 写回 wrangler.toml ----
  patchWranglerToml(replacements);

  // ---- 初始化 D1 表结构（仅当刚创建 D1 时） ----
  if (needsD1 && replacements[PLACEHOLDER_D1]) {
    log("初始化 D1 表结构...");
    try {
      wrangler("d1 execute nvr-key-db --remote --file=./schema.sql");
      log("✅ D1 表结构已就绪");
    } catch (e) {
      warn(`D1 表结构初始化失败（可能已存在）: ${e.message}`);
    }
  }

  log("✅ bootstrap 完成");
}

try {
  main();
} catch (e) {
  fail(e.message);
}
