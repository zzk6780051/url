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
| `DELETE` | `/api/links/:code` | 删除短链，body: `{ password }` |
| `GET` | `/:code` | 302 重定向到原始 URL |

## 测试

```bash
npm test
```

测试不需要网络和 Cloudflare 账号，覆盖登录、创建（随机/自定义/重复）、列表权限隔离、跳转计数、删除、未配置密码等场景。
