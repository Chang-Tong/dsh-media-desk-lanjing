// 埋点转化：小程序会话级有序漏斗（只读聚合）。
// 数据来自 Host 的 media-desk-lanjing/buy-points/funnel，字段是数据仓 scripts/conversion-funnel.js 的 v1 契约。
// 原则：只渲染真实返回的数字；缺字段或在 unavailable 里就写「未获取」，0 就是 0，不估算、不补零。
//
// 加载体验：缓存优先 + 后台刷新（stale-while-revalidate）。
// - Host 有磁盘缓存时立刻返回快照（meta.cached + meta.cachedAt + meta.revalidating）；
//   本页先渲染快照并给一条轻提示，再带 wait=1 静默等后台刷新完成，成功后直接替换数据，不闪回骨架。
// - 首屏没有缓存才进整页加载态（进度条 + 已等待秒数 + 取消）。
// - 顶部「重新取数」带 fresh=1，跳过缓存强制跑一次。
// - 切回看过的窗口先用本会话内存里的快照，再向 Host 要最新。
import React from 'react'
import { toast } from './desk.js'
import { lang, t, useLang } from './i18n.js'
import { Icon, Segmented } from './ui.jsx'

const BASE = 'media-desk-lanjing/'
const WINDOWS = [7, 14, 30]
const BUDGET_LABEL = {
  unknown: '未知',
  under_500: '500万以下',
  '500_800': '500–800万',
  '800_1200': '800–1200万',
  '1200_2000': '1200–2000万',
  above_2000: '2000万以上',
  unsure: '不确定',
}
const DIMENSIONS = [['source', '来源'], ['pageKey', '页面'], ['budgetBand', '预算档位'], ['project', '项目']]
const DIMENSION_NOTE = {
  source: '按会话开始时的自报来源分组（1 个会话只归 1 个来源）；渠道标签只作结构观察，不作财务归因。',
  pageKey: '按会话内出现过的页面分组；一个会话可以出现在多行，反映页面覆盖，不是互斥拆分。',
  budgetBand: '按用户自选的购房总预算分组（1 个会话只归 1 档）；本轮埋点刚加，尚未上线时几乎全是「未知」。',
  project: '按事件里携带的项目 ID 分组；一个会话可以落在多个项目。',
}
// 预算档位合并口径：只看「800 万及以上 vs 800 万以下」，不把 unknown 凑进任何一边。
const BUDGET_GROUPS = [
  { key: 'high', label: '800 万及以上', values: ['800_1200', '1200_2000', 'above_2000'] },
  { key: 'low', label: '800 万以下', values: ['under_500', '500_800'] },
]
const BUDGET_UNKNOWN_VALUES = ['unknown', '(none)', 'none', '']
const FLOW_TOP_PATHS = 6
const EVENT_SERIES_MAX = 8
// 本会话内缓存：切回看过的窗口先拿它顶上，Host 侧还有磁盘缓存与后台刷新。
const MEMO = new Map()

// 采集健康度判定：全部基于现有 events[] 计数做「量级提示」，不下结论。
const EXPECTED_RESEARCH_EVENTS = ['budget_selected', 'unlock_clicked', 'layout_viewed', 'building_viewed', 'follow_added', 'compare_added']
const DIAGNOSTIC_EVENTS = ['service_entry_state_changed', 'lead_form_state_changed']
const EVENTS_PER_SESSION_HIGH = 40
const DIAGNOSTIC_SHARE_HIGH = 0.5

const isNum = value => typeof value === 'number' && Number.isFinite(value)
const fmt = value => (isNum(value) ? value.toLocaleString('zh-CN') : null)
const pct = (value, digits = 1) => (isNum(value) ? `${(value * 100).toFixed(digits)}%` : null)

function Missing() {
  return <span className="bp-missing">{t('未获取')}</span>
}

function timeText(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  return date.toLocaleString(lang() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 小时数：保留 1 位小数，整数不带 .0。 */
function hoursText(minutes) {
  const hours = Math.round((minutes / 60) * 10) / 10
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
}

/** pageKey 显示：去掉 pages/ 前缀与 /index 后缀（packages/... 只去掉 /index）。 */
function prettyPageKey(key) {
  const text = String(key ?? '').trim()
  if (!text) return '—'
  const noPrefix = text.startsWith('pages/') ? text.slice('pages/'.length) : text
  const noIndex = noPrefix.endsWith('/index') ? noPrefix.slice(0, -'/index'.length) : noPrefix
  return noIndex || text
}

/** 阶段数组按位求和：任一档缺这一级就是 null，不把缺失当 0。 */
function sumStages(rows, index, stagesLength) {
  const values = rows.map(row => (Array.isArray(row.stages) ? row.stages[index] : undefined))
  if (!values.length || !values.every(value => isNum(value))) return null
  return values.reduce((sum, value) => sum + value, 0)
}

function unavailableHas(data, field) {
  const list = Array.isArray(data?.unavailable) ? data.unavailable : []
  return list.some(item => item === field || String(item).startsWith(`${field}.`))
}

function funnelOf(data, key) {
  return (Array.isArray(data?.funnels) ? data.funnels : []).find(funnel => funnel.key === key) || null
}

function stageOf(funnel, keys) {
  if (!funnel || !Array.isArray(funnel.stages)) return null
  return funnel.stages.find(stage => keys.includes(stage.key)) || null
}

function stageLabel(funnel, key) {
  return funnel?.stages?.find(stage => stage.key === key)?.label || key
}

/** 上一个参与有序判定的级：detached 级只观测，不成为后续级的基准。 */
function orderedBaseline(funnel, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (funnel.stages[i]?.detached === true) continue
    return { stage: funnel.stages[i], index: i }
  }
  return null
}

/**
 * 逐级流失：按 lost 降序返回全部行，并补上两端会话数与标签。
 * 目标级未获取时不拿 rate 冒充流失率（否则会显示 100%）。
 */
function dropoffRows(data, funnel) {
  const stages = Array.isArray(funnel?.stages) ? funnel.stages : []
  const byKey = new Map(stages.map(stage => [stage.key, stage]))
  return (Array.isArray(data?.dropoff) ? data.dropoff : [])
    .filter(row => row.funnel === (funnel?.key || 'primary'))
    .map((row) => {
      const fromActors = byKey.get(row.from)?.actors
      const toActors = byKey.get(row.to)?.actors
      const provided = isNum(toActors) ? row.rate : null
      const computed = isNum(fromActors) && fromActors > 0 && isNum(row.lost) && isNum(toActors) ? row.lost / fromActors : null
      return {
        ...row,
        key: `${row.from}→${row.to}`,
        fromActors,
        toActors,
        fromLabel: stageLabel(funnel, row.from),
        toLabel: stageLabel(funnel, row.to),
        rateValue: isNum(provided) ? provided : computed,
      }
    })
    .filter(row => isNum(row.lost))
    .sort((a, b) => b.lost - a.lost)
}

async function requestFunnel(days, { force = false, signal } = {}) {
  const headers = { 'x-media-desk-lanjing-lang': lang() }
  const res = force
    ? await fetch(`${BASE}buy-points/refresh`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ days }), signal })
    : await fetch(`${BASE}buy-points/funnel?days=${days}`, { headers, signal })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || t('请求失败（{status}）', { status: res.status }))
  return data
}

/** 数据新鲜度：只读契约里的 freshness，不给缺失字段编时间。 */
function freshnessOf(freshness) {
  if (!freshness || typeof freshness !== 'object') return { tone: 'missing', text: t('新鲜度未获取') }
  const lastEventAt = typeof freshness.lastEventAt === 'string' && freshness.lastEventAt ? freshness.lastEventAt : null
  const ageMinutes = isNum(freshness.ageMinutes) ? freshness.ageMinutes : null
  if (freshness.stale === true) {
    if (!lastEventAt) return { tone: 'stale', text: t('⚠ 窗口内没有事件') }
    if (ageMinutes !== null) return { tone: 'stale', text: t('⚠ 数据已 {hours} 小时未更新', { hours: hoursText(ageMinutes) }) }
    return { tone: 'stale', text: t('⚠ 数据已过期') }
  }
  if (ageMinutes !== null) return { tone: 'fresh', text: t('数据新鲜 · {n} 分钟前', { n: ageMinutes }) }
  if (lastEventAt) return { tone: 'fresh', text: t('数据新鲜') }
  return { tone: 'missing', text: t('新鲜度未获取') }
}

function FreshnessPill({ freshness }) {
  const state = freshnessOf(freshness)
  const at = typeof freshness?.lastEventAt === 'string' && freshness.lastEventAt ? freshness.lastEventAt : null
  return (
    <span className={`bp-freshness is-${state.tone}`} title={at ? t('最后一条事件：{time}', { time: timeText(at) }) : t('新鲜度字段没有返回')}>
      {state.text}
    </span>
  )
}

function Banner({ tone, title, children, action }) {
  return (
    <div className={`bp-banner is-${tone}`} role={tone === 'mock' || tone === 'bad' ? 'alert' : 'status'}>
      {title ? <strong>{title}</strong> : null}
      <span className="bp-banner-text">{children}</span>
      {action}
    </div>
  )
}

function Kpi({ label, value, unit, note, tone, percent }) {
  const text = isNum(value) ? (percent ? (value * 100).toFixed(1) : fmt(value)) : null
  return (
    <div className={`bp-kpi ${tone ? `is-${tone}` : ''}`}>
      <span className="bp-kpi-label">{label}</span>
      <b className="bp-kpi-value">{text === null ? <Missing /> : <>{text}{unit ? <small>{unit}</small> : null}</>}</b>
      {note ? <span className="bp-kpi-note">{note}</span> : null}
    </div>
  )
}

