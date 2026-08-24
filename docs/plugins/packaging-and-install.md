# 打包、签名与安装

## 包结构（.omni-plugin）

```
my-plugin.omni-plugin        # zip 容器
├─ plugin.json               # 清单（必填，schema 见 manifest-reference）
├─ logic.js / logic.wasm     # 可选：L2 逻辑包（entry.logic 指向）
├─ ui/index.html             # 可选：L3 沙箱页面（overlays[].entry 指向）
├─ assets/                   # 可选：静态资源
└─ signature.ed25519         # ed25519 签名（不参与规范化字节流）
```

签名对象 = 除 `signature.ed25519` 外全部条目按路径排序后的
规范化字节流：`u32le(len(name)) | name | u32le(len(data)) | data`。

## 打包

```bash
# dev 签名（内置开发公钥；仅 dev 构建可安装）
cargo run -p omnipanel-plugin-pkg --bin pack -- <plugin_dir> out.omni-plugin

# 未签名包同样只能装进 dev 构建
```

> 正式发布 MUST 使用离线保管的发布密钥另行签名，并将公钥加入
> `crates/omnipanel-plugin-pkg/src/lib.rs` 的 `OFFICIAL_VERIFY_PUBKEYS_HEX`。

## 安装

设置 → 插件 → **安装本地插件** → 选择 `.omni-plugin`：

- 解压到 `app_data/plugins/<plugin_id>/`；
- 验签 → 清单校验 → 与内置插件 id 冲突检查 → Registry 重建 → 贡献点生效；
- 同 id 重复安装即覆盖升级；
- 启用状态持久化，重启保持。

## 卸载

- **已安装**来源：设置页「卸载」按钮（删目录 + 清启用记录）；
- **内置**来源：不可卸载，仅可禁用。

## 签名校验矩阵

| 构建类型 | 有有效官方签名 | 无签名 | 错误 key 签名 |
|---|---|---|---|
| release | ✅ 接受 | ❌ `UnsignedRejected` | ❌ `BadSignature` |
| dev | ✅ 接受 | ✅ 接受（开发便利） | ❌ `BadSignature` |

## 安装期兼容检查

- `minHostApi` > 宿主 `HOST_API_VERSION` → 拒绝装载并提示版本差距；
- 清单 schema 校验失败 → 拒绝并指出违规字段。
