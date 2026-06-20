/**
 * nvr-key · Cloudflare Workers 入口
 *
 * 技术栈: Hono + D1 + KV + Workers Assets
 * 等价于 Python 版 keygen_web.py
 */

import { Hono, type Context } from "hono";
import {
  generateKey,
  validateKey,
  normalizeMachineCode,
  sanitizeInt,
  LICENSE_NAMES,
  LICENSE_TYPE_STANDARD,
  type LicenseType,
} from "./license";
import { createSession, checkSession, destroySession } from "./session";

// ============================================================
// 类型
// ============================================================

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  KEYGEN_ADMIN_PASSWORD: string;
  SESSION_TTL_SECONDS?: string;
}

interface ApiResult {
  ok: boolean;
  [key: string]: unknown;
}

// ============================================================
// 应用
// ============================================================

const app = new Hono<{ Bindings: Env }>();

// ---------- 公开路由 ----------

app.post("/api/login", async (c) => {
  const body = await readJsonBody(c);
  const pwd = String(body.password ?? "");
  if (pwd === c.env.KEYGEN_ADMIN_PASSWORD) {
    const token = await createSession(c.env.SESSIONS);
    console.log(`[login] success token=${token.slice(0, 8)}...`);
    return json(c, { ok: true, token });
  }
  console.log(`[login] failed: password length=${pwd.length}`);
  return json(c, { ok: false, error: "密码错误" });
});

// ---------- 鉴权中间件 ----------

app.use("/api/*", async (c, next) => {
  // /api/login 已经处理过，跳过
  if (c.req.path === "/api/login") {
    await next();
    return;
  }
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!(await checkSession(c.env.SESSIONS, token))) {
    return json(c, { ok: false, error: "未登录或会话已过期" }, 401);
  }
  await next();
});

// ---------- 受保护 API ----------

app.post("/api/logout", async (c) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  await destroySession(c.env.SESSIONS, token);
  return json(c, { ok: true });
});

app.post("/api/generate", async (c) => {
  const body = await readJsonBody(c);
  const { code: mc, error } = normalizeMachineCode(String(body.machine_code ?? ""));
  if (error) return json(c, { ok: false, error });

  const licenseType = (body.license_type ?? LICENSE_TYPE_STANDARD) as LicenseType;
  const expiryDate: string | null = (body.expiry_date as string) || null;

  let result;
  try {
    result = await generateKey(mc, licenseType, expiryDate);
  } catch (e) {
    return json(c, { ok: false, error: (e as Error).message });
  }

  await saveRecord(c, mc, result.activation_key, licenseType, result.expiry_date ?? "", String(body.operator ?? "web"));

  return json(c, {
    ok: true,
    activation_key: result.activation_key,
    license_type: licenseType,
    license_name: LICENSE_NAMES[licenseType] ?? licenseType,
    expiry_date: result.expiry_date ?? "永不过期",
    machine_code: mc,
  });
});

app.post("/api/batch", async (c) => {
  const body = await readJsonBody(c);
  const rawCodes = String(body.machine_codes ?? "");
  const licenseType = (body.license_type ?? LICENSE_TYPE_STANDARD) as LicenseType;
  const operator = String(body.operator ?? "web");

  const results: unknown[] = [];
  for (const line of rawCodes.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const { code: mc, error } = normalizeMachineCode(trimmed);
    if (error) {
      results.push({ machine_code: trimmed, activation_key: "", error: "格式无效" });
      continue;
    }

    try {
      const r = await generateKey(mc, licenseType);
      await saveRecord(c, mc, r.activation_key, licenseType, r.expiry_date ?? "", operator);
      results.push({
        machine_code: mc,
        activation_key: r.activation_key,
        license_type: licenseType,
        expiry_date: r.expiry_date ?? "永不过期",
        ok: true,
      });
    } catch (e) {
      results.push({ machine_code: mc, activation_key: "", error: (e as Error).message });
    }
  }
  return json(c, { ok: true, results });
});

