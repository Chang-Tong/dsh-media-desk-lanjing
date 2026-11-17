// 新闻可成组选入某天；排期只组织工作，打开选题后才分析与生成。
import React from 'react'
import { dispatchOps, openItem, setDesk, useDesk } from './desk.js'
import { composeSources, isMaterial, isTopic, sourceDrag, sourceIdsFrom, toggleSource, ITEM_DRAG } from './editorial.jsx'
import { Icon, IconButton } from './ui.jsx'
import { dayKey, displayItem, fmtDate, fmtTime, posterOf, relativeDay } from './util.js'

const WEEK = ['周日','周一','周二','周三','周四','周五','周六']
function startDrag(event, id) { event.dataTransfer.setData(ITEM_DRAG, id); event.dataTransfer.effectAllowed = 'move' }
function moveTo(items, id, date) {
  const item = items.find(i => i.id === id)
  if (!item) return
  const key = dayKey(date)
  const target = new Date(`${key}T20:00:00+08:00`)
  dispatchOps([{ op: 'schedule_item', id, scheduledAt: target.toISOString() }], { label: '修改创作排期' })
}
function Thumb({ item }) { const poster = posterOf(displayItem(item)); return <span className="md-cal-thumb">{poster ? <img src={poster} alt="" draggable={false} loading="lazy" /> : <Icon name="pen" size={13} />}</span> }
function Chip({ item }) {
  return <button type="button" className={`md-cal-chip status-${item.status}`} draggable title={item.title} onDragStart={event => startDrag(event, item.id)} onClick={event => { event.stopPropagation(); openItem(item.id) }}><Thumb item={item} /><span className="md-cal-chip-text"><time>{fmtTime(item.scheduledAt)}</time><span>{displayItem(item).title}</span></span></button>
}

