# nvr-key · Cloudflare Workers 版

把原 Python 项目移植到 Cloudflare Workers，享受全球边缘网络、自动 HTTPS、按需计费。

## 与原 Python 版的差异

| 维度 | Python 版 | Cloudflare Workers 版 |
|------|-----------|----------------------|
| 语言 | Python 3 | TypeScript |
| Web 框架 | `http.server` | Hono |
| 数据库 | 本地 SQLite | Cloudflare D1 |
| Session | 进程内存 dict | Cloudflare KV (TTL 自动清理) |
| 静态资源 | 直接读文件 | Workers Assets |
| HMAC | `hashlib` / `hmac` | Web Crypto API |
| 硬件信息查询 | `subprocess` 调用 wmic/lsblk/ioreg | ❌ 已移除（仅客户端用） |

> ⚠️ 密钥生成算法、HMAC、机器码格式 100% 一致，Python 客户端生成的密钥可以直接被 Workers 版验证（已通过测试，密钥互通）。

## 项目结构

```
nvr-key-cloudflare/
├── src/
│   ├── index.ts         # Hono 路由（移植 keygen_web.py）
│   ├── license.ts       # 密钥算法（移植 license_manager.py 核心部分）
│   └── session.ts       # KV-based session 管理
├── public/
│   └── index.html       # 静态前端（与 Python 版完全相同）
├── schema.sql           # D1 表结构
├── wrangler.toml        # Cloudflare 配置
├── package.json
└── tsconfig.json
```

## 本地开发

```bash
# 1. 安装依赖
npm install

# 2. 初始化本地 D1（首次运行）
npm run db:init

# 3. 启动本地 dev server
npm run dev
# 访问 http://localhost:8787
```

## 部署到 Cloudflare

### 1. 安装 wrangler 并登录

```bash
npx wrangler login
# 浏览器会打开 Cloudflare 授权页
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create nvr-key-db
# 输出会包含 database_id，把它复制到 wrangler.toml 里
```

### 3. 创建 KV 命名空间

```bash
npx wrangler kv namespace create SESSIONS
# 输出会包含 id，把它复制到 wrangler.toml 里
```

### 4. 编辑 `wrangler.toml`

把 `REPLACE_WITH_YOUR_D1_ID` 和 `REPLACE_WITH_YOUR_KV_ID` 替换成上两步拿到的真实 ID。

### 5. 初始化远程 D1 表结构

```bash
npm run db:init:remote
```

### 6. 设置管理密码（推荐用 secret，避免硬编码）

```bash
npx wrangler secret put KEYGEN_ADMIN_PASSWORD
# 按提示输入新密码
```

设置 secret 后，可以删除 `wrangler.toml` 中的 `[vars]` 段里的 `KEYGEN_ADMIN_PASSWORD` 行。

### 7. 部署！

```bash
npm run deploy
# 输出会给出线上访问地址，类似:
# https://nvr-key.<your-subdomain>.workers.dev
```

### 8. 后续查看日志

```bash
npm run tail
```

## 已验证的功能

本地集成测试已通过（11/11）:

- ✅ 登录 / 鉴权 / 登出 / 会话过期
- ✅ 生成单条注册码（试用/标准/终身）
- ✅ 批量生成
- ✅ 验证密钥
- ✅ 历史记录分页
- ✅ 删除 / 清空记录
- ✅ CSV 导出（正确转义含逗号字段）
- ✅ 与 Python 版密钥互通（同机器码生成同密钥）

## 性能预算（参考）

- Workers 免费套餐: 100,000 请求/天
- D1 免费套餐: 5GB 存储 + 5M 行读/天
- KV 免费套餐: 100,000 读 + 1,000 写/天

对于内部使用的注册机系统，免费套餐完全够用。

## 安全提示

- `SECRET_KEY` 仍硬编码在 `src/license.ts` 中，与 Python 版保持一致以便密钥互通
- 生产环境务必通过 `wrangler secret put KEYGEN_ADMIN_PASSWORD` 设置管理密码
- Workers 自带 HTTPS，无需额外配置证书
- Cloudflare 自带 DDoS 防护和 WAF
