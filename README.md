# Widgets Disk（Pages 版）

Cloudflare Pages 高级模式部署的文件储存面板：仓库根目录的 `_worker.js` 接管全部请求，运行时与原 Worker 版完全一致。

## 必需配置（Pages 项目 → 设置）

- 绑定 KV 命名空间：变量名 `FILE_KV`
- 绑定 D1 数据库：变量名 `FILE_DB`
- 环境变量（生产）：`ADMIN_SECRET` = 面板登录密钥

修改绑定或环境变量后，需要一次新的部署才生效（推一个提交即可自动部署）。

## 说明

- 数据存放在 KV（文件本体）与 D1（文件清单）中，与部署方式无关，Worker 版与 Pages 版共用同一份数据。
- 面板支持添加到 iPhone 主屏幕以独立应用窗口运行（PWA）。
