import React from 'react'
import { readOutlookReceipts, saveOutlookReviewDraft } from './desk.js'
import { Dialog, Empty, Icon } from './ui.jsx'

const chinaTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const formatTime = value => value && Number.isFinite(Date.parse(value)) ? chinaTime.format(new Date(value)) : '未知'
const searchLabels = { ok: '搜索正常', degraded: '搜索降级', unknown: '搜索状态未知' }
const queryFailures = {
  provider_search_failed: '搜索服务返回失败', provider_invalid_response: '搜索服务返回无法读取',
  provider_response_too_large: '搜索结果过大', provider_unavailable: '搜索服务不可用', timeout: '搜索超时',
}
const candidateKey = row => `${row.id}:${row.revision}`
const quantity = value => value ?? '未知'

function OriginalLink({ candidate }) {
  return <a href={candidate.source.url} target="_blank" rel="noopener noreferrer">打开原文 <Icon name="upRight" size={14} /></a>
}

function ReviewDialog({ candidate, draft, onClose, onSave }) {
  const [title, setTitle] = React.useState(draft?.title || candidate.source.title)
  const [summary, setSummary] = React.useState(draft?.summary || '')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const save = async event => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      onSave(await saveOutlookReviewDraft({ id: candidate.id, revision: candidate.revision, title, summary }))
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="审核新房动态" onClose={onClose} width={660}>
      <form className="md-form md-outlook-editor" onSubmit={save}>
        <div className="md-outlook-evidence">
          <strong>{candidate.source.title}</strong>
          <span>原文发布日期 {candidate.sourcePublishedAt || '未知'} · 采集于 {formatTime(candidate.observedAt)}</span>
          <OriginalLink candidate={candidate} />
        </div>
        <label className="md-field"><span>公开标题</span>
          <input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} />
        </label>
        <label className="md-field"><span>公开摘要</span>
          <textarea required rows={5} maxLength={1200} value={summary} onChange={event => setSummary(event.target.value)}
            placeholder="核对原文后，写明本项目发生了什么。" />
        </label>
        {error ? <p className="md-error" role="alert">{error}</p> : null}
        <div className="md-outlook-preview"><strong>小程序内容预览</strong><h3>{title.trim() || '填写标题'}</h3><p>{summary.trim() || '摘要将在这里显示。'}</p></div>
        <div className="md-form-foot">
          <button type="button" className="md-btn" onClick={onClose}>关闭</button>
          <button type="submit" className="md-btn is-primary" disabled={saving || !title.trim() || !summary.trim()}>{saving ? '保存中…' : '保存审核稿'}</button>
          <button type="button" className="md-btn" disabled>批准并发布</button>
        </div>
      </form>
    </Dialog>
  )
}

function RunRow({ run, expanded, onToggle, newestVersions, drafts, onReview, canReview }) {
  return (
    <li className="md-outlook-run">
      <button type="button" className="md-outlook-run-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="md-outlook-dot" data-state={run.searchState} aria-hidden="true" />
        <time dateTime={run.observedAt}>{formatTime(run.observedAt)}</time>
        <span className="md-outlook-badge" data-state={run.searchState}>{searchLabels[run.searchState] || searchLabels.unknown}</span>
        <span className="md-outlook-count">新增候选 {quantity(run.newCandidates)}</span>
        <Icon name={expanded ? 'chevD' : 'chevR'} size={15} />
      </button>
      {expanded ? (
        <div className="md-outlook-run-body">
          <dl className="md-outlook-metrics">
            <div><dt>失败查询 / 总查询</dt><dd>{quantity(run.failedQueries)} / {quantity(run.queryCount)}</dd></div>
            <div><dt>搜索发现并核验</dt><dd>{quantity(run.searchDiscoveredSources)}</dd></div>
            <div><dt>核验来源</dt><dd>{quantity(run.verifiedSources)}</dd></div>
            <div><dt>原文打开 / 失败</dt><dd>{quantity(run.openedSources)} / {quantity(run.failedFetches)}</dd></div>
          </dl>
          {run.searchState === 'degraded' ? <p className="md-outlook-note">搜索覆盖不完整。即使新增为 0，也可能漏掉消息。</p> : null}
          {run.queries?.length ? <details className="md-outlook-queries">
            <summary>查看查询明细</summary>
            <ul>{run.queries.map((query, index) => <li key={index}>
              <span>{query.query || `查询 ${index + 1}`}</span>
              <span>{query.status === 'ok' ? `返回 ${quantity(query.results)} 条` : query.status === 'failed' ? queryFailures[query.reason] || '搜索失败' : '状态未知'}</span>
            </li>)}</ul>
          </details> : null}
          {run.items.length ? (
            <ul className="md-outlook-candidates">{run.items.map(item => {
              const saved = drafts.get(candidateKey(item))
              const superseded = item.revision < newestVersions.get(item.id)
              const state = item.published ? '已发布' : superseded ? '历史版本' : saved ? '已保存审核稿'
                : ({ pending: '待审', approved: '已批准', rejected: '已驳回' }[item.reviewStatus] || '审核状态未知')
              return <li key={candidateKey(item)}>
                <div className="md-outlook-evidence">
                  <strong>{item.source.title}</strong>
                  <span>{item.discovery === 'seed' ? '历史基线' : item.discovery === 'search' ? '搜索发现' : '发现方式未知'} · {state} · 原文日期 {item.sourcePublishedAt || '未知'}</span>
                  <OriginalLink candidate={item} />
                </div>
                {item.reviewStatus === 'pending' && !item.published && !superseded ? (
                  <button type="button" className="md-btn is-small" disabled={!canReview} onClick={() => onReview(item)}>{saved ? '打开审核稿' : '填写审核稿'}</button>
                ) : null}
              </li>
            })}</ul>
          ) : null}
          {run.newCandidates > run.items.length ? <p className="md-muted">本轮有部分候选的明细无法关联到回执。</p> : null}
          {run.newCandidates === 0 && !run.items.length ? <p className="md-muted">本轮没有新增候选记录。</p> : null}
        </div>
      ) : null}
    </li>
  )
}

