/**
 * 许可证核心算法 — 移植自 Python core/license_manager.py
 *
 * 仅保留 Web 端所需功能:
 *   - generate_key(): 生成激活密钥
 *   - validate_key(): 验证激活密钥
 *
 * 客户端用到的硬件信息查询 (MAC/磁盘序列号)、文件存储、试用模式等
 * 在 Workers 环境中无意义，已剔除。
 *
 * HMAC 使用 Web Crypto API (SubtleCrypto.sign)，Workers 原生支持。
 */

// ============================================================
// 常量
// ============================================================

/** HMAC 密钥 — 与 Python 版本保持一致，确保密钥互通 */
const SECRET_KEY = "HikVision_Downloader_2024_SecretKey_XsInfo";

// 预导入的 HMAC key（避免每次 importKey）
let _hmacKeyPromise: Promise<CryptoKey> | null = null;
async function getHmacKey(): Promise<CryptoKey> {
  if (!_hmacKeyPromise) {
    _hmacKeyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return _hmacKeyPromise;
}

export const LICENSE_TYPE_TRIAL = "trial";
export const LICENSE_TYPE_STANDARD = "standard";
export const LICENSE_TYPE_LIFETIME = "lifetime";

export type LicenseType =
  | typeof LICENSE_TYPE_TRIAL
  | typeof LICENSE_TYPE_STANDARD
  | typeof LICENSE_TYPE_LIFETIME;

/** 各类型对应有效期天数（lifetime 为 null） */
const LICENSE_DURATION: Record<LicenseType, number | null> = {
  [LICENSE_TYPE_TRIAL]: 7,
  [LICENSE_TYPE_STANDARD]: 365,
  [LICENSE_TYPE_LIFETIME]: null,
};

/** 中文展示名 */
export const LICENSE_NAMES: Record<LicenseType, string> = {
  [LICENSE_TYPE_TRIAL]: "试用版",
  [LICENSE_TYPE_STANDARD]: "标准版",
  [LICENSE_TYPE_LIFETIME]: "终身版",
};

const HEX_CHARS = "0123456789ABCDEF";
const HEX_SET = new Set(HEX_CHARS);

// ============================================================
// 工具函数
// ============================================================

/** 把 16 位 hex 字符串格式化为 XXXX-XXXX-XXXX-XXXX */
function formatKey(hexStr: string): string {
  return [hexStr.slice(0, 4), hexStr.slice(4, 8), hexStr.slice(8, 12), hexStr.slice(12, 16)].join("-");
}

/** 反向：去分隔符 + 大写 */
function unformatKey(key: string): string {
  return key.replace(/-/g, "").toUpperCase();
}

/** 校验是否为 16 位大写十六进制 */
function isValidHex16(s: string): boolean {
  if (s.length !== 16) return false;
  for (const c of s) {
    if (!HEX_SET.has(c)) return false;
  }
  return true;
}

/** ISO 日期字符串 → Date，校验格式 */
function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** YYYY-MM-DD */
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 今天（本地日历日，去掉时分秒） */
function todayDate(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** 计算 HMAC-SHA256，返回前 16 位大写 hex */
async function hmacShort(message: string): Promise<string> {
  const key = await getHmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex.slice(0, 16).toUpperCase();
}

// ============================================================
// 类型定义
// ============================================================

export interface GenerateKeyResult {
  activation_key: string;
  license_type: LicenseType;
  expiry_date: string | null;
  machine_code: string;
}

export interface ValidateKeyResult {
  valid: boolean;
  license_type: LicenseType | null;
  expiry_date: string | null;
  error: string | null;
}

// ============================================================
// 核心 API
// ============================================================

/**
 * 生成激活密钥
 *
 * 算法: HMAC-SHA256(SECRET_KEY, machine_code + expiry_date?) 的前 16 位
 */
export async function generateKey(
  rawMachineCode: string,
  licenseType: LicenseType = LICENSE_TYPE_STANDARD,
  expiryDate?: string | null,
): Promise<GenerateKeyResult> {
  const cleanCode = rawMachineCode.replace(/-/g, "").toUpperCase();
  if (cleanCode.length !== 16) {
    throw new Error(`机器码长度必须为16个字符，当前为 ${cleanCode.length} 个字符`);
  }
  if (!isValidHex16(cleanCode)) {
    throw new Error("机器码必须为有效的十六进制字符");
  }
  if (!(licenseType in LICENSE_DURATION)) {
    throw new Error(`不支持的许可证类型: ${licenseType}`);
  }

  // 计算过期日期
  let expDate: string | null;
  if (expiryDate) {
    const d = parseIsoDate(expiryDate);
    if (!d) {
      throw new Error(`过期日期格式无效，应为 YYYY-MM-DD: ${expiryDate}`);
    }
    expDate = expiryDate;
  } else {
    const duration = LICENSE_DURATION[licenseType];
    if (duration === null) {
      expDate = null; // 终身版
    } else {
      const today = todayDate();
      today.setDate(today.getDate() + duration);
      expDate = toIsoDate(today);
    }
  }

  const message = expDate ? `${cleanCode}${expDate}` : cleanCode;
  const hex = await hmacShort(message);
  return {
    activation_key: formatKey(hex),
    license_type: licenseType,
    expiry_date: expDate,
    machine_code: cleanCode,
  };
}

/**
 * 验证激活密钥
 *
 * 策略:
 *   1) 先匹配终身版（无 expiry_date）
 *   2) 再在近 30 天 / 400 天范围内逐日尝试 timed 类型
 */
export async function validateKey(rawMachineCode: string, rawKey: string): Promise<ValidateKeyResult> {
  const cleanCode = rawMachineCode.replace(/-/g, "").toUpperCase();
  if (!isValidHex16(cleanCode)) {
    return { valid: false, license_type: null, expiry_date: null, error: "机器码格式无效" };
  }
  const cleanKey = unformatKey(rawKey);
  if (!isValidHex16(cleanKey)) {
    return { valid: false, license_type: null, expiry_date: null, error: "激活密钥格式无效" };
  }

  // 终身版
  const lifetimeHex = await hmacShort(cleanCode);
  if (lifetimeHex === cleanKey) {
    return {
      valid: true,
      license_type: LICENSE_TYPE_LIFETIME,
      expiry_date: null,
      error: null,
    };
  }

  // timed 类型逐日搜索
  const today = todayDate();
  const timedTypes = (Object.entries(LICENSE_DURATION) as [LicenseType, number | null][])
    .filter(([, d]) => d !== null) as [LicenseType, number][];

  for (const searchRangeDays of [30, 400]) {
    for (const [licenseType, duration] of timedTypes) {
      const start = new Date(today);
      start.setDate(start.getDate() - searchRangeDays);
      const end = new Date(today);
      end.setDate(end.getDate() + duration + 30);

      const current = new Date(start);
      while (current <= end) {
        const expiryStr = toIsoDate(current);
        const hex = await hmacShort(`${cleanCode}${expiryStr}`);
        if (hex === cleanKey) {
          if (current < today) {
            return {
              valid: false,
              license_type: licenseType,
              expiry_date: expiryStr,
              error: "许可证已过期",
            };
          }
          return {
            valid: true,
            license_type: licenseType,
            expiry_date: expiryStr,
            error: null,
          };
        }
        current.setDate(current.getDate() + 1);
      }
    }
  }

  return {
    valid: false,
    license_type: null,
    expiry_date: null,
    error: "激活密钥与机器码不匹配",
  };
}

// ============================================================
// 机器码校验辅助（与 Python 版 _normalize_machine_code 等价）
// ============================================================

export interface NormalizedMachineCode {
  code: string;
  error: string | null;
}

export function normalizeMachineCode(raw: string | undefined | null): NormalizedMachineCode {
  if (!raw) return { code: "", error: "机器码不能为空" };
  const mc = raw.trim().replace(/-/g, "").replace(/ /g, "").toUpperCase();
  if (mc.length !== 16 || !isValidHex16(mc)) {
    return { code: mc, error: "机器码格式无效，需 16 位十六进制字符" };
  }
  return { code: mc, error: null };
}

export function sanitizeInt(value: unknown, defaultValue: number, min = 1, max = 1000): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