export function ScheduleView() {
  const allItems = useDesk(s => s.state.items)
  const sourceSelection = useDesk(s => s.sourceSelection)
  const items = React.useMemo(() => allItems.filter(row => isTopic(row) && !row.parentId), [allItems])
  const feed = React.useMemo(() => allItems.filter(isMaterial), [allItems])
  const [cursor, setCursor] = React.useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [over, setOver] = React.useState(null)
  const [selectedDay, setSelectedDay] = React.useState(() => dayKey(new Date()))
  const [topicSelection, setTopicSelection] = React.useState([])
  const [query, setQuery] = React.useState('')
  const y = cursor.getFullYear(), m = cursor.getMonth()
  const first = new Date(y, m, 1).getDay()
  const cellCount = Math.ceil((first + new Date(y, m + 1, 0).getDate()) / 7) * 7
  const cells = Array.from({ length: cellCount }, (_, index) => new Date(y, m, index - first + 1))
  const byDay = React.useMemo(() => {
    const result = new Map()
    for (const item of items) if (item.scheduledAt) { const key = dayKey(item.scheduledAt); if (!result.has(key)) result.set(key, []); result.get(key).push(item) }
    return result
  }, [items])
  const posts = byDay.get(selectedDay) ?? []
  const waiting = items.filter(row => !row.scheduledAt && row.status !== 'published')
  const sources = feed.filter(row => [row.title, row.source].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const selectedSourceIds = feed.filter(row => sourceSelection.includes(row.id)).map(row => row.id)
  const selectedTopics = posts.filter(row => topicSelection.includes(row.id))
  const selectedSourceUnion = [...new Set(selectedTopics.flatMap(row => row.sourceIds ?? []))]
  const dateIso = new Date(`${selectedDay}T20:00:00+08:00`).toISOString()
  return <div className="md-board-page"><div className="md-schedule">
    <div className="md-calendar-main"><section className="md-tile md-cal-tile">
      <header className="md-cal-head"><div className="md-cal-num">{String(m + 1).padStart(2, '0')}</div><div className="md-cal-month"><span>{y}</span><em>创作日历</em></div><p className="md-muted">新闻拖到某天后组成选题；当天打开，再分析生成。</p><span className="md-grow" />
        <IconButton icon="chevL" label="上个月" onClick={() => setCursor(new Date(y,m-1,1))} /><button className="md-pill is-small" onClick={() => { const now = new Date(); setCursor(new Date(now.getFullYear(), now.getMonth(),1)); setSelectedDay(dayKey(now)) }}>今天</button><IconButton icon="chevR" label="下个月" onClick={() => setCursor(new Date(y,m+1,1))} />
      </header><div className="md-cal-weeks">{WEEK.map(w => <span key={w}>{w}</span>)}</div>
      <div className="md-cal-grid" role="grid" style={{ '--rows': cellCount / 7 }}>{cells.map(date => { const key=dayKey(date); const daily=byDay.get(key) ?? []; return <div key={key} role="gridcell" aria-label={`${key}，${daily.length}个选题`} tabIndex={0} className={`md-cal-cell ${date.getMonth() !== m ? 'is-outside' : ''} ${key === dayKey(new Date()) ? 'is-today' : ''} ${selectedDay === key ? 'is-selected' : ''} ${over === key ? 'is-over' : ''}`}
        onClick={() => { setSelectedDay(key); setTopicSelection([]) }} onKeyDown={e => { if(e.key==='Enter') { setSelectedDay(key); setTopicSelection([]) } }}
        onDragOver={e => { e.preventDefault(); setOver(key) }} onDragLeave={() => setOver(null)} onDrop={e => { e.preventDefault(); setOver(null); setSelectedDay(key); const ids=sourceIdsFrom(e); if(ids.length) composeSources(ids,new Date(`${key}T20:00:00+08:00`).toISOString()); else { const id=e.dataTransfer.getData(ITEM_DRAG); if(id) moveTo(items,id,date) } }}>
        <div className="md-cal-cell-top"><span className="md-cal-date">{date.getDate()}</span><span className="md-muted">{daily.length ? `${daily.length} 题` : ''}</span></div><div className="md-cal-posts">{daily.slice(0,2).map(row => <Chip key={row.id} item={row} />)}{daily.length>2 ? <button type="button" className="md-cal-more" onClick={e => { e.stopPropagation(); setSelectedDay(key) }}>查看全部 {daily.length} 个选题</button> : null}</div>
      </div> })}</div>
    </section>
    <section className="md-tile md-day-plan"><header className="md-section-head"><div><h2>{selectedDay} · 创作计划</h2><p className="md-muted">共 {posts.length} 个选题，点击打开素材、选择平台与生成形式。</p></div><span className="md-grow" /><button className="md-btn is-primary" disabled={!selectedSourceIds.length} onClick={() => composeSources(selectedSourceIds,dateIso)}>把已选 {selectedSourceIds.length} 条素材排到这天</button></header>
      {posts.length ? <><div className="md-day-actions"><button className="md-btn" disabled={selectedTopics.length<2 || !selectedSourceUnion.length} onClick={() => setDesk({ compose: { sourceIds: selectedSourceUnion, topicIds: selectedTopics.map(row => row.id), scheduledAt: dateIso } })}>将勾选的 {selectedTopics.length} 个选题合并解读</button></div><ul className="md-day-list">{posts.map(row => <li key={row.id}><input type="checkbox" aria-label={`合并 ${row.title}`} checked={topicSelection.includes(row.id)} onChange={event => setTopicSelection(event.target.checked ? [...topicSelection,row.id] : topicSelection.filter(id=>id!==row.id))} /><div><button className="md-src-title" onClick={() => openItem(row.id)}>{row.title}</button><span className="md-muted">{row.sourceIds?.length || 0} 条素材 · {row.platform || '待选平台'} · {row.production?.status==='done' ? '已有稿件' : '待研究'}</span></div><button className="md-btn is-primary" onClick={() => openItem(row.id)}>打开选题</button><button className="md-btn" onClick={() => dispatchOps([{op:'schedule_item',id:row.id,scheduledAt:null}],{label:'取消排期'})}>取消排期</button></li>)}</ul></> : <p className="md-tray-empty">这天还没有选题。从右侧多选新闻后拖到日历，或拖入已有灵感。</p>}
    </section></div>
    <aside className="md-rail-col"><section className="md-tile md-tray"><header className="md-tile-head"><h2>灵感源素材</h2><span className="md-tile-meta">多选后一起拖拽</span></header><div className="md-tray-scroll"><label className="md-search"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索新闻" aria-label="搜索排期素材" /></label><p className="md-muted">已选 {selectedSourceIds.length} 条 <button className="md-pill" onClick={() => setDesk({sourceSelection:[]})}>清空</button></p><div className="md-tray-list">{sources.map(row => <div key={row.id} className={`md-source-tray ${sourceSelection.includes(row.id)?'is-selected':''}`} draggable onDragStart={e=>sourceDrag(e,row.id)}><input type="checkbox" aria-label={`选择排期素材 ${row.title}`} checked={sourceSelection.includes(row.id)} onChange={()=>toggleSource(row.id)} /><button onClick={()=>setDesk({sourcePreview:row.id})}>{row.title}</button></div>)}</div></div></section>
      <section className="md-tile md-tray" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault(); const id=e.dataTransfer.getData(ITEM_DRAG); if(id) dispatchOps([{op:'schedule_item',id,scheduledAt:null}],{label:'取消排期'})}}><header className="md-tile-head"><h2>已有灵感 · 待排期</h2></header><div className="md-tray-scroll"><div className="md-tray-list">{waiting.map(row=><button key={row.id} draggable className="md-tray-item" onDragStart={e=>startDrag(e,row.id)} onClick={()=>openItem(row.id)}><Thumb item={row} /><span>{row.title}</span></button>)}</div>{!waiting.length ? <p className="md-tray-empty">先从灵感源创建选题。</p> : null}</div></section>
    </aside>
  </div></div>
}
