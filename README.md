# cf-shortlink

基于 Cloudflare Workers + D1 的短链服务。支持自定义短码、点击计数、管理员登录、列表查看与删除。

## 文件说明

| 文件 | 作用 |
|---|---|
| `src/worker.js` | Worker 入口，包含 API、重定向和前端页面 |
| `schema.sql` | D1 表结构，首次部署时在控制台执行一次 |
| `wrangler.jsonc` | 部署配置，声明 D1 绑定名，供 Git 集成部署使用 |
| `package.json` | 依赖与脚本 |
| `test/worker.test.js` | 单元测试（Node 内置 test runner + 内存 D1 模拟） |

## 部署步骤

### 1. 创建 D1 数据库

Cloudflare 控制台 → **Storage & Databases → D1 → Create Database**，命名为 `url`。

### 2. 初始化表结构

进入该 D1 数据库的 **Console**，粘贴并执行 `schema.sql` 的内容。

### 3. 配置管理密码

Worker 项目 → **Settings → Variables and Secrets → Add**：

- Type：**Secret**
- Name：`ADMIN_PASSWORD`
- Value：你的管理密码

### 4. 连接 GitHub 仓库

Worker 项目 → **Settings → Builds → Connect**，选择仓库和 `main` 分支。Build command 留空，Deploy command 保持 `npx wrangler deploy`。

### 5. 触发部署

向 `main` 推送任意提交，Cloudflare 自动部署。部署后在浏览器打开 Worker 的 `*.workers.dev` 域名即可使用。

## 排查「服务端未配置管理密码」

页面提示 **服务端未配置管理密码**，说明运行时 `env.ADMIN_PASSWORD` 和 `env.DELETE_PASSWORD` 都是空值。

部署后访问：

```
https://<你的 worker 域名>/api/health
```

根据返回的 JSON 判断：

- `"passwordConfigured": false` —— 变量没进到当前运行的 Worker：
  1. 最可靠的方式是用 CLI 设置，它会立即创建并部署新版本：
     ```bash
     npx wrangler secret put ADMIN_PASSWORD
     ```
  2. 控制台添加后必须点 **Deploy**（或触发一次仓库部署），Secret 才会进入运行版本。
  3. 名字必须完全一致：`ADMIN_PASSWORD`，全大写、无空格；`Type` 选 Secret。
  4. 确认打开域名对应的 Worker 名字是 `wrangler.jsonc` 里的 `cf-shortlink`。Git 集成项目名与配置里的 `name` 不一致时，可能同时存在两个 Worker，Secret 容易加到没在用的那个上。
  5. 别加到 **Build variables** 里：那是构建期变量，Worker 运行时读不到；要加在 **Variables and Secrets**（运行时）。
  6. 用 `npx wrangler secret list` 确认当前 Worker 有哪些 Secret。
- `"db": "error"` —— D1 绑定有问题：确认 `wrangler.jsonc` 的 `d1_databases` 绑定名是 `DB`、`database_name` 是 `url`，且该 D1 已执行过 `schema.sql`。
- `"envKeys"` 里能看到绑定名（如 `DB`、`ADMIN_PASSWORD`），但不含任何值，可以安全分享。

## 权限模型

| 操作 | 未登录 | 已登录 |
|---|---|---|
| 查看短链列表（短码、原始链接、创建时间） | ✅ | ✅ |
| 查看点击次数 | ❌ | ✅ |
| 创建短链 | ❌ | ✅ |
| 删除短链 | ❌ | ✅ |

登录态保存在 `sessionStorage`，关闭标签页即失效。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/login` | 校验密码，body: `{ password }` |
| `POST` | `/api/shorten` | 创建短链，body: `{ url, customCode?, password }` |
| `GET` | `/api/links` | 列表；请求头带 `X-Admin-Password` 时返回 `hits` |
| `GET` | `/api/health` | 诊断：返回 `passwordConfigured`、`db`、`envKeys`（只含绑定名，不含任何值） |
| `DELETE` | `/api/links/:code` | 删除短链，body: `{ password }` |
| `GET` | `/:code` | 302 重定向到原始 URL |

## 测试

```bash
npm test
```

测试不需要网络和 Cloudflare 账号，覆盖登录、创建（随机/自定义/重复）、列表权限隔离、跳转计数、删除、未配置密码、健康检查等场景。
