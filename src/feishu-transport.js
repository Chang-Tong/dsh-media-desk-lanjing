// Feishu 传输：经 `lark-cli` 子进程读写消息以及消费卡片回调事件，绝不走 shell，
// 绝不直接调平台 HTTP。配置单独由 root 提供（可传可执行文件路径），这里只执行具体的 lark-cli 命令。
//
// 安全契约：
// - execFile / spawn（无 shell），命令参数全部数组字面量，不接受外部拼接。
// - 强制 `ok`，超时与 stdout 上限均有界。
// - 任何异常路径都不把令牌/密钥写进日志；卡片事件回调的原始内容也不落日志。
// - 卡片回调流经 CLI 凭证认证，不开放任意 HTTP 入口。
import { execFile, spawn } from 'node:child_process'

const DEFAULT_TIMEOUT = 15_000
// 单条命令 stdout 上限：50 条消息的 JSON 远小于该值，防止应答被恶意撑爆内存。
const MAX_STDOUT = 8_000_000
const DEFAULT_EXECUTABLE = 'lark-cli'
// 事件流单行上限与累计缓冲上限：防恶意撑爆内存，普通 NDJSON 远小于该值。
const MAX_LINE_BYTES = 2_000_000
const MAX_STREAM_BYTES = 16_000_000
const READY_MARKER = /\[event\] ready event_key=card\.action\.trigger/
// 重连与就绪超时（毫秒）。
const READY_TIMEOUT = 10_000
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
// onEvent 串行队列上限：超过即报错丢弃，防止内存无界增长。
const MAX_EVENT_QUEUE = 100

function run(executable, args, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0)
    // 每个子进程独立的集合，失败时不向日志泄露任何内容。
    execFile(executable, args, { timeout: timeoutMs, maxBuffer: MAX_STDOUT }, (err, out) => {
      if (err) {
        // 不包含令牌：只给出通用错误与退出状态。args 属于受控白名单，不含任何密钥。
        const reason = err.killed ? 'timed out' : (err.code || String(err.signal || 'failed'))
        reject(Object.assign(new Error(`lark-cli 调用失败：${reason}`), { code: err.code, cause: err }))
        return
      }
      stdout = out
      try {
        resolve(JSON.parse(stdout.toString('utf8')))
      } catch {
        reject(new Error('lark-cli 返回的不是有效 JSON'))
      }
    })
  })
}

function requireOk(payload, action) {
  if (!payload || payload.ok !== true) {
    throw new Error(`lark-cli ${action} 未成功（ok 不为 true）`)
  }
  return payload.data || {}
}

/**
 * 读频道消息（升序、从 since 起、分页）。
 * @param {{chatId:string, since:string, pageToken?:string, executable?:string, timeoutMs?:number}} opts
 * @returns {Promise<{messages:object[], nextPageToken?:string, hasMore:boolean}>}
 */
export async function readMessages({ chatId, since, pageToken, executable = process.env.LARK_CLI || DEFAULT_EXECUTABLE, timeoutMs } = {}) {
  if (!chatId || !since) throw new Error('读取飞书消息缺少 chatId 或 since')
  const args = ['im', '+chat-messages-list', '--as', 'bot', '--chat-id', chatId, '--sort', 'asc', '--start', since, '--page-size', '50', '--format', 'json']
  if (pageToken) args.push('--page-token', pageToken)
  const data = requireOk(await run(executable, args, { timeoutMs }), '读消息')
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    nextPageToken: data.page_token,
    hasMore: data.has_more === true,
  }
}

/**
 * 发送消息。可选 card：传 card 时走交互式消息 `--msg-type interactive --content <JSON>`；
 * 否则走普通文本（`--text`，行为不变）。idempotencyKey 稳定幂等，重试不会重复发送。
 * @param {{chatId:string, text?:string, card?:object, idempotencyKey:string, executable?:string, timeoutMs?:number}} opts
 * @returns {Promise<string>} data.message_id
 */
