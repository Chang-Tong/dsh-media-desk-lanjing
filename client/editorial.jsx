import React from 'react'
import { Dialog, Icon } from './ui.jsx'
import { dispatchOps, getDesk, openItem, setDesk, toast, useDesk } from './desk.js'
import { isMaterial, isTopic, topicsUsing } from '../src/editorial.js'
import { fmtWhen } from './util.js'

export const SOURCE_DRAG = 'application/x-lanjing-sources'
export const ITEM_DRAG = 'text/media-desk-lanjing-item'
export { isMaterial, isTopic, topicsUsing }

export function toggleSource(id) {
  const selected = getDesk().sourceSelection
  if (!selected.includes(id) && selected.length >= 20) return toast('每个选题最多关联 20 条素材', { error: true })
  setDesk({ sourceSelection: selected.includes(id) ? selected.filter(key => key !== id) : [...selected, id] })
}
export function sourceDrag(event, id) {
  const selected = getDesk().sourceSelection
  event.dataTransfer.setData(SOURCE_DRAG, JSON.stringify(selected.includes(id) ? selected : [id]))
  event.dataTransfer.effectAllowed = 'copy'
}
export function sourceIdsFrom(event) {
  try {
    const ids = JSON.parse(event.dataTransfer.getData(SOURCE_DRAG))
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string').slice(0, 20) : []
  } catch { return [] }
}
export function composeSources(sourceIds, scheduledAt = null) {
  setDesk({ compose: { sourceIds, scheduledAt } })
}

export function SourceDialog() {
  const id = useDesk(s => s.sourcePreview)
  const items = useDesk(s => s.state?.items ?? [])
  const row = items.find(item => item.id === id)
  if (!row) return null
  const used = topicsUsing(items, id)
  return <Dialog title="素材详情" onClose={() => setDesk({ sourcePreview: null })} width={680}>
    <div className="md-source-detail"><h2>{row.title}</h2><p>{row.body || '暂无摘要，请读取原文。'}</p>
      <p className="md-muted">{row.source} · {row.publishedAt ? `发布时间 ${fmtWhen(row.publishedAt)}` : `收集日期 ${(row.date || row.createdAt || '').slice(0, 10)}`}</p>
      {row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">读取原文 ↗</a> : null}
      <p className="md-muted">{row.evidenceStatus === 'verified' ? '收集时已核对原文；写作前仍需确认时效。' : '这是收集素材，内容与数字须在研究时核对原文。'}</p>
      {used.length ? <div><h3>已加入的选题</h3>{used.map(topic => <button key={topic.id} className="md-pill" onClick={() => { setDesk({ sourcePreview: null }); openItem(topic.id) }}>{topic.title}</button>)}</div> : <p>尚未加入选题。</p>}
      <div className="md-form-foot"><button className="md-btn is-primary" onClick={() => { setDesk({ sourcePreview: null }); composeSources([row.id]) }}>加入选题</button><button className="md-btn" onClick={() => { setDesk({ sourcePreview: null, view: 'schedule', sourceSelection: [row.id] }) }}>去日历排期</button></div>
    </div>
  </Dialog>
}

export function ComposeDialog() {
  const compose = useDesk(s => s.compose)
  const items = useDesk(s => s.state?.items ?? [])
  const [title, setTitle] = React.useState('')
  const [body, setBody] = React.useState('')
  const [targetId, setTargetId] = React.useState('')
  const [date, setDate] = React.useState('')
  const [platform, setPlatform] = React.useState('小红书')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    if (!compose) return
    const rows = items.filter(item => compose.sourceIds.includes(item.id))
    setTitle(rows.length === 1 ? rows[0]?.title ?? '' : '')
    setBody(''); setTargetId(''); setPlatform('小红书')
    const when = compose.scheduledAt ? new Date(compose.scheduledAt) : null
    setDate(when ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}` : '')
  }, [compose])
  if (!compose) return null
  const sources = items.filter(item => compose.sourceIds.includes(item.id) && isMaterial(item))
  const topics = items.filter(item => isTopic(item) && !item.parentId && item.status !== 'published' && !item.sample)
  const close = () => setDesk({ compose: null })
  return <Dialog title={`用 ${sources.length} 条素材创建选题`} onClose={close} width={660}>
    <form className="md-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true)
      const scheduledAt = date ? new Date(`${date}T20:00:00+08:00`).toISOString() : null
      const result = await dispatchOps([{ op: compose.topicIds ? 'merge_topics' : 'consume_sources', topicIds: compose.topicIds, sourceIds: sources.map(row => row.id), title, body, scheduledAt, targetId: targetId || undefined, platform }], { label: compose.topicIds ? '合并选题' : targetId ? '加入已有选题' : '创建选题' })
      setBusy(false)
      if (!result || result.errors?.length) return
      setDesk({ compose: null, sourceSelection: [], view: date ? 'schedule' : 'home' })
    }}>
      <p className="md-muted">先把素材组织成一个问题。此步只创建选题，不会生成内容或发布。</p>
      <ul className="md-compose-sources">{sources.map(row => <li key={row.id}>{row.title}</li>)}</ul>
      {!compose.topicIds ? <label className="md-field"><span>加入哪里</span><select value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">新建一个选题</option>{topics.map(row => <option key={row.id} value={row.id}>{row.title}{row.scheduledAt ? ` · ${fmtWhen(row.scheduledAt)}` : ''}</option>)}</select></label> : <p>合并后保留原始选题和素材，可用「撤销」恢复；日历只显示新的合辑。</p>}
      {!targetId ? <><label className="md-field"><span>选题标题 / 想解读的问题</span><input value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：海外利率与土地市场，给北京买房什么启发？" required maxLength={300} /></label>
        <label className="md-field"><span>你的分析角度（可选）</span><textarea rows={3} value={body} onChange={e => setBody(e.target.value)} placeholder="这些新闻有什么联系？要回答谁的什么问题？" /></label>
        <div className="md-field-row"><label className="md-field"><span>研究 / 创作日期（北京时间，可留空）</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label><label className="md-field"><span>目标平台</span><select value={platform} onChange={e => setPlatform(e.target.value)}>{['小红书','公众号','抖音','视频号','其他'].map(value => <option key={value}>{value}</option>)}</select></label></div></> : null}
      <div className="md-form-foot"><button className="md-btn" type="button" onClick={close}>取消</button><button className="md-btn is-primary" type="submit" disabled={busy || !sources.length}>{busy ? '保存中…' : targetId ? '加入已有选题' : date ? '创建并排期' : '加入灵感'}</button></div>
    </form>
  </Dialog>
}