/** 一句话描述最大卡点：会话从哪一级走到哪一级、掉了多少。 */
function lossSentence(row) {
  if (!row) return ''
  return t('{from} 个会话到了「{fromLabel}」，只有 {to} 个走到「{toLabel}」', {
    from: isNum(row.fromActors) ? fmt(row.fromActors) : t('未获取'),
    fromLabel: row.fromLabel,
    to: isNum(row.toActors) ? fmt(row.toActors) : t('未获取'),
    toLabel: row.toLabel,
  })
}

/** 一条漏斗：横向条宽度按首级占比；最大卡点那一级用强调连线 + 一句话标出，不整行变红。
    有 previous 时多一列「环比」（按 stage.key 对齐），缺 previous 时整列隐藏。 */
function FunnelRows({ funnel, focus, previous }) {
  if (!funnel || !Array.isArray(funnel.stages)) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('这一条漏斗取数失败：脚本把 stages 置为 null 或没有返回，不填 0 占位。')}</span>
      </div>
    )
  }
  const first = funnel.stages[0]?.actors
  const focusKey = focus?.key || null
  const previousStages = Array.isArray(previous?.stages) ? previous.stages : []
  const compare = previousStages.length > 0
  const previousByKey = new Map(previousStages.map(stage => [stage.key, stage]))
  return (
    <div className={`bp-funnel${compare ? ' is-compare' : ''}`}>
      <div className="bp-funnel-head">
        <span>{t('环节')}</span>
        <span>{t('会话占比')}</span>
        <span className="bp-right">{t('会话')}</span>
        <span className="bp-right">{t('较上一级')}</span>
        {compare ? <span className="bp-right" title={t('与上一个同长度窗口相比，按阶段 key 对齐')}>{t('环比')}</span> : null}
        <span className="bp-right">{t('流失')}</span>
      </div>
      {funnel.stages.map((stage, index) => {
        const actors = stage.actors
        const pending = stage.pending === true
        const detached = stage.detached === true
        const baseline = index === 0 ? null : orderedBaseline(funnel, index)
        const baselineActors = baseline?.stage?.actors
        const fromPrev = index === 0
          ? null
          : isNum(stage.fromPrev) ? stage.fromPrev : isNum(actors) && isNum(baselineActors) && baselineActors > 0 ? actors / baselineActors : null
        const lost = index === 0 || detached || !isNum(actors) || !isNum(baselineActors) ? null : Math.max(0, baselineActors - actors)
        const ofFirst = isNum(stage.ofFirst) ? stage.ofFirst : isNum(first) && first > 0 && isNum(actors) ? actors / first : null
        const width = isNum(ofFirst) && ofFirst > 0 ? Math.max(actors > 0 ? 1.2 : 0, Math.min(100, ofFirst * 100)) : 0
        const key = baseline ? `${baseline.stage.key}→${stage.key}` : ''
        const isFocus = index > 0 && key === focusKey
        const previousStage = compare ? previousByKey.get(stage.key) || null : null
        const previousActors = previousStage?.actors
        const deltaRate = compare
          ? isNum(previousStage?.deltaRate)
            ? previousStage.deltaRate
            : isNum(previousActors) && previousActors > 0 && isNum(actors) ? (actors - previousActors) / previousActors : null
          : null
        const classes = ['bp-funnel-row']
        if (pending) classes.push('is-pending')
        if (detached) classes.push('is-detached')
        if (isFocus) classes.push('is-focus')
        if (!isNum(actors)) classes.push('is-missing')
        return (
          <React.Fragment key={stage.key}>
            <div className={classes.join(' ')}>
              <span className="bp-funnel-name">
                <b>{stage.label}</b>
                {pending ? <em className="bp-chip is-pending">{t('未上线')}</em> : null}
                {detached ? <em className="bp-chip is-detached">{t('分解级')}</em> : null}
                {isFocus ? <em className="bp-chip is-focus">{t('卡点')}</em> : null}
              </span>
              <span className="bp-funnel-track" aria-hidden="true" title={isNum(ofFirst) ? t('占首级 {value}', { value: pct(ofFirst) }) : t('占比未获取')}>
                <i style={{ width: `${width.toFixed(2)}%` }} />
              </span>
              <b className="bp-funnel-actors" title={isNum(stage.unordered) ? t('不要求顺序的会话 {n}（诊断用）', { n: fmt(stage.unordered) }) : undefined}>
                {isNum(actors) ? fmt(actors) : <Missing />}
              </b>
              <span className="bp-funnel-conv" title={baseline ? t('较上一个有序级：{label}', { label: baseline.stage.label }) : undefined}>
                {index === 0
                  ? <span className="bp-first">{t('首级')}</span>
                  : detached
                    ? <span title={t('分解级只作观测，不参与有序判定')}>—</span>
                    : !isNum(actors) || !isNum(baselineActors)
                      ? <Missing />
                      : baselineActors === 0
                        ? <span title={t('上一个有序级为 0 个会话，比率无定义')}>—</span>
                        : pct(fromPrev, isNum(fromPrev) && fromPrev < 0.01 ? 2 : 1)}
              </span>
              {compare ? (
                <span
                  className={`bp-funnel-delta${isNum(deltaRate) && deltaRate > 0 ? ' is-up' : isNum(deltaRate) && deltaRate < 0 ? ' is-down' : ''}`}
                  title={t('上期 {from} → 本期 {to}', {
                    from: isNum(previousActors) ? fmt(previousActors) : t('未获取'),
                    to: isNum(actors) ? fmt(actors) : t('未获取'),
                  })}
                >
                  {isNum(deltaRate)
                    ? `${deltaRate > 0 ? '+' : deltaRate < 0 ? '−' : ''}${(Math.abs(deltaRate) * 100).toFixed(1)}%`
                    : <span className="bp-first">—</span>}
                </span>
              ) : null}
              <span className="bp-funnel-loss" title={baseline ? t('较上一个有序级：{label}', { label: baseline.stage.label }) : undefined}>
                {index === 0 || detached ? '—' : isNum(lost) ? (lost > 0 ? <em className="bp-loss-tag">−{fmt(lost)}</em> : <span className="bp-first">0</span>) : <Missing />}
              </span>
            </div>
            {isFocus ? (
              <p className="bp-funnel-callout">
                <span className="bp-funnel-callout-arrow" aria-hidden="true">↳</span>
                <span>{lossSentence(focus)}</span>
                <span className="bp-funnel-callout-meta">
                  {t('流失 {n} 个会话', { n: fmt(focus.lost) })}{isNum(focus.rateValue) ? t('（{pct}）', { pct: pct(focus.rateValue) }) : ''}
                </span>
              </p>
            ) : null}
          </React.Fragment>
        )
      })}
    </div>
  )
}

/** 卡点排行：dropoff 里流失会话数最大的三级，直接说结论。 */
function Blockers({ rows, funnel }) {
  if (!rows.length) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('逐级流失（dropoff）未获取或没有可用行，没有填 0。')}</span>
      </div>
    )
  }
  const top = rows[0]
  const max = top.lost || 1
  return (
    <>
      <p className="bp-blockers-summary">
        {t('最大的卡点是「{from} → {to}」：{fromActors} 个会话里只有 {toActors} 个继续，流失 {lost} 个（{pct}）。', {
          from: top.fromLabel,
          to: top.toLabel,
          fromActors: isNum(top.fromActors) ? fmt(top.fromActors) : t('未获取'),
          toActors: isNum(top.toActors) ? fmt(top.toActors) : t('未获取'),
          lost: fmt(top.lost),
          pct: isNum(top.rateValue) ? pct(top.rateValue) : t('流失率未获取'),
        })}
      </p>
      <ol className="bp-blockers">
        {rows.slice(0, 3).map((row, index) => (
          <li key={row.key} className={index === 0 ? 'is-top' : ''}>
            <span className="bp-blockers-rank" aria-hidden="true">{index + 1}</span>
            <div className="bp-blockers-main">
              <div className="bp-blockers-line">
                <b>{row.fromLabel} → {row.toLabel}</b>
                <span>{t('流失')} <em className="bp-loss-tag">−{fmt(row.lost)}</em> {t('个会话')}</span>
                <span className="bp-blockers-pct">{isNum(row.rateValue) ? pct(row.rateValue) : <Missing />}</span>
              </div>
              <span className="bp-blockers-track" aria-hidden="true"><i style={{ width: `${Math.max(3, Math.round((row.lost / max) * 100))}%` }} /></span>
            </div>
          </li>
        ))}
      </ol>
      <p className="bp-tile-foot">
        {t('口径：{scope}', { scope: funnel?.label || t('主漏斗') })}
        {t(' · 只统计相邻有序级之间的流失，detached 的分解级不参与。')}
      </p>
    </>
  )
}

