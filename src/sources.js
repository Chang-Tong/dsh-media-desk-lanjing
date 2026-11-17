// 灵感源摄入：每天由生成器推送一批带频道的灵感，幂等去重后写进灵感墙。
// 同一个模块同时服务于 Host 接口（/sources/ingest）和 CLI（scripts/ingest-sources.mjs），
// 契约一致：{ channel, date, items: [{ title, body, url, source, tags }] }。
import { CHANNEL_IDS, channelTag } from './channels.js'
import { applyOps } from './ops.js'
import { isMaterial } from './editorial.js'

const MAX_ITEMS = 200
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** 把一条原始条目规范成 add_item 操作，并给出幂等键。不合法返回 null。 */
export function normalizeEntry(entry, channel, date) {
  if (!entry || typeof entry !== 'object') return null
  const title = String(entry.title ?? '').trim().slice(0, 300)
  const body = String(entry.body ?? '').trim().slice(0, 40000)
  const url = isHttpUrl(String(entry.url ?? '')) ? String(entry.url).trim() : null
  const source = String(entry.source ?? '').trim().slice(0, 80)
  if (!title && !body && !url) return null
  const day = DATE_RE.test(String(date ?? '')) ? String(date) : new Date().toISOString().slice(0, 10)
  const tags = [...(Array.isArray(entry.tags) ? entry.tags.filter(value => typeof value === 'string').map(value => value.trim().slice(0, 20)).filter(Boolean) : []), channelTag(channel)]
  const finalTitle = title || body.slice(0, 28) || url
  // 幂等键与入库后的 (url / channel::title) 保持一致，重复推送才会被跳过
  const dedupeKey = url || `${channel}::${finalTitle}`
  const kind = url ? 'web' : 'note'
  return {
    dedupeKey,
    day,
    op: {
      op: 'add_item',
      kind,
      title: finalTitle,
      body,
      url,
      source,
      tags: [...new Set(tags)].slice(0, 24),
      channel, recordType: 'material', date: day,
      ...(entry.publishedAt && !Number.isNaN(Date.parse(entry.publishedAt)) ? { publishedAt: entry.publishedAt } : {}),
      retrievedAt: new Date().toISOString(),
      evidenceStatus: typeof entry.evidenceStatus === 'string' ? entry.evidenceStatus.slice(0, 80) : 'provided',
    },
  }
}

/**
 * 幂等摄入一批灵感源条目。
 * @param {import('./store.js').Store} store
 * @param {{channel: string, date?: string, items: Array<object>}} body
 * @returns {Promise<{channel: string, date: string, added: number, skipped: number, receipts: object[], errors: string[], state: object}>}
 */
export async function ingest(store, body) {
  const channel = typeof body?.channel === 'string' ? body.channel : null
  if (!CHANNEL_IDS.includes(channel)) {
    throw Object.assign(new Error('灵感源频道无效'), { status: 400 })
  }
  const entries = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS) : []
  const date = DATE_RE.test(String(body?.date ?? '')) ? String(body.date) : new Date().toISOString().slice(0, 10)

  const result = await store.mutate(`灵感源 ${channel} ${date} 入库`, (draft) => {
    const existing = new Set()
    for (const item of draft.items) {
      if (item.sample || !isMaterial(item)) continue
      if (item.url) existing.add(item.url)
      if (item.channel && item.title) existing.add(`${item.channel}::${item.title}`)
    }
    const ops = []
    let skipped = 0
    for (const entry of entries) {
      const normalized = normalizeEntry(entry, channel, date)
      if (!normalized || existing.has(normalized.dedupeKey) || (normalized.op.url && existing.has(normalized.op.url))) {
        skipped += 1
        continue
      }
      existing.add(normalized.dedupeKey)
      if (normalized.op.url) existing.add(normalized.op.url)
      ops.push(normalized.op)
    }
    const { receipts, errors } = applyOps(draft, ops)
    draft.sourceRuns ??= {}
    draft.sourceRuns[channel] = { date, receivedAt: new Date().toISOString(), added: receipts.length, skipped, errors, note: typeof body.note === 'string' ? body.note.slice(0, 500) : '' }
    return { channel, date, added: receipts.length, skipped, receipts, errors }
  }, { undoable: false })
  return { ...result, state: await store.read() }
}
