# Editorial Commands（本地文件命令队列）

把自动化/验收「命令」以 JSON 文件写入 `Store.root/editorial-requests/<id>.json`，
由 host 周期调用 `createEditorialCommands(...).tick()` 串行消费，结果原子写入
`Store.root/editorial-results/<id>.json`。队列本身只操作本机文件；具体动作仍会按配置调用飞书或创作服务。

## 命令契约

每个请求文件为 `{ "id": string, "action": string, "payload": object }`：

- `id`：`/^[a-zA-Z0-9_-]{1,100}$/`，必须与文件名一致。
- `action`：白名单，`status | topics | propose | review | browser-approval | record-draft | resume-creation | revise-production | recover-preview-request`。
- `payload`：随动作而定。
- 文件总字节上限 128KB（含信封）。
- 请求/结果文件权限 0600，目录权限 0700。

## CLI 用法

```sh
node scripts/editorial-request.mjs \
  --action propose \
  --input /abs/payload.json \
  [--id stableid] \
  [--timeout 60] \
  --root /abs/path/to/store
```

- `--input` 必须为绝对路径。可选 `--root` 若提供也必须为绝对路径；省略时使用当前 DSH 数据目录。
- `--id` 省略时自动生成随机 id。
- 完成输出 `{id, ok, result|error}`；超时输出 `{"status":"pending","id":...}`。
- 同 `--id` 幂等：既有请求/结果在 action 和 payload 序列化内容一致时直接复用；
  不一致则冲突、`exit 2`、绝不覆盖。
- 未知参数拒绝；载荷不存在/非法/超限拒绝。

## 模块

```js
import { createEditorialCommands } from './src/editorial-commands.js'
const cmds = createEditorialCommands({ store, editorial })
await cmds.tick()   // 消费当前全部请求
```

设计要点：

- 崩溃安全：先持久化「认领」状态再派发；启动 recover 只重写缺失的结果文件、
  只重试只读 status，绝不盲目重跑破坏性副作用。
- 结果先持久化进 Store 再原子写文件；写文件失败时不覆盖成功的持久化结果，
  下一步 tick 会只重写文件（不重跑动作）。
- 单条命令异常不毒化队列。
- 拒绝符号链接命令文件；chmod 目录时跳过符号链接目标。

## 恢复已有明确创作指令

`resume-creation` 载荷为 `{topicId,messageId,brief,contextMessageId?}`。仅接受已入库且处理完成的本人原始明确创作消息；默认须是当前最新消息。若其后有改稿反馈，必须同时传入最新反馈的 `contextMessageId`，不能跳过取消、换题或其他新指令。服务核验当前选题、版本与一次性派发记录，将原文和反馈一起保留。该操作只开始创作，不授权小红书操作或公开发布。

## 修订已完成稿件并重新排版

`revise-production` 载荷为 `{topicId,artifactHash,title,article}`。从 `status` 取得当前产物哈希，标题最多20字，正文最多20000字，只允许当前活动选题的已完成归藏图文。保留旧稿记录，修改后旧排版和评审失效，待确认的浏览器申请作废；已批准的浏览器任务进行中时拒绝修改。返回 `relayoutStarted:true` 仅表示重排已启动，必须继续检查实际 `production.status`、`layoutOutdated` 及图片，再重新评审。失败保留修订稿和明确错误，不盲目重试。


## 原生草稿确认卡（2026-11-14）

`browser-approval` 载荷 `{topicId}`，只能对当前完成且审稿通过的内容发起。要求 `status.cardListener.ready=true`；返回 pending 是等待用户点击，不是草稿成功。工作台发送飞书原生卡片，绑定当前内容 hash、本人、会话及 cardMessageId；按钮为“确认保存草稿”和“暂不保存”。改稿后旧卡不再授权新内容。重复回调不重复批准，卡片更新失败通过 outbox 重试。审批后仍由 Air / GPT-6.1 Terra 执行，并通过 `record-draft` 记录真实回读证据。

卡片消费默认使用 lark-cli；已有异机同应用事件总线时，通过 Store.root/card-event-command.json 配置 executable 与 argsPrefix 复用认证事件流。本次实际复用 Mini 总线，通过 SSH 将事件送到 Air Host；不可同时新建竞争总线，也不能据此宣称 Air 离线可用。该配置在仓外，禁止写入凭据。

`recover-preview-request` 仅用于已证实的只读预览误判，载荷 `{topicId,messageId,artifactHash,briefHash}`。Host 核验最新已处理消息、相邻真实创作授权、简报版本与时间、精确 hash 及只读白名单后，清除误置 outdated；不恢复旧审稿或浏览器审批。正常“看看稿件，发我一下”直接走只读预览分支，不改变简报和成稿。
