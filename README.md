# OpenAgile

一个本地优先的看板，用来监督 AI 智能体的工作。智能体负责提出、认领、推进和完成任务；你负责盯看板、写备注、做决定。

## 这是什么

OpenAgile 是一个看板，核心用途是让人监督 AI 智能体。看板完全在浏览器里运行，数据保存在 IndexedDB，本身不需要服务器。

智能体不需要浏览器。它们连接 `harness/` 里可选的 harness：一个很小的 Node 进程，负责提供构建好的前端、对外提供 MCP，并维护与浏览器共用的事件日志。两边接上之后，智能体移动卡片会出现在看板上，看板上的改动也会传到智能体那边。

它适合这样的使用者：同时盯着一到几个智能体，想一眼看清每个智能体接了什么、卡在哪里、哪些需要人来拍板。

## 五个固定列

每个看板都有相同的五列，顺序也固定。

| 列 | 含义 |
|---|---|
| **Backlog（待办）** | 智能体提出、尚未开始的工作，也就是智能体的队列。 |
| **Human In The Loop（人在环中）** | 唯一允许人手动新增任务的列。 |
| **In Progress（进行中）** | 智能体正在处理；人在这里看到的任务表单是只读的。 |
| **Blocked（阻塞）** | 需要人来决定，或者卡在资源冲突上的工作。 |
| **Finished（已完成）** | 已经完成的工作。 |

列的 id、顺序以及 Finished 的 done 角色都是固定的。显示名称只是标签，列相关的工具会拒绝新增、删除和重排。

## 谁负责什么：描述与备注

一个任务有两个书写面，分别属于不同的人。

- **描述**属于智能体。智能体在这里写计划和结果。
- **备注**属于人。人通过添加备注把信息交给智能体。任何智能体工具都不能新增、修改或删除备注。

两者靠一个小循环连在一起：

1. 你添加一条备注（任务不在 In Progress 时）。这会把任务的 `needsDigest` 置位。
2. 智能体把备注归并进描述，然后调用 `digest_key_points`。这一步会给每条备注打上已归并的时间戳，并清除 `needsDigest`。
3. 只有做完这一步，智能体才可以开始这个任务。

`digest_key_points` 是清除这个标记的唯一方式，没有别的途径能打时间戳或清标记。

### 什么时候会被拒绝

当任务上还有智能体没归并的备注时，两件事会被拦住：

- `claim_task` 会被拒绝。
- `move_task` 移入 **In Progress** 会被拒绝；移到其他列不受影响。

浏览器的事件桥（`POST /api/events`）执行同样的规则，网页端做不了智能体被禁止的事。桥会返回 `422` 并拒绝以下请求（以及其他类似情况）：

- 目标列是 In Progress、而任务还有未归并备注的 `task.moved`；
- 会给备注打上 `digestedAt`、或在仍有未归并备注时清除 `needsDigest` 的 `task.updated` 或 `task.created`；
- 写入 `column` 字段的 `task.updated`（移动应当是 `task.moved`）；
- 写入 `claimedBy` 或 `claimedAt` 的 `task.updated`（认领应当走 `claim_task`）。

被拒绝的请求不会写入任何东西。如果一个批次里有一个事件被拒绝，整批都会被拒绝。

已经归并的备注是只读的；还没归并的备注可以修改或删除。删掉最后一条未归并的备注会清除 `needsDigest`，因为已经没有东西需要归并了。给 **Finished** 里的任务添加备注，会让它回到 **Backlog** 并标记为返工。

## 卡片怎么移动

只有智能体能移动卡片，通过 `move_task`。看板不给人改动任务所在列的方式：没有拖拽，没有列选择器，弹窗里也只把列当上下文展示。背后的规则很简单：智能体执行，人来决定。

## 认领计时与五分钟自动阻塞

`claim_task` 会记录是谁认领的、什么时候认领的，并在 assignee 为空时写入 assignee。

harness 每 30 秒扫描一次。**In Progress** 里带有认领标记、并且超过五分钟没有任何更新的任务，会被移到 **Blocked**。看门狗会写入原因 `Auto-blocked: no agent sync for over 5 minutes.`，并设置 `blockedAt`，据此冻结已用时间。这次移动和智能体自己的移动完全一样：一个 `task.moved` 加上一个带阻塞字段的 `task.updated`，并记入 `columnHistory`。

扫描只看 **In Progress** 里带认领标记的任务。没被认领的、刚更新过的、已经在 Blocked 的任务都不会被动。卡片一旦离开 **In Progress**，这个时间窗口就不再适用；如果智能体自己把卡片移到 **Finished** 或 **Blocked**，看门狗根本看不到它。

## 分组与迭代

- **分组**是用户命名的容器，用来放迭代。可以在侧边栏手动改名，也可以用 MCP 工具 `rename_group`。
- **迭代**是分组里的一个看板，按它在分组里的位置编号：「Iteration 1」「Iteration 2」，以此类推。迭代不能手动命名，`rename_board` 永远拒绝。
- 看板不能脱离分组存在。创建时不指定分组，会把它挂到最后一个分组；把分组 id 设成空值也是同样的结果。
- 删除分组会一并删除它下面的迭代。
- 分组开头连续若干个「任务全部在 **Finished**」的迭代，可以折叠到一个控件后面。
- 迭代可以设置开始日期、结束日期和目标，MCP 工具 `list_roadmap` 会报告这些信息。

