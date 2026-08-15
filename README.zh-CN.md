# self-memorycontrol

**面向 DeepSeek Harness (DSH) 的即插即用「上下文管理 + 结构化记忆」插件。**

DSH 自带内置的 `memory_*` 记忆工具；**self-memorycontrol** 与它互补：共用同一个本地记忆库和查询 DSL，并额外提供浏览器「记忆」标签页、可选语义搜索、完整配置，以及让长多轮对话自动保持精简的上下文引擎。

把上下文内容存到对话之外、需要时精确召回，并且像查数据库一样搜索记忆 —— 结构化过滤、查询 DSL、模糊匹配，可选语义向量检索。本地优先、零外部服务、无需构建：一条 `dsh plugin add` 即可从 Git 或本地目录安装。

> **命名说明**：GitHub 仓库叫 `whynotcooper/memorycontrol`，npm 包名叫 **`self-memorycontrol`** —— 改名是为了跟 DeepSeek Harness 自带的记忆系统区分开。

## 与 DSH 内置记忆的区别

| | DSH 内置 `memory_*` 工具 | **self-memorycontrol** |
| --- | --- | --- |
| 工具 | memory_save/search/get/list/delete/stats/prune/export/import + context_status/context_archive | 同名工具，**若系统已有则自动跳过**（重名守卫） |
| 存储 | `$DSH_HOME/memory/entries.json` | **同一个文件、同一套 schema** —— 两边数据互通 |
| 查询 DSL | `kind: tag: importance:>3 since:7d "短语" +必须 -排除` | **完全一致** |
| 作用域 | 项目（workspace）+ 全局（global） | **一致**（自动召回 = 全局 + 当前项目） |
| 上下文引擎 | 回合抽取 + 压缩归档 + `<memory-recall>` | **同一设计**，且由 harness 自身的 `compaction/*` 会话事件驱动 |
| 浏览器界面 | 无 | **「记忆」标签页**（搜索/浏览/新建/删除） |
| 语义搜索 | 无（纯词法） | **可选 embeddings**（`semantic`/`hybrid` 排序） |
| 可配置性 | 固定不可调 | **全配置化**（存储路径、预算、各功能开关） |
| 独立性 | 随 DSH 版本绑定 | **独立开源包** —— 可装到任意 profile、可扩展、可发布 |

一句话：内置记忆是「核心」，self-memorycontrol 是同一份记忆的「增强可见侧」——两边写同一个库，数据零重复。

## 与现有 DSH 记忆插件的对比

