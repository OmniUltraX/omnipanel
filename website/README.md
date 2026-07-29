# OmniPanel 官网

基于 Vite 的静态营销站点，可部署到 GitHub Pages。

## 本地开发

```bash
cd website
npm install
npm run dev
```

浏览器访问 `http://localhost:5173/omnipanel/`（开发模式同样使用 `/omnipanel/` 作为 base 路径）。

## 构建

```bash
npm run build
npm run preview
```

产物输出到 `website/dist/`。

## 部署到 GitHub Pages

1. 在仓库 **Settings → Pages** 中，Source 选择 **GitHub Actions**
2. 推送 `website/` 目录变更到 `master` 分支，或手动运行 **Deploy Website** workflow
3. 站点地址：`https://omniultrax.github.io/omnipanel/`

### 自定义域名

在 `website/public/` 下添加 `CNAME` 文件，内容为你的域名；并在仓库 Pages 设置中填写同一域名。构建时将 `GITHUB_PAGES_BASE` 设为 `/`：

```yaml
env:
  GITHUB_PAGES_BASE: /
```

### 修改 base 路径

默认 base 为 `/omnipanel/`（与 GitHub 项目页一致）。本地或 CI 可通过环境变量覆盖：

```bash
GITHUB_PAGES_BASE=/ npm run build   # 根路径部署
```

## 下载页

- 路径：`download.html`（本地 `http://localhost:5173/omnipanel/download.html`）
- 数据源：
  - 优先拉 OSS：`…/omnipanel/releases/latest.json`、`versions.json`
  - 回退同域镜像：`public/releases/*`（`prebuild` / `predev` 由 `npm run sync:releases` 生成）
- 安装包下载链接仍直链 OSS（`<a href>`，不依赖 CORS）
- 首次引导历史索引：`node scripts/bootstrap-oss-versions.mjs --out ./versions.json`

### OSS CORS（可选，用于浏览器直连清单）

在阿里云 OSS 控制台 → Bucket `omnipanel` → 权限管理 → 跨域设置，增加规则：

| 来源 | 允许 Methods | 允许 Headers | 暴露 Headers | 缓存 |
|------|--------------|--------------|--------------|------|
| `https://omniultrax.github.io` | `GET, HEAD` | `*` | `ETag` | `3600` |

未配置时官网仍可用构建镜像；配置后可拿到更新鲜的线上清单。

## 目录结构

```
website/
├── index.html          # 首页
├── download.html       # 下载页
├── src/
│   ├── main.ts         # 首页入口
│   ├── download.ts     # 下载页入口
│   ├── releases.ts     # OSS 清单解析
│   ├── site.ts         # 公共导航
│   └── styles/main.css # 样式
├── public/
│   ├── .nojekyll       # 禁用 Jekyll
│   └── logo/           # 静态资源
└── vite.config.ts
```
