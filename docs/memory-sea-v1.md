# 记忆识海 v1 · 设计方案(讨论稿)

> 状态:**已落地(v0.1.16)**。本文是最初的选型讨论稿,保留为决策记录;实际实现与本文有若干出入,以 [memory-sea-brain.md](memory-sea-brain.md) 为准(差异清单见文末)。
> 结论先行:三个红框位置**都能放**,技术上没有阻塞;真正要定的是「主入口放哪、画什么数据、要不要时间回放」。

## 一、三个菜单落点:实测可行

DSH Web GUI 的 UI 扩展点是「槽位(slot)」系统。插件在客户端 bundle 里用
`ctx.slots.register({ name, id/key, order, label }, Component)` 往槽位里塞 React 组件。

| 图 | 位置 | 槽位名 | 形态 | 备注 |
|---|---|---|---|---|
| 图1 | 左侧全局侧边栏图标行 | `sidebar.panellist` | list / root | 需同时注册 `main` 页面,否则宿主拒绝选中 |
| 图2 | 空会话页快捷卡片网格 | `conversation.hero.options` | list / session | 卡片型,和「文件/上下文/浏览器」同排 |
| 图3 | 设置弹窗左侧分区 | `settings.section`(+ `settings.section.icon`) | list / root | 适合放「配置 + 概览」而非全屏大图 |

**关键约束(实证,不是推测)**:左侧栏的行和主区页面是一对。
`dsh-mcp-connector/lib/client.js:3096` 的原注释写着「main 必须先于 panellist 行就绪,否则宿主会拒绝选中缺页面的行」。
所以走图1 方案要注册两处:

```js
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'recall-sea' }, SeaPage))
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'recall-sea', order: 60, label: () => t('记忆识海'),
}, SeaIcon))
// 点击行时宿主调 layout.selectPanel('recall-sea')
```

**建议**:主入口走图1(`sidebar.panellist` + `main`),这是插件市场、MCP 连接器、Trae 等所有已装插件的共同做法;
图2 的 `conversation.hero.options` 做次级快捷入口(空会话时也能一眼看到);
图3 的 `settings.section` 放「识海设置 + 数据概览」(节点数/边数/上次巩固时间),不放全屏图。

## 二、客户端插件机制:本插件要新增的三样东西

现在 `package.json` 只有 `dsh.bundle.patch`,是纯 host 插件。要做 UI 必须补:

1. `dsh.client.inject`:声明客户端依赖的宿主服务包,如
   `["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"]`,并加 `"platform": "web"`。
2. `exports["./client"]` → `./client/client.js`(客户端产物),以及 `files` 里加上这个目录。
3. 客户端 bundle 的导出形态。两种都能用,已装插件里都有先例:
   - **ModuleLoader 形态**(dsh-pet / dsh-mcp-connector / dsh-better-sidebar 都用):
     `window.__ModuleLoader__.load({ id: 'dsh-recall-rebuild', factory: (require) => { ... return { name, inject, apply } } })`,
     `require` 可拿到 `react`、`react/jsx-runtime`、`react-dom`。
   - **普通 ESM 形态**(dsh-context):`export const name/inject/apply`。

   注意:两种形态下 `apply(ctx)` 的 ctx 是**客户端**根上下文(有 `slots`/`locale`/`layout` 服务),和 host 侧的 `ctx` 不是同一个东西。

**关于「零依赖」**:本插件 host 侧坚持零运行时依赖,这点不受影响。
客户端 bundle 是**打包产物**,d3-force 这类库会被打进 `client.js`,不产生 npm 运行时依赖,也不要求用户装任何东西。

## 三、视觉参考:GitHub 上已经很好看的几个

| 项目 | 风格 | 可借鉴点 |
|---|---|---|
| **JoeDoesJits/mempalace-viz** ★9 | D3 力导向 + 语义聚类 + 实时 MCP 接入 | 语义最接近(记忆宫殿);节点按簇着色、悬停浮出记忆原文 |
| ianhandy/lightrag-explorer | D3 力导向知识图谱 | 左侧筛选 + 右侧详情的经典双栏 |
| Yorha9e/graphify-viz | 2D 力导向 + 3D 球面 | 2D/3D 切换的观感 |
| MamboJiang/mambo-universe | 2D 力导向「宇宙」 | 深色星空底 + 发光节点,最像「识海」这个词 |

**取长补短的组合**:mambo-universe 的深色星空底与辉光 → 承载「识海」气质;
mempalace-viz 的聚类着色 → 表达五类记忆(stable-fact/pattern/preference/relationship/mood);
lightrag-explorer 的双栏 → 放详情、来源碎片、置信度。

## 四、数据从哪来:全部现成,不需要新存储

