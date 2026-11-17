import React from 'react'
import { connectXhs, dispatchOps, probeDataMcp, relayoutCards, runProduce, saveProduced, setDesk, syncXhsDraft, toast, useDesk } from './desk.js'
import { Dialog, Icon } from './ui.jsx'
import { fmtWhen, renderMarkdown, toLocalInput } from './util.js'

export const FORMAT_LABEL = { text: '纯文案', guizang: '归藏 3:4 图文', video: '视频脚本 / 分镜' }

export function GenerationOptions({ item }) {
  const busy = item.production?.status === 'running'
  const status = useDesk(s => s.dataStatus)
  const [checking, setChecking] = React.useState(false)
  const set = patch => dispatchOps([{ op: 'update_item', id: item.id, ...patch }], { label: '修改生成选项', silent: true })
  const format = item.outputFormat || 'text'
  return <div className="md-generation-options">
    <label className="md-field"><span>目标平台</span><select aria-label="目标平台" disabled={busy} value={item.platform || '小红书'} onChange={e => set({ platform: e.target.value })}>{['小红书','公众号','抖音','视频号','其他'].map(value => <option key={value}>{value}</option>)}</select></label>
    <label className="md-field"><span>生成形式</span><select aria-label="生成形式" disabled={busy} value={format} onChange={e => set({ outputFormat: e.target.value })}>{Object.entries(FORMAT_LABEL).map(([id,label]) => <option value={id} key={id}>{label}</option>)}</select></label>
    <p className="md-idea-hint">{format === 'text' ? '只生成所选平台的文字，不调用生图。' : format === 'guizang' ? '调用已安装的归藏卡片 Skill，用 HTML 排版并导出 1080×1440 PNG，无需生图模型。' : '生成口播与分镜脚本；接入生图后可画封面与分镜，暂不渲染成片。'}</p>
    <label className="md-generation-data"><input type="checkbox" disabled={busy} checked={item.useData === true} onChange={e => set({ useData: e.target.checked })} />先查询 data MCP，结合数据库分析</label>
    <div className="md-generation-connection"><span>{status ? status.status === 'ok' ? '只读 MCP 已连接' : status.message || status.gaps?.[0]?.message || status.status : '生成时会按需连接 MCP'}</span><button className="md-link-btn" disabled={checking || busy} onClick={async()=>{setChecking(true);await probeDataMcp();setChecking(false)}}>{checking?'检查中…':'检查连接'}</button></div>
    <label className="md-field"><span>研究 / 创作排期</span><input type="datetime-local" aria-label="创作日期" disabled={busy} value={toLocalInput(item.scheduledAt)} onChange={e => set({ scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label>
    <button className="md-go" disabled={busy} onClick={() => runProduce(item.id, { platform: item.platform || '小红书', format, useData: item.useData === true })}>{busy ? '正在研究 / 生成…' : item.production?.status === 'done' ? '按当前选项重新生成' : item.useData ? '查询数据并生成' : '生成内容'}</button>
    {item.production?.outdated ? <p className="md-idea-hint is-error">素材已更新，当前稿件尚未包含新增素材，请重新生成。</p> : null}
    {item.production?.layoutOutdated ? <p className="md-idea-hint is-error">文案已修改，旧图卡未包含修改。<button className="md-link-btn" disabled={busy} onClick={() => relayoutCards(item.id)}>按当前文案重新排版</button></p> : null}
    {item.sourceMaterials?.length ? <details className="md-source-bundle" open><summary>本选题的 {item.sourceMaterials.length} 条素材</summary><ol>{item.sourceMaterials.map((row,i)=><li key={row.id || i}>{row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.title} ↗</a> : row.title}<p>{row.source} {row.date || ''}</p><button className="md-link-btn" onClick={() => setDesk({sourcePreview:row.id})}>核对素材</button></li>)}</ol></details> : <p className="md-idea-hint">可在「灵感源」多选新闻，加入这个已有选题。</p>}
  </div>
}

export function ResearchEvidence({ research }) {
  if (!research) return null
  return <details className="md-research-evidence"><summary>数据库核查 · {research.status === 'ok' ? '已取得只读证据' : '尚有缺口'} · {research.fetchedAt ? fmtWhen(research.fetchedAt) : ''}</summary>
    {research.gaps?.map((row,i)=><p className="md-idea-hint is-error" key={i}>{row.message || String(row)}</p>)}
    {research.facts?.map((row,i)=><details key={i}><summary>{row.tool}</summary><pre>{JSON.stringify(row.result,null,2)}</pre></details>)}
  </details>
}

function XhsDraftActions({ item, disabled }) {
  const workflow = useDesk(s => s.state?.editorialWorkflow)
  const [busy, setBusy] = React.useState('')
  const [message, setMessage] = React.useState(null)
  const [retry, setRetry] = React.useState(false)
  const receipt = item.draftReceipt || item.xhsDraft
  const status = message?.status ?? receipt?.status
  const uncertain = status === 'syncing' || status === 'uncertain'
  const hasCards = Boolean(item.production?.cards?.length) && item.production?.format === 'guizang'
  const awaitingRunner = workflow?.browserRequiresConfirmation === true
  const block = disabled || !hasCards || item.production?.outdated || item.production?.layoutOutdated || awaitingRunner
  const run = async (kind, retryUncertain = false) => {
    setBusy(kind)
    try {
      if (kind === 'login') {
        setMessage({ status: 'needs_login', message: '请在独立浏览器窗口按小红书提示完成登录。' })
        const result = await connectXhs()
        setMessage({ status: result.loggedIn ? 'connected' : 'needs_login', message: result.message })
      } else setMessage(await syncXhsDraft(item.id, retryUncertain))
    } catch (error) { setMessage({ status: uncertain ? 'uncertain' : 'error', message: error.message }) }
    finally { setBusy('') }
  }
  return <div className="md-xhs-draft">
    {awaitingRunner ? <p role="status">电脑草稿操作需先确认本次稿件、{workflow.browserDevice || '执行电脑'}与 GPT-6.1 Terra。请在灵感源上方的飞书流程中校对成稿、申请本次确认；回到飞书确认后等待 Air 执行。公开发布由你本人完成。</p> : null}
    <div className="md-written-actions">
      <button type="button" className="md-btn is-primary" disabled={block || Boolean(busy)} onClick={() => uncertain ? setRetry(true) : run('save')}><Icon name="upload" size={14} />{busy === 'save' ? '正在存草稿…' : '同步到小红书草稿箱'}</button>
      {status === 'needs_login' && !awaitingRunner ? <button type="button" className="md-btn" disabled={Boolean(busy)} onClick={() => run('login')}>{busy === 'login' ? '等待登录…' : '登录小红书'}</button> : null}
      {uncertain ? <p>请在保存时使用的专用浏览器里核对草稿，普通浏览器或手机端可能看不到。</p> : null}
    </div>
    <p className={['error', 'failed', 'needs_login', 'uncertain', 'syncing'].includes(status) ? 'md-error' : 'md-muted'} role="status">{message?.message || receipt?.message || (item.draftReceipt?.status === 'draft_saved' ? `历史保存记录 · ${item.draftReceipt.draftTitle || item.production?.title || item.title} · Air · 标题、正文与媒体已回读核验` : uncertain ? '上次同步没有回执，请先核对草稿箱。' : !hasCards ? '生成归藏 3:4 图文后即可同步。' : '只存草稿，不发布。')}</p>
    {retry ? <Dialog title="草稿箱核对" onClose={() => setRetry(false)}>
      <div className="md-form"><p>如果草稿箱里已有这篇，就不用再同步。只有确认没有，才需要重试。</p>
        <div className="md-form-foot"><button className="md-btn" onClick={() => setRetry(false)}>取消</button>
          <button className="md-btn is-primary" onClick={() => { setRetry(false); run('save', true) }}>已核对，没有这篇；重试</button></div></div>
    </Dialog> : null}
  </div>
}

/** 非视频输出不显示封面/分镜占位，交付物直接可复制和下载。 */
export function WrittenSheet({ item, live }) {
  const production=item.production
  const text=production?.article || live?.text || ''
  const [draft,setDraft]=React.useState(text)
  const title = production?.title || item.title
  const [draftTitle, setDraftTitle] = React.useState(title)
  const [editing,setEditing]=React.useState(false)
  const [saving,setSaving]=React.useState(false)
  const [committing,setCommitting]=React.useState(false)
  React.useEffect(() => { if (!editing) { setDraft(text); setDraftTitle(title) } }, [text, title, editing])
  const done=production?.status==='done'
  return <div className="md-sheet"><div className="md-written-sheet">
    <header><p className="md-muted">{production?.platform || item.platform || '小红书'} · {FORMAT_LABEL[production?.format || item.outputFormat || 'text']}</p><h1>{production?.title || item.title}</h1>
      <div className="md-written-actions"><button className="md-btn" disabled={!text} onClick={async()=>{await navigator.clipboard.writeText(`# ${production?.title || item.title}\n\n${text}`);toast('文案已复制')}}><Icon name="copy" size={14} />复制文案</button>
        <button className="md-btn" disabled={!done || committing} onClick={async () => {
          if (!editing) { setEditing(true); return }
          if (!draftTitle.trim() || !draft.trim()) { toast('标题和正文不能为空。', { error: true }); return }
          if (draft !== text || draftTitle.trim() !== title) {
            setCommitting(true)
            const result = await dispatchOps([{ op: 'update_production', id: item.id, title: draftTitle.trim(), article: draft }], { label: '修改文案', silent: true })
            setCommitting(false)
            if (!result || result.errors?.length) return
          }
          setEditing(false)
        }}>{editing?'保存编辑':'编辑文案'}</button>
        <button className="md-btn is-primary" disabled={!done || saving || editing} onClick={async()=>{setSaving(true);await saveProduced(item.id);setSaving(false)}}>{saving?'保存中…':'保存文案 / 图文包'}</button></div>
    </header>
    {done && production.platform === '小红书' ? <XhsDraftActions key={item.id} item={item} disabled={editing} /> : null}
    <ResearchEvidence research={production?.research} />
    {production?.error ? <p className="md-error">{production.error}</p> : null}
    {!text ? <div className="md-written-empty"><Icon name="pen" size={28} /><h2>{production?.status==='running'?'正在核查素材并生成内容':'确定今天要回答的问题'}</h2><p>左侧选择平台、输出形式与是否查询数据库，然后开始生成。</p></div>
      : editing ? <div className="md-form">
        <label className="md-field"><span>标题{production.platform === '小红书' ? '（最多 20 字）' : ''}</span><input value={draftTitle} maxLength={production.platform === '小红书' ? 20 : 200} onChange={e => setDraftTitle(e.target.value)} /></label>
        <textarea className="md-written-editor" aria-label="编辑平台文案" value={draft} onChange={e=>setDraft(e.target.value)} />
      </div>
        : <article className="md-prose" dangerouslySetInnerHTML={{__html:renderMarkdown(text)}} />}
    {production?.cards?.length ? <section className="md-output-cards"><header><h2>归藏 3:4 图文 · {production.cards.length} 张</h2><p className="md-muted">1080 × 1440 · HTML 排版导出</p></header><div>{production.cards.map((row,i)=><figure key={row.src || i}><a href={row.src} target="_blank" rel="noopener noreferrer"><img src={row.src} alt={row.title || `第${i+1}页`} /></a><figcaption>{i+1}. {row.title} <a href={row.src} download>下载 PNG</a></figcaption></figure>)}</div>{production.cardHtml?.src ? <a className="md-btn" href={production.cardHtml.src} target="_blank" rel="noopener noreferrer">查看卡片 HTML</a> : null}</section> : null}
  </div></div>
}