export function OutlookWorkbench() {
  const [data, setData] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [expanded, setExpanded] = React.useState(null)
  const [review, setReview] = React.useState(null)
  const [savedNotice, setSavedNotice] = React.useState('')
  const requestToken = React.useRef(0)
  const refresh = React.useCallback(async (force = false) => {
    const token = ++requestToken.current
    setBusy(true)
    try {
      const result = await readOutlookReceipts(force)
      if (requestToken.current !== token) return
      setError(result.error || '')
      setData(previous => result.receipt ? result : previous)
    } catch {
      if (requestToken.current === token) setError('无法读取采集回执，请刷新重试。')
    } finally {
      if (requestToken.current === token) setBusy(false)
    }
  }, [])
  React.useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) refresh() }, 60_000)
    refresh()
    return () => { ++requestToken.current; clearInterval(timer) }
  }, [refresh])

  const receipt = data?.receipt
  const runs = receipt?.runs ?? []
  const latest = runs[0]
  const drafts = new Map((data?.drafts ?? []).map(row => [candidateKey(row), row]))
  const newestVersions = new Map()
  for (const run of runs) for (const item of run.items) {
    newestVersions.set(item.id, Math.max(newestVersions.get(item.id) ?? 0, item.revision))
  }
  const activeInterval = receipt?.collector?.intervalSeconds
  const interval = activeInterval || receipt?.intervalSeconds
  const intervalText = interval > 0 ? interval % 3600 === 0 ? `${interval / 3600} 小时` : `${interval} 秒` : '未知'
  const collectorState = { running: '正在采集', waiting: '等待下次调度' }[receipt?.collector?.state]
  const canReview = !!receipt

  return (
    <section className="md-outlook" aria-label="新房动态工作台">
      <header className="md-outlook-head">
        <div><h2>新房动态</h2><p>酒仙桥 1019-0013-1 · 北京时间</p></div>
        <button type="button" className="md-btn" disabled={busy} onClick={() => refresh(true)}><Icon name="refresh" size={15} />{busy ? '读取中…' : '刷新回执'}</button>
      </header>
      {receipt ? <dl className="md-outlook-overview">
        <div><dt>{activeInterval ? '服务器运行间隔' : '服务器配置间隔'}</dt><dd>{intervalText}</dd></div>
        <div><dt>最近采集回执</dt><dd>{formatTime(latest?.observedAt)}</dd></div>
        <div><dt>回执数</dt><dd>{receipt.totalRuns}</dd></div>
        <div><dt>最近读取服务器</dt><dd>{formatTime(receipt.checkedAt)}</dd></div>
      </dl> : null}
      {collectorState ? <p className="md-muted">采集器{collectorState}。</p> : null}
      {error ? <p className="md-error" role="alert">{error}{receipt ? ' 下方保留上次读取的回执。' : ''}</p> : null}
      {receipt?.unreadableRuns ? <p className="md-outlook-note">{receipt.unreadableRuns} 轮回执读取失败。</p> : null}
      <div className="md-outlook-publish-status">
        <strong>小程序发布</strong><span>发布通道待接通，可先核对原文和保存审核稿。</span>
      </div>
      {savedNotice ? <p role="status" className="md-outlook-note">{savedNotice}</p> : null}
      {runs.length ? (
        <>
          <ol className="md-outlook-runs">{runs.map(run => (
            <RunRow key={run.id} run={run} expanded={expanded === null ? run.id === latest.id : expanded === run.id}
              onToggle={() => setExpanded((expanded === null ? run.id === latest.id : expanded === run.id) ? '' : run.id)}
              newestVersions={newestVersions} drafts={drafts} onReview={setReview} canReview={canReview} />
          ))}</ol>
          {receipt.totalRuns > runs.length ? <p className="md-muted">显示最近 {runs.length} 轮。</p> : null}
        </>
      ) : <Empty title={busy ? '正在读取服务器回执' : error ? '服务器回执暂不可用' : '当前没有采集回执'} />}
      {review ? <ReviewDialog key={candidateKey(review)} candidate={review} draft={drafts.get(candidateKey(review))}
        onClose={() => setReview(null)} onSave={draft => {
          ++requestToken.current
          setBusy(false)
          setData(previous => ({ ...previous, drafts: [...previous.drafts.filter(row => candidateKey(row) !== candidateKey(draft)), draft] }))
          setReview(null)
          setSavedNotice('审核稿已保存，等待发布通道接通。')
        }} /> : null}
    </section>
  )
}
