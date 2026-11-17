// 技能：分仓技能仓 skills/ 里的项目技能。
// 真本只有一份（RealEstateIntelligent-skill/skills/），Host 半边通过 DSH 技能服务读出来；
// 版式跟灵感/风格/复盘/排期同一套看板：md-board-page + md-tile + 英雄区 + 指标。
import React from 'react'
import { fetchWorkspaceSkill, fetchWorkspaceSkills, toast } from './desk.js'
import { t, useLang } from './i18n.js'
import { canStartSession, startSkillSession } from './session.js'
import { SkillGlyph, glyphTone } from './skill-glyphs.jsx'
import { Dialog, Empty, Icon, IconButton } from './ui.jsx'

const SOURCE_LABEL = {
  custom: '分仓技能',
  'project-agents': '项目技能',
  'project-dsh': '项目技能',
  'user-agents': '用户技能',
  'user-dsh': '用户技能',
  runtime: '运行时',
  bundled: '内置',
}

// 兜底：宿主那半没更新时，列表也别混进全局通用技能
const PROJECT_PROVIDERS = new Set(['realestateintelligent-skill'])

const sourceLabel = skill => t(SOURCE_LABEL[skill.source] ?? '技能')

function invocation(skill) {
  return t('用 {name} 技能处理：', { name: skill.name })
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text)
    toast(done)
  } catch {
    toast(t('复制失败，手动选中吧'), { error: true })
  }
}

/** 直接调用：在 DSH 里开一个新对话，第一条消息就是技能调用语。 */
function runSkill(skill) {
  const prompt = invocation(skill)
  if (startSkillSession(prompt)) {
    toast(t('已在新对话里调用 {name}', { name: skill.name }))
    return
  }
  copy(prompt, t('这里开不了新对话，调用语已复制'))
}

function Metric({ label, value, unit }) {
  return <div className="md-metric"><dt>{label}</dt><dd>{value}{unit ? <small>{unit}</small> : null}</dd></div>
}

function SkillCard({ skill, onOpen }) {
  return (
    <li className="md-skill-card">
      <header>
        <span className={`md-style-icon md-skill-icon tone-${glyphTone(skill.name)}`} aria-hidden="true">
          <SkillGlyph name={skill.name} />
        </span>
        <div>
          <strong>{skill.name}</strong>
          <small>{sourceLabel(skill)}</small>
        </div>
      </header>
      <p>{skill.description || t('没有描述')}</p>
      {skill.whenToUse ? <p className="md-skill-when">{t('适用：{when}', { when: skill.whenToUse })}</p> : null}
      <footer>
        <button type="button" className="md-pill is-small is-primary" onClick={() => runSkill(skill)}><Icon name="bolt" size={13} />{t('调用')}</button>
        <button type="button" className="md-pill is-small" onClick={() => onOpen(skill)}>{t('看正文')}</button>
        <span className="md-grow" />
        <IconButton icon="copy" label={t('复制调用语')} onClick={() => copy(invocation(skill), t('调用语已复制'))} />
      </footer>
    </li>
  )
}

function SkillDialog({ name, onClose }) {
  const [skill, setSkill] = React.useState(null)
  const [error, setError] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    fetchWorkspaceSkill(name).then(data => { if (alive) setSkill(data) }).catch(err => { if (alive) setError(err.message) })
    return () => { alive = false }
  }, [name])
  return (
    <Dialog title={name} onClose={onClose} width={680}>
      {error ? <p className="md-muted">{t('正文读取失败：{error}', { error })}</p> : null}
      {!skill && !error ? <p className="md-loading"><span className="md-shimmer">{t('正在读正文…')}</span></p> : null}
      {skill ? (
        <>
          <p className="md-skill-lead">{skill.description || t('没有描述')}</p>
          {skill.whenToUse ? <p className="md-skill-when">{t('适用：{when}', { when: skill.whenToUse })}</p> : null}
          <div className="md-skill-actions">
            <button type="button" className="md-pill is-small is-primary" onClick={() => { onClose(); runSkill(skill) }}><Icon name="bolt" size={13} />{t('调用')}</button>
            <button type="button" className="md-pill is-small" onClick={() => copy(skill.content, t('正文已复制'))}><Icon name="copy" size={13} />{t('复制正文')}</button>
          </div>
          <pre className="md-skill-body">{skill.content || t('（正文为空）')}</pre>
          <p className="md-skill-path">{skill.path}</p>
        </>
      ) : null}
    </Dialog>
  )
}

export function SkillsView() {
  useLang()
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [query, setQuery] = React.useState('')
  const [open, setOpen] = React.useState(null)

  const load = React.useCallback(() => {
    setError(null)
    setData(null)
    fetchWorkspaceSkills()
      .then(setData)
      .catch(err => setError(err.message))
  }, [])

  React.useEffect(() => { load() }, [load])

  const skills = (data?.skills ?? []).filter(skill => PROJECT_PROVIDERS.has(skill.provider))
  const keyword = query.trim().toLowerCase()
  const shown = keyword
    ? skills.filter(skill => `${skill.name} ${skill.description} ${skill.whenToUse}`.toLowerCase().includes(keyword))
    : skills

  return (
    <div className="md-board-page">
      <div className="md-skills">
        <section className="md-tile md-i-hero">
          <div className="md-hero-copy">
            <h1 className="md-i-line"><b>{skills.length}</b> {t('个分仓技能，')}<br />{t('会话里和工作台共用同一份真本。')}</h1>
            <div className="md-hero-actions">
              <label className="md-search">
                <Icon name="search" size={15} />
                <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜技能名或描述')} aria-label={t('搜技能名或描述')} />
              </label>
            </div>
          </div>
          <dl className="md-metrics">
            <Metric label={t('技能')} value={skills.length} unit={t('个')} />
            {data?.hidden ? <Metric label={t('已隐藏')} value={data.hidden} unit={t('个通用')} /> : null}
          </dl>
        </section>

        <section className="md-tile md-i-skills">
          <header className="md-tile-head">
            <h2>{t('技能')}</h2>
            <span className="md-grow" />
            <button type="button" className="md-pill is-small" onClick={load}><Icon name="refresh" size={13} />{t('刷新')}</button>
          </header>

          {error ? <p className="md-muted md-skill-empty">{t('技能目录读取失败：{error}', { error })}</p> : null}
          {!data && !error ? <p className="md-loading md-skill-empty"><span className="md-shimmer">{t('正在读技能目录…')}</span></p> : null}
          {data && shown.length ? (
            <ul className="md-skill-grid">
              {shown.map(skill => <SkillCard key={skill.name} skill={skill} onOpen={setOpen} />)}
            </ul>
          ) : null}
          {data && !shown.length ? <Empty title={t('没有匹配的技能')} hint={t('换个关键词，或清空搜索。')} /> : null}
          {data && skills.length && !canStartSession() ? <p className="md-skill-foot">{t('当前窗口开不了新对话，调用会复制调用语')}</p> : null}
        </section>
      </div>
      {open ? <SkillDialog name={open.name} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}
