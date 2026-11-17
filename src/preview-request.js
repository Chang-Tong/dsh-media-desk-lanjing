// Read-only requests must not invalidate a finished manuscript or authorize publication.
import { createHash } from 'node:crypto'

const PREVIEW_PHRASES = new Set([
  '看看稿件，发我一下', '看看稿件,发我一下', '看看稿件',
  '把稿子发给我', '稿件发我一下', '看看稿子', '发我看一下稿件',
])

export function isPreviewRequest(text) {
  if (typeof text !== 'string') return false
  return PREVIEW_PHRASES.has(text.trim().replace(/[。.!！?？~～\-]+$/u, '').trim())
}

function pathValue(row) {
  if (typeof row === 'string' && row) return row
  if (row && typeof row === 'object') return row.src ?? row.path ?? row.url ?? row.file ?? null
  return null
}

function fingerprint(prod) {
  const data = {
    title: prod?.title ?? '', article: prod?.article ?? '', coverText: prod?.coverText ?? '',
    cover: prod?.cover != null ? pathValue(prod.cover) : null,
    images: (prod?.images ?? []).map(pathValue), cards: (prod?.cards ?? []).map(pathValue),
    slides: (prod?.slides ?? []).map(pathValue), shots: (prod?.shots ?? []).map(pathValue),
    video: prod?.videoSrc ?? prod?.video ?? null,
  }
  return digest(JSON.stringify(data))
}
const digest = value => createHash('sha256').update(value).digest('hex')
const reject = message => { throw Object.assign(new Error(`不能恢复查看稿件请求：${message}`), { status: 409 }) }

/** Narrow historical repair, executed only by the existing Host Store writer. */
export async function recoverPreviewRequest({ store, topicId, messageId, artifactHash, briefHash }) {
  if (!topicId || !messageId || !/^[a-f0-9]{64}$/.test(artifactHash ?? '') || !/^[a-f0-9]{64}$/.test(briefHash ?? '')) reject('缺少有效的选题、消息和指纹')
  let result
  await store.mutate('恢复误判的查看稿件请求', state => {
    const cfg = state.editorialWorkflow?.feishu
    const topic = state.items?.find(row => row.id === topicId)
    if (cfg?.enabled !== true || !cfg.ownerId || !cfg.chatId || cfg.activeTopicId !== topicId || !topic || topic.recordType !== 'topic') reject('当前选题或飞书配置不匹配')
    const prod = topic.production
    if (!prod || prod.status !== 'done' || prod.layoutOutdated === true || fingerprint(prod) !== artifactHash) reject('成稿未完成、布局过期或指纹已改变')
    if (typeof topic.editorialBrief !== 'string' || digest(topic.editorialBrief) !== briefHash) reject('创作简报已改变')
    if (['approved', 'pending'].includes(topic.browserApproval?.status) || topic.draftReceipt) reject('已有浏览器确认或草稿回执')
    const discussions = topic.editorialDiscussion ?? []
    const row = discussions.at(-1)
    if (row?.messageId !== messageId || row.status !== 'processed' || !isPreviewRequest(row.text) || !cfg.processedIds?.includes(messageId)) reject('不是最新已处理的纯查看消息')
    const prior = discussions.at(-2)
    if (prior?.confirmed !== true || !Number.isInteger(topic.editorialBriefVersion) || prior.briefVersion !== topic.editorialBriefVersion - 1) reject('查看前没有相邻的创作确认')
    const confirmedAt = Date.parse(prior.at)
    const startedAt = Date.parse(prod.startedAt)
    const finishedAt = Date.parse(prod.finishedAt)
    const requestAt = Date.parse(row.at)
    if (![confirmedAt, startedAt, finishedAt, requestAt].every(Number.isFinite) || startedAt < confirmedAt || finishedAt < startedAt || finishedAt >= requestAt) reject('创作与查看时间顺序不符')
    const marker = '\n\n【主人原文】\n'
    const markerAt = topic.editorialBrief.lastIndexOf(marker)
    const redlineAt = topic.editorialBrief.lastIndexOf('\n\n【创作红线')
    if (markerAt < 0 || redlineAt <= markerAt || topic.editorialBrief.slice(markerAt + marker.length, redlineAt).trim() !== row.text.trim()) reject('简报末尾不是本次纯查看原文')
    const audit = (topic.previewRecoveries ?? []).find(entry => entry.messageId === messageId && entry.artifactHash === artifactHash && entry.briefHash === briefHash)
    if (audit && prod.outdated === false && row.intent === 'preview_request') {
      result = { recovered: true, alreadyRecovered: true, topicId, messageId, artifactHash }
      return
    }
    if (cfg.phase !== 'awaiting_creation_confirmation' || prod.outdated !== true) reject('当前状态不属于这次误判')
    if (topic.editorialConfirmation?.brief !== topic.editorialBrief || topic.editorialConfirmation?.briefVersion !== topic.editorialBriefVersion) reject('待创作确认与当前简报不符')
    const at = new Date().toISOString()
    prod.outdated = false
    topic.readyForReview = true
    cfg.phase = 'awaiting_review'
    delete topic.editorialConfirmation
    row.intent = 'preview_request'
    row.recoveredAt = at
    row.recoveryArtifactHash = artifactHash
    topic.previewRecoveries = [...(topic.previewRecoveries ?? []), { messageId, artifactHash, briefHash, at }].slice(-100)
    result = { recovered: true, alreadyRecovered: false, topicId, messageId, artifactHash }
  }, { undoable: false })
  return result
}
