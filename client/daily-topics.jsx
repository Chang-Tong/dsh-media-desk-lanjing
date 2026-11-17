import React from 'react'
import { DAILY_SOURCES, dailyTopics, beijingDay } from '../src/daily-topics.js'
import { CHANNELS } from './util.js'
import { createDailyTopic, openItem, setDesk, useDesk } from './desk.js'
import { Icon } from './ui.jsx'

export function DailyTopics({ items }) {
  const source = useDesk(s => s.dailySource)
  const [today, setToday] = React.useState(beijingDay)
  const [opening, setOpening] = React.useState(null)
  React.useEffect(() => {
    const update = () => setToday(beijingDay())
    const timer = setInterval(update, 60_000)
    window.addEventListener('focus', update)
    return () => { clearInterval(timer); window.removeEventListener('focus', update) }
  }, [])
  const { day, topics } = React.useMemo(() => dailyTopics(items, source, new Date(today + 'T12:00:00+08:00')), [items, source, today])
  const pick = async topic => {
    if (topic.topicId) return openItem(topic.topicId)
    setOpening(topic.id)
    try {
      const id = await createDailyTopic(topic.id, source)
      if (id) openItem(id)
    } finally { setOpening(null) }
  }
  return <section className="md-daily-topics" aria-labelledby="md-daily-heading">
    <div className="md-daily-head"><div><h2 id="md-daily-heading">今日选题</h2>
      <p>{day} · 北京时间 · 近 7 天素材 · {topics.length} 条推荐</p></div>
      <div className="md-daily-actions"><label className="md-field"><span>灵感来源</span><select value={source} disabled={Boolean(opening)} onChange={event => setDesk({ dailySource: event.target.value })}>
        {DAILY_SOURCES.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
        <optgroup label="按素材频道">{CHANNELS.filter(row => row.id !== 'writing-prompts').map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</optgroup>
      </select></label></div>
    </div>
    {topics.length ? <ol className="md-daily-list">
      {topics.map(topic => <li key={topic.id}>
        <div><h3>{topic.title}</h3><p>{topic.angle}</p>
          <small>{topic.label} · {topic.date} · {topic.source}{!topic.verified ? ' · 待核原文' : ''}</small></div>
        <div className="md-daily-actions"><button type="button" className="md-link-btn" onClick={() => setDesk({ sourcePreview: topic.id })}>看素材</button>
          <button type="button" className="md-btn is-primary" disabled={Boolean(opening)} onClick={() => pick(topic)}><Icon name={topic.topicId ? 'pen' : 'plus'} size={13} />{topic.topicId ? '继续创作' : opening === topic.id ? '正在打开…' : '选这个题'}</button></div>
      </li>)}
    </ol> : <p className="md-muted">这个来源近 7 天没有符合条件的素材。可以切换来源，或在素材库查看历史记录。</p>}
  </section>
}
