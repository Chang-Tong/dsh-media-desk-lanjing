import React from 'react'
import { DailyTopics } from './daily-topics.jsx'
import { EditorialSeries } from './series.jsx'
import { OutlookWorkbench } from './outlook-workbench.jsx'
import { dispatchOps, loadDesk, openItem, probeDataMcp, refreshServerInsights, setDesk, useDesk } from './desk.js'
import { composeSources, isMaterial, isTopic, sourceDrag, toggleSource } from './editorial.jsx'
import { Empty, Icon, IconButton } from './ui.jsx'
import { CHANNELS, channelLabel } from './util.js'
import editorialSources from '../data/editorial-sources.json'

const PAGE_SIZE = 24
const MAX_SELECTED = 20
const SECTIONS = [
  { id: 'library', label: '素材库', icon: 'list' },
  { id: 'topics', label: '今日选题', icon: 'spark' },
  { id: 'outlook', label: '新房动态', icon: 'clock' },
  { id: 'references', label: '参考来源', icon: 'link' },
  { id: 'progress', label: '创作进度', icon: 'branch' },
]
const CHANNEL_FILTERS = [{ id: 'all', label: '全部频道' }, ...CHANNELS]
const referenceSources = editorialSources.sources.filter(source => source.enabled)
const collectedDay = item => (item.date || item.createdAt || '').slice(0, 10)

function SourceRow({ item, selected, used }) {
  return (
    <li className={`md-src-row${selected ? ' is-selected' : ''}`} draggable onDragStart={event => sourceDrag(event, item.id)}>
      <input type="checkbox" aria-label={`选择 ${item.title}`} checked={selected} onChange={() => toggleSource(item.id)} />
      <div className="md-src-main">
        <div className="md-src-meta">
          <span className="md-src-category">{channelLabel(item.channel)}</span>
          {item.source ? <span>{item.source}</span> : null}
        </div>
        <h3><button type="button" className="md-src-title" onClick={() => setDesk({ sourcePreview: item.id })}>{item.title}</button></h3>
        {item.body ? <p className="md-src-body">{item.body}</p> : null}
        {used.length ? <div className="md-source-topics">{used.map(topic => (
          <button key={topic.id} type="button" onClick={() => openItem(topic.id)}>{topic.title} ↗</button>
        ))}</div> : null}
      </div>
      <div className="md-src-actions">
        <button type="button" className="md-btn is-small" onClick={() => composeSources([item.id])}><Icon name="plus" size={13} />加入选题</button>
        {item.url ? <a className="md-icon-btn" href={item.url} target="_blank" rel="noopener noreferrer" aria-label="打开原文" title="打开原文"><Icon name="upRight" size={15} /></a> : null}
        <IconButton icon="trash" label={`删除素材 ${item.title}`} disabled={used.length > 0} title={used.length ? '已被选题引用' : '删除素材'}
          onClick={() => dispatchOps([{ op: 'delete_item', id: item.id }], { label: '删除素材' })} />
      </div>
    </li>
  )
}

function ServerConnection() {
  const dataStatus = useDesk(s => s.dataStatus)
  const [busy, setBusy] = React.useState(false)
  const run = async action => {
    setBusy(true)
    try { await action() } finally { setBusy(false) }
  }
  return (
    <section className="md-data-connect" aria-label="服务器数据">
      <div><h2>服务器数据</h2><p role="status">{busy ? '查询中…' : dataStatus?.status === 'ok' ? '只读连接正常' : dataStatus?.message || dataStatus?.gaps?.[0]?.message || dataStatus?.status || '可按需检查连接或读取最新数据'}</p></div>
      <button type="button" className="md-btn" disabled={busy} onClick={() => run(probeDataMcp)}>检查连接</button>
      <button type="button" className="md-btn is-primary" disabled={busy} onClick={() => run(refreshServerInsights)}>读取最新数据</button>
    </section>
  )
}