## 安装与运行

需要 Node.js 和 npm。

### 前端

```bash
cd client
npm install
npm run dev      # Vite 开发服务器 http://localhost:5173
npm run build    # 生产构建，输出到 client/dist
npm run preview  # 本地预览生产构建
```

### harness

harness 是智能体连接的那个进程，同时也负责提供构建好的前端。

```bash
cd harness
npm install
node src/server.mjs
```

依赖装一次即可，harness 只需要它自己的 `npm install`。先构建前端（在 `client/` 里执行 `npm run build`），否则 harness 没有静态文件可提供，会提示 `client/dist` 缺失。

harness 读取这几个环境变量：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `OPENAGILE_HOST` | `127.0.0.1` | 监听地址。 |
| `OPENAGILE_PORT`（或 `PORT`） | `8787` | 监听端口。 |
| `OPENAGILE_DATA_DIR` | `harness/data` | 事件日志的持久化目录。 |
| `OPENAGILE_AGENT_NAME` | `openagile-harness` | 工具上报的 actor id。 |

启动后，前端在 `http://127.0.0.1:8787/`，MCP 在 `http://127.0.0.1:8787/mcp`。

在 Windows 上，`harness/start-bg.ps1` 和 `harness/stop-bg.ps1` 可以在后台启动和停止 harness。不要在工具调用里启动常驻服务，因为调用会一直等到进程退出。

## 测试

前端有两层 Vitest 测试，单元和 DOM：

```bash
cd client
npm test          # 先单元，再 DOM
npm run test:unit
npm run test:dom
```

harness 有独立的测试文件，在仓库根目录运行：

```bash
node harness/test.mjs
```

写作时的状态是：`npm run build` 通过，单元测试 305 个全部通过，DOM 测试 178 个全部通过，harness 测试 33 个全部通过。

## 让智能体通过 MCP 接入

harness 通过 Streamable HTTP 在 `http://127.0.0.1:8787/mcp` 提供 MCP。它是 HTTP 端点，不是 stdio 命令，把 MCP 客户端指向这个地址即可。

用官方 SDK 的最小客户端：

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp')));

const { tools } = await client.listTools();
console.log(tools.map((tool) => tool.name));
```

harness 注册的工具包括：

- 看板与迭代：`list_boards`、`create_board`、`delete_board`、`get_board`、`list_roadmap`、`set_board_dates`。
- 分组：`list_groups`、`create_group`、`rename_group`、`delete_group`、`assign_board_to_group`。
- 任务：`create_task`、`update_task`、`move_task`、`delete_task`、`list_tasks`、`get_task`、`set_blocked_reason`。
- 备注与认领：`digest_key_points`、`claim_task`、`release_task`。
- 读取状态：`list_columns`、`get_board_snapshot`、`get_settings`、`update_settings`、`list_events`。
- 技能：`list_skills`、`get_skill`、`create_skill`、`update_skill`、`delete_skill`。

有几个工具永远拒绝，这是有意为之：`create_column`、`delete_column`、`reorder_columns` 因为列是固定的，`rename_board` 因为迭代是编号的。

这里列的是代表性工具，完整集合由服务端自己公布。

## 项目结构

```
client/       浏览器前端（原生 JS ES 模块，用 Vite 构建）
  src/        入口（index.html）和 modules/
  tests/      unit/ 与 dom/ 两套 Vitest 测试
  dist/       生产构建产物（生成）
harness/      Node harness：静态服务、MCP 工具、事件桥
  src/        server.mjs、mcp-tools.mjs、store.mjs、bridge.mjs、hlc.mjs
  test.mjs    harness 测试
  data/       持久化的事件日志（生成）
docs/         规格、ADR、用户文档和计划
scripts/      发布与规格工具
```

## 这个产品强制执行的规则

以下规则在每条路径上都成立，MCP 和浏览器都一样。

- 五个固定列。id、顺序和 Finished 角色都不变，列相关工具拒绝新增、删除和重排。
- 只有智能体能移动卡片。前端没有任何方式改变任务所在的列。
- 描述属于智能体，备注属于人。任何智能体工具都不能新增、修改或删除备注。
- 有未归并备注的任务不能被开始。`claim_task` 和移入 **In Progress** 都会被拒绝，MCP 路径和浏览器事件桥都是如此。
- 只有 `digest_key_points` 能给备注打时间戳或清除 `needsDigest`。
- 一个任务只有标题、描述、备注和生命周期时间戳。没有优先级、截止日期、任务标签、子任务、附件、自定义字段、类型、估算、评论、关系或标注。
- 每个迭代都属于某个分组，并按位置编号，不能手动命名。
- 给 **Finished** 里的任务添加备注，会让它回到 **Backlog** 并标记为返工。
- 没有报表页，也没有点数、速率或燃尽之类指标。
- 看板画布就是纯色纸面：没有点阵网格，且除表单控件外文字不可选中。

## 文档

- [CONTEXT.md](CONTEXT.md)：领域模型。
- [AGENTS.md](AGENTS.md)：智能体与开发者指南。
- [docs/spec/columns.md](docs/spec/columns.md)、[docs/spec/tasks.md](docs/spec/tasks.md)、[docs/spec/data-models.md](docs/spec/data-models.md)：功能与数据规格。
