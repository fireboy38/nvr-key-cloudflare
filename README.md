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

支持两种部署方式：

### 方式 1：Cloudflare Workers Build（推荐，CI 自动部署）

通过 GitHub 仓库连接 Cloudflare，每次 push 自动部署。

**一次性设置**：

1. 在 Cloudflare Dashboard 进入 Workers & Pages → Create → Workers → Connect to Git
2. 选择仓库 `nvr-key-cloudflare`，分支 `main`
3. **Build command**: 留空（或填 `npm install`）
4. **Deploy command**: `npm run deploy`（关键！会自动先跑 `bootstrap` 再 `wrangler deploy`）
5. 保存并部署

首次部署时，`scripts/bootstrap.mjs` 会：
- 检测 `wrangler.toml` 中 D1/KV ID 是否还是占位符
- 自动创建 `nvr-key-db` D1 数据库和 `SESSIONS` KV 命名空间
- 把真实 ID 写回 `wrangler.toml`（**注意：脚本会修改 wrangler.toml，但不会 push 回仓库**）
- 自动执行 `schema.sql` 初始化表结构
- 之后才执行 `wrangler deploy`

> ⚠️ Cloudflare Workers Build 默认会注入 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 给 wrangler 使用，无需额外配置。

**部署后必须做的事**：

到 Worker 的 Dashboard → Settings → Variables and Secrets → 添加：
- 变量名: `KEYGEN_ADMIN_PASSWORD`
- 值: 你的管理密码
- 类型: **Secret**（加密）

### 方式 2：手动本地部署

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare（一次性）
npx wrangler login

# 3. 一键部署（会自动 bootstrap）
npm run deploy
```

`npm run deploy` 会触发 `predeploy` 钩子自动跑 bootstrap.mjs，所以你不需要手动创建 D1/KV。

**设置管理密码**：

```bash
npx wrangler secret put KEYGEN_ADMIN_PASSWORD
# 按提示输入新密码
```

### 后续查看日志

```bash
npm run tail
# 或在 Cloudflare Dashboard → Worker → Logs 查看
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
