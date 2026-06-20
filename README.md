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

支持两种方式：

### 方式 1：Cloudflare Workers Build + Dashboard 绑定（推荐，最稳）

#### 第 1 步：连接 GitHub 仓库

在 Cloudflare Dashboard:
- Workers & Pages → Create → Workers → Connect to Git
- 选 `nvr-key-cloudflare` 仓库，分支 `main`
- **Build command**: 留空（或填 `npm install`）
- **Deploy command**: 保持默认 `npx wrangler deploy`（不需要改！）
- 保存

#### 第 2 步：在 Dashboard 创建并绑定 D1 + KV

进入刚创建的 Worker（叫 `nvr-key-cloudflare`）→ **Settings → Bindings**：

**a) 添加 D1 数据库**:
- 点 "Add binding" → 选 "D1 database"
- Variable name: **`DB`**（必须完全一致）
- 选 "Create new database"，名字填 `nvr-key-db`
- 保存

**b) 添加 KV 命名空间**:
- 点 "Add binding" → 选 "KV namespace"
- Variable name: **`SESSIONS`**（必须完全一致）
- 选 "Create new namespace"，名字填 `SESSIONS`
- 保存

#### 第 3 步：初始化 D1 表结构

在 Cloudflare Dashboard:
- Workers & Pages → D1 → 选 `nvr-key-db` → Console
- 把 `schema.sql` 的内容粘贴进去执行

或用本地命令（需要 `wrangler login`）:
```bash
npx wrangler d1 execute nvr-key-db --remote --file=./schema.sql
```

#### 第 4 步：设置管理密码

进入 Worker → Settings → Variables and Secrets → Add variable:
- Variable name: `KEYGEN_ADMIN_PASSWORD`
- Value: 你的管理密码
- Type: **Secret** (Encrypt)

#### 第 5 步：重新部署

在 Worker 的 Deployments 列表点 "Retry deployment"，或随便 `git push` 一个空 commit 触发:
```bash
git commit --allow-empty -m "trigger redeploy" && git push
```

部署成功后访问 `https://nvr-key-cloudflare.<你的子域>.workers.dev`。

### 方式 2：本地手动部署（如果你更喜欢命令行）

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 用 bootstrap 脚本创建 D1 + KV 并初始化表结构
#    （脚本会输出 database_id 和 kv namespace id）
npm run bootstrap

# 4. 把上一步输出的两个 ID 填到 wrangler.toml 中，添加这两段:
#    [[d1_databases]]
#    binding = "DB"
#    database_name = "nvr-key-db"
#    database_id = "<填这里>"
#
#    [[kv_namespaces]]
#    binding = "SESSIONS"
#    id = "<填这里>"

# 5. 设置管理密码
npx wrangler secret put KEYGEN_ADMIN_PASSWORD

# 6. 部署
npm run deploy
```

### 后续查看日志

```bash
npm run tail
# 或在 Cloudflare Dashboard → Worker → Logs 查看
```

### 为什么不再用 `predeploy` 自动 bootstrap？

之前我们尝试过用 npm `predeploy` 钩子自动 bootstrap，但 Cloudflare Workers Build 默认 deploy command 是 `npx wrangler deploy`（直接调 wrangler），不经过 npm run，钩子不触发。

用 Dashboard 绑定方式是 Cloudflare 官方推荐做法，更直观、更稳定、不需要改 deploy command。

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