export async function sendMessage({ chatId, text, card, idempotencyKey, executable = process.env.LARK_CLI || DEFAULT_EXECUTABLE, timeoutMs } = {}) {
  if (!chatId) throw new Error('发送飞书消息缺少 chatId')
  if (card) {
    if (typeof card !== 'object') throw new Error('发送交互式消息 card 必须是对象')
    if (!idempotencyKey) throw new Error('发送飞书消息缺少 idempotencyKey')
    const content = JSON.stringify(card)
    const data = requireOk(await run(executable, ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--msg-type', 'interactive', '--content', content, '--idempotency-key', idempotencyKey], { timeoutMs }), '发卡片消息')
    if (!data.message_id) throw new Error('飞书未返回 message_id')
    return data.message_id
  }
  if (!text) throw new Error('发送飞书消息缺少 text 或 card')
  if (!idempotencyKey) throw new Error('发送飞书消息缺少 idempotencyKey')
  const data = requireOk(await run(executable, ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--text', text, '--idempotency-key', idempotencyKey], { timeoutMs }), '发消息')
  if (!data.message_id) throw new Error('飞书未返回 message_id')
  return data.message_id
}

/**
 * 更新已发送的交互式卡片：typed CLI `im messages patch --message-id <id> --as bot --data {"content":...}`。
 * 载荷 content 是 card 的 JSON 字符串；schema 由 root 事前核验。
 * @param {{messageId:string, card:object, executable?:string, timeoutMs?:number}} opts
 * @returns {Promise<void>}
 */
export async function updateCard({ messageId, card, executable = process.env.LARK_CLI || DEFAULT_EXECUTABLE, timeoutMs } = {}) {
  if (!messageId) throw new Error('更新飞书卡片缺少 messageId')
  if (typeof card !== 'object' || card === null) throw new Error('更新飞书卡片缺少 card 对象')
  // --data 载荷为 {content: <card 的 JSON 字符串>}；content 本身是字符串值。
  const data = JSON.stringify({ content: JSON.stringify(card) })
  await requireOk(await run(executable, ['im', 'messages', 'patch', '--message-id', messageId, '--as', 'bot', '--data', data], { timeoutMs }), '更新卡片')
}

/**
 * 消费卡片按钮回调：`event consume card.action.trigger --as bot`。
 *
 * - spawn 子进程并把 stdin 管道保持打开；stdout 为 NDJSON 事件；stderr 出现就绪标记
 *   `[event] ready event_key=card.action.trigger` 才算 ready。
 * - 事件按行解析，onEvent 回调串行化（同一时刻至多一个在跑），未就绪前不投递任何事件，
 *   队列长度有上限（溢出即报错），异常被捕获进 onStatus。
 * - 子进程退出/启动失败（含 ENOENT 经 close）后用指数退避重连；就绪超时也会重建。
 * - 优雅停止只关闭 stdin + SIGTERM（绝不 SIGKILL）；每次启动重清缓冲区。
 * - 绝不把原始 stderr/事件内容当作机密日志吐出；safeLog 只收安全标记与计数。
 *
 * 事件字段（FLAT）：type='card.action.trigger', event_id, timestamp（毫秒字符串）,
 * operator_id（主人 openid）, chat_id, message_id（cardid）, host='im_message',
 * action_tag='button', action_value（JSON 字符串），card_content（字符串）。
 *
 * @param {{onEvent:(event:object)=>any|Promise<any>, onStatus?:(status:string, info?:object)=>any,
 *          executable?:string, argsPrefix?:string[], log?:boolean}} opts
 * @returns {() => Promise<void>} cleanup 函数
 */
export function startCardEvents({ onEvent, onStatus, executable = process.env.LARK_CLI || DEFAULT_EXECUTABLE, argsPrefix = [], readyTimeoutMs = READY_TIMEOUT, reconnectBaseMs = RECONNECT_BASE_MS }) {
  let stopped = false, child = null, timer = null, attempt = 0, queued = 0
  let serial = Promise.resolve()
  const report = (state, info) => { try { onStatus?.(state, info) } catch {} }
  function launch() {
    if (stopped) return
    report('starting')
    const proc = spawn(executable, [...argsPrefix, 'event', 'consume', 'card.action.trigger', '--as', 'bot'], { stdio: ['pipe', 'pipe', 'pipe'] })
    child = proc
    let ready = false, stdout = '', stderr = ''
    proc.stdin.on('error', () => {})
    const terminate = () => { proc.stdin.end(); try { proc.kill('SIGTERM') } catch {} }
    const startup = setTimeout(() => { report('error', { error: 'ready-timeout' }); terminate() }, readyTimeoutMs)
    startup.unref?.()
    proc.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8192)
      if (!ready && READY_MARKER.test(stderr) && !stopped) {
        ready = true; attempt = 0; clearTimeout(startup); report('ready'); drainLines()
      }
    })
    function drainLines() {
      if (!ready || stopped) return
      let boundary
      while ((boundary = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, boundary); stdout = stdout.slice(boundary + 1)
        if (!ready || stopped || Buffer.byteLength(line) > MAX_LINE_BYTES) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (queued >= MAX_EVENT_QUEUE) { report('error', { error: 'event-queue-overflow' }); continue }
        queued++
        serial = serial.then(async () => {
          try { if (!stopped) await onEvent(event) }
          catch { report('error', { error: 'event-handler-failed' }) }
          finally { queued-- }
        })
      }
    }
    proc.stdout.on('data', chunk => {
      stdout += chunk.toString()
      if (Buffer.byteLength(stdout) > MAX_STREAM_BYTES) {
        stdout = ''; report('error', { error: 'stream-overflow' }); terminate(); return
      }
      drainLines()
    })
    proc.on('error', () => report('error', { error: 'event-process-failed' }))
    // close also fires when spawn fails with ENOENT; reconnect exactly once.
    proc.once('close', () => {
      clearTimeout(startup)
      if (child === proc) child = null
      if (stopped) return
      report('error', { error: 'event-process-closed' })
      timer = setTimeout(launch, Math.min(RECONNECT_MAX_MS, reconnectBaseMs * 2 ** Math.min(attempt++, 8)))
      timer.unref?.()
    })
  }
  launch()
  return async () => {
    stopped = true; clearTimeout(timer)
    const proc = child
    if (proc) {
      const closed = new Promise(resolve => proc.once('close', resolve))
      proc.stdin.end()
      try { proc.kill('SIGTERM') } catch {}
      await closed
    }
    await serial
    report('stopped')
  }
}

/** 便于测试注入假替换；真实运行默认走子进程。deps 可覆盖任一方法/事件流。 */
export function createTransport(deps = {}) {
  return {
    readMessages: (opts) => deps.readMessages ? deps.readMessages(opts) : readMessages(opts),
    sendMessage: (opts) => deps.sendMessage ? deps.sendMessage(opts) : sendMessage(opts),
    updateCard: (opts) => deps.updateCard ? deps.updateCard(opts) : updateCard(opts),
    startCardEvents: (opts) => deps.startCardEvents ? deps.startCardEvents(opts) : startCardEvents(opts),
  }
}
