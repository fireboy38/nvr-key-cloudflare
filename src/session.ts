/**
 * 基于 KV 的 session 管理（替代 Python 版的内存 dict）。
 *
 * Workers 是无状态的，每次请求可能在不同的 isolate 中执行，
 * 因此必须使用 KV 或 Durable Objects 持久化 session。
 */

const SESSION_TTL_SECONDS = 7200; // 2 小时

export interface SessionData {
  token: string;
  expiresAt: number; // epoch 毫秒
}

/**
 * 创建新 session，返回 token。
 * KV 的 expireTtl 单位为秒，过期自动清理。
 */
export async function createSession(kv: KVNamespace): Promise<string> {
  const token = generateToken();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await kv.put(`session:${token}`, JSON.stringify({ expiresAt }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

/** 校验 token 是否有效 */
export async function checkSession(kv: KVNamespace, token: string | null): Promise<boolean> {
  if (!token) return false;
  const raw = await kv.get(`session:${token}`);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw) as SessionData;
    return data.expiresAt > Date.now();
  } catch {
    return false;
  }
}

/** 销毁 session */
export async function destroySession(kv: KVNamespace, token: string | null): Promise<void> {
  if (!token) return;
  await kv.delete(`session:${token}`);
}

/** 生成 32 字节 url-safe token */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