/** 按日趋势：首级放大成主趋势 + 当日会话数，其余每一级一个小多图（sparkline）。缺口日斜纹、不补 0、不连线。 */
function TrendPanel({ data, funnel }) {
  const rows = Array.isArray(data?.trend) ? data.trend : []
  const fallback = rows.map(row => row.date)
  const dates = (() => {
    const from = data?.range?.from
    const to = data?.range?.to
    if (!from || !to) return fallback
    const start = new Date(`${from}T00:00:00`)
    const end = new Date(`${to}T00:00:00`)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return fallback
    const out = []
    for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
      out.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`)
      if (out.length > 400) break
    }
    return out.length ? out : fallback
  })()
  if (!rows.length || !dates.length) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('按日趋势取数失败（unavailable: trend），没有用 0 补位。')}</span>
      </div>
    )
  }
  const byDate = new Map(rows.map(row => [row.date, row]))
  const key = funnel?.key || 'primary'
  const sessions = dates.map((date) => {
    const value = byDate.get(date)?.sessions
    return isNum(value) && value >= 0 ? value : null
  })
  const sessionsKnown = sessions.some(value => value !== null)
  const series = (funnel?.stages || []).map((stage, index) => {
    const values = dates.map((date) => {
      const daySeries = byDate.get(date)?.[key]
      if (!Array.isArray(daySeries)) return null
      const value = daySeries[index]
      return isNum(value) && value >= 0 ? value : null
    })
    const known = values.filter(value => value !== null)
    if (!known.length) return null
    const peak = Math.max(...known)
    const average = known.reduce((sum, value) => sum + value, 0) / known.length
    return { stage, values, known, peak, average, last: known.at(-1), gaps: values.length - known.length }
  }).filter(Boolean)
  if (!series.length) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('返回的按日趋势里没有任何一级有数字。')}</span>
      </div>
    )
  }
  const main = series[0]
  const smalls = series.slice(1)
  return (
    <>
      <div className="bp-spark-main">
        <div className="bp-spark-head">
          <b>{main.stage.label}</b>
          <span className="bp-spark-meta">
            {t('峰值 {peak} · 日均 {avg}', { peak: fmt(main.peak), avg: fmt(Math.round(main.average)) })}
            {main.gaps ? t(' · {n} 天缺口', { n: main.gaps }) : ''}
          </span>
        </div>
        <div className="bp-spark-bars is-main">
          {main.values.map((value, i) => (value === null
            ? <i className="is-gap" key={dates[i]} title={t('{date} · 无数据（不补 0）', { date: dates[i] })} />
            : <i key={dates[i]} style={{ height: `${Math.max(3, Math.round((value / Math.max(main.peak, 1)) * 100))}%` }} title={t('{date}：{value} 个会话', { date: dates[i], value: fmt(value) })} />))}
        </div>
        {sessionsKnown ? (
          <div className="bp-spark-sessions">
            <span className="bp-spark-sessions-label">{t('当日会话数')}</span>
            <div className="bp-spark-bars is-sessions">
              {sessions.map((value, i) => (value === null
                ? <i className="is-gap" key={dates[i]} title={t('{date} · 无数据（不补 0）', { date: dates[i] })} />
                : <i key={dates[i]} style={{ height: `${Math.max(3, Math.round((value / Math.max(...sessions.filter(v => v !== null), 1)) * 100))}%` }} title={t('{date}：{value} 个会话', { date: dates[i], value: fmt(value) })} />))}
            </div>
          </div>
        ) : null}
        <div className="bp-spark-axis" aria-hidden="true">
          <span>{dates[0].slice(5)}</span>
          <span>{dates[Math.floor((dates.length - 1) / 2)].slice(5)}</span>
          <span>{dates[dates.length - 1].slice(5)}</span>
        </div>
      </div>
      {smalls.length ? (
        <div className="bp-spark-grid">
          {smalls.map(({ stage, values, peak, last, gaps }) => (
            <div className="bp-spark-card" key={stage.key}>
              <div className="bp-spark-head">
                <b>
                  {stage.label}
                  {stage.pending ? <em className="bp-chip is-pending">{t('未上线')}</em> : null}
                </b>
              </div>
              <div className="bp-spark-bars">
                {values.map((value, i) => (value === null
                  ? <i className="is-gap" key={dates[i]} title={t('{date} · 无数据（不补 0）', { date: dates[i] })} />
                  : <i key={dates[i]} style={{ height: `${Math.max(3, Math.round((value / Math.max(peak, 1)) * 100))}%` }} title={t('{date}：{value} 个会话', { date: dates[i], value: fmt(value) })} />))}
              </div>
              <span className="bp-spark-meta">
                {t('峰值 {peak} · 末值 {last}', { peak: fmt(peak), last: fmt(last) })}
                {gaps ? t(' · {n} 天缺口', { n: gaps }) : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}

/** 预算档位并排漏斗：800 万及以上 vs 800 万以下，各画一条迷你漏斗；unknown 不进任何一边。 */
function BudgetCompare({ data, primary }) {
  const group = (Array.isArray(data?.breakdown) ? data.breakdown : []).find(item => item.dimension === 'budgetBand')
  const rows = Array.isArray(group?.rows) ? group.rows.filter(row => row && typeof row === 'object') : null
  const stages = Array.isArray(primary?.stages) ? primary.stages : []
  if (!rows) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('预算档位拆解未获取（unavailable: breakdown.budgetBand），没有拿 0 顶替。')}</span>
      </div>
    )
  }
  const informative = rows.filter(row => !BUDGET_UNKNOWN_VALUES.includes(String(row.value)))
  if (!informative.length) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('预算档位尚未采集（埋点已上线但还没有用户选择）。不能显示成 0 转化。')}</span>
      </div>
    )
  }
  const entryIndex = stages.findIndex(stage => stage.key === 'entry_clicked' || stage.key === 'entry')
  const attemptIndex = stages.findIndex(stage => stage.key === 'attempt' || stage.key === 'submit')
  const buildGroup = (definition) => {
    const groupRows = rows.filter(row => definition.values.includes(String(row.value)))
    const sessions = groupRows.some(row => isNum(row.sessions)) ? groupRows.reduce((sum, row) => sum + (isNum(row.sessions) ? row.sessions : 0), 0) : null
    const values = stages.map((stage, index) => sumStages(groupRows, index, stages.length))
    const first = values[0]
    return { ...definition, rows: groupRows, sessions, values, first, entry: entryIndex >= 0 ? values[entryIndex] : null, attempt: attemptIndex >= 0 ? values[attemptIndex] : null }
  }
  const groups = BUDGET_GROUPS.map(buildGroup)
  return (
    <>
      <div className="bp-budget">
        {groups.map(groupData => {
          const hasStages = Array.isArray(stages) && stages.length > 0 && isNum(groupData.first) && groupData.first > 0
          return (
            <div className="bp-budget-col" key={groupData.key}>
              <div className="bp-budget-head">
                <b>{groupData.label}</b>
                <span>{isNum(groupData.sessions) ? t('{n} 个会话', { n: fmt(groupData.sessions) }) : <Missing />}</span>
              </div>
              {hasStages ? (
                <div className="bp-budget-rows">
                  {stages.map((stage, index) => {
                    const value = groupData.values[index]
                    const ofFirst = isNum(value) && groupData.first > 0 ? value / groupData.first : null
                    const width = isNum(ofFirst) && ofFirst > 0 ? Math.max(value > 0 ? 1.5 : 0, Math.min(100, ofFirst * 100)) : 0
                    const isEntry = index === entryIndex
                    const isAttempt = index === attemptIndex
                    return (
                      <div className={`bp-budget-row${isEntry ? ' is-entry' : ''}`} key={stage.key || index}>
                        <span className="bp-budget-label">{stage.label}</span>
                        <span className="bp-budget-track" aria-hidden="true"><i style={{ width: `${width.toFixed(1)}%` }} /></span>
                        <b className="bp-budget-value">{isNum(value) ? fmt(value) : <Missing />}</b>
                        <span className="bp-budget-pct">{isNum(ofFirst) ? pct(ofFirst, 1) : isNum(value) ? '0.0%' : '—'}</span>
                        {isAttempt ? <em className="bp-chip is-detached">{t('留资')}</em> : isEntry ? <em className="bp-chip is-focus">{t('进入服务')}</em> : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="bp-unavailable"><Missing /><span>{t('该档位本期没有可归因会话（未采集，不是 0 转化）。')}</span></div>
              )}
              <p className="bp-budget-foot">
                {t('占首级 {first}', { first: isNum(groupData.first) ? fmt(groupData.first) : t('未获取') })}
                {isNum(groupData.entry) && isNum(groupData.first) && groupData.first > 0 ? t(' · 进入服务 {n}（{pct}）', { n: fmt(groupData.entry), pct: pct(groupData.entry / groupData.first, 2) }) : t(' · 进入服务 未获取')}
                {isNum(groupData.attempt) ? t(' · 留资 {n}', { n: fmt(groupData.attempt) }) : t(' · 留资 未获取')}
              </p>
            </div>
          )
        })}
      </div>
      <p className="bp-tile-foot">
        {t('合并口径：800 万及以上 = 800_1200 + 1200_2000 + above_2000；800 万以下 = under_500 + 500_800。没有选择预算的会话（unknown）不并入任何一边。')}
      </p>
    </>
  )
}

/** 桑基带：从 (x1,y1) 到 (x2,y2) 的上下两条三次曲线围成的填充区域。 */
function ribbonPath(x1, y1, x2, y2, height) {
  const curve = (x2 - x1) * 0.5
  return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2} L ${x2} ${y2 + height} C ${x2 - curve} ${y2 + height}, ${x1 + curve} ${y1 + height}, ${x1} ${y1 + height} Z`
}

/** 入口路径（三列桑基）：来源 → 页面 → 进入服务 / 未进入；取会话数最大的 6 条，其余合并「其他」。 */
function SankeyCard({ data }) {
  const [hovered, setHovered] = React.useState(null)
  const raw = Array.isArray(data?.flow) ? data.flow : null
  const pairs = new Map()
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!row || typeof row !== 'object' || !row.source || !row.pageKey) continue
    if (!isNum(row.sessions) || row.sessions <= 0) continue
    const source = String(row.source)
    const pageKey = String(row.pageKey)
    const entered = isNum(row.entered) ? Math.max(0, Math.min(row.entered, row.sessions)) : 0
    const key = `${source}\u0000${pageKey}`
    const hit = pairs.get(key)
    if (hit) {
      hit.sessions += row.sessions
      hit.entered += entered
    } else {
      pairs.set(key, { source, pageKey, sessions: row.sessions, entered })
    }
  }
  const all = [...pairs.values()]
  if (!all.length) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{raw === null ? t('入口路径未获取（unavailable: flow），没有拿 0 占位。') : t('需要 source 与 pageKey 都有值的事件，窗口内还没有这样的路径。')}</span>
      </div>
    )
  }
  const sorted = [...all].sort((a, b) => b.sessions - a.sessions)
  const head = sorted.slice(0, FLOW_TOP_PATHS)
  const rest = sorted.slice(FLOW_TOP_PATHS)
  if (rest.length) {
    head.push({
      source: t('其他'),
      pageKey: t('其他'),
      sessions: rest.reduce((sum, row) => sum + row.sessions, 0),
      entered: rest.reduce((sum, row) => sum + row.entered, 0),
      aggregated: rest.length,
    })
  }
  const total = head.reduce((sum, row) => sum + row.sessions, 0)
  const enteredTotal = head.reduce((sum, row) => sum + row.entered, 0)
  const enteredRate = total > 0 ? enteredTotal / total : null
  const groupBy = (key, label) => {
    const nodes = new Map()
    for (const row of head) {
      const name = row[key]
      const node = nodes.get(name) || { name, sessions: 0, entered: 0 }
      node.sessions += row.sessions
      node.entered += row.entered
      nodes.set(name, node)
    }
    return [...nodes.values()].sort((a, b) => b.sessions - a.sessions)
  }
  const sourceNodes = groupBy('source')
  const pageNodes = groupBy('pageKey')
  const outcomeNodes = [
    { key: 'entered', label: t('进入服务'), sessions: enteredTotal, good: true },
    { key: 'left', label: t('未进入'), sessions: total - enteredTotal },
  ]
  const HEIGHT = Math.max(250, Math.min(400, 84 + head.length * 36))
  const PAD_TOP = 26
  const PAD_BOTTOM = 12
  const GAP = 10
  const columns = [sourceNodes, pageNodes, outcomeNodes]
  const scale = Math.min(...columns.map(nodes => {
    const available = HEIGHT - PAD_TOP - PAD_BOTTOM - Math.max(0, nodes.length - 1) * GAP
    return available / total
  }))
  const applyLayout = (nodes) => {
    const used = nodes.reduce((sum, node) => sum + node.sessions * scale, 0) + Math.max(0, nodes.length - 1) * GAP
    let y = PAD_TOP + Math.max(0, (HEIGHT - PAD_TOP - PAD_BOTTOM - used) / 2)
    for (const node of nodes) {
      node.y = y
      node.height = Math.max(3, node.sessions * scale)
      y += node.height + GAP
    }
    return nodes
  }
  applyLayout(sourceNodes)
  applyLayout(pageNodes)
  applyLayout(outcomeNodes)
  const WIDTH = 780
  const SRC_X = 88
  const NODE_W = 8
  const PAGE_X = 350
  const OUT_X = 650
  const sourceIndex = new Map(sourceNodes.map(node => [node.name, node]))
  const pageIndex = new Map(pageNodes.map(node => [node.name, node]))
  const sourceCursor = new Map(sourceNodes.map(node => [node.name, node.y]))
  const pageInCursor = new Map(pageNodes.map(node => [node.name, node.y]))
  const pageOutCursor = new Map(pageNodes.map(node => [node.name, node.y]))
  const enteredNode = outcomeNodes[0]
  const leftNode = outcomeNodes[1]
  const enteredCursor = { y: enteredNode.y }
  const leftCursor = { y: leftNode.y }
  const ribbons = []
  for (const row of head) {
    const source = sourceIndex.get(row.source)
    const page = pageIndex.get(row.pageKey)
    const height = row.sessions * scale
    ribbons.push({
      id: `${row.source}\u0000${row.pageKey}`,
      row,
      d: ribbonPath(SRC_X + NODE_W, sourceCursor.get(row.source), PAGE_X, pageInCursor.get(row.pageKey), height),
      rate: row.sessions > 0 ? row.entered / row.sessions : null,
    })
    sourceCursor.set(row.source, sourceCursor.get(row.source) + height)
    pageInCursor.set(row.pageKey, pageInCursor.get(row.pageKey) + height)
  }
  for (const page of pageNodes) {
    const entered = page.entered
    const left = page.sessions - entered
    if (entered > 0) {
      const height = entered * scale
      ribbons.push({ id: `out|${page.name}|entered`, out: true, d: ribbonPath(PAGE_X + NODE_W, pageOutCursor.get(page.name), OUT_X, enteredCursor.y, height) })
      pageOutCursor.set(page.name, pageOutCursor.get(page.name) + height)
      enteredCursor.y += height
    }
    if (left > 0) {
      const height = left * scale
      ribbons.push({ id: `out|${page.name}|left`, out: true, left: true, d: ribbonPath(PAGE_X + NODE_W, pageOutCursor.get(page.name), OUT_X, leftCursor.y, height) })
      pageOutCursor.set(page.name, pageOutCursor.get(page.name) + height)
      leftCursor.y += height
    }
  }
  const hoveredRow = hovered ? head.find(row => `${row.source}\u0000${row.pageKey}` === hovered) : null
  const textWidth = (text) => Math.min(126, Math.max(28, String(text).length * 6.1 + 10))
  const truncate = (text, max = 13) => (String(text).length > max ? `${String(text).slice(0, max - 1)}…` : String(text))
  const nodeLabel = (node, column) => {
    if (column === 'source') return node.sessions > 0 ? t('{name} · {n}', { name: truncate(node.name, 10), n: fmt(node.sessions) }) : node.name
    return t('{name} · {n}', { name: truncate(prettyPageKey(node.name), 11), n: fmt(node.sessions) })
  }
  const outcomeLabel = (node) => t('{name} · {n}', { name: node.label, n: fmt(node.sessions) })
  const pageLabelWidth = Math.max(28, ...pageNodes.map(node => textWidth(nodeLabel(node, 'page'))))
  const caption = hoveredRow
    ? t('{source} → {page}：{n} 个会话，进入 {entered}（{rate}）', {
      source: hoveredRow.source,
      page: prettyPageKey(hoveredRow.pageKey),
      n: fmt(hoveredRow.sessions),
      entered: fmt(hoveredRow.entered),
      rate: isNum(hoveredRow.rate ?? (hoveredRow.sessions > 0 ? hoveredRow.entered / hoveredRow.sessions : null)) ? pct(hoveredRow.entered / hoveredRow.sessions) : t('未获取'),
    })
    : t('显示会话数最大的 {top} 条路径（共 {all} 条），其余 {rest} 条合并为「其他」。整体进入服务 {entered} / {total}{rate}。', {
      top: Math.min(FLOW_TOP_PATHS, all.length),
      all: all.length,
      rest: rest.length,
      entered: fmt(enteredTotal),
      total: fmt(total),
      rate: isNum(enteredRate) ? t('（{pct}）', { pct: pct(enteredRate) }) : '',
    })
  return (
    <>
      <div className="bp-sankey">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t('入口路径桑基图：来源到页面到进入服务')}>
          <text className="bp-sankey-col" x={SRC_X - 4} y={13} textAnchor="end">{t('来源')}</text>
          <text className="bp-sankey-col" x={PAGE_X} y={13}>{t('页面')}</text>
          <text className="bp-sankey-col" x={OUT_X} y={13}>{t('结果')}</text>
          {ribbons.map(ribbon => (
            <path
              key={ribbon.id}
              className={`bp-sankey-link${ribbon.out ? ' is-out' : ''}${ribbon.left ? ' is-left' : ''}${hovered === ribbon.id ? ' is-hover' : ''}${hovered && hovered !== ribbon.id && !ribbon.out ? ' is-dim' : ''}`}
              d={ribbon.d}
              onMouseEnter={ribbon.out ? undefined : () => setHovered(ribbon.id)}
              onMouseLeave={ribbon.out ? undefined : () => setHovered(null)}
            >
              {ribbon.row ? <title>{t('{source} → {page}：{n} 个会话，进入 {entered}（{rate}）', {
                source: ribbon.row.source,
                page: prettyPageKey(ribbon.row.pageKey),
                n: fmt(ribbon.row.sessions),
                entered: fmt(ribbon.row.entered),
                rate: ribbon.row.sessions > 0 ? pct(ribbon.row.entered / ribbon.row.sessions) : t('未获取'),
              })}</title> : null}
            </path>
          ))}
          {sourceNodes.map(node => (
            <g key={`src-${node.name}`}>
              <rect className="bp-sankey-node" x={SRC_X} y={node.y} width={NODE_W} height={node.height} rx={3} />
              <text className="bp-sankey-label" x={SRC_X - 6} y={node.y + node.height / 2 + 3.5} textAnchor="end">
                {nodeLabel(node, 'source')}
              </text>
              <title>{t('{name}：{n} 个会话', { name: node.name, n: fmt(node.sessions) })}</title>
            </g>
          ))}
          {pageNodes.map(node => (
            <g key={`page-${node.name}`}>
              <rect className="bp-sankey-node is-page" x={PAGE_X} y={node.y} width={NODE_W} height={node.height} rx={3} />
              <rect className="bp-sankey-pill" x={PAGE_X + NODE_W + 5} y={node.y + node.height / 2 - 8} width={pageLabelWidth} height={16} rx={8} />
              <text className="bp-sankey-label is-page" x={PAGE_X + NODE_W + 10} y={node.y + node.height / 2 + 3.5}>
                {nodeLabel(node, 'page')}
              </text>
              <title>{t('{name}：{n} 个会话，进入 {entered}', { name: prettyPageKey(node.name), n: fmt(node.sessions), entered: fmt(node.entered) })}</title>
            </g>
          ))}
          {outcomeNodes.map(node => (
            <g key={`out-${node.key}`}>
              <rect className={`bp-sankey-node${node.good ? ' is-good' : ' is-left'}`} x={OUT_X} y={node.y} width={NODE_W} height={node.height} rx={3} />
              <text className="bp-sankey-label" x={OUT_X + NODE_W + 8} y={node.y + node.height / 2 + 3.5}>
                {outcomeLabel(node)}
              </text>
              <title>{t('{name}：{n} 个会话', { name: node.label, n: fmt(node.sessions) })}</title>
            </g>
          ))}
        </svg>
      </div>
      <p className="bp-sankey-caption" aria-live="polite">{caption}</p>
      <p className="bp-tile-foot">
        {t('带宽按会话数比例；进入/未进入按页面汇总，单条路径的转化率看悬停提示。pageKey 已去掉 pages/ 前缀与 /index 后缀。')}
      </p>
    </>
  )
}

