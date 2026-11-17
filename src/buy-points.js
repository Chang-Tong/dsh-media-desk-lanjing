// 埋点转化：小程序会话级有序漏斗，只读聚合。
// 子进程调用数据仓 scripts/conversion-funnel.js（--json），校验并归一化成 v1 契约，
// 内存缓存 + 磁盘缓存；脚本缺失、环境未配置、执行失败或超时都如实降级，绝不用 0 冒充缺失。
// 只读：不写 CloudBase，不保存任何逐人明细，返回体只有聚合计数。
//
// 加载体验：缓存优先 + 后台刷新（stale-while-revalidate）。
// - 内存缓存 TTL 6 小时（21600s）：命中即视为新鲜，直接返回、不触发刷新。
// - 磁盘缓存有效期到「写入之后的第一个本地 03:00」：03:00 之后视为过期（meta.cacheFresh=false、meta.stale=true），
//   但在 03:00 前即使已经超过 6 小时，仍先返回快照再后台刷新（stale-while-revalidate），不会因为过期把已有数字换掉。
//   每天 03:00 的预热会把磁盘快照换成本日数据，所以磁盘有效期和预热节奏对齐。
// - 内存未命中但有磁盘缓存：立刻返回磁盘快照（meta.cached=true、meta.cachedAt、meta.revalidating=true），
//   同时后台异步刷新一次。同一窗口同一时刻只允许一个刷新（in-flight 去重），并发请求共用同一个 promise。
// - 客户端拿到 meta.revalidating 后再带 wait=1 请求一次：该请求挂在同一个后台刷新上，
//   刷新成功返回新数据（静默替换），失败则回退到磁盘快照并带 meta.degradeReason。
// - fresh=1：跳过内存缓存和「缓存优先」，同步跑一次脚本（页面顶部「重新取数」用）。
//   后台刷新失败/超时时仍回退到磁盘快照，绝不用 0 冒充缺失。
//
// 预热：每天本地 03:00 依次（串行）预热 7 / 14 / 30 天三个窗口，刷新内存与磁盘缓存，然后调度第二天。
// - 用 setTimeout 逐天调度（不用 setInterval，避免漂移），所有 timer 都 unref()，不阻止进程退出。
// - 启动补跑：插件启动时读 cache/warm-state.json 的 lastWarmAt，如果「今天 03:00 之后还没预热过」就后台补跑一次，
//   不阻塞首屏。失败只记日志，不冒泡；每个窗口一次，不疯狂重试。
// - 预热与用户请求共用同一个 in-flight 锁：用户正在拉 7 天时，预热不会重复跑 7 天。
// - 调试参数 warm=1：触发一次后台预热，默认关闭。
//
// 新契约字段（freshness / previous / breakdown 的 dimension=project / flow / eventTrend / retention）原样透传：
// 缺失就是 null，不补 0、不补空对象，也不因为新字段缺省把整份快照判为非法；unavailable 的语义不变
// （仍只表示脚本既有聚合这一段没取到）。这些字段随归一化结果一起进内存和磁盘缓存。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { dshHome } from './store.js'

const ALLOWED_DAYS = [7, 14, 30]
const ALLOWED = new Set(ALLOWED_DAYS)
// 6 小时：磁盘缓存兜底，内存命中只是省掉一次子进程；磁盘快照的有效期另按「次日 03:00」判定。
const MEMORY_TTL_MS = 21_600_000
// 每日预热时间（本地时区）与落盘文件：03:00 依次预热 7 / 14 / 30 天。
const WARM_HOUR = 3
const WARM_WINDOWS = ALLOWED_DAYS
const WARM_STATE_FILE = 'warm-state.json'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 16 * 1024 * 1024
const SCRIPT_NAME = 'conversion-funnel.js'
// 数据仓默认检出位置；换机器或换目录时用 LANJING_CONVERSION_SCRIPT 指定。
const PROJECT_SCRIPT = '/Users/dongair/project/01-开发项目/RealEstateIntelligent-repos/RealEstateIntelligent-data/scripts/conversion-funnel.js'

const memory = new Map()

function expandHome(input) {
  const text = String(input ?? '').trim()
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(text)
}

async function exists(file) {
  if (!file) return false
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

const num = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
const ratio = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = value => (typeof value === 'string' ? value.trim() : '')

/**
 * 严格晚于 fromMs 的下一个本地 03:00（毫秒时间戳）。
 * 正好落在 03:00 时取次日：避免「03:00 刚预热完又立刻排一次」。
 */
export function nextWarmBoundary(fromMs = Date.now()) {
  const date = new Date(fromMs)
  const boundary = new Date(date.getFullYear(), date.getMonth(), date.getDate(), WARM_HOUR, 0, 0, 0)
  if (boundary.getTime() <= fromMs) boundary.setDate(boundary.getDate() + 1)
  return boundary.getTime()
}

/** 不晚于 nowMs 的最近一个本地 03:00：用来判断「今天 03:00 之后有没有预热过」。 */
export function lastWarmBoundary(nowMs = Date.now()) {
  const next = new Date(nextWarmBoundary(nowMs))
  next.setDate(next.getDate() - 1)
  return next.getTime()
}

/**
 * 磁盘快照是否还在有效期内：写入时间之后的第一个 03:00 之前算新鲜，03:00 之后算过期。
 * 过期不影响回退（stale-while-revalidate 仍会先给快照再后台刷新），只影响 meta 的新鲜度标记。
 */
export function isDiskCacheFresh(atMs, nowMs = Date.now()) {
  if (!Number.isFinite(atMs)) return false
  return nowMs < nextWarmBoundary(atMs)
}

/** 脚本可能先打日志再输出 JSON：先整体解析，再取最后一个 {...} 块。 */
export function parseScriptOutput(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) throw new Error('脚本没有输出内容')
  try {
    return JSON.parse(text)
  } catch {
    // 继续往下面找可解析的 JSON 块
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // 继续
    }
  }
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // 继续往前找
    }
  }
  throw new Error('脚本 stdout 不是 JSON')
}