| 插件 | 外部依赖 | 结构化搜索 | Web 界面 |
| --- | --- | --- | --- |
| [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | `mnemon` CLI | 部分（spaces/entities） | 侧边栏工作台 |
| [dsh-memoryhub](https://github.com/solknight48/dsh-memoryhub) | `mh` CLI（Python + git） | 走 mh | Memory 标签页（iframe 嵌入 mh ui） |
| [dsh-plugin-meta-memory](https://github.com/YYTbit/dsh-plugin-meta-memory) | 无 | 仅关键字 | 无 |
| **self-memorycontrol** | **无** | **查询 DSL + 多面过滤 + 模糊 + 可选语义** | **Memory 标签页（原生）** |

self-memorycontrol 是唯一不需要任何外部二进制或服务的插件，自带真正的查询语言做结构化召回，并且完全本地化。

## 安装

前置：DSH `0.1.0-rc.6+`，Node ≥ 22。

```sh
# 从 GitHub（无需构建步骤）
dsh plugin --profile web add github:whynotcooper/memorycontrol

# 或本地开发目录
dsh plugin --profile web add link:/绝对/路径/self-memorycontrol

# 或 npm 源（发布后）
dsh plugin --profile web add self-memorycontrol
```

`dsh plugin add` 会自动识别 `dsh.bundle` 声明、安装包并追加到 profile 的 bundle 列表。重启 profile（`dsh --profile web`）后「记忆」标签页即可使用；`memory_*` 工具仅在系统未提供时注册（重名守卫）。

换用其他 profile 名称可在别处启用（`headless` 或自建 profile）。

## 配置

全部可选。在 profile 的 `cordis.patch.yml` 中重述整行即可覆盖任意项：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- insert:
    - id: self-memorycontrol
      name: self-memorycontrol
      config:
        root: ''                     # 存储根目录；'' => $DSH_HOME/memory
        registerTools: true          # 注册 memory_* 模型工具
        prompt: true                 # 在系统提示中加入记忆使用指引
        webApi: true                 # 浏览器 UI JSON API（web profile）
        defaultLimit: 10             # 默认结果条数
        maxRecallBytes: 12000        # memory_get 单条内容上限
        maxContentBytes: 65536       # memory_save 单条内容上限
        embedding:                   # 可选语义搜索
          enabled: false
          baseUrl: https://api.deepseek.com
          model: deepseek-embedding
          apiKeyEnv: DEEPSEEK_API_KEY
        context:                     # 上下文管理引擎（v0.2）
          enabled: true
          extract:                   # 回合级知识抽取
            enabled: true
            minNewChars: 2000        # 新文本达到该长度才抽取
            maxInputChars: 30000     # 每次抽取输入上限
            minIntervalMs: 60000     # 抽取冷却时间
            maxTokens: 2048
            provider: ''             # '' = 复用最近一次请求路由
            model: ''
          archive:                   # 压缩感知全保真归档
            enabled: true
            maxChars: 60000          # 每次归档的原文上限
          recall:                    # 会话启动时有界自动召回
            enabled: true
            onSessionStart: true
            budgetChars: 6000        # 召回块大小上限（约 1500 token）
            maxEntries: 8
```

## 工具

| 工具 | 用途 |
| --- | --- |
| `memory_save` | 新建/更新一条记忆（kind、tags、importance、scope、links、expires_at）。 |
| `memory_search` | 结构化过滤 + 排序搜索；返回精简命中。 |
| `memory_get` | 按 id（或标题）取回完整内容。 |
| `memory_list` | 像表格一样浏览（过滤 + 分页 + 排序）。 |
| `memory_delete` | 按 id 删除。 |
| `memory_stats` | 按类型/范围统计、热门标签、过期数、语义状态。 |
| `memory_prune` | 清理过期条目（`dry_run` 预览）。 |
| `memory_export` / `memory_import` | JSON 备份与恢复/合并。 |
| `context_status` | 对话体量（字符/Token）、压缩次数、模块遥测。 |
| `context_archive` | 立即把整个对话快照成可搜索的存档（可附摘要）并提炼持久知识。 |

### 搜索查询语言

```
自由词                    参与排名的全文词
+term  /  -term           必须出现 / 必须不出现
"精确短语"                短语必须出现（标题或内容）
kind:decision kind:fact   类型过滤（可重复 = OR）
tag:auth  tag:"api design" 标签过滤（可重复 = OR）
scope:global|workspace|all 范围过滤
workspace:/绝对/路径       工作区过滤（绝对路径）
link:mem_abc              引用了 mem_abc 的条目
importance:>3 <2 >=4      重要度范围
since:2026-01-01          createdAt >=（也支持 7d / 2w / 3mo / 1y）
until:2026-06-01          createdAt <=（日期按当天结束计算）
created:>x  updated:<x    时间戳范围
```

过滤条件之间为 AND；同字段内重复的 `kind:`/`tag:` 为 OR。`scope:auto`（默认）搜索全局 + 当前工作区；`scope:all` 搜索所有工作区。

### 条目结构

```json
{
  "id": "mem_…", "kind": "decision", "title": "…", "content": "…",
  "tags": ["auth"], "importance": 4,
  "scope": "workspace", "workspace": "/绝对/路径",
  "links": ["mem_…"], "source": {"kind": "agent", "session": "…"},
  "createdAt": "…", "updatedAt": "…", "expiresAt": null
}
```

`kind` ∈ `fact | decision | preference | knowledge | todo | note | context | person | project | code | other`。
条目小而相互链接；提示词会引导模型用多条小条目 + 链接，而不是一条巨型条目。

## 存储与数据

- 单一 JSON 文档：`<root>/entries.json`（`{version, updatedAt, entries}`）。
- 每次写入都是原子的（临时文件 + fsync + rename）—— 崩溃不会留下半写文件。
- `memory_export` 生成可移植备份；`memory_import` 合并回（已有 id 默认跳过，`replace: true` 覆盖）。
- **切勿把密钥存进记忆**（API Key、Token、私钥等）。

## 安全说明

- Web API 路由（`/plugins/self-memorycontrol/api`）拒绝跨域请求（Origin 头校验），且只由默认回环绑定的 web 服务器提供；只有同源页面能访问。
- 除非你启用 `embedding`（用你的 API Key 调用你配置的接口计算向量），否则数据不会离开本机。
- 卸载插件不会删除 `<root>/*.json` —— 需要清空数据时手动删除。

## 开发

```sh
npm install
npm test          # node --test：存储、搜索、查询 DSL、工具、Web 路由
```

包体是纯 ESM JavaScript —— `lib/` 直接提交，没有构建步骤（这正是 Git 安装零摩擦的原因）。

目录：

```
lib/index.js      host 插件入口（inject、Config、apply）
lib/store.js      MemoryStore：持久化 JSON 存储 + CRUD + 索引维护
lib/search.js     分词（拉丁词 + CJK 二元组）、倒排索引、排序、模糊
lib/query.js      结构化查询 DSL 解析器
lib/semantic.js   可选 OpenAI 兼容 embeddings 客户端
lib/context.js    ContextManager：回合抽取、压缩归档、自动召回
lib/tools.js      十一个 memory_* / context_* 工具定义
lib/web.js        浏览器 UI JSON API 路由（仅 web profile）
lib/client.js     浏览器端：记忆标签页（web 模块加载器 bundle）
lib/prompt.js     记忆 + 上下文使用指引（系统提示片段）
```

## 设计与相关工作

上下文引擎建立在既有研究成果之上：

- **MemGPT / 操作系统式虚拟上下文**（[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)）—— 主上下文 + 外部内存分页：我们把被压缩的区间「换出」到可搜索存储（全保真），会话启动时再把相关记忆「换入」。
- **认知架构 CoALA**（[arXiv:2309.02427](https://arxiv.org/abs/2309.02427)）—— 工作/情景/语义记忆分层：当前对话面=工作记忆，存档=情景记忆，条目=语义记忆。
- **Generative Agents**（[arXiv:2304.03442](https://arxiv.org/abs/2304.03442)）—— 记忆流 + 近因/重要度/相关性检索：自动召回按重要度和工作区相关性排序。
- **MemoryBank**（[arXiv:2305.10250](https://arxiv.org/abs/2305.10250)）与 **Mem0**（[arXiv:2504.19413](https://arxiv.org/abs/2504.19413)）—— 长期记忆 + 持续抽取：回合级抽取在信息被摘要吞掉之前先提炼入库。
- **LLMLingua 式提示压缩**（[arXiv:2310.05736](https://arxiv.org/abs/2310.05736)）方向刻意交给 harness 自身（工具结果剪枝、`compaction-basic`），我们做互补而不是重造。

我们不替换 DSH 自带的压缩，而是监听其持久的 `compaction/start|summary|end` 会话事件，补上压缩单独做不到的两件事：**无损留存**（被压原文仍可搜索）和**持久提炼**（知识在有损摘要之外存活）。

## License

MIT © whynotcooper