/** 事件级每日趋势：多折线（最多 8 条），图例可点选隐藏；缺数据日断线，不补 0。 */
const EVENT_OTHER_KEY = '\u0000other'
const EVENT_LINE_COUNT = 8

function EventTrendCard({ data }) {
  const [hidden, setHidden] = React.useState(() => new Set())
  const raw = Array.isArray(data?.eventTrend)
    ? data.eventTrend.filter(row => row && typeof row === 'object' && typeof row.date === 'string' && row.counts && typeof row.counts === 'object')
    : null
  if (!raw || !raw.length) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{raw === null ? t('事件级每日趋势未获取（unavailable: eventTrend），没有补 0。') : t('窗口内没有事件级逐日计数。')}</span>
      </div>
    )
  }
  const byDate = new Map(raw.map(row => [String(row.date), row.counts]))
  const dates = [...byDate.keys()].sort()
  const totals = new Map()
  for (const counts of byDate.values()) {
    for (const [name, value] of Object.entries(counts)) {
      if (!isNum(value) || value < 0) continue
      totals.set(name, (totals.get(name) || 0) + value)
    }
  }
  const names = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  const restNames = names.length > EVENT_SERIES_MAX ? names.slice(EVENT_SERIES_MAX - 1) : []
  const seriesNames = names.length > EVENT_SERIES_MAX ? [...names.slice(0, EVENT_SERIES_MAX - 1), EVENT_OTHER_KEY] : names
  const valueOf = (counts, name) => {
    if (name === EVENT_OTHER_KEY) {
      let sum = null
      for (const restName of restNames) {
        if (!Object.prototype.hasOwnProperty.call(counts, restName)) continue
        const value = counts[restName]
        if (!isNum(value) || value < 0) continue
        sum = (sum ?? 0) + value
      }
      return sum
    }
    if (!Object.prototype.hasOwnProperty.call(counts, name)) return null
    const value = counts[name]
    return isNum(value) && value >= 0 ? value : null
  }
  const series = seriesNames.map(name => ({
    name,
    label: name === EVENT_OTHER_KEY ? t('其他 {n} 个事件', { n: restNames.length }) : name,
    values: dates.map(date => valueOf(byDate.get(date), name)),
  }))
  const visible = series.filter(item => !hidden.has(item.name))
  const scaleMax = Math.max(1, ...visible.flatMap(item => item.values.filter(value => value !== null)))
  const WIDTH = 760
  const HEIGHT = 168
  const X0 = 8
  const X1 = 752
  const Y0 = 12
  const Y1 = 146
  const xAt = index => (dates.length > 1 ? X0 + (index / (dates.length - 1)) * (X1 - X0) : (X0 + X1) / 2)
  const yAt = value => Y1 - (value / scaleMax) * (Y1 - Y0)
  const segmentsOf = (values) => {
    const segments = []
    let current = []
    values.forEach((value, index) => {
      if (value === null) {
        if (current.length) segments.push(current)
        current = []
        return
      }
      current.push([xAt(index), yAt(value)])
    })
    if (current.length) segments.push(current)
    return segments
  }
  const toggle = (name) => {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  return (
    <>
      <div className="bp-evts">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t('事件级每日趋势折线图')}>
          <line className="bp-evts-baseline" x1={X0} y1={Y1} x2={X1} y2={Y1} />
          <text className="bp-evts-max" x={X0} y={Y0 - 2}>{t('峰值 {n}', { n: fmt(scaleMax) })}</text>
          {visible.map(item => {
            const colorIndex = (series.findIndex(row => row.name === item.name) % EVENT_LINE_COUNT) + 1
            return segmentsOf(item.values).map((segment, segmentIndex) => (segment.length === 1
              ? <circle key={`${item.name}-${segmentIndex}`} className={`bp-evts-line c${colorIndex}`} cx={segment[0][0]} cy={segment[0][1]} r={1.8} />
              : <polyline key={`${item.name}-${segmentIndex}`} className={`bp-evts-line c${colorIndex}`} points={segment.map(point => point.join(',')).join(' ')} />))
          })}
        </svg>
        <div className="bp-evts-axis" aria-hidden="true">
          <span>{dates[0].slice(5)}</span>
          <span>{dates[Math.floor((dates.length - 1) / 2)].slice(5)}</span>
          <span>{dates[dates.length - 1].slice(5)}</span>
        </div>
        <div className="bp-evts-legend">
          {series.map(item => {
            const colorIndex = (series.findIndex(row => row.name === item.name) % EVENT_LINE_COUNT) + 1
            const off = hidden.has(item.name)
            return (
              <button
                type="button"
                key={item.name}
                className={`bp-evts-key${off ? ' is-off' : ''}`}
                aria-pressed={!off}
                onClick={() => toggle(item.name)}
              >
                <i className={`c${colorIndex}`} aria-hidden="true" />
                {item.label}
              </button>
            )
          })}
        </div>
      </div>
      <p className="bp-evts-caption">
        {t('共 {n} 个事件，最多画 8 条（含「其他」）。某天某事件突然归零会画到 0 轴；事件没上报则是断线（缺数据），不补 0。点图例可隐藏。', { n: names.length })}
      </p>
    </>
  )
}

