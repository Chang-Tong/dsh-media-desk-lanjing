import { applyOps } from './ops.js'
import { dailyTopics } from './daily-topics.js'

export async function selectTopic(store, { id, source, now = new Date(), slot }) {
  return store.mutate('选择每日选题', state => {
    const previous = state.items.find(row => !row.mergedInto && row.dailyTopicKey === id)
    if (previous && !slot) return { id: previous.id }
    if (previous || (slot && !state.editorialSeries?.enabled)) throw Object.assign(new Error('选题已使用或自动排期已暂停。'), { status: 409 })
    const selected = dailyTopics(state.items, source, now, { forSeries: Boolean(slot) }).topics.find(row => row.id === id)
    if (!selected || (slot && !selected.verified)) throw Object.assign(new Error('选题已更新或素材不符合条件，请刷新后再选。'), { status: 400 })
    if (slot && state.editorialSeries.runs?.[slot.date] && state.editorialSeries.runs[slot.date].status !== 'waiting') throw Object.assign(new Error('该日已有排期记录。'), { status: 409 })
    const { receipts, errors } = applyOps(state, [{
      op: 'consume_sources', sourceIds: [id], title: selected.title, body: [selected.angle, slot?.brief].filter(Boolean).join('\n'),
      platform: '小红书', outputFormat: 'guizang', useData: slot?.source === 'net-sign' || selected.label === '网签',
    }])
    if (errors.length) throw Object.assign(new Error(errors[0]), { status: 400 })
    const item = state.items.find(row => row.id === receipts[0].target)
    item.dailyTopicKey = id
    if (slot) {
      item.dailySeries = { name: slot.name, date: slot.date }
      item.scheduledAt = new Date(slot.date + 'T09:00:00+08:00').toISOString()
      item.status = 'outline'
      const runs = state.editorialSeries.runs ??= {}
      runs[slot.date] = { status: 'generating', topicId: item.id, message: '正在生成文案和图卡。', updatedAt: now.toISOString() }
    }
    return { id: item.id }
  }, { undoable: !slot })
}
