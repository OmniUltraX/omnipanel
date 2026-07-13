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
2. 推送 `website/` 目录变更到 `main` 分支，或手动运行 **Deploy Website** workflow
3. 站点地址：`https://<org>.github.io/omnipanel/`

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

## 目录结构

```
website/
├── index.html          # 页面结构
├── src/
│   ├── main.ts         # 导航与链接逻辑
│   └── styles/main.css # 样式
├── public/
│   ├── .nojekyll       # 禁用 Jekyll
│   └── logo/           # 静态资源
└── vite.config.ts
```