function normalizeStage(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const key = str(raw.key) || str(raw.id) || `stage_${index + 1}`
  return {
    key,
    label: str(raw.label) || key,
    actors: num(raw.actors),
    events: num(raw.events),
    fromPrev: ratio(raw.fromPrev),
    ofFirst: ratio(raw.ofFirst),
    // pending：该级事件尚未上线（0 是没采集，不是零转化）；detached：留在展示序列里但不参与有序判定。
    pending: raw.pending === true,
    detached: raw.detached === true,
    unordered: num(raw.unordered),
  }
}

function normalizeStages(raw) {
  if (!Array.isArray(raw)) return null
  const stages = raw.map(normalizeStage).filter(Boolean)
  return stages.length >= 2 ? stages : null
}

function normalizeFunnel(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  // 某一级聚合失败时脚本保留漏斗槽位、把 stages 置为 null：这要当作「未获取」，不能丢掉整条漏斗。
  const rawStages = raw.stages
  const stages = rawStages === null || rawStages === undefined ? null : normalizeStages(rawStages)
  if (rawStages !== null && rawStages !== undefined && !stages) return null
  return {
    key: str(raw.key) || `funnel_${index + 1}`,
    label: str(raw.label) || `漏斗 ${index + 1}`,
    stages,
  }
}

function normalizeOutcome(raw) {
  if (!raw || typeof raw !== 'object') return null
  return { saved: num(raw.saved), contact: num(raw.contact) }
}

function normalizeTrend(raw, funnelKeys) {
  if (!Array.isArray(raw)) return null
  const rows = raw
    .filter(row => row && typeof row === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(str(row.date)))
    .map((row) => {
      const out = { date: str(row.date) }
      for (const key of funnelKeys) {
        out[key] = Array.isArray(row[key]) ? row[key].map(value => (Number.isFinite(value) && value >= 0 ? value : null)) : null
      }
      if (Number.isFinite(row.sessions)) out.sessions = row.sessions
      return out
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  // 缺数据的日期本来就不出现在数组里；这里不补 0，也不补空行。
  return rows.length ? rows : null
}

function normalizeBreakdown(raw) {
  if (!Array.isArray(raw)) return null
  const groups = raw
    .filter(group => group && typeof group === 'object')
    .map(group => ({
      dimension: str(group.dimension),
      // rows 为 null 表示这一维度取数失败，保留槽位让界面显示「未获取」。
      rows: Array.isArray(group.rows)
        ? group.rows
            .filter(row => row && typeof row === 'object')
            .map(row => ({
              value: str(row.value) || 'unknown',
              sessions: num(row.sessions),
              stages: Array.isArray(row.stages) ? row.stages.map(value => (Number.isFinite(value) && value >= 0 ? value : null)) : [],
            }))
        : null,
    }))
    .filter(group => group.dimension)
  return groups.length ? groups : null
}

function normalizeEvents(raw) {
  // null 表示这次没取到事件清单（不是「窗口里没有事件」），由 unavailable 标记，界面显示「未获取」。
  if (!Array.isArray(raw)) return null
  return raw
    .filter(row => row && typeof row === 'object' && str(row.name))
    .map(row => ({ name: str(row.name), count: num(row.count) }))
}

function normalizeLegacy(raw) {
  if (!raw || typeof raw !== 'object') return null
  return { started: num(raw.started), reportViewed: num(raw.reportViewed), linked: raw.linked === true, note: str(raw.note) }
}

function normalizeExtra(raw) {
  if (!raw || typeof raw !== 'object') return null
  return { outcome: normalizeOutcome(raw.outcome), legacyInspection: normalizeLegacy(raw.legacyInspection) }
}

// ---- 新契约字段：原样透传，缺省就是 null，不补 0 / 不补空对象 ----
function normalizeFreshness(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    lastEventAt: str(raw.lastEventAt) || null,
    // ageMinutes 允许 0（刚刚发生），但缺省必须是 null 而不是 0。
    ageMinutes: num(raw.ageMinutes),
    stale: raw.stale === true,
  }
}

function normalizePreviousRange(raw) {
  if (!raw || typeof raw !== 'object') return null
  const days = Number(raw.days)
  return {
    days: Number.isFinite(days) ? days : null,
    from: str(raw.from) || null,
    to: str(raw.to) || null,
  }
}

/** previous.funnels[].stages[]：delta / deltaRate 可能为负（下降），不能用只收非负的 num。 */
function normalizePreviousStages(raw) {
  if (!Array.isArray(raw)) return null
  return raw
    .filter(stage => stage && typeof stage === 'object')
    .map(stage => ({
      key: str(stage.key) || null,
      actors: num(stage.actors),
      delta: ratio(stage.delta),
      deltaRate: ratio(stage.deltaRate),
    }))
}

function normalizePrevious(raw) {
  if (!raw || typeof raw !== 'object') return null
  const range = normalizePreviousRange(raw.range)
  // 整个 previous 缺省才返回 null；只缺 range 或只缺 funnels 时保留另一半。
  const funnels = Array.isArray(raw.funnels)
    ? raw.funnels
        .filter(funnel => funnel && typeof funnel === 'object')
        .map((funnel, index) => ({
          key: str(funnel.key) || `funnel_${index + 1}`,
          stages: normalizePreviousStages(funnel.stages),
        }))
    : null
  if (!range && !funnels) return null
  return { range, funnels }
}

/** flow[{source,pageKey,sessions,entered}]：缺失返回 null，空数组如实返回 []。 */
function normalizeFlow(raw) {
  if (!Array.isArray(raw)) return null
  return raw
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      source: str(row.source) || null,
      pageKey: str(row.pageKey) || null,
      sessions: num(row.sessions),
      entered: num(row.entered),
    }))
}

