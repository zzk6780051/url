# url-shortener

基于 **Cloudflare Workers + D1** 的短链接服务。单文件 Worker，前端页面由 Worker 直接返回，无需构建步骤。

## 功能

- 生成短链：随机 6 位短码，或自定义短码（字母、数字、`-`、`_`，长度 2–32）。
- 访问 `/<code>` 会 302 跳转到原始链接，并在后台累加点击次数。
- 短链列表：**未登录也能查看**短码、原始链接和创建时间。
- 管理员登录后可创建 / 删除短链、查看点击次数。
- 管理员密码通过请求头 `X-Admin-Password` 传递，不进入 URL、Referer 或访问日志；比较使用常量时间实现。
- 点击次数在接口层就做隔离：未登录请求 `/api/links` 时响应里根本没有 `hits` 字段，而不是前端隐藏。
- 若服务端密码被修改，前端会自动清掉本地旧密码并回退到未登录视图。

## 技术栈

| 部分 | 说明 |
| --- | --- |
| 运行时 | Cloudflare Workers（ES Module 语法） |
| 数据库 | Cloudflare D1（SQLite） |
| 前端 | 原生 HTML/CSS/JS，由 Worker 内联返回 |
| 测试 | Node.js 内置 `node:test` + 内存 D1 模拟 |

## 目录结构

```
.
├── worker.js            # Worker 全部逻辑：路由、API、内联前端页面
├── schema.sql           # D1 建表语句
├── wrangler.toml        # Wrangler 配置（D1 绑定）
├── package.json         # 脚本与开发依赖
├── test/
│   └── worker.test.js   # 单元测试（mock D1）
├── .gitignore
└── LICENSE
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/` | 否 | 管理页面 |
| `GET` | `/<code>` | 否 | 302 跳转并计数 |
| `GET` | `/api/links` | 可选（`X-Admin-Password` 头） | 短链列表；密码正确时额外返回 `hits` |
| `POST` | `/api/login` | 否 | 校验密码，body：`{ "password": "..." }` |
| `POST` | `/api/shorten` | 是 | 创建短链，body：`{ "url", "customCode"?, "password" }` |
| `DELETE` | `/api/links/<code>` | 是 | 删除短链，body：`{ "password": "..." }` |

鉴权失败统一返回 `401`，错误信息为 `{ "error": "未登录或登录已失效" }`。

## 本地开发

```bash
npm install

# 初始化本地 D1
npx wrangler d1 create shortlinks   # 首次：创建数据库，把返回的 database_id 填入 wrangler.toml
npm run db:init:local

# 本地变量（不要提交到仓库）
echo 'ADMIN_PASSWORD="your-password"' > .dev.vars

npm run dev
```

## 部署

```bash
# 1. 创建 D1 并写入 database_id
npx wrangler d1 create shortlinks

# 2. 建表
npm run db:init:remote

# 3. 配置管理密码（secret，不落仓库）
npx wrangler secret put ADMIN_PASSWORD

# 4. 部署
npm run deploy
```

部署后 Worker 域名形如 `https://url-shortener.<your-subdomain>.workers.dev`，短链就是 `https://.../<code>`。
如需自定义域名，在 Cloudflare 控制台给 Worker 添加 Custom Domain 即可。

## 测试

```bash
npm test
```

测试使用内存版 D1 模拟，无需网络和 Cloudflare 账号，覆盖登录、创建（随机/自定义/重复）、列表权限隔离、跳转计数、删除、未配置密码等场景。

## 安全说明

- 管理密码只通过 `wrangler secret put ADMIN_PASSWORD` 注入，仓库中不包含任何明文密码。
- 密码比较使用常量时间比较，避免时序侧信道。
- 未登录时 `hits` 不会出现在响应 JSON 中，无法通过 DevTools 获取。
- 短链列表本身是公开的；若希望列表也仅管理员可见，在 `handleListLinks` 中未授权时直接返回 `401`，并隐藏页面左上角的列表按钮。

## License

[MIT](./LICENSE)
