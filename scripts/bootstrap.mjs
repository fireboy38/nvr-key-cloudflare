#!/usr/bin/env node
/**
 * 本地手动初始化脚本：创建 D1 数据库 + KV 命名空间 + 初始化表结构
 *
 * 适用场景: 你想用本地命令行一次性创建好 Cloudflare 资源，而不是在 Dashboard
 *           手动点界面。
 *
 * 前置条件:
 *   - 已 wrangler login
 *   - 或设置了 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID 环境变量
 *
 * 用法:
 *   node scripts/bootstrap.mjs
 *
 * 输出: 创建好的 D1 database_id 和 KV namespace id，你可以复制到 wrangler.toml
 *       (如果选择用 wrangler.toml 绑定方式)
 *
 * 注: 该脚本不会自动修改 wrangler.toml。本项目的部署推荐使用 Cloudflare
 *     Dashboard 上的 Bindings 配置，无需修改 wrangler.toml。
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_SQL = join(__dirname, "..", "schema.sql");

function log(msg) {
  console.log(`[bootstrap] ${msg}`);
}

function fail(msg) {
  console.error(`[bootstrap] ✘ ${msg}`);
  process.exit(1);
}

function wrangler(args) {
  const cmd = `npx wrangler ${args}`;
  log(`$ ${cmd}`);
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function listD1Databases() {
  try {
    return JSON.parse(wrangler("d1 list --json")) || [];
  } catch {
    return [];
  }
}

function listKvNamespaces() {
  try {
    return JSON.parse(wrangler("kv namespace list --json")) || [];
  } catch {
    return [];
  }
}

function parseId(stdout, key) {
  const m = stdout.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
  if (!m) throw new Error(`无法从输出中解析 ${key}`);
  return m[1];
}

function main() {
  log(`开始 (cwd=${process.cwd()})`);

  // 1. D1
  let d1Id;
  const dbs = listD1Databases();
  const existingDb = dbs.find((d) => d.name === "nvr-key-db");
  if (existingDb) {
    d1Id = existingDb.uuid;
    log(`找到已存在的 D1: ${d1Id}`);
  } else {
    log("创建 D1 数据库 nvr-key-db ...");
    const out = wrangler("d1 create nvr-key-db");
    d1Id = parseId(out, "database_id");
    log(`✅ 已创建 D1: ${d1Id}`);
  }

  // 2. KV
  let kvId;
  const kvs = listKvNamespaces();
  const existingKv = kvs.find((k) => k.title === "SESSIONS");
  if (existingKv) {
    kvId = existingKv.id;
    log(`找到已存在的 KV: ${kvId}`);
  } else {
    log("创建 KV 命名空间 SESSIONS ...");
    const out = wrangler("kv namespace create SESSIONS");
    kvId = parseId(out, "id");
    log(`✅ 已创建 KV: ${kvId}`);
  }

  // 3. 初始化 D1 表结构
  log("初始化 D1 表结构...");
  try {
    wrangler(`d1 execute nvr-key-db --remote --file=${SCHEMA_SQL}`);
    log("✅ D1 表结构已就绪");
  } catch (e) {
    log(`⚠️  D1 表结构初始化跳过（可能已存在）: ${e.message}`);
  }

  console.log("\n===============================================");
  console.log("✅ 资源创建完成。请记录以下 ID:");
  console.log("===============================================");
  console.log(`D1 database_id:  ${d1Id}`);
  console.log(`KV namespace id: ${kvId}`);
  console.log("");
  console.log("如果你用 Cloudflare Dashboard 绑定方式，无需记这些 ID。");
  console.log("如果你用 wrangler.toml 绑定方式，把它们填入 wrangler.toml:");
  console.log(`  database_id = "${d1Id}"`);
  console.log(`  id          = "${kvId}"`);
}

try {
  main();
} catch (e) {
  fail(e.message);
}