function SourceLibrary({ items }) {
  const sourceRuns = useDesk(s => s.state.sourceRuns)
  const selected = useDesk(s => s.sourceSelection)
  const [channel, setChannel] = React.useState('all')
  const [usage, setUsage] = React.useState('all')
  const [query, setQuery] = React.useState('')
  const [limit, setLimit] = React.useState(PAGE_SIZE)
  const { feed, usageMap, counts } = React.useMemo(() => {
    const materials = []
    const links = new Map()
    const counts = new Map()
    for (const item of items) {
      if (isMaterial(item)) {
        materials.push(item)
        counts.set(item.channel, (counts.get(item.channel) ?? 0) + 1)
      } else if (isTopic(item)) {
        for (const id of new Set(item.sourceIds ?? [])) {
          if (!links.has(id)) links.set(id, [])
          links.get(id).push(item)
        }
      }
    }
    counts.set('all', materials.length)
    materials.sort((a, b) => collectedDay(b).localeCompare(collectedDay(a)))
    return { feed: materials, usageMap: links, counts }
  }, [items])
  const rows = React.useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return feed.filter(row => (channel === 'all' || channel === row.channel)
      && (usage === 'all' || usageMap.has(row.id) === (usage === 'used'))
      && (!keyword || [row.title, row.body, row.source, ...(row.tags ?? [])].join(' ').toLowerCase().includes(keyword)))
  }, [feed, channel, usage, query, usageMap])

  const selectedSet = new Set(selected)
  const selectedRows = feed.filter(row => selectedSet.has(row.id))
  const visible = rows.slice(0, limit)
  const batchIds = visible.slice(0, MAX_SELECTED).map(row => row.id)
  const allChecked = batchIds.length > 0 && batchIds.every(id => selectedSet.has(id))
  const groups = new Map()
  for (const row of visible) {
    const date = collectedDay(row)
    if (!groups.has(date)) groups.set(date, [])
    groups.get(date).push(row)
  }

  const changeFilter = setter => value => {
    setter(value)
    setLimit(PAGE_SIZE)
  }
  const clearFilters = () => {
    setChannel('all')
    setUsage('all')
    setQuery('')
    setLimit(PAGE_SIZE)
  }
  const toggleBatch = () => setDesk({
    sourceSelection: allChecked
      ? selected.filter(id => !batchIds.includes(id))
      : [...new Set([...selected, ...batchIds])].slice(0, MAX_SELECTED),
  })

  return (
    <div className="md-source-library">
      <div className="md-src-channels" role="group" aria-label="素材频道">
        {CHANNEL_FILTERS.map(entry => (
          <button key={entry.id} type="button" aria-pressed={channel === entry.id} onClick={() => changeFilter(setChannel)(entry.id)}>
            <span>{entry.label}</span><span className="md-src-count">{counts.get(entry.id) ?? 0}</span>
          </button>
        ))}
      </div>
      <section className="md-src-results" aria-label="素材列表">
        <div className="md-source-tools">
          <label className="md-search">
            <Icon name="search" size={16} /><input type="search" aria-label="搜索灵感源" value={query} onChange={event => changeFilter(setQuery)(event.target.value)} placeholder="搜索标题、摘要、来源" />
          </label>
          <select className="md-source-filter" aria-label="使用状态" value={usage} onChange={event => changeFilter(setUsage)(event.target.value)}>
            <option value="all">全部状态</option><option value="new">待使用</option><option value="used">已加入选题</option>
          </select>
        </div>
        <div className="md-source-selection">
          <label><input type="checkbox" checked={allChecked} disabled={!batchIds.length || (!allChecked && selected.length >= MAX_SELECTED)}
            onChange={toggleBatch} />批量选择</label>
          <span className="md-muted" aria-live="polite">{selectedRows.length ? `已选 ${selectedRows.length} / ${MAX_SELECTED}` : `${rows.length} 条素材`}</span>
          {selectedRows.length ? (
            <div className="md-source-selection-actions">
              <button type="button" className="md-btn is-primary is-small" onClick={() => composeSources(selectedRows.map(row => row.id))}>合并为一个选题</button>
              <button type="button" className="md-btn is-small" onClick={() => setDesk({ view: 'schedule' })}>去排期</button>
              <button type="button" className="md-link-btn" onClick={() => setDesk({ sourceSelection: [] })}>清空</button>
            </div>
          ) : null}
        </div>
        {channel === 'server-insights' ? <ServerConnection /> : null}
        {channel !== 'all' && sourceRuns?.[channel]?.note ? (
          <details className="md-source-note"><summary>最近采集说明</summary><p>{sourceRuns[channel].note}</p></details>
        ) : null}
        {rows.length ? [...groups].map(([day, entries]) => (
          <section key={day} className="md-src-group">
            <h2>{day ? <><time dateTime={day}>{day}</time><span>收集日期</span></> : '收集日期未知'}</h2>
            <ul className="md-src-list">{entries.map(item => (
              <SourceRow key={item.id} item={item} selected={selectedSet.has(item.id)} used={usageMap.get(item.id) ?? []} />
            ))}</ul>
          </section>
        )) : (
          <div className="md-source-empty">
            <Empty title={feed.length ? '没有匹配的素材' : '素材库还没有内容'} hint={feed.length ? '试试更换关键词或筛选条件。' : '采集完成后，素材会显示在这里。'} />
            {feed.length && (query || channel !== 'all' || usage !== 'all') ? <button className="md-btn" type="button" onClick={clearFilters}>清除筛选</button> : null}
          </div>
        )}
        {rows.length > visible.length ? (
          <div className="md-source-more">
            <span className="md-muted">已显示 {visible.length} / {rows.length} 条</span>
            <button type="button" className="md-btn" onClick={() => setLimit(limit + PAGE_SIZE)}>显示更多</button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function ReferenceSources() {
  return (
    <section className="md-source-references" aria-label="选题参考来源">
      <ul>{referenceSources.map(source => (
        <li key={source.id}><h2>{source.name}</h2><p>{source.scope}</p>
          {source.identityStatus === 'awaiting_account_confirmation' ? <small>具体账号待核对</small> : null}
        </li>
      ))}</ul>
    </section>
  )
}

export function SourcesView() {
  const items = useDesk(s => s.state.items)
  const [section, setSection] = React.useState('library')
  const [refreshing, setRefreshing] = React.useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try { await loadDesk() } finally { setRefreshing(false) }
  }
  return (
    <div className="md-page md-sources-page">
      <div className="md-sources-inner">
        <header className="md-sources-head">
          <div><h1>灵感源</h1><p>整理新闻与数据，找到值得写的选题。</p></div>
          <div className="md-sources-head-actions">
            <button className="md-btn" type="button" disabled={refreshing} onClick={refresh}><Icon name="refresh" size={15} />{refreshing ? '刷新中…' : '刷新素材'}</button>
            <button className="md-btn" type="button" onClick={() => setDesk({ view: 'schedule' })}><Icon name="calendar" size={15} />日历排期</button>
          </div>
        </header>
        <div className="md-sources-nav" role="group" aria-label="灵感源视图">
          {SECTIONS.map(entry => (
            <button key={entry.id} type="button" aria-pressed={section === entry.id} onClick={() => setSection(entry.id)}>
              <Icon name={entry.icon} size={16} />{entry.label}
            </button>
          ))}
        </div>
        <div hidden={section !== 'library'}><SourceLibrary items={items} /></div>
        {section === 'topics' ? <DailyTopics items={items} /> : null}
        {section === 'outlook' ? <OutlookWorkbench /> : null}
        {section === 'references' ? <ReferenceSources /> : null}
        {section === 'progress' ? <EditorialSeries expanded /> : null}
      </div>
    </div>
  )
}
