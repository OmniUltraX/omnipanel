# 反馈群二维码（官网 Tab + 后台可配 + 客户端）

## 目标

反馈群二维码可在 omniserver 管理后台上传配置；官网联系我们用 Tab（公众号 / 反馈群）；客户端侧栏小程序入口旁增加「反馈群」Tab。

## 协议

- `GET /api/public/qrcodes` 增加 `feedback_group_url`
- `GET /feedback-group-qrcode.png` 输出当前图片
- 配置键：`feedback.group.qrcode_path`（默认 `assets/feedback_group_qrcode.png`）

## 范围

- omniserver：种子图、公开接口、管理上传页
- website：联系区 Tab + 拉取/兜底
- omnipanel 客户端：SidebarMiniappButton 三 Tab