| 视觉元素 | 数据源 | 位置 |
|---|---|---|
| 节点 | `ConsolidatedMemory[]`(id/content/type/confidence/status/touchCount) | `src/consolidated.ts:27-47` |
| 边 | `LinkGraph`(Record<from, Record<to, {weight,label,at}>>) | `src/consolidated.ts:62` |
| 分区 | `type` 五类 + `status`(active/dormant/superseded) | `src/consolidated.ts:24` |
| 用户视角 | `userKey`(IM 用户级隔离) | 同上 |
| 时间回放 | `RebuildLogEntry` 审计日志(每轮原始碎片↔重建片段) | `src/observability.ts:15` |
| 节点大小 | `touchCount` / `confidence` / `lastRecalledAt` 衰减 | 同上 |

也就是说:**v1 不需要新增任何存储**,读 `<DSH_HOME>/recall-rebuild/consolidated/` 即可。
HTTP 侧用 `host.webServer.register({ kind: 'exact', path: '/recall-rebuild/sea/graph', handler })` 暴露 JSON,
前端 same-origin fetch 拿数据 —— dshmarket 的遥测端点就是这么做的。

## 五、三个待拍板问题

1. **入口形态**:主入口放图1(左侧栏 + 主区整页)可以吗?还是只要一个浮层?
   - A. 图1 整页(推荐,信息密度最高,和已装插件一致)
   - B. 图2 卡片 → 点开浮层(`shell.overlay`)
   - C. 三处都放(工作量 +30%,但触达最好)
2. **数据范围**:只画巩固层(几十~几百个节点,清爽),还是把原始碎片也画进去(上千个,壮观但杂乱)?
   - A. 只画巩固层(推荐 v1)
   - B. 巩固层 + 原始碎片(碎片做小点/半透明)
3. **时间回放**:要不要「拖动时间轴看记忆怎么长出来」?
   - A. 不要(v1 砍掉,省一半工作量)
   - B. 要(数据现成,但交互复杂度显著上升)

## 六、风险与工作量

| 项 | 判断 |
|---|---|
| 工作量 | 图1 整页 + 只画巩固层 + 无回放 ≈ 2~3 天;加回放 +1 天;三处入口 +0.5 天 |
| 性能 | 500 节点内 Canvas 2D 稳 60fps;超 2000 建议 WebGL 或分簇懒加载 |
| 兼容 | 槽位缺失时要降级(宿主版本老没有 `sidebar.panellist`),用 `ctx.slots.inject` 天然处理 |
| 打包 | 需要新增 `tsconfig.client.json` + 打包脚本(esbuild/tsdown),产物进 `client/` |

## 七、落地后回看:和本文的出入(v0.1.16 实测)

| 本文设想 | 实际做法 | 为什么改 |
|---|---|---|
| 客户端产物放 `client/client.js` | 放 `lib/client.js`,`exports["./client"]` 指过去 | 与已装插件(dsh-better-sidebar 等)的目录习惯一致,`dist` 只放宿主侧 tsc 产物 |
| 需要打包脚本(esbuild/tsdown) | **手写 84 行 UMD 形状的 `lib/client.js`,零构建** | 面板本体是 iframe,客户端 bundle 只注册两个槽位,没有任何可复用模块值得打包 |
| 面板是 React 组件 | 面板是 `<iframe>`,指向宿主注册的 `/recall-rebuild/sea/` | 渲染器是三个零依赖 ES 模块,搬进 React 要接宿主构建管线,收益为零 |
| 用 d3-force 做力导向 | **纯几何:控制点轮廓 + 值噪声 + FNV-1a 哈希定坐标**,不跑物理模拟 | 力导向每次加载布局都不一样,「同一段记忆总在同一个位置」才有识海感;而且省掉 d3 |
| `kind:'exact'` 路由 `/recall-rebuild/sea/graph` | `kind:'prefix'` 路由 `/recall-rebuild`,数据在 `/sea/data` | 静态资源也要走同一套 fence 与响应头,一条 prefix 更省事 |
| 500 节点内稳 60fps,超 2000 上 WebGL | 900 条内 60fps;默认上限 1200,超了**丢最老的** | 真实节奏下一年才 ~550 条;上限的意义是防脏数据,不是拼性能 |
| 节点大小 ∝ `touchCount`/`confidence` | 节点大小只随**总量**分四档(62/46/36/27px),不看单点权重 | 单点大小差异在点云里读不出来,只会让图变脏;密度才是要表达的东西 |
| 时间回放砍掉(选 A) | **做了**,底部时间轴 9 秒回放生长过程 | 数据现成,而且这是最直观的「越用越像大脑」演示 |
| 半透明脑壳 | **不要壳**,轮廓靠点云密度浮现 | 见 memory-sea-brain.md 第十节:壳会吃掉星云气质 |