/** 拆解表：可排序、带合计；分母为 0 时转化率写「—」，不写 0.00%。 */
function Breakdown({ data, dimension, onDimension }) {
  const [sortKey, setSortKey] = React.useState(null)
  const [sortDir, setSortDir] = React.useState('desc')
  const groups = new Map((Array.isArray(data?.breakdown) ? data.breakdown : []).map(group => [group.dimension, group]))
  // 拆解表的转化口径跟着主漏斗走：默认看「进入服务」这一级，因为它才是真正卡住人的地方；
  // 主漏斗里没有这一级时退回末级，不硬编码下标。
  const primaryStages = (Array.isArray(data?.funnels) ? data.funnels : []).find(funnel => funnel.key === 'primary')?.stages
  const stageMeta = Array.isArray(primaryStages) ? primaryStages : []
  const targetIndex = (() => {
    const found = stageMeta.findIndex(stage => stage.key === 'entry_clicked')
    return found >= 0 ? found : stageMeta.length - 1
  })()
  const targetLabel = stageMeta[targetIndex]?.label || t('进入服务')
  const dimensionLabel = t((DIMENSIONS.find(([value]) => value === dimension) || [dimension, dimension])[1])
  const groupMissing = !groups.get(dimension)
  const rows = Array.isArray(groups.get(dimension)?.rows) ? groups.get(dimension).rows : null

  const decorate = (row) => {
    const stages = Array.isArray(row.stages) ? row.stages : []
    const first = stages.length ? stages[0] : null
    const reached = targetIndex >= 0 ? stages[targetIndex] : null
    const conversion = isNum(first) && first > 0 && isNum(reached) ? reached / first : null
    return { ...row, first, reached, conversion }
  }

  const toggleSort = (nextKey) => {
    if (sortKey === nextKey) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc')
      return
    }
    setSortKey(nextKey)
    setSortDir('desc')
  }

  if (!groups.size) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('拆解表取数失败（unavailable: breakdown），没有填 0。')}</span>
      </div>
    )
  }
  const decorated = rows === null ? null : rows.map(decorate)
  const projectEmpty = dimension === 'project' && decorated !== null && decorated.every(row => BUDGET_UNKNOWN_VALUES.includes(String(row.value)))
  const sorted = decorated && sortKey
    ? [...decorated].sort((a, b) => {
        const left = a[sortKey]
        const right = b[sortKey]
        if (!isNum(left) && !isNum(right)) return 0
        if (!isNum(left)) return 1
        if (!isNum(right)) return -1
        return sortDir === 'asc' ? left - right : right - left
      })
    : decorated
  const total = decorated
    ? {
        sessions: decorated.every(row => isNum(row.sessions)) ? decorated.reduce((sum, row) => sum + row.sessions, 0) : null,
        reached: decorated.every(row => isNum(row.reached)) ? decorated.reduce((sum, row) => sum + row.reached, 0) : null,
        first: decorated.every(row => isNum(row.first)) ? decorated.reduce((sum, row) => sum + row.first, 0) : null,
      }
    : null
  const totalConversion = total && isNum(total.first) && total.first > 0 && isNum(total.reached) ? total.reached / total.first : null
  const sortButton = (key, label, active) => (
    <th className="is-num" aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={`bp-th-sort${active ? ' is-active' : ''}`} onClick={() => toggleSort(key)}>
        {label}
        <span className="bp-th-arrow" aria-hidden="true">{active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  )
  return (
    <>
      <div className="bp-breakdown-head">
        <Segmented
          label={t('拆解维度')}
          value={dimension}
          onChange={onDimension}
          options={DIMENSIONS.map(([value, label]) => ({ value, label: t(label) }))}
        />
        <span className="bp-note">{t(DIMENSION_NOTE[dimension] || '')}</span>
        {dimension === 'project' ? <span className="bp-note bp-note-warn">{t('项目 ID 与网签页楼盘 ID 不同源，不能直接对号。')}</span> : null}
      </div>
      {sorted === null ? (
        <div className="bp-unavailable">
          <Missing />
          <span>{groupMissing
            ? t('本次没有返回「{dim}」这一维度（可能未上线或未采集），没有拿 0 补位。', { dim: dimensionLabel })
            : t('这一维度取数失败，保留槽位但不填 0。')}</span>
        </div>
      ) : projectEmpty ? (
        <div className="bp-unavailable">
          <Missing />
          <span>{t('窗口内还没有可归因的项目事件（只有 (none) / unknown）。')}</span>
        </div>
      ) : sorted.length ? (
        <div className="bp-table-scroll">
          <table className="md-table is-plain bp-table">
            <thead>
              <tr>
                <th>{t(dimension === 'budgetBand' ? '预算档位' : dimension === 'pageKey' ? '页面 pageKey' : dimension === 'project' ? '项目' : '来源')}</th>
                {sortButton('sessions', t('会话'), sortKey === 'sessions')}
                <th className="is-num">{t(targetLabel)}</th>
                {sortButton('conversion', t('占首级'), sortKey === 'conversion')}
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => (
                <tr key={row.value}>
                  <td>{dimension === 'budgetBand' ? t(BUDGET_LABEL[row.value] || row.value) : row.value}</td>
                  <td className="is-num">{isNum(row.sessions) ? fmt(row.sessions) : <Missing />}</td>
                  <td className="is-num">{isNum(row.reached) ? fmt(row.reached) : <Missing />}</td>
                  <td className="is-num">
                    {isNum(row.conversion)
                      ? pct(row.conversion, 2)
                      : isNum(row.first) && row.first === 0
                        ? <span title={t('该组首级为 0 个会话，比率无定义')}>—</span>
                        : <Missing />}
                  </td>
                </tr>
              ))}
              <tr className="bp-table-total">
                <td>{t('合计')}</td>
                <td className="is-num">{total && isNum(total.sessions) ? fmt(total.sessions) : <Missing />}</td>
                <td className="is-num">{total && isNum(total.reached) ? fmt(total.reached) : <Missing />}</td>
                <td className="is-num">
                  {isNum(totalConversion)
                    ? pct(totalConversion, 2)
                    : total && isNum(total.first) && total.first === 0
                      ? '—'
                      : <Missing />}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bp-unavailable"><Missing /><span>{t('这一维度没有返回行。')}</span></div>
      )}
    </>
  )
}

