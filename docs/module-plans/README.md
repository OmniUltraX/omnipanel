# OmniPanel 模块规划文档

本目录用于沉淀各功能模块的专项规划文档。目标不是替代 [`../PRD.md`](../PRD.md)，而是把 PRD 中的模块目标继续拆成可执行的工作区方案、连接模型、信息架构、接口设计与迭代计划，方便后续开发直接落地。

## 目录约定

```text
module-plans/
├── README.md
├── TEMPLATE.md
└── <module>/
    └── README.md
```

说明：

- `README.md`：说明本目录用途与写法。
- `TEMPLATE.md`：后续所有模块规划文档统一参考模板。
- `<module>/README.md`：某个模块的专项规划文档，首个示例为 Docker。

## 适用范围

以下场景应优先落到本目录，而不是只停留在聊天结论里：

- 某个模块需要独立的信息架构设计
- 某个模块需要定义连接模型或资源模型
- 某个模块需要明确前后端接口边界
- 某个模块需要拆分 MVP / Phase / 验收标准
- 某个模块存在多来源接入或适配层设计

## 文档命名建议

- 模块目录使用小写短横线命名，如 `docker`、`server`、`workflow`
- 模块主文档统一使用 `README.md`
- 若某模块后续拆成多篇，可继续扩展：
  - `api.md`
  - `data-model.md`
  - `ui-structure.md`
  - `milestones.md`

## 推荐写作顺序

每个模块文档建议保持以下顺序，便于不同模块之间横向对齐：

1. 背景与目标
2. 当前现状
3. 目标信息架构
4. 连接模型 / 资源模型
5. 前端拆分方案
6. 后端接口清单
7. 迭代计划
8. 验收标准
9. 风险与待确认项

## 当前模块

- [Docker 模块规划](./docker/README.md)
- [Server 模块规划](./server/README.md)
- [本地优先（草案）](./local-first/README.md)

后续新增模块时，直接复制 [TEMPLATE.md](./TEMPLATE.md) 到对应模块目录中，再按模块实际情况补全即可。
