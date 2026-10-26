# dsh-recall-rebuild —— 重建式回忆增强插件(DeepSeek Harness)

> **定位**:现有 DSH 记忆插件的**增强层**。先装 `dsh-prime-memory`(或其记忆库),再装本插件,
> 把"存储 → 检索 → 原文注入(播放录音)"升级为"存储 → 检索 → **生成式重建 → 回忆注入(再体验)"。

- 只读现有记忆库(`$DSH_HOME/memory/memory.db`),**不重写捕获管线、不写任何数据**;
- 在每步模型推理前(`agent/pre-step`),用会话末尾消息召回记忆碎片,交给 LLM **重建为带语境/情绪/时间感的回忆片段**,注入本轮;
- 重建失败/超时一律**跳过本轮**,绝不阻塞对话;
- 依赖 Node 22+ 内置 `node:sqlite`,**零部署环境成本**(不买显卡、不租 GPU;重建调用走宿主已有的 LLM 路由,消耗少量 token)。

## 安装

前置:
- DeepSeek Harness `0.1.0-rc.2 … 0.2.1-rc.3`;
- Node ≥ 22.5(需要内置 `node:sqlite`;DSH 桌面版自带运行时版本已满足);
- 已安装并运行过 `dsh-prime-memory`(0.26.x),且记忆库已生成。

```bash
dsh plugin --profile <你的配置文件名> add dsh-recall-rebuild
```

安装后无需手动改 profile 的 `cordis.patch.yml`(包内组合层会自动插入插件行)。
如需覆盖配置,在 profile 的 `cordis.patch.yml` 里写**顶层裸 patch**(同 id 再 insert 会报
duplicate loader entry,按行整体替换、不深合并):

```yaml
- id: recall-rebuild
  name: dsh-recall-rebuild
  config:
    enabled: true
    rebuild:
      maxResults: 5
      maxOutputChars: 600
      timeoutMs: 8000
    inject:
      strategy: replace   # replace = 替换 prime-memory 的原文注入; append = 追加
```

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `dataDir` | `''` | 记忆库目录;空 = `$DSH_HOME/memory` |
| `source` | `auto` | 记忆来源(当前支持 `auto`/`prime`,均指向 prime-memory 库) |
| `rebuild.enabled` | `true` | 重建式回忆开关;`false` 退化为原文检索注入 |
| `rebuild.maxResults` | `5` | 每轮检索条数 |
| `rebuild.maxMemoryChars` | `400` | 单条记忆进重建 prompt 的字符上限 |
| `rebuild.maxTotalChars` | `2000` | 重建 prompt 记忆总量上限 |
| `rebuild.maxOutputChars` | `600` | 重建片段输出上限 |
| `rebuild.temperature` | `0.7` | 重建调用温度 |
| `rebuild.maxTokens` | `1024` | 重建调用输出 token 上限 |
| `rebuild.timeoutMs` | `8000` | 重建总超时;超时跳过本轮 |
| `inject.strategy` | `replace` | `replace` = 原位替换 prime-memory 的原文召回;`append` = 追加 |
| `inject.maxChars` | `1200` | 注入正文单条上限 |
| `inject.includeSources` | `true` | 注入时附记忆来源 id 标注 |
| `query.tailMessages` | `8` | 召回查询取会话末尾消息条数 |
| `query.maxChars` | `1200` | 召回查询字符上限 |

## 工作原理

```
用户新消息 → agent/pre-step(本插件 prepend,先于其它插件执行)
  ├─ 构造召回查询(会话末尾消息 → 去重/截断)
  ├─ 只读检索 prime-memory 库(l1_fts BM25,LIKE 兜底)
  ├─ LLM 重建:记忆碎片 + 当前对话主题 → 一段"回忆"(仅用碎片内信息,禁止编造)
  └─ 注入:
       replace → 找到本轮其它插件注入的原文召回并原位替换
       append  → 追加重建消息
       source.kind='plugin:recall-rebuild' → 不会被 prime-memory 当作新用户消息再次捕获/蒸馏
```

## 与现有插件的错开与共存

- 注入消息 `source.kind` 用 v4 语义 `plugin:recall-rebuild`,与 prime-memory 的
  `plugin:memory` 互不干扰;capture 侧只收 `source.kind==='user'`,天然不被二次捕获。
- `strategy=replace` 时只替换本轮**已存在的**原文召回消息;没有则退化为追加,不重复注入。

## 局限(如实声明)

1. **只增强召回/呈现层**:底层库捕获了什么,重建就基于什么;库缺字段(如没有情绪标注)时,
   重建不会凭空造出它。
2. **幻觉受控但非零**:重建 prompt 明确禁止编造碎片外事实,但 LLM 仍有漂移概率;
   注入标注记忆依据 id 便于审计。需要强事实的场景可关掉重建(`rebuild.enabled=false`)。
3. **token 消耗**:每轮召回命中即产生一次重建调用(通常百级 token),由宿主模型路由计费。
4. **未覆盖**:IM 用户级命名空间隔离、LoRA 权重内化等是本插件之外的方向(见方案文档)。

## 开发与验证

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # 编译到 dist/
node scripts/verify.mjs   # 运行时验证:导出/Config/只读 FTS 检索/LIKE 兜底/降级
npm pack --dry-run  # 检查发布包内容
```

## License

MIT