/** 采集健康度：用 events[] 判断「没数据」和「是 0」的差别，并提示诊断事件/刷量风险。 */
function HealthPanel({ data, primary }) {
  const events = Array.isArray(data?.events) ? data.events : null
  if (!events || !events.length || unavailableHas(data, 'events')) {
    return (
      <div className="bp-unavailable">
        <Missing />
        <span>{t('事件清单未获取（unavailable: events），没有用 0 条事件占位。')}</span>
      </div>
    )
  }
  const known = events.filter(event => isNum(event.count))
  const total = known.reduce((sum, event) => sum + event.count, 0)
  const sessions = primary?.stages?.[0]?.actors
  const perSession = isNum(sessions) && sessions > 0 ? total / sessions : null
  const diagnostic = known.filter(event => DIAGNOSTIC_EVENTS.includes(event.name))
  const diagnosticTotal = diagnostic.reduce((sum, event) => sum + event.count, 0)
  const diagnosticShare = total > 0 ? diagnosticTotal / total : null
  const research = events.filter(event => EXPECTED_RESEARCH_EVENTS.includes(event.name))
  const researchWithCount = research.filter(event => isNum(event.count) && event.count > 0)
  const researchMissing = EXPECTED_RESEARCH_EVENTS.filter(name => !events.some(event => event.name === name))
  const legacy = data.extra?.legacyInspection
  const sortedEvents = [...events].sort((a, b) => (isNum(b.count) ? b.count : -1) - (isNum(a.count) ? a.count : -1))
  return (
    <>
      <div className="bp-health-summary">
        <span>{t('窗口内事件 {total} 次', { total: fmt(total) })}</span>
        <span>{isNum(sessions) ? t('会话 {sessions} 个 · 每会话 {n} 次事件', { sessions: fmt(sessions), n: perSession === null ? '—' : perSession.toFixed(1) }) : t('会话数未获取，算不出每会话事件数')}</span>
      </div>
      <div className="bp-table-scroll bp-health-scroll">
        <table className="md-table is-plain bp-table bp-health-table">
          <thead>
            <tr>
              <th>{t('事件')}</th>
              <th className="is-num">{t('次数')}</th>
              <th>{t('占事件总数')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedEvents.map((event) => {
              const share = isNum(event.count) && total > 0 ? event.count / total : null
              return (
                <tr key={event.name} className={DIAGNOSTIC_EVENTS.includes(event.name) ? 'is-diagnostic' : ''}>
                  <td>
                    {event.name}
                    {DIAGNOSTIC_EVENTS.includes(event.name) ? <em className="bp-chip is-detached">{t('诊断')}</em> : null}
                  </td>
                  <td className="is-num">{isNum(event.count) ? fmt(event.count) : <Missing />}</td>
                  <td>
                    <span className="bp-health-share" title={isNum(share) ? pct(share) : t('未获取')}>
                      <span className="bp-health-track"><i style={{ width: `${Math.max(0, Math.min(100, Math.round((share || 0) * 100)))}%` }} /></span>
                      <b>{isNum(share) ? pct(share, 1) : <Missing />}</b>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ul className="bp-health-flags">
        {researchWithCount.length ? (
          <li className="is-ok">{t('研究型埋点已采集 {n}/{total}：{names}', { n: researchWithCount.length, total: EXPECTED_RESEARCH_EVENTS.length, names: researchWithCount.map(event => `${event.name}（${fmt(event.count)}）`).join('、') })}</li>
        ) : (
          <li className="is-warn">{t('研究型埋点：{names} 一个都没有，属于未上线/未采集，不是 0 转化。', { names: EXPECTED_RESEARCH_EVENTS.join(' / ') })}</li>
        )}
        {researchWithCount.length && researchMissing.length ? (
          <li className="is-warn">{t('还没采集到：{names}（未上线/未采集，不是 0）。', { names: researchMissing.join(' / ') })}</li>
        ) : null}
        {isNum(diagnosticShare) && diagnosticShare > DIAGNOSTIC_SHARE_HIGH ? (
          <li className="is-warn">{t('诊断事件占比 {share}（每会话 {per} 次），可能是重复渲染：诊断事件是「上报」不是「业务动作」，别当转化看。', { share: pct(diagnosticShare), per: isNum(sessions) && sessions > 0 ? (diagnosticTotal / sessions).toFixed(1) : '—' })}</li>
        ) : null}
        {isNum(perSession) && perSession > EVENTS_PER_SESSION_HIGH ? (
          <li className="is-warn">{t('每会话 {n} 次事件，偏高：可能是刷量或重复上报，先核对再引用。', { n: perSession.toFixed(1) })}</li>
        ) : null}
        {diagnostic.length ? (
          <li className="is-ok">{t('诊断事件：{names}', { names: diagnostic.map(event => `${event.name}（${isNum(event.count) ? fmt(event.count) : t('未获取')}）`).join('、') })}</li>
        ) : null}
      </ul>
      {legacy ? (
        <p className="bp-note bp-health-legacy">
          {t('巡查旧埋点流（无会话关联）：inspection_started {started} / report {report}', {
            started: isNum(legacy.started) ? fmt(legacy.started) : t('未获取'),
            report: isNum(legacy.reportViewed) ? fmt(legacy.reportViewed) : t('未获取'),
          })}
        </p>
      ) : null}
    </>
  )
}

/** 加载中：没有缓存可先显示时给进度、秒数和取消，别让页面看着像卡死。 */
function Loading({ days, seconds, onCancel }) {
  const hint = seconds < 20
    ? t('正在跑只读聚合，通常需要几十秒；这次没有可用的缓存快照，先别关掉这一页。')
    : seconds < 50
      ? t('还在聚合：CloudBase 要跑多条查询，慢一点是正常的。')
      : t('比平时慢，可能 CloudBase 在排队；可以取消，过一会儿再取。')
  return (
    <div className="bp-loading">
      <div className="bp-loading-bar" aria-hidden="true"><i style={{ width: `${Math.min(92, 8 + (seconds / 70) * 84).toFixed(1)}%` }} /></div>
      <p className="bp-loading-title md-shimmer">{t('正在读取近 {days} 天的埋点转化…', { days })}</p>
      <p className="bp-note">{hint}</p>
      <p className="bp-note">{t('已等待 {n} 秒', { n: seconds })}</p>
      <button type="button" className="md-btn is-small" onClick={onCancel}>{t('取消')}</button>
      <div className="bp-skeleton" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
    </div>
  )
}

export function BuyPointsView() {
  useLang()
  const [days, setDays] = React.useState(7)
  const [state, setState] = React.useState({ status: 'loading', data: null, error: null, seconds: 0, cached: false, cachedAt: null, refreshing: false, refreshNote: null })
  const [dimension, setDimension] = React.useState('source')
  const abortRef = React.useRef(null)
  const tickRef = React.useRef(null)
  const seqRef = React.useRef(0)
  const shownRef = React.useRef(null)

  const stopTick = React.useCallback(() => {
    clearInterval(tickRef.current)
    tickRef.current = null
  }, [])

  const load = React.useCallback((window, { force = false } = {}) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const token = (seqRef.current += 1)
    const startedAt = Date.now()
    stopTick()
    const memo = MEMO.get(window)
    if (memo) {
      shownRef.current = memo.data
      setState({ status: 'ready', data: memo.data, error: null, seconds: 0, cached: memo.data.meta?.cached === true,
        cachedAt: memo.data.meta?.cachedAt ?? null, refreshing: force, refreshNote: null })
    } else {
      shownRef.current = null
      setState({ status: 'loading', data: null, error: null, seconds: 0, cached: false, cachedAt: null, refreshing: false, refreshNote: null })
      if (force) tickRef.current = setInterval(() => setState(prev => (prev.status === 'loading' ? { ...prev, seconds: Math.round((Date.now() - startedAt) / 1000) } : prev)), 1000)
    }

    const alive = () => token === seqRef.current

    const finish = async () => {
      let first
      try {
        first = await requestFunnel(window, { force, signal: controller.signal })
      } catch (error) {
        if (!alive() || error?.name === 'AbortError') return
        stopTick()
        const kept = shownRef.current
        if (kept && kept.ok === true) {
          // 已经有数据就不整页报错：留着旧数据，只提示这次刷新失败。
          setState(prev => ({ ...prev, status: 'ready', refreshing: false, refreshNote: t('这次没取到新数据：{error}。下面还是上一次的结果。', { error: error.message }) }))
          toast(t('埋点转化取数失败：{error}', { error: error.message }), { error: true })
          return
        }
        setState({ status: 'error', data: null, error: error.message, seconds: Math.round((Date.now() - startedAt) / 1000), cached: false, cachedAt: null, refreshing: false, refreshNote: null })
        toast(t('埋点转化取数失败：{error}', { error: error.message }), { error: true })
        return
      }
      if (!alive()) return
      stopTick()
      if (first?.ok === true) {
        MEMO.set(window, { at: Date.now(), data: first })
        shownRef.current = first
        const cached = first.meta?.cached === true
        setState({ status: 'ready', data: first, error: null, seconds: 0, cached, cachedAt: first.meta?.cachedAt ?? null, refreshing: false, refreshNote: first.meta?.degradeReason || null })
        return
      }
      // ok:false（未接入 / 脚本失败）：保留返回体，由下面的 gate 渲染，不猜数字。
      shownRef.current = first
      setState({ status: 'ready', data: first, error: null, seconds: 0, cached: false, cachedAt: null, refreshing: false, refreshNote: null })
    }
    finish()
  }, [stopTick])

  React.useEffect(() => {
    load(days)
    return () => {
      abortRef.current?.abort()
      stopTick()
    }
  }, [days, load, stopTick])

  const data = state.data
  const blocked = Boolean(data) && data.ok === false && data.code === 'not_configured'
  const empty = data?.code === 'no_cache'
  const failed = Boolean(data) && data.ok === false && !blocked && !empty
  const ready = Boolean(data) && data.ok === true
  const primary = ready ? funnelOf(data, 'primary') : null
  const research = ready ? funnelOf(data, 'research') : null
  const losses = ready ? dropoffRows(data, primary) : []
  const researchLosses = ready ? dropoffRows(data, research) : []
  const top = losses[0] || null
  const attemptActors = stageOf(primary, ['attempt', 'submit'])?.actors
  const previousFunnels = ready && Array.isArray(data.previous?.funnels) ? data.previous.funnels : []
  const previousPrimary = previousFunnels.find(funnel => funnel.key === 'primary') || null
  const previousResearch = previousFunnels.find(funnel => funnel.key === 'research') || null
  const warnings = ready && Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : []
  const noteCount = 3 + warnings.length

  return (
    <div className="md-board-page bp-page">
      <section className="md-tile bp-hero">
        <div className="bp-hero-copy">
          <div className="bp-hero-title">
            <h1>{t('埋点转化')}</h1>
            {ready ? <FreshnessPill freshness={data?.freshness} /> : null}
          </div>
          <p>{t('小程序里用户走到哪一步停下——会话级有序漏斗，只读聚合。')}</p>
        </div>
        <span className="md-grow" />
        <Segmented label={t('时间窗口')} value={days} onChange={setDays} options={WINDOWS.map(value => ({ value, label: t('近 {n} 天', { n: value }) }))} />
        {ready ? (
          <button type="button" className="md-btn is-small" disabled={state.refreshing} onClick={() => load(days, { force: true })}>
            <Icon name="refresh" size={13} />{t('重新取数')}
          </button>
        ) : null}
      </section>

      {state.status === 'loading' ? (
        <Loading
          days={days}
          seconds={state.seconds}
          onCancel={() => {
            abortRef.current?.abort()
            stopTick()
            setState({ status: 'idle', data: null, error: null, seconds: 0, cached: false, cachedAt: null, refreshing: false, refreshNote: null })
          }}
        />
      ) : null}

      {empty ? (
        <div className="bp-gate">
          <p className="bp-gate-title">还没有本地埋点快照</p>
          <p className="bp-note">进入页面只查看缓存。需要最新数据时，再手动读取腾讯云。</p>
          <button type="button" className="md-btn is-primary is-small" onClick={() => load(days, { force: true })}>读取埋点数据</button>
        </div>
      ) : null}

      {state.status === 'idle' ? (
        <div className="bp-gate">
          <p className="bp-gate-title">{t('已取消这次取数')}</p>
          <p className="bp-note">{t('Host 那边这次聚合还在跑，跑完会写进磁盘缓存；再取一次通常能直接读到缓存。')}</p>
          <button type="button" className="md-btn is-primary is-small" onClick={() => load(days, { force: true })}>{t('重新取数')}</button>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="bp-gate">
          <p className="bp-gate-title">{t('整页取不到埋点数据')}</p>
          <p className="bp-note">{state.error || t('服务没有返回埋点转化数据。')}</p>
          <p className="bp-note">{t('本机还没有成功过的缓存，所以不显示任何数字。')}</p>
          <button type="button" className="md-btn is-primary is-small" onClick={() => load(days, { force: true })}>{t('重试')}</button>
        </div>
      ) : null}

      {blocked ? (
        <div className="bp-gate">
          <p className="bp-gate-title">{t('整页未接入')}</p>
          <p className="bp-note">{data.message}</p>
          <ol className="bp-gate-list">
            <li className={(data.missing || []).includes('script') ? 'is-missing' : 'is-ok'}>
              <b>{t('数据仓脚本')}</b>
              <code>RealEstateIntelligent-data/scripts/conversion-funnel.js</code>
              <span>{t('默认在数据仓检出位置查找，也可以用环境变量 LANJING_CONVERSION_SCRIPT 指定。')}</span>
            </li>
            <li className={(data.missing || []).includes('envId') ? 'is-missing' : 'is-ok'}>
              <b>{t('CloudBase 环境 ID')}</b>
              <code>~/.config/.cloudbase/global.json → currentEnvId</code>
              <span>{t('也可以用环境变量 LANJING_CONVERSION_ENV 指定。')}</span>
            </li>
          </ol>
          {data.hint ? <p className="bp-note">{data.hint}</p> : null}
          <p className="bp-note">{t('只读：接口不写 CloudBase，也不保存任何逐人明细；缺数据时不会用 0 或估算值占位。')}</p>
          <button type="button" className="md-btn is-primary is-small" onClick={() => load(days, { force: true })}>{t('重新检查')}</button>
        </div>
      ) : null}

      {failed ? (
        <div className="bp-gate">
          <p className="bp-gate-title">{t('取数失败')}</p>
          <p className="bp-note">{data.message || t('脚本执行失败')}{data.timedOut ? t('（超时）') : ''}</p>
          <button type="button" className="md-btn is-primary is-small" onClick={() => load(days, { force: true })}>{t('重试')}</button>
        </div>
      ) : null}

      {ready ? (
        <>
          {data.meta?.mock ? (
            <Banner tone="mock" title={t('示例数据 · 非真实')}>
              {t('Host 用 LANJING_CONVERSION_MOCK=1 返回固定示例快照，只用于联调渲染，这里任何一个数字都不能引用。')}
            </Banner>
          ) : null}
          {state.cached ? (
            <Banner
              tone="cached"
              title={t('缓存 · 截至 {time}', { time: timeText(state.cachedAt) })}
              action={<button type="button" className="md-btn is-small" onClick={() => load(days, { force: true })}>{t('重新取数')}</button>}
            >
              {state.refreshing
                ? '正在读取最新数据，暂时显示本地快照。'
                : state.refreshNote || '当前显示本地快照，可按需重新取数。'}
            </Banner>
          ) : null}
          {!state.cached && state.refreshNote ? (
            <Banner tone="partial" title={t('刷新未完成')}>{state.refreshNote}</Banner>
          ) : null}
          {state.refreshing && !state.cached ? (
            <Banner tone="cached" title={t('后台更新中')}>{t('先显示已取到的数据，刷新完成后自动替换。')}</Banner>
          ) : null}
          {Array.isArray(data.unavailable) && data.unavailable.length ? (
            <Banner tone="partial" title={t('部分区块未获取')}>
              {t('{fields}：对应区块显示「未获取」，没有用 0 或估算值补位。', { fields: data.unavailable.join('、') })}
            </Banner>
          ) : null}

          <section className="md-tile bp-kpis">
            <Kpi label={t('打开会话')} value={primary?.stages?.[0]?.actors} note={t('小程序会话数（首级）')} />
            <Kpi label={t('进入服务')} value={stageOf(primary, ['entry_clicked', 'entry'])?.actors} note={t('服务入口 → 进入服务')} />
            <Kpi label={t('提交留资')} value={attemptActors} note={t('达到提交留资的会话')} />
            <Kpi label={t('留资成功')} value={data.outcome?.saved} note={t('lead_saved 会话')} />
            <Kpi label={t('联系建立')} value={data.outcome?.contact} note={t('含企微名片路径')} />
            <Kpi
              label={t('最大流失环节')}
              value={top?.rateValue}
              unit="%"
              percent
              tone="loss"
              note={top
                ? t('{from} → {to} 流失 {value}', { from: top.fromLabel, to: top.toLabel, value: isNum(top.rateValue) ? pct(top.rateValue) : t('未获取') })
                : t('没有可用的逐级流失数据')}
            />
          </section>

          <section className="md-tile bp-funnel-tile">
            <header className="md-tile-head">
              <h2>{t('主转化漏斗')}</h2>
              <span className="md-tile-meta">{t('会话数 · 宽度按首级占比')}</span>
              <span className="md-grow" />
              <span className="bp-tile-note">{t('强调 = 最大卡点那一级')}</span>
            </header>
            <div className="bp-tile-body">
              <FunnelRows funnel={primary} focus={top} previous={previousPrimary} />
              <p className="bp-tile-foot">
                {data.scope || t('会话级有序漏斗；排除已识别管理员与 develop/trial')}
                {top ? t(' · 最大流失：{from} → {to}，流失 {n} 个会话。', { from: top.fromLabel, to: top.toLabel, n: fmt(top.lost) }) : ''}
                {previousPrimary ? t(' · 环比 = 与上一个同长度窗口相比（按阶段 key 对齐）。') : ''}
              </p>
            </div>
          </section>

          <section className="md-tile bp-blockers-tile">
            <header className="md-tile-head">
              <h2>{t('卡点排行')}</h2>
              <span className="md-tile-meta">{t('按流失会话数取前三 · 全部来自 dropoff')}</span>
              <span className="md-grow" />
              <span className="bp-tile-note">{t('只作结构观察，不作归因')}</span>
            </header>
            <div className="bp-tile-body">
              <Blockers rows={losses} funnel={primary} />
            </div>
          </section>

          <section className="md-tile bp-outcome-tile">
            <header className="md-tile-head"><h2>{t('结果')}</h2><span className="md-grow" /><span className="bp-tile-note">{t('会话内出现过即计入')}</span></header>
            <div className="bp-tile-body">
              {unavailableHas(data, 'outcome') ? (
                <div className="bp-unavailable"><Missing /><span>{t('结果字段取数失败（unavailable: outcome）。')}</span></div>
              ) : (
                <dl className="bp-outcome">
                  <div>
                    <dt>{t('留资成功')}</dt>
                    <dd>{isNum(data.outcome?.saved) ? <>{fmt(data.outcome.saved)}<small>{t('个会话')}</small></> : <Missing />}</dd>
                  </div>
                  <div>
                    <dt>{t('联系建立')}</dt>
                    <dd>{isNum(data.outcome?.contact) ? <>{fmt(data.outcome.contact)}<small>{t('个会话')}</small></> : <Missing />}</dd>
                  </div>
                  <div>
                    <dt>{t('提交后联系率')}</dt>
                    <dd>
                      {(() => {
                        const contact = data.outcome?.contact
                        if (!isNum(contact) || !isNum(attemptActors)) return attemptActors === 0 ? '—' : <Missing />
                        return attemptActors > 0 ? pct(contact / attemptActors, 0) : '—'
                      })()}
                    </dd>
                  </div>
                </dl>
              )}
              <p className="bp-tile-foot">
                {t('联系建立不是提交的子集：企微名片可以不经表单直接发生，所以联系会话数可以大于提交会话数，这里不把它们塞进同一根条形。留资成功按会话去重，不要求该会话先打开过表单，因此它可以和「提交留资 0」同时出现。')}
              </p>
            </div>
          </section>

          <section className="md-tile bp-budget-tile">
            <header className="md-tile-head">
              <h2>{t('预算档位并排漏斗')}</h2>
              <span className="md-tile-meta">{t('800 万及以上 vs 800 万以下 · 迷你漏斗')}</span>
              <span className="md-grow" />
              <span className="bp-tile-note">{t('只做结构对照，不作归因')}</span>
            </header>
            <div className="bp-tile-body">
              <BudgetCompare data={data} primary={primary} />
            </div>
          </section>

          <section className="md-tile bp-research-tile">
            <header className="md-tile-head">
              <h2>{t('研究深度漏斗')}</h2>
              <span className="md-tile-meta">{t('分解级只作观测，不参与有序判定')}</span>
            </header>
            <div className="bp-tile-body">
              <FunnelRows funnel={research} focus={researchLosses[0] || null} previous={previousResearch} />
              <p className="bp-tile-foot">
                {t('「未上线」那一级的事件还没上线：未采集 ≠ 0 转化，它不参与有序判定，后面的「留资成功」与上一个有序级比较。「分解级」同理只作观测。')}
              </p>
            </div>
          </section>

          <section className="md-tile bp-sankey-tile">
            <header className="md-tile-head">
              <h2>{t('入口路径')}</h2>
              <span className="md-tile-meta">{t('来源 → 页面 → 进入服务/未进入 · 带宽按会话数')}</span>
              <span className="md-grow" />
              <span className="bp-tile-note">{t('只用来找路径结构，不推断因果')}</span>
            </header>
            <div className="bp-tile-body">
              <SankeyCard data={data} />
            </div>
          </section>

          <section className="md-tile bp-trend-tile">
            <header className="md-tile-head">
              <h2>{t('按日趋势')}</h2>
              <span className="md-tile-meta">{t('首级主趋势 + 每级一个小多图 · 空白格是缺口日')}</span>
            </header>
            <div className="bp-tile-body">
              <TrendPanel data={data} funnel={primary} />
              <p className="bp-tile-foot">{t('柱子高度按每一级自己的峰值归一，只看形状；缺口日（那天没有采集到数据）留空，不补 0、不连线。主趋势下方浅色条是当日会话总数，用来对照走势。')}</p>
            </div>
          </section>

          <section className="md-tile bp-events-tile">
            <header className="md-tile-head">
              <h2>{t('事件趋势')}</h2>
              <span className="md-tile-meta">{t('事件级每日计数 · 缺数据日断线不补 0')}</span>
              <span className="md-grow" />
              <span className="bp-tile-note">{t('用来发现某天某事件突然归零')}</span>
            </header>
            <div className="bp-tile-body">
              <EventTrendCard data={data} />
            </div>
          </section>

          <section className="md-tile bp-breakdown-tile">
            <header className="md-tile-head">
              <h2>{t('拆解')}</h2>
              <span className="md-grow" />
              <span className="bp-tile-note">{t('占首级 = 该组走到「{stage}」的会话 / 该组首级会话', { stage: t(targetLabelOf(data)) })}</span>
            </header>
            <div className="bp-tile-body">
              <Breakdown data={data} dimension={dimension} onDimension={setDimension} />
            </div>
          </section>

          <section className="md-tile bp-health-tile">
            <header className="md-tile-head">
              <h2>{t('采集健康度')}</h2>
              <span className="md-tile-meta">{t('窗口内事件清单 · 区分未采集与真实 0')}</span>
            </header>
            <div className="bp-tile-body">
              <HealthPanel data={data} primary={primary} />
            </div>
          </section>

          <section className="md-tile bp-notes-tile">
            <header className="md-tile-head"><h2>{t('口径')}</h2><span className="md-tile-meta">{t('只读聚合，没有逐人明细')}</span></header>
            <div className="bp-tile-body">
              <ul className="bp-notes">
                <li>{t('会话级有序漏斗：同一会话内按事件发生顺序，只有满足前序事件的会话才计入下一级。')}</li>
                <li>{t('已排除管理员、开发版与体验版会话。')}</li>
                <li>{t('渠道为小程序内自报标签，只用于看结构，不作财务归因。')}</li>
              </ul>
              {noteCount > 3 ? (
                <details className="bp-notes-more">
                  <summary>{t('展开其余 {n} 条口径与提示', { n: noteCount - 3 })}</summary>
                  <ul className="bp-notes">
                    {warnings.map(line => <li key={line}>{line}</li>)}
                  </ul>
                </details>
              ) : null}
              <p className="bp-tile-foot">
                {t('只读聚合：{env} · {collection} · 窗口 {from} — {to}（{days} 天）· 生成 {at}', {
                  env: data.source?.envId || t('环境未知'),
                  collection: data.source?.collection || 'product_events',
                  from: data.range?.from || '—',
                  to: data.range?.to || '—',
                  days: data.range?.days ?? '—',
                  at: timeText(data.generatedAt),
                })}
                {data.meta?.mock ? t(' · 示例数据') : ''}
                {data.meta?.cached ? t(' · 缓存（{time}）', { time: timeText(data.meta.cachedAt) }) : ''}
              </p>
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

/** 拆解表口径文案里的目标级标签：与 Breakdown 内部选择逻辑保持一致。 */
function targetLabelOf(data) {
  const stages = (Array.isArray(data?.funnels) ? data.funnels : []).find(funnel => funnel.key === 'primary')?.stages
  const list = Array.isArray(stages) ? stages : []
  const found = list.findIndex(stage => stage.key === 'entry_clicked')
  return list[found >= 0 ? found : list.length - 1]?.label || t('进入服务')
}