/** eventTrend[{date,counts{eventName:count}}]：缺事件名/非法计数保留 null，绝不补 0。 */
function normalizeEventTrend(raw) {
  if (!Array.isArray(raw)) return null
  const rows = raw
    .filter(row => row && typeof row === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(str(row.date)))
    .map((row) => {
      const counts = {}
      if (row.counts && typeof row.counts === 'object' && !Array.isArray(row.counts)) {
        for (const [name, value] of Object.entries(row.counts)) if (str(name)) counts[str(name)] = num(value)
      }
      return { date: str(row.date), counts }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  // 和 trend 一样：缺数据的日期本来就不出现，这里不补空行。
  return rows.length ? rows : null
}

function normalizeRetention(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    accounts: num(raw.accounts),
    newAccounts: num(raw.newAccounts),
    returningAccounts: num(raw.returningAccounts),
    // 次日回访率是比率（0~1），缺省 null，不填 0。
    nextDayReturnRate: ratio(raw.nextDayReturnRate),
  }
}

/** 把脚本输出校验并归一化成 v1 契约（字段名与数据仓一致，不改名、不补零）。 */
export function normalizeBuyPoints(raw, { days } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('脚本输出不是对象')
  if (raw.ok !== true) throw new Error(str(raw.error?.message) || str(raw.error?.code) || str(raw.error) || str(raw.message) || '脚本返回 ok:false')
  const funnels = Array.isArray(raw.funnels) ? raw.funnels.map(normalizeFunnel).filter(Boolean) : []
  if (!funnels.length) throw new Error('脚本输出缺少 funnels[].stages')
  const range = raw.range && typeof raw.range === 'object' ? raw.range : {}
  const scriptDays = Number(range.days)
  if (days && Number.isFinite(scriptDays) && scriptDays !== days) throw new Error(`脚本返回窗口 ${scriptDays} 天，与请求的 ${days} 天不一致`)
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {}
  const funnelKeys = funnels.map(funnel => funnel.key)
  const unavailable = Array.isArray(raw.unavailable) ? raw.unavailable.map(item => str(item)).filter(Boolean) : []
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(item => str(item)).filter(Boolean) : []
  const trend = normalizeTrend(raw.trend, funnelKeys)
  const breakdown = normalizeBreakdown(raw.breakdown)
  const events = normalizeEvents(raw.events)
  // 数据仓脚本把结果放在 extra.outcome；契约里也可能直接给顶层 outcome。两边都认。
  const outcome = normalizeOutcome(raw.outcome) || normalizeOutcome(raw.extra?.outcome)
  const dropoff = Array.isArray(raw.dropoff)
    ? raw.dropoff
        .filter(row => row && typeof row === 'object')
        .map(row => ({
          funnel: str(row.funnel) || 'primary',
          from: str(row.from),
          to: str(row.to),
          lost: num(row.lost),
          // 数据仓脚本：rate = 流失率（lost / from），passRate = 通过率（to / from）。
          rate: ratio(row.rate),
          passRate: ratio(row.passRate),
        }))
        .filter(row => row.from && row.to)
    : []
  if (!outcome) unavailable.push('outcome')
  if (!trend) unavailable.push('trend')
  if (!breakdown) unavailable.push('breakdown')
  if (!dropoff.length) unavailable.push('dropoff')
  if (!events || !events.length) unavailable.push('events')
  // 某一级 stages 被置为 null 时，那一级的数据本身就是「未获取」。
  for (const funnel of funnels) if (!funnel.stages) unavailable.push(funnel.key)
  return {
    ok: true,
    generatedAt: str(raw.generatedAt) || null,
    timezone: str(raw.timezone) || 'Asia/Shanghai',
    range: {
      days: Number.isFinite(scriptDays) ? scriptDays : days || null,
      from: str(range.from) || null,
      to: str(range.to) || null,
    },
    source: {
      envId: str(source.envId),
      collection: str(source.collection) || 'product_events',
      readOnly: source.readOnly !== false,
      schema: Number.isFinite(Number(source.schema)) ? Number(source.schema) : null,
    },
    scope: str(raw.scope),
    funnels,
    outcome: outcome || { saved: null, contact: null },
    dropoff,
    trend,
    breakdown,
    events,
    extra: normalizeExtra(raw.extra),
    // 新契约字段是可选透传：缺失就是 null，不判整份快照非法，也不写进 unavailable（unavailable 语义不变）。
    freshness: normalizeFreshness(raw.freshness),
    previous: normalizePrevious(raw.previous),
    flow: normalizeFlow(raw.flow),
    eventTrend: normalizeEventTrend(raw.eventTrend),
    retention: normalizeRetention(raw.retention),
    warnings,
    unavailable: [...new Set(unavailable)],
  }
}

// ---------- 示例快照（LANJING_CONVERSION_MOCK=1） ----------
// 数字取自数据仓脚本 2026-11-10 的 7 天窗口实跑结果，只用来联调渲染；标了 meta.mock，界面必须显示「示例数据」。
const MOCK_PRIMARY = [
  { key: 'session', label: '打开小程序', actors: 402 },
  { key: 'view', label: '浏览页面', actors: 401 },
  { key: 'entry_shown', label: '服务入口曝光', actors: 355 },
  { key: 'entry_clicked', label: '进入服务', actors: 1 },
  { key: 'form', label: '打开表单', actors: 0 },
  { key: 'attempt', label: '提交留资', actors: 0 },
]
const MOCK_RESEARCH = [
  { key: 'session', label: '打开小程序', actors: 402 },
  { key: 'detail', label: '看楼盘详情', actors: 249 },
  { key: 'deep', label: '看户型/楼栋/关注/对比/解锁', actors: 0, pending: true, detached: true },
  { key: 'lead', label: '留资成功', actors: 1 },
]
const MOCK_WEIGHTS = [0.82, 1.05, 0.71, 1.18, 0.93, 1.12, 0.66, 1.24, 0.88, 0.97, 1.31, 0.74, 1.02, 0.91]
const MOCK_BREAKDOWN = {
  source: [
    { value: 'other_page', sessions: 209, stages: [209, 208, 181, 0, 0, 0] },
    { value: 'home_viewing', sessions: 171, stages: [171, 171, 155, 1, 0, 0] },
    { value: 'project_detail', sessions: 15, stages: [14, 14, 14, 0, 0, 0] },
    { value: 'home_promotion', sessions: 3, stages: [3, 3, 2, 0, 0, 0] },
    { value: 'discover', sessions: 1, stages: [1, 1, 1, 0, 0, 0] },
    { value: 'unknown', sessions: 1, stages: [1, 1, 0, 0, 0, 0] },
  ],
  pageKey: [
    { value: 'pages/home/index', sessions: 365, stages: [364, 364, 328, 1, 0, 0] },
    { value: 'pages/search/index', sessions: 276, stages: [275, 275, 253, 1, 0, 0] },
    { value: 'pages/project-detail/index', sessions: 250, stages: [249, 249, 247, 1, 0, 0] },
    { value: 'packages/lowfreq/market/index', sessions: 32, stages: [32, 32, 29, 0, 0, 0] },
    { value: 'pages/my-follows/index', sessions: 31, stages: [31, 31, 29, 0, 0, 0] },
    { value: 'packages/lowfreq/land-auction/index', sessions: 15, stages: [15, 15, 6, 0, 0, 0] },
  ],
  budgetBand: [{ value: 'unknown', sessions: 403, stages: [402, 401, 355, 1, 0, 0] }],
  // 新契约：按项目维度拆分（示例数据）
  project: [
    { value: '示例项目A', sessions: 96, stages: [96, 96, 88, 1, 0, 0] },
    { value: '示例项目B', sessions: 63, stages: [63, 63, 57, 0, 0, 0] },
    { value: 'unknown', sessions: 244, stages: [243, 242, 210, 0, 0, 0] },
  ],
}

function mockDates(days) {
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    out.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`)
  }
  return out
}

function mockGaps(days) {
  if (days === 14) return new Set([9])
  if (days === 30) return new Set([4, 13, 24])
  return new Set()
}

/** 把总数按固定权重拆到各天（最大余数法），缺口日留空。 */
function mockDistribute(total, days, gaps) {
  const weights = []
  for (let i = 0; i < days; i += 1) weights.push(gaps.has(i) ? 0 : MOCK_WEIGHTS[i % MOCK_WEIGHTS.length])
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const raw = weights.map(weight => (total * weight) / sum)
  const values = raw.map((value, index) => (gaps.has(index) ? null : Math.floor(value)))
  let rest = total - values.reduce((a, b) => a + (b ?? 0), 0)
  const order = raw
    .map((value, index) => ({ index, fraction: gaps.has(index) ? -1 : value - Math.floor(value) }))
    .filter(item => item.fraction >= 0)
    .sort((a, b) => b.fraction - a.fraction)
  let cursor = 0
  while (rest > 0 && order.length) {
    values[order[cursor % order.length].index] += 1
    rest -= 1
    cursor += 1
  }
  return values
}

/** fromPrev 的基准是「上一个有序级」：detached 级只观测，不成为后续级的基准。 */
function mockWithRates(stages) {
  const first = stages[0]?.actors ?? null
  let baseline = null
  return stages.map((stage, index) => {
    const prev = baseline ? baseline.actors : null
    const pending = stage.pending === true
    const detached = stage.detached === true
    const item = {
      key: stage.key,
      label: stage.label,
      actors: stage.actors,
      events: pending ? 0 : stage.actors + Math.round(stage.actors * 0.1),
      fromPrev: index === 0 || !Number.isFinite(prev) || prev === 0 ? null : Number((stage.actors / prev).toFixed(4)),
      ofFirst: index === 0 ? 1 : Number.isFinite(first) && first > 0 ? Number((stage.actors / first).toFixed(4)) : null,
      unordered: stage.actors,
    }
    if (pending) item.pending = true
    if (detached) item.detached = true
    if (!detached) baseline = stage
    return item
  })
}

/** 数据仓脚本口径：rate = 流失率（lost / from），passRate = 通过率（to / from）；detached 级不出现在 dropoff。 */
function mockDropoff(funnel) {
  const rows = []
  let baseline = null
  for (const stage of funnel.stages) {
    if (stage.detached === true) continue
    if (baseline) {
      const lost = Math.max(0, baseline.actors - stage.actors)
      rows.push({
        funnel: funnel.key,
        from: baseline.key,
        to: stage.key,
        lost,
        rate: baseline.actors > 0 ? Number((lost / baseline.actors).toFixed(4)) : null,
        passRate: baseline.actors > 0 ? Number((stage.actors / baseline.actors).toFixed(4)) : null,
      })
    }
    baseline = stage
  }
  return rows
}

export function mockBuyPointsSnapshot(days = 7) {
  const gaps = mockGaps(days)
  const dates = mockDates(days)
  const funnels = [
    { key: 'primary', label: '主转化漏斗', stages: mockWithRates(MOCK_PRIMARY) },
    { key: 'research', label: '研究深度漏斗', stages: mockWithRates(MOCK_RESEARCH) },
  ]
  const series = funnel => funnel.stages.map(stage => mockDistribute(stage.actors, days, gaps))
  const primarySeries = series(funnels[0])
  const researchSeries = series(funnels[1])
  const trend = dates.map((date, index) => ({
    date,
    primary: primarySeries.map(row => row[index]),
    research: researchSeries.map(row => row[index]),
    sessions: primarySeries[0][index],
  }))
  // 新契约字段也用示例数据（meta.mock=true，界面必须显示「示例数据」）。
  const shiftDate = (iso, delta) => {
    const [year, month, day] = iso.split('-').map(Number)
    const date = new Date(year, month - 1, day + delta)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const previousDates = dates.map(date => shiftDate(date, -days))
  const previous = {
    range: { days, from: previousDates[0], to: previousDates.at(-1) },
    funnels: funnels.map(funnel => ({
      key: funnel.key,
      stages: funnel.stages.map((stage) => {
        const current = Number.isFinite(stage.actors) ? stage.actors : null
        const previousActors = current === null ? null : Math.max(0, current - Math.round(current * 0.05))
        const delta = current === null ? null : current - previousActors
        return {
          key: stage.key,
          actors: previousActors,
          delta,
          deltaRate: previousActors ? Number((delta / previousActors).toFixed(4)) : null,
        }
      }),
    })),
  }
  const flow = MOCK_BREAKDOWN.source.slice(0, 3).map((row, index) => ({
    source: row.value,
    pageKey: MOCK_BREAKDOWN.pageKey[index]?.value ?? null,
    sessions: row.sessions,
    entered: row.stages[3] ?? null,
  }))
  const eventTrend = dates.map((date, index) => ({
    date,
    counts: {
      app_session_started: primarySeries[0][index],
      view_page: primarySeries[1][index],
      service_entry_shown: primarySeries[2][index],
    },
  }))
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    range: { days, from: dates[0], to: dates.at(-1) },
    source: { envId: 'mock-env', collection: 'product_events', readOnly: true, schema: 3 },
    scope: '示例数据：会话级有序漏斗；排除已识别管理员与 develop/trial；渠道为自报标签，不作财务归因',
    outcome: { saved: 1, contact: 2 },
    funnels,
    dropoff: funnels.flatMap(mockDropoff),
    trend,
    breakdown: Object.entries(MOCK_BREAKDOWN).map(([dimension, rows]) => ({ dimension, rows })),
    freshness: { lastEventAt: `${dates.at(-1)}T10:00:00.000Z`, ageMinutes: 21, stale: false },
    previous,
    flow,
    eventTrend,
    retention: { accounts: 402, newAccounts: 358, returningAccounts: 44, nextDayReturnRate: 0.183 },
    events: [
      { name: 'service_entry_state_changed', count: 4815 },
      { name: 'lead_form_state_changed', count: 3320 },
      { name: 'page_viewed', count: 3023 },
      { name: 'service_entry_shown', count: 1700 },
      { name: 'app_session_started', count: 402 },
      { name: 'lead_saved', count: 1 },
      { name: 'lead_submit_attempted', count: 1 },
      { name: 'phone_authorization_succeeded', count: 1 },
      { name: 'wecom_card_sent', count: 1 },
    ],
    warnings: [
      '部分埋点事件尚未上线，对应级为 0 表示未采集而非零转化（见 stage.pending）',
      '联系建立含不经表单的企微名片路径，contact 可大于提交会话数',
      'research.deep 为分解级（detached）：仅作观测展示，不参与有序判定，其后的级以上一个有序级为基准',
      'budgetBand 本轮新增且尚未上线，全部会话归 unknown，暂不能回答「800 万以上客群转化」',
      '采集缺口：attempt 有 1 个会话但前置级 form 为 0，严格序下该级记为 0（缺事件而非零转化）',
      'freshness / previous / project 拆分 / flow / eventTrend / retention 是示例数据，用来联调新契约渲染',
    ],
    unavailable: [],
    extra: {
      outcome: { saved: 1, contact: 2 },
      legacyInspection: { started: 434, reportViewed: 356, linked: false, note: '旧埋点流，无 sessionHash/schemaVersion，不能与会话漏斗串联' },
    },
  }
}

// ---------- 执行器：默认用子进程跑数据仓脚本；测试可注入替身 ----------
function timeoutFromEnv(env) {
  const value = Number(env?.LANJING_CONVERSION_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

/** 默认执行器：跑脚本并解析 stdout，返回脚本的原始 JSON（未归一化）。 */
export function runScript({ file, envId, days, timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [file, '--json', '--days', String(days), '--env', envId],
      {
        cwd: dirname(file),
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env, CLOUDBASE_ENV_ID: envId, LANJING_CONVERSION_ENV: envId, TZ: 'Asia/Shanghai' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT'
          const detail = String(stderr || '').trim().slice(0, 400) || String(stdout || '').trim().slice(0, 400)
          const firstLine = (detail || String(error.message || '')).split('\n')[0].slice(0, 200)
          rejectRun(Object.assign(new Error(timedOut ? `脚本执行超时（${Math.round(timeoutMs / 1000)} 秒）` : `脚本退出异常：${firstLine}`), { stderr: detail, timedOut }))
          return
        }
        try {
          resolveRun(parseScriptOutput(stdout))
        } catch (parseError) {
          rejectRun(Object.assign(parseError, { stderr: String(stderr || '').trim().slice(0, 400) }))
        }
      },
    )
  })
}

function cacheFileName(days) {
  const hash = createHash('sha1').update(`buy-points-funnel:${days}`).digest('hex').slice(0, 16)
  return `funnel-${days}-${hash}.json`
}

/** 候选脚本路径：环境变量 → 数据仓默认检出 → 当前工作目录下的常见布局。 */
export function scriptCandidates(env = process.env) {
  const configured = expandHome(env.LANJING_CONVERSION_SCRIPT)
  const list = [configured, expandHome(PROJECT_SCRIPT)]
  const home = homedir()
  list.push(join(home, 'project', '01-开发项目', 'RealEstateIntelligent-repos', 'RealEstateIntelligent-data', 'scripts', SCRIPT_NAME))
  list.push(join(process.cwd(), 'RealEstateIntelligent-data', 'scripts', SCRIPT_NAME))
  list.push(join(process.cwd(), 'scripts', SCRIPT_NAME))
  return [...new Set(list.filter(Boolean))]
}

/**
 * 建一个埋点转化实例。默认导出给 Host 用；测试注入 run / cacheDir / envId / script 避免联网。
 * @param {object} [options] 注入点：run、script、envId、scriptCandidates、cacheDir、env、mock、timeoutMs、
 *   memoryTtlMs、now（时钟）、timers（setTimeout/clearTimeout）、log（日志）。测试用假时钟验证 03:00 预热与缓存新鲜度。
 */
export function createBuyPoints(options = {}) {
  const env = options.env ?? process.env
  const cacheDir = options.cacheDir ?? join(dshHome(env), 'media-desk-lanjing', 'cache')
  const timeoutMs = options.timeoutMs ?? timeoutFromEnv(env)
  const run = options.run ?? runScript
  const candidates = options.scriptCandidates ?? scriptCandidates(env)
  const mock = options.mock ?? env.LANJING_CONVERSION_MOCK === '1'
  const fixedScript = options.script === undefined ? null : String(options.script ?? '')
  const fixedEnvId = options.envId === undefined ? null : String(options.envId ?? '')
  const ttl = options.memoryTtlMs ?? MEMORY_TTL_MS
  // 可注入的时钟 / 定时器 / 日志：不注入就是真实时间与全局 timer。
  const now = options.now ?? (() => Date.now())
  const timers = options.timers ?? { setTimeout, clearTimeout }
  const log = options.log ?? console

  // 成功结果存内存（新鲜 6 小时）；磁盘快照单独放磁盘，命中时先返回再后台刷新。
  const cache = new Map()
  function cacheGet(key) {
    const hit = cache.get(key)
    if (!hit) return null
    if (now() - hit.at > ttl) {
      cache.delete(key)
      return null
    }
    return hit
  }
  function cacheSet(key, entry) {
    cache.set(key, { at: now(), ...entry })
    return entry
  }

  // 同一窗口同一时刻只允许一个刷新：并发请求共用同一个 promise，不重复跑几十秒的聚合。
  const inFlight = new Map()

  async function resolveScript() {
    if (fixedScript !== null) return { file: fixedScript || null, candidates: fixedScript ? [fixedScript] : [], source: 'option' }
    const configured = expandHome(env.LANJING_CONVERSION_SCRIPT)
    for (const file of candidates) {
      if (!(await exists(file))) continue
      return { file, candidates, source: configured && file === configured ? 'env' : 'search' }
    }
    return { file: null, candidates, source: 'search' }
  }

  async function resolveEnvId() {
    if (fixedEnvId !== null) return { envId: fixedEnvId, source: fixedEnvId ? 'option' : null }
    const configured = str(env.LANJING_CONVERSION_ENV)
    if (configured) return { envId: configured, source: 'env' }
    try {
      const raw = await readFile(join(homedir(), '.config', '.cloudbase', 'global.json'), 'utf8')
      const parsed = JSON.parse(raw)
      const envId = str(parsed?.currentEnvId || parsed?.envId)
      if (envId) return { envId, source: 'cloudbase-global' }
    } catch {
      // 没有 CloudBase CLI 配置时走「未配置」提示，不猜环境
    }
    return { envId: '', source: null }
  }

  async function readDiskCache(days) {
    try {
      const parsed = JSON.parse(await readFile(join(cacheDir, cacheFileName(days)), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.data) return null
      return parsed
    } catch {
      return null
    }
  }

  async function writeDiskCache(days, data) {
    try {
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, cacheFileName(days)), JSON.stringify({ at: new Date(now()).toISOString(), days, data }), 'utf8')
    } catch {
      // 缓存写失败不影响主流程
    }
  }

  function withMeta(data, meta) {
    return { ...data, meta }
  }

  function baseMeta(script, envInfo, extra = {}) {
    return { mock: false, cached: false, cachedAt: null, revalidating: false, degradeReason: null, scriptPath: script.file, scriptSource: script.source, envId: envInfo.envId, envSource: envInfo.source, retrievedAt: new Date(now()).toISOString(), timeoutMs, ...extra }
  }

  /** 内存命中：TTL 内即新鲜（内存不按 03:00 判定，磁盘才按次日 03:00）。 */
  function memoryFreshness(atMs) {
    return {
      cacheAgeMs: Math.max(0, now() - atMs),
      cacheTtlMs: ttl,
      cacheFresh: true,
      stale: false,
      cacheExpiresAt: new Date(atMs + ttl).toISOString(),
    }
  }

  /** 磁盘快照的新鲜度：写入后第一个本地 03:00 之前算新鲜，之后算过期（仍可先返回，只是标 stale）。 */
  function diskFreshness(entry) {
    const atMs = Date.parse(entry?.at)
    if (!Number.isFinite(atMs)) return { cacheAgeMs: null, cacheFresh: null, stale: false, cacheExpiresAt: null }
    const fresh = isDiskCacheFresh(atMs, now())
    return {
      cacheAgeMs: Math.max(0, now() - atMs),
      cacheFresh: fresh,
      stale: !fresh,
      cacheExpiresAt: new Date(nextWarmBoundary(atMs)).toISOString(),
    }
  }

  /** 跑一次完整取数：解析脚本/环境 → 子进程 → 归一化 → 写磁盘 + 内存。缺配置时返回 { missing }，不写缓存。 */
  async function execute(days) {
    const script = await resolveScript()
    const envInfo = await resolveEnvId()
    const missing = []
    if (!script.file || !(await exists(script.file))) missing.push('script')
    if (!envInfo.envId) missing.push('envId')
    if (missing.length) return { missing, script, envInfo }
    const scripted = await run({ file: script.file, envId: envInfo.envId, days, timeoutMs })
    const data = normalizeBuyPoints(scripted, { days })
    await writeDiskCache(days, data)
    cacheSet(`buy-points:funnel:${days}`, { data, script, envInfo })
    return { data, script, envInfo }
  }

  /** 后台刷新：同一窗口只跑一次；没有人 await 时不让 rejection 冒成 unhandled。 */
  function revalidate(days) {
    const existing = inFlight.get(days)
    if (existing) return existing
    const task = execute(days).then(
      (value) => {
        inFlight.delete(days)
        return value
      },
      (error) => {
        inFlight.delete(days)
        throw error
      },
    )
    inFlight.set(days, task)
    task.catch(() => {})
    return task
  }

  // ---------- 每日 03:00 预热 ----------
  // 串行预热 7/14/30，结果写内存与磁盘；启动时按 warm-state.json 判定是否补跑。
  let warmTimer = null
  let warmRun = null
  let warmStarted = false
  function warmStatePath() {
    return join(cacheDir, WARM_STATE_FILE)
  }

  async function readWarmState() {
    try {
      const parsed = JSON.parse(await readFile(warmStatePath(), 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  async function writeWarmState(state) {
    try {
      await mkdir(cacheDir, { recursive: true })
      await writeFile(warmStatePath(), JSON.stringify(state), 'utf8')
    } catch {
      // 落盘失败不影响预热本身
    }
  }

  /** 真正跑一遍预热：三个窗口串行；单窗口失败只记日志，不抛到外面。 */
  async function doWarm({ reason = 'manual' } = {}) {
    const startedAt = now()
    const script = await resolveScript()
    const envInfo = await resolveEnvId()
    const missing = []
    if (!script.file || !(await exists(script.file))) missing.push('script')
    if (!envInfo.envId) missing.push('envId')
    if (missing.length) {
      // 未配置：记一次日志并在 warm-state 里登记「尝试过」，同一天不反复重试；下次启动再试一次。
      log.warn?.(`[media-desk-lanjing] 埋点转化预热跳过（${reason}）：缺 ${missing.join(' / ')}`)
      const state = { lastWarmAt: new Date(now()).toISOString(), lastWarmOk: false, reason, missing, windows: [] }
      await writeWarmState(state)
      return { ok: false, reason, missing, windows: [], at: state.lastWarmAt }
    }
    const windows = []
    for (const days of WARM_WINDOWS) {
      try {
        // 与用户请求共用 in-flight 锁：用户正在拉这个窗口时不会再跑一遍。
        const result = await revalidate(days)
        if (!result?.data) throw new Error(result?.missing ? '缺配置，未取到数据' : '没有取到数据')
        windows.push({ days, ok: true, at: new Date(now()).toISOString() })
      } catch (error) {
        const message = String(error?.message || error).slice(0, 200)
        windows.push({ days, ok: false, error: message })
        log.warn?.(`[media-desk-lanjing] 埋点转化预热 ${days} 天失败：${message}`)
      }
    }
    const ok = windows.every(window => window.ok)
    const state = {
      lastWarmAt: new Date(now()).toISOString(),
      lastWarmOk: ok,
      reason,
      startedAt: new Date(startedAt).toISOString(),
      windows,
    }
    await writeWarmState(state)
    return { ok, reason, windows, at: state.lastWarmAt }
  }

  /** 同一时刻只允许一次预热（手动 warm=1 / 每日调度 / 启动补跑共用）；任何失败都收成日志。 */
  function warmOnce(args = {}) {
    if (warmRun) return warmRun
    const task = doWarm(args).catch((error) => {
      const message = String(error?.message || error)
      log.warn?.(`[media-desk-lanjing] 埋点转化预热失败：${message}`)
      return { ok: false, reason: args.reason || 'manual', windows: [], error: message }
    })
    warmRun = task
    const clear = () => {
      if (warmRun === task) warmRun = null
    }
    task.then(clear, clear)
    return task
  }

  /** 用 setTimeout 排下一次（不用 setInterval，避免漂移）；timer 一律 unref()。 */
  function scheduleNextWarm() {
    if (!warmStarted) return null
    if (warmTimer) {
      try {
        timers.clearTimeout?.(warmTimer)
      } catch {
        // 注入的 timer 清理失败不影响后面重新排
      }
      warmTimer = null
    }
    const at = nextWarmBoundary(now())
    const timer = timers.setTimeout(() => {
      warmTimer = null
      // 到点：预热完成后（无论成功失败）再排下一天 03:00。
      warmOnce({ reason: 'daily' }).then(scheduleNextWarm, scheduleNextWarm)
    }, Math.max(0, at - now()))
    // 不让预热 timer 阻止进程退出
    timer?.unref?.()
    warmTimer = timer
    return at
  }

  /** 启动补跑：今天 03:00 之后还没预热过才补跑一次；不阻塞首屏。 */
  async function warmCatchUp() {
    try {
      const state = await readWarmState()
      const last = state?.lastWarmAt ? Date.parse(state.lastWarmAt) : NaN
      if (Number.isFinite(last) && last >= lastWarmBoundary(now())) return { skipped: true, lastWarmAt: state.lastWarmAt }
      return { skipped: false, ...(await warmOnce({ reason: 'catch-up' })) }
    } catch (error) {
      const message = String(error?.message || error)
      log.warn?.(`[media-desk-lanjing] 埋点转化启动补跑失败：${message}`)
      return { skipped: false, ok: false, error: message }
    }
  }

  /**
   * Host 侧在插件 apply 时调用一次：排每天 03:00 的预热，并在必要时后台补跑今天的那一次。
   * 幂等：重复调用只重排 timer，不再重复补跑。返回 { nextWarmAt, catchUp }。
   */
  function scheduleWarm({ catchUp = true } = {}) {
    if (mock) return { nextWarmAt: null, catchUp: null, skipped: 'mock' }
    const first = !warmStarted
    warmStarted = true
    const nextAt = scheduleNextWarm()
    const catchUpTask = first && catchUp ? warmCatchUp() : null
    return { nextWarmAt: nextAt === null ? null : new Date(nextAt).toISOString(), catchUp: catchUpTask }
  }

  /** 测试/卸载用：清掉 timer。 */
  function stopWarm() {
    if (warmTimer) {
      try {
        timers.clearTimeout?.(warmTimer)
      } catch {
        // ignore
      }
      warmTimer = null
    }
    warmStarted = false
    return true
  }

  async function warmStatus() {
    const state = await readWarmState()
    return {
      windows: WARM_WINDOWS,
      nextWarmAt: new Date(nextWarmBoundary(now())).toISOString(),
      lastWarmAt: state?.lastWarmAt ? String(state.lastWarmAt) : null,
      lastWarmOk: state?.lastWarmOk === true,
      lastWarmReason: state?.reason ? String(state.reason) : null,
      lastWarmWindows: Array.isArray(state?.windows) ? state.windows : null,
      stateFile: warmStatePath(),
    }
  }

  function notConfigured(result) {
    const missing = result.missing
    const need = [missing.includes('script') ? '数据仓脚本 scripts/conversion-funnel.js' : '', missing.includes('envId') ? 'CloudBase 环境 ID' : ''].filter(Boolean).join(' 和 ')
    const hint = [
      missing.includes('script') ? '把数据仓 RealEstateIntelligent-data 放在默认检出位置，或用环境变量 LANJING_CONVERSION_SCRIPT 指定 scripts/conversion-funnel.js 的路径。' : '',
      missing.includes('envId') ? '需要 CloudBase 环境 ID：设置环境变量 LANJING_CONVERSION_ENV，或让 ~/.config/.cloudbase/global.json 里有 currentEnvId。' : '',
    ].filter(Boolean).join(' ')
    return {
      ok: false,
      code: 'not_configured',
      message: `埋点转化还没有接入：缺${need}`,
      missing,
      hint,
      scriptPath: result.script.file,
      scriptCandidates: result.script.candidates,
      scriptSource: result.script.source,
      envId: result.envInfo.envId,
      envSource: result.envInfo.source,
      meta: baseMeta(result.script, result.envInfo),
    }
  }

  async function runFunnel(input = {}) {
    const raw = input.days
    const days = raw === null || raw === undefined || raw === '' ? 7 : Number(raw)
    if (!ALLOWED.has(days)) {
      return { ok: false, code: 'invalid_days', message: '时间窗口只支持 7 / 14 / 30 天', allowed: ALLOWED_DAYS, days: Number.isFinite(days) ? days : null }
    }
    const key = `buy-points:funnel:${days}`
    // force / fresh 两种叫法都认：Host 路由用 fresh=1，内部调用可以直接传 force。
    const force = [input.force, input.fresh].some(value => value === '1' || value === 1 || value === true)
    const wait = input.wait === '1' || input.wait === 1 || input.wait === true

    if (mock) {
      const cachedMemory = cacheGet(key)
      if (cachedMemory) return withMeta(cachedMemory.data, baseMeta({ file: 'mock', source: 'mock' }, { envId: 'mock-env', source: 'mock' }, { mock: true, ...memoryFreshness(cachedMemory.at) }))
      const data = normalizeBuyPoints(mockBuyPointsSnapshot(days), { days })
      cacheSet(key, { data, script: { file: 'mock', source: 'mock' }, envInfo: { envId: 'mock-env', source: 'mock' } })
      return withMeta(data, baseMeta({ file: 'mock', source: 'mock' }, { envId: 'mock-env', source: 'mock' }, { mock: true }))
    }

    // 1) 内存缓存：6 小时内视为新鲜，秒回、不触发刷新。
    if (!force) {
      const cachedMemory = cacheGet(key)
      if (cachedMemory) return withMeta(cachedMemory.data, baseMeta(cachedMemory.script, cachedMemory.envInfo, memoryFreshness(cachedMemory.at)))
    }

    // 被动浏览只读取已有快照，既不调用 CloudBase，也不安排后台刷新。
    if (input.cacheOnly === true) {
      const disk = await readDiskCache(days)
      if (!disk?.data) return { ok: false, code: 'no_cache', message: '还没有本地快照。需要时可手动读取。' }
      return withMeta(disk.data, baseMeta({}, {}, { cached: true, cachedAt: disk.at || null, ...diskFreshness(disk) }))
    }

    // 2) 磁盘缓存：先给快照，同时后台刷新（stale-while-revalidate）。wait=1 的请求挂在同一个刷新上。
    //    03:00 前（即使超过 6 小时）仍然先返回；03:00 之后视为过期（meta.cacheFresh=false / stale=true），
    //    但同样先返回再后台刷新，不因为过期把已有数字换掉。
    if (!force) {
      const disk = await readDiskCache(days)
      if (disk?.data) {
        const script = await resolveScript()
        const envInfo = await resolveEnvId()
        const fresh = diskFreshness(disk)
        const refresh = revalidate(days)
        if (wait) {
          try {
            const result = await refresh
            if (result.data) return withMeta(result.data, baseMeta(result.script, result.envInfo))
            return withMeta(disk.data, baseMeta(script, envInfo, { cached: true, cachedAt: disk.at || null, ...fresh, degradeReason: notConfigured(result).message }))
          } catch (error) {
            return withMeta(disk.data, baseMeta(script, envInfo, { cached: true, cachedAt: disk.at || null, ...fresh, degradeReason: error.message || '脚本执行失败' }))
          }
        }
        return withMeta(disk.data, baseMeta(script, envInfo, { cached: true, cachedAt: disk.at || null, revalidating: true, ...fresh }))
      }
    }

    // 3) 没有缓存（或 fresh=1 强制刷新）：同步等这次取数。
    try {
      const result = await revalidate(days)
      if (result.missing) return notConfigured(result)
      return withMeta(result.data, baseMeta(result.script, result.envInfo))
    } catch (error) {
      // 强制刷新/首次取数失败时仍优先给磁盘快照，不把已有数字换成空页面。
      const disk = await readDiskCache(days)
      const script = await resolveScript()
      const envInfo = await resolveEnvId()
      if (disk?.data) {
        return withMeta(disk.data, baseMeta(script, envInfo, { cached: true, cachedAt: disk.at || null, ...diskFreshness(disk), degradeReason: error.message || '脚本执行失败' }))
      }
      return {
        ok: false,
        code: 'script_failed',
        message: `埋点转化脚本执行失败：${error.message}`,
        timedOut: error.timedOut === true,
        stderr: error.stderr || '',
        scriptPath: script.file,
        envId: envInfo.envId,
        meta: baseMeta(script, envInfo, { degradeReason: error.message || '脚本执行失败' }),
      }
    }
  }

  /** warm=1：后台触发一次预热（调试用，默认关闭）。 */
  function maybeWarm(input) {
    if (mock) return false
    const triggered = [input.warm].some(value => value === '1' || value === 1 || value === true)
    if (!triggered) return false
    warmOnce({ reason: 'request' })
    return true
  }

  /** 对外取数入口：warm=1 时先挂一次后台预热，再把结果标上 meta.warmTriggered。 */
  async function funnel(input = {}) {
    const warmTriggered = input.cacheOnly !== true && maybeWarm(input)
    const result = await runFunnel(input)
    if (warmTriggered && result && typeof result === 'object') result.meta = { ...(result.meta || {}), warmTriggered: true }
    return result
  }

  /** 给页面空态用：脚本与环境解析结果，不含任何数据。 */
  async function status() {
    const script = await resolveScript()
    const envInfo = await resolveEnvId()
    return {
      ok: true,
      mock,
      scriptPath: script.file,
      scriptCandidates: script.candidates,
      scriptSource: script.source,
      scriptExists: script.file ? await exists(script.file) : false,
      envId: envInfo.envId,
      envSource: envInfo.source,
      days: ALLOWED_DAYS,
      cacheDir,
      timeoutMs,
      memoryTtlMs: ttl,
      warm: await warmStatus(),
    }
  }

  return { funnel, status, warm: warmOnce, scheduleWarm, stopWarm, warmStatus }
}

let shared = null
function instance() {
  if (!shared) shared = createBuyPoints()
  return shared
}

/** Host 接口：GET buy-points/funnel */
export function buyPointsFunnel(input) {
  return instance().funnel(input ?? {})
}

/** Host 接口：GET buy-points/status */
export function buyPointsStatus() {
  return instance().status()
}

/** Host 接口：插件 apply 时调用一次，启动每日 03:00 预热与启动补跑（幂等）。 */
export function buyPointsStartWarm() {
  return instance().scheduleWarm()
}

/** Host 接口：插件卸载时停掉预热 timer。 */
export function buyPointsStopWarm() {
  return instance().stopWarm()
}

/** Host 接口：GET buy-points/warm（调试） */
export function buyPointsWarmStatus() {
  return instance().warmStatus()
}