app.post("/api/verify", async (c) => {
  const body = await readJsonBody(c);
  const { code: mc, error } = normalizeMachineCode(String(body.machine_code ?? ""));
  if (error) return json(c, { ok: false, error });

  const key = String(body.activation_key ?? "").trim();
  if (!key) return json(c, { ok: false, error: "请输入激活密钥" });

  const result = await validateKey(mc, key);
  return json(c, {
    ok: true,
    valid: result.valid,
    license_type: result.license_type,
    license_name: result.license_type ? LICENSE_NAMES[result.license_type] ?? "" : "",
    expiry_date: result.expiry_date ?? "永不过期",
    error: result.error,
  });
});

app.post("/api/history", async (c) => {
  const body = await readJsonBody(c);
  const page = sanitizeInt(body.page, 1, 1, 100000);
  const size = sanitizeInt(body.size, 20, 1, 200);
  const offset = (page - 1) * size;

  const db = c.env.DB;
  const totalRow = await db.prepare("SELECT COUNT(*) AS c FROM records").first<{ c: number }>();
  const total = totalRow?.c ?? 0;

  const rows = await db
    .prepare(
      "SELECT id, machine_code, activation_key, license_type, expiry_date, operator, created_at " +
        "FROM records ORDER BY id DESC LIMIT ? OFFSET ?",
    )
    .bind(size, offset)
    .all<DbRecord>();

  const records = (rows.results ?? []).map((r) => ({
    id: r.id,
    machine_code: r.machine_code,
    activation_key: r.activation_key,
    license_type: r.license_type,
    license_name: LICENSE_NAMES[r.license_type as LicenseType] ?? r.license_type,
    expiry_date: r.expiry_date || "永不过期",
    operator: r.operator,
    created_at: r.created_at,
  }));

  return json(c, { ok: true, records, total, page, size });
});

app.post("/api/delete", async (c) => {
  const body = await readJsonBody(c);
  const id = body.id;
  if (id == null) return json(c, { ok: false, error: "缺少 id" });
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) return json(c, { ok: false, error: "id 必须为整数" });

  await c.env.DB.prepare("DELETE FROM records WHERE id = ?").bind(idNum).run();
  return json(c, { ok: true });
});

app.post("/api/clear", async (c) => {
  await c.env.DB.prepare("DELETE FROM records").run();
  return json(c, { ok: true });
});

app.post("/api/export", async (c) => {
  const rows = await c.env.DB
    .prepare(
      "SELECT machine_code, activation_key, license_type, expiry_date, operator, created_at " +
        "FROM records ORDER BY id DESC",
    )
    .all<DbRecord>();

  const lines: string[] = ["机器码,注册码,授权类型,过期日期,备注,生成时间"];
  for (const r of rows.results ?? []) {
    const licenseName = LICENSE_NAMES[r.license_type as LicenseType] ?? r.license_type;
    lines.push(
      [r.machine_code, r.activation_key, licenseName, r.expiry_date || "永不过期", r.operator, r.created_at]
        .map(csvEscape)
        .join(","),
    );
  }
  return json(c, { ok: true, csv: lines.join("\n") });
});

// ---------- 静态 HTML ----------

app.get("/", async (c) => {
  // Workers Assets 自动提供 /public 目录下的文件
  // 用 ASSETS binding 直接 fetch /index.html
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

// ---------- 兜底 ----------

app.notFound((c) => json(c, { ok: false, error: "未知接口" }, 404));
app.onError((err, c) => {
  console.error(`[onError] ${c.req.method} ${c.req.path}:`, err);
  return json(c, { ok: false, error: `服务器内部错误: ${err.message}` }, 500);
});

// ============================================================
// 辅助函数
// ============================================================

interface DbRecord {
  id: number;
  machine_code: string;
  activation_key: string;
  license_type: string;
  expiry_date: string | null;
  operator: string;
  created_at: string;
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

function json(c: Context, data: ApiResult, status = 200): Response {
  return c.json(data, status as any);
}

async function saveRecord(
  c: Context<{ Bindings: Env }>,
  machineCode: string,
  activationKey: string,
  licenseType: string,
  expiryDate: string,
  operator: string,
): Promise<void> {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  await c.env.DB.prepare(
    "INSERT INTO records (machine_code, activation_key, license_type, expiry_date, operator, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(machineCode, activationKey, licenseType, expiryDate, operator, now)
    .run();
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// 引入 Context 类型（Hono 推断）

// ============================================================
// 导出
// ============================================================

export default app;
