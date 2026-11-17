import React from 'react'
import { seriesWeek } from '../src/daily-topics.js'
import { loadDesk, openItem, readSeries, readEditorialWorkflow, pollEditorialWorkflow, proposeEditorial, reviewEditorial, requestEditorialBrowser, useDesk } from './desk.js'

const statuses = { waiting: '等素材', generating: '生成中', draft_saved: '已存草稿', needs_login: '待登录', uncertain: '待核对', failed: '待处理' }

export function EditorialSeries({ expanded = false }) {
  const [data, setData] = React.useState(null)
  const workflow = useDesk(s => s.state?.editorialWorkflow)
  const rules = useDesk(s => s.state?.skills)
  const [bridge, setBridge] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [topicId, setTopicId] = React.useState('')
  const [brief, setBrief] = React.useState('')
  const items = useDesk(s => s.state?.items)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let active = true
    const load = () => Promise.all([readSeries(), readEditorialWorkflow(), loadDesk()]).then(([result, bridgeStatus]) => {
      if (active) { setData(result); setBridge(bridgeStatus); setError('') }
    }).catch(error => { if (active) setError(error.message) })
    load()
    const timer = setInterval(load, 15000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const phaseNames = { idle: '等选题', awaiting_selection: '待选择题目', awaiting_topic_choice: '待选择题目', uncertain: '草稿待回读核对', discussing: '讨论中', awaiting_confirmation: '待确认创作', awaiting_creation_confirmation: '待确认创作', generating: '创作中', awaiting_review: '成稿待校对', ready_for_review: '成稿待校对', awaiting_browser_approval: '等待点击飞书确认卡', browser_approved: '已确认，待 Air 执行', deferred: '已暂缓存草稿', needs_review: '需要核对', failed: '待处理', draft_saved: '草稿已核验' }
  const current = items?.find(item => item.id === bridge?.activeTopicId)
  return <details className="md-editorial-series" open={expanded}>
    <summary>飞书选题 → 创作 → 电脑草稿 <span>先沟通确认，再创作</span></summary>
    <p>每天北京时间 {workflow?.dailyTime || '10:00'}，发送 {workflow?.dailyCount || 5} 个选题。当前由本机 Codex 调度，每日定时任务需要本机在线。</p>
    <ol><li>飞书选择题目并讨论，明确说“按这个方向开始写”即可创作，也可回复确认码。</li><li>联网研究、调用相关技能，创作后执行去 AI 味与事实校稿。</li><li>看完稿图，在飞书卡片点“确认保存草稿”或“暂不保存”，无需输入草稿确认码。卡片列明当前稿件、媒体数量和 Air / GPT-6.1 Terra。</li><li>重新打开草稿核对标题、正文和图片或视频，核验成功再通知本人发布。</li></ol>
    <p>拟执行电脑：{workflow?.browserDevice || '待确认'}；浏览器操作{workflow?.browserApproval === 'pending' ? '待确认' : '每次需确认'}。草稿保存在该电脑专用浏览器，本人点击公开发布。本次浏览器操作只保存草稿，完成后回读核验。</p>
    <section aria-label="飞书回复处理状态" aria-live="polite">
      <h4>飞书回复与创作进度</h4>
      <p>{bridge?.enabled ? '回复接收已开启 · 在 Air 的工作台运行' : '回复接收尚未开启'} · {phaseNames[bridge?.phase] || bridge?.phase || '等待连接'}</p>
      {bridge?.cardListener?.supported ? <p>{bridge.cardListener.ready ? '飞书确认按钮已连接。每次确认只对卡片对应的稿件版本有效。' : '飞书确认按钮正在连接，连接恢复后才能发送确认卡片。'}</p> : null}
      {bridge?.browserApproval === 'deferred' ? <p>本次已暂缓，稿件和配图仍保留在工作台，不会保存小红书草稿。</p> : null}
      {current ? <button type="button" className="md-link-btn" onClick={async () => { await loadDesk(); openItem(current.id) }}>{current.title} ↗</button> : null}
      {current?.editorialDiscussion?.length ? <details><summary>最近的飞书讨论</summary>{current.editorialDiscussion.slice(-6).map((message, index) => <section key={message.messageId || index}>
        <p><strong>{message.confirmed ? '已确认创作' : message.naturalWriteIntent ? '本次创作依据' : '你的回复'}</strong> · {message.at || message.receivedAt || ''}</p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p>
        {message.reply ? <p style={{ whiteSpace: 'pre-wrap' }}>工作台回复 · {message.reply}</p> : null}
        {message.needsReview ? <p className="md-error">消息已保存，回复处理需要重试。</p> : null}
      </section>)}</details> : null}
      {bridge?.batch?.phase === 'awaiting_topic_choice' ? <p>当前有 {bridge.batch.choices?.length || 0} 个候选题，请在飞书回复对应编号，选定后继续讨论。</p> : null}
      {bridge?.lastInboundAt ? <p>最近收到回复 {new Date(bridge.lastInboundAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</p> : null}
      {bridge?.lastSendError ? <p className="md-error" role="alert">飞书发送待重试 · {bridge.lastSendError}</p> : null}
      {current?.draftReceipt ? <p>最近交付 · {current.draftReceipt.status === 'draft_saved' ? '已保存并回读核验' : '尚未完成核验'}</p> : null}
      {bridge?.lastError ? <p className="md-error" role="alert">{bridge.lastError}</p> : null}
      <button type="button" className="md-btn" disabled={busy || !bridge?.enabled} onClick={async () => {
        setBusy(true); setError('')
        try { await pollEditorialWorkflow(); setBridge(await readEditorialWorkflow()); await loadDesk() }
        catch (err) { setError(err.message) }
        finally { setBusy(false) }
      }}>{busy ? '检查回复中…' : '立即检查飞书回复'}</button>
      {bridge?.phase === 'ready_for_review' && current ? <section>
        <p>成稿需要核对原文依据、文案和图卡。通过后会向飞书申请本次 Air 草稿操作。</p>
        <button type="button" className="md-btn" disabled={busy || !bridge?.artifactHash} onClick={async () => {
          setBusy(true); setError('')
          try { await reviewEditorial(current.id, bridge.artifactHash, 'passed'); await requestEditorialBrowser(current.id); setBridge(await readEditorialWorkflow()); await loadDesk() }
          catch (err) { setError(err.message) }
          finally { setBusy(false) }
        }}>已完成校对，发送飞书确认卡</button>
      </section> : null}
      <details><summary>发起一次飞书创作讨论</summary>
        <label className="md-field"><span>选题</span><select value={topicId} onChange={event => { const id = event.target.value; setTopicId(id); setBrief((typeof items?.find(row => row.id === id)?.editorialBrief === 'string' ? items.find(row => row.id === id).editorialBrief : items?.find(row => row.id === id)?.editorialBrief?.text) || items?.find(row => row.id === id)?.body || '') }}><option value="">选择已有选题</option>{(items || []).filter(row => row.recordType === 'topic' && !row.sample).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
        <label className="md-field"><span>这篇要怎么写</span><textarea rows={5} value={brief} onChange={event => setBrief(event.target.value)} placeholder="写清角度、目标读者、形式及要核实的问题" /></label>
        <button type="button" className="md-btn" disabled={busy || !bridge?.enabled || !topicId || !brief.trim()} onClick={async () => {
          setBusy(true); setError('')
          try { await proposeEditorial(topicId, brief.trim()); setBridge(await readEditorialWorkflow()); await loadDesk() }
          catch (err) { setError(err.message) }
          finally { setBusy(false) }
        }}>发到飞书讨论并确认</button>
      </details>
      <p>在当前选题里继续讨论，明确要求开始写就会进入创作；只选编号或讨论不会开写。写稿同意不包含电脑存稿或公开发布。退出工作台或电脑离线时，回复会等待下次启动处理。</p>
    </section>
    <details><summary>已保存的研究、写作与交付规则</summary>{(rules || []).filter(row => ['workflow-confirmation','research-routing','human-writing-review','draft-delivery'].includes(row.id)).map(row => <section key={row.id}><h4>{row.name}</h4><p>{row.rule}</p></section>)}<p>规则已供写作提示使用；专业技能自动编排与执行回执尚在接入。</p></details>
    <div className="md-daily-head"><p>旧的无人确认自动创作已停用。下面保留历史排期和同步回执。</p>
      <div className="md-daily-actions">
        <button type="button" className="md-btn" disabled={true} title="先在飞书确认本次电脑操作">浏览器操作待确认</button>
      </div></div>
    {error ? <p role="alert" className="md-error">{error}</p> : null}
    <ol className="md-series-list">{(data?.slots ?? seriesWeek()).map(slot => <li key={slot.date}>
      <span>{slot.date.slice(5)} · {slot.name}</span>
      <span>{statuses[slot.xhsStatus] || statuses[slot.status] || (slot.date < (data?.day ?? '') ? '已过' : '待排')}</span>
      {slot.title ? <button type="button" className="md-link-btn" onClick={async () => { await loadDesk(); openItem(slot.topicId) }}>{slot.title} ↗</button> : <small>{slot.brief}</small>}
      {slot.message ? <small>{slot.message}</small> : null}
    </li>)}</ol>
  </details>
}
