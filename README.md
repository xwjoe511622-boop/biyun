## 演示模式（v0 / 设计预览）

`npm install && npm run dev` 即可看到完整页面：`.env.development` 里的 `VITE_DEMO=1` 会把浏览器内的模拟后端
（`demo/mock.js`、`demo/icons.json`）注入页面，不连接任何服务器。打开即为已登录的演示账号，币种与价格为模拟数据。

- 连接真实后端开发：把 `.env.development` 改成 `VITE_DEMO=0`。
- 本仓库带有 `.env.production`（`VITE_DEMO=1`），所以部署出来的链接同样是演示模式。**正式上线前必须删除该文件**，否则线上会显示模拟数据。
- `vercel.json` 让 Vercel 上直接打开或刷新 `/assets` 这类地址时不报 404。
- 演示数据（币种、价格、账号、公告、横幅）都在 `demo/mock.js`，不是真实数据。

# BITWINEX Pro 前端源码

使用与接入方式见压缩包根目录的 README.md。
