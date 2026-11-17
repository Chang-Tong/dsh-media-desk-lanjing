// 素材是输入，选题是明确的创作意图。两个视图共享这份判定与关系契约。
import { CHANNEL_IDS } from './channels.js'

export const isMaterial = item => item?.recordType === 'material' || (!item?.recordType && CHANNEL_IDS.includes(item?.channel))
export const isTopic = item => Boolean(item) && !isMaterial(item) && !item.mergedInto
export const topicsUsing = (items, id) => items.filter(row => isTopic(row) && row.sourceIds?.includes(id))

export function inferChannel(item) {
  if (CHANNEL_IDS.includes(item.channel)) return item.channel
  const text = [item.title, item.body, item.source, ...(item.tags ?? [])].join(' ')
  if (/英国|新加坡|美国|日本|海外|伦敦|纽约|洛杉矶|澳大利亚|Canada|Singapore|London|U\.S\./i.test(text)) return 'overseas-news'
  if (/土拍|地块|宅地|拍地/.test(text)) return 'land-auction'
  if (/政策|细则|通知|新规/.test(text)) return 'policy'
  if (/GDP|LPR|M2|加息|降息|央行|宏观|利率/.test(text)) return 'macro'
  if (/小红书|抖音|热梗|热搜/.test(text)) return 'memes'
  if (/服务器|网签库|remote_django|MCP/.test(text)) return 'server-insights'
  return /北京|朝阳|海淀|昌平|丰台|密云|通州/.test(text) ? 'beijing-news' : 'china-news'
}

export function materialSnapshot(row) {
  const result = {}
  for (const key of ['id', 'title', 'body', 'url', 'source', 'channel', 'date', 'publishedAt', 'retrievedAt', 'evidenceStatus']) {
    if (row[key] !== undefined) result[key] = row[key]
  }
  return result
}

/** 兼容0.1：已排期/成稿的id保持不变，另存其原始素材；可反复执行。 */
export function migrateEditorialState(state) {
  if (state.editorialVersion >= 2) return state
  const additional = []
  for (const row of state.items ?? []) {
    if (row.sample || row.recordType || row.parentId) continue
    if (!row.channel && !(row.kind === 'web' && /^https?:\/\//.test(row.url ?? ''))) continue
    const channel = inferChannel(row)
    const used = row.scheduledAt || row.production || row.drafts?.article || row.drafts?.script || row.status !== 'idea'
    if (used) {
      const id = `src_${row.id}`
      const source = { ...materialSnapshot(row), id, channel, recordType: 'material', kind: row.kind, tags: [...(row.tags ?? [])], status: 'idea', createdAt: row.createdAt }
      if (!(state.items ?? []).some(item => item.id === id)) additional.push(source)
      row.recordType = 'topic'
      row.sourceIds = [...new Set([...(row.sourceIds ?? []), id])]
      row.sourceMaterials = [...(row.sourceMaterials ?? []).filter(item => item.id !== id), materialSnapshot(source)]
      delete row.channel
    } else {
      row.recordType = 'material'
      row.channel = channel
    }
  }
  state.items.push(...additional)
  state.editorialVersion = 2
  return state
}

export function resolveMaterials(state, sourceIds) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > 20) throw new Error('请选择 1–20 条灵感源')
  const ids = [...new Set(sourceIds)]
  const rows = ids.map(id => state.items.find(item => item.id === id && isMaterial(item)))
  if (rows.some(row => !row)) throw new Error('选中的灵感源不存在，请刷新后重试')
  return rows
}

export function attachMaterials(topic, rows) {
  const snapshots = new Map((topic.sourceMaterials ?? []).map(row => [row.id, row]))
  for (const row of rows) snapshots.set(row.id, materialSnapshot(row))
  const ids = [...new Set([...(topic.sourceIds ?? []), ...rows.map(row => row.id)])]
  if (ids.length > 20) throw new Error('每个选题最多关联 20 条素材')
  topic.sourceIds = ids
  topic.sourceMaterials = ids.map(id => snapshots.get(id)).filter(Boolean)
  if (topic.production) topic.production.outdated = true
}
