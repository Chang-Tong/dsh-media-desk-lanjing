// 从已安装归藏 Swiss seed 排版。模型只提供正文文字，绝不运行模型 HTML/JS。
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const WIDTH = 1080
const HEIGHT = 1440
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const plain = value => String(value ?? '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim()
const short = (value, max) => { const chars = Array.from(plain(value)); return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('') }
const titleHtml = (value, max) => {
  const title = short(value, max)
  const phrases = title.split(/(?<=[，,：:；;])/u).filter(Boolean)
  // 两个可容纳的短句优先在标点处断行，避免把“统计口径”“不能”等词拆开。
  return phrases.length === 2 && Array.from(title).length > 9 && phrases.every(part => Array.from(part).length <= 9)
    ? phrases.map(escape).join('<br>') : escape(title)
}

export async function locateGuizangSkill({ skillDir, env = process.env } = {}) {
  const candidates = []
  if (skillDir) candidates.push(skillDir)
  try {
    const pkg = createRequire(import.meta.url).resolve('dsh-guizang-design/package.json')
    candidates.push(join(dirname(pkg), 'skills', 'guizang-social-card-skill'))
  } catch { /* 开发 fork 通过当前 profile 中的已安装插件定位。 */ }
  for (const root of [env.DSH_PROFILE_DIR, env.DSH_PROFILE_HOME, env.DSH_HOME, join(env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop')]) {
    if (root) candidates.push(join(root, 'node_modules', 'dsh-guizang-design', 'skills', 'guizang-social-card-skill'))
  }
  for (const candidate of candidates) {
    try { await access(join(candidate, 'assets', 'template-swiss-card.html')); return candidate } catch { /* 尝试下一处。 */ }
  }
  throw new Error('未找到已安装的 guizang-social-card-skill，请先安装归藏设计插件')
}

function chunks(value, max = 112) {
  const result = []
  let rest = Array.from(value)
  while (rest.length) {
    let at = Math.min(rest.length, max)
    if (at < rest.length) {
      const head = rest.slice(0, at).join('')
      const breaks = [...head.matchAll(/[。！？；.!?;]/gu)]
      const cut = breaks.at(-1)?.index ?? -1
      if (cut > max / 3) at = Array.from(head.slice(0, cut + 1)).length
    }
    result.push(rest.slice(0, at).join(''))
    rest = rest.slice(at)
  }
  return result
}

/** 从真实正文拆页，不另请模型生成卡片中的数字或结论。 */
export function planCards(production) {
  let heading = production.title
  const rows = []
  let hasHeading = false
  let introCount = 0
  for (const paragraph of String(production.article ?? '').split(/\n\s*\n/)) {
    let body = paragraph.trim()
    if (!body) continue
    const match = /^(#{1,6})\s+([^\n]+)(?:\n|$)/.exec(body)
      ?? /^(\*\*)([^\n]+?)\*\*[ \t]*(?:\n|$)/.exec(body)
    if (match) { hasHeading = true; heading = plain(match[2]); body = body.slice(match[0].length).trim() }
    body = plain(body.replace(/^\s*[-+>]\s*/gm, ''))
    for (const part of chunks(body)) { rows.push({ title: heading, body: part }); if (!hasHeading) introCount += 1 }
  }
  if (!rows.length) throw new Error('正文为空，无法生成归藏卡片')
  // 不静默丢弃正文。较长公众号文章拆成更多页，异常模型长文给出可解释错误。
  if (rows.length > 75) throw new Error('正文过长，归藏卡片最多承载 75 个短段落，请缩短正文后重试')
  const coverOwnsIntro = hasHeading && introCount === 1 && Array.from(rows[0].body).length <= 126
  const teaser = coverOwnsIntro ? rows[0].body : rows[0].body.match(/^.*?[。！？]/u)?.[0] ?? rows[0].body
  const pages = [{ kind: 'cover', title: production.title, teaser: short(teaser, 126) }]
  for (let i = coverOwnsIntro ? 1 : 0; i < rows.length;) {
    // 避免末页孤零零只剩一段，4 段均分为 2+2，保留完整正文。
    let count = rows.length - i === 4 ? 2 : 3
    if (hasHeading) {
      count = 1
      while (count < 3 && i + count < rows.length && rows[i + count].title === rows[i].title) count += 1
    }
    pages.push({ kind: 'ledger', title: rows[i].title, rows: rows.slice(i, i + count) })
    i += count
  }
  return pages
}

const TASK_CSS = `
/* media-desk task layout: S01 accent cover + S07 takeaway ledger */
.desk-card .content{display:flex;flex-direction:column;gap:32px;overflow:hidden}
.desk-card p{margin:0}
.desk-card .h-xl{overflow-wrap:anywhere;line-height:1.14;letter-spacing:0;text-wrap:balance}
.desk-card .lead{font-size:32px;line-height:1.6;overflow-wrap:anywhere}
.desk-card .desk-meta{font-size:22px;line-height:1.5;letter-spacing:0;color:var(--text-secondary)}
.desk-card .desk-header{display:flex;justify-content:space-between;gap:24px;border-bottom:1px solid var(--line);padding-bottom:18px;flex:none}
.desk-card .desk-evidence{display:flex;flex-direction:column;justify-content:space-around;gap:24px;flex:1;min-height:0;border-top:2px solid var(--accent)}
.desk-card .desk-source{padding:16px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.desk-card .desk-source .body{font-size:28px;line-height:1.5}
.desk-card .desk-source .t-cat{margin-bottom:12px}
.desk-card .desk-rows{display:flex;flex-direction:column;gap:0;flex:1;min-height:0;border-top:2px solid var(--ink)}
.desk-card .desk-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:24px;padding:24px 0;border-bottom:1px solid var(--line);flex:1;align-content:center}
.desk-card .desk-row .h-md{font-size:38px;line-height:1.3;margin-bottom:18px;overflow-wrap:anywhere}
.desk-card .desk-row .body{font-size:30px;line-height:1.65;overflow-wrap:anywhere}
.desk-card .desk-row .num-xl{font-size:56px;line-height:1.2;color:var(--accent-ink)}
.desk-card .foot{display:flex;justify-content:space-between;gap:24px;margin-top:auto;border-top:1px solid var(--line);padding-top:18px;flex:none}
.poster.xhs.desk-card .desk-page-title{font-size:72px;line-height:1.2;font-weight:300}
.desk-card.desk-sparse .desk-row .body{font-size:42px;line-height:1.65}
.desk-card.desk-sparse .desk-row .h-md{font-size:48px}
`

/** 返回源模板副本：保留 token 原块，只替换页面并移除网络/脚本依赖。 */
export function buildCardHtml(seed, production, pages = planCards(production)) {
  if (!seed.includes('GZ:TOKENS:START') || !seed.includes('<!-- POSTERS_HERE -->')) throw new Error('归藏 seed 模板结构不兼容')
  const sources = (production.sourceMaterials ?? []).slice(0, 3)
  const provenance = sources.length ? sources.map((row, index) => ({ label: `[来源${index + 1}] ${row.source || '原始资料'}`, title: row.title, date: row.publishedAt || row.date || '日期未提供' })) : [{ label: '选题资料', title: production.title, date: '日期未提供' }]
  const posters = pages.map((page, index) => {
    const id = `card-${String(index + 1).padStart(2, '0')}`
    const head = `<div class="desk-header desk-meta"><span>${escape(production.platform || '小红书')}</span><span>${String(index + 1).padStart(2, '0')} / ${String(pages.length).padStart(2, '0')}</span></div>`
    const foot = `<footer class="foot desk-meta"><span>资料与日期见正文出处</span><span>${String(index + 1).padStart(2, '0')}</span></footer>`
    if (page.kind === 'cover') return `<section class="poster xhs desk-card" id="${id}" data-recipe="S01"><div class="content">${head}<h1 class="h-xl">${titleHtml(page.title, 40)}</h1><p class="lead">${escape(page.teaser)}</p><div class="desk-evidence">${provenance.map(row => `<div class="desk-source"><p class="t-cat">${escape(row.label)}</p><p class="body">${escape(short(row.title, 46))}</p><p class="desk-meta">${escape(short(row.date, 32))}</p></div>`).join('')}</div>${foot}</div></section>`
    return `<section class="poster xhs desk-card${page.rows.length === 1 ? ' desk-sparse' : ''}" id="${id}" data-recipe="S07"><div class="content">${head}<h2 class="h-xl desk-page-title">${titleHtml(page.title, 24)}</h2><div class="desk-rows">${page.rows.map((row, rowIndex) => `<div class="desk-row"><span class="num-xl">${String(rowIndex + 1).padStart(2, '0')}</span><div>${row.title !== page.title ? `<h3 class="h-md">${escape(short(row.title, 24))}</h3>` : ''}<p class="body">${escape(row.body)}</p></div></div>`).join('')}</div>${foot}</div></section>`
  }).join('\n')
  return seed.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escape(production.title)}</title>`)
    .replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">`)
    .replace('</style>', `${TASK_CSS}\n</style>`)
    .replace(/^([ \t]*<!-- POSTERS_HERE -->)[\s\S]*?(\s*<\/main>)/m, (_, start, end) => `${start}\n${posters}\n${end}`)
}

/** 仅加载固定 seed 生成的转义文字页，禁 JS、禁网络、禁表单；原 skill 只读。 */
export async function renderGuizang(production, { filesDir, skillDir, signal } = {}) {
  signal?.throwIfAborted()
  const root = await locateGuizangSkill({ skillDir })
  const seed = await readFile(join(root, 'assets', 'template-swiss-card.html'), 'utf8')
  const pages = planCards(production)
  const html = buildCardHtml(seed, production, pages)
  const prefix = `gz_${randomUUID()}`
  await mkdir(filesDir, { recursive: true })
  const htmlName = `${prefix}.html`
  await writeFile(join(filesDir, htmlName), html)
  let chromium
  try { ({ chromium } = createRequire(join(root, 'package.json'))('playwright')) } catch { throw new Error('归藏设计插件缺少 Playwright 渲染依赖') }
  const browser = await chromium.launch({ headless: true })
  const abort = () => { browser.close().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    const context = await browser.newContext({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: 'block', offline: true })
    await context.route('**/*', route => route.abort())
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 })
    await page.evaluate(() => document.fonts.ready)
    const cards = []
    for (const [index, planned] of pages.entries()) {
      signal?.throwIfAborted()
      const id = `card-${String(index + 1).padStart(2, '0')}`
      const board = page.locator(`#${id}`)
      const issues = await board.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const content = element.querySelector('.content')
        const footer = element.querySelector('.foot').getBoundingClientRect()
        const errors = []
        if (content.scrollHeight > content.clientHeight + 1) errors.push(`内容超出 ${content.scrollHeight - content.clientHeight}px`)
        for (const child of element.querySelectorAll('h1,h2,h3,p,.desk-row,.desk-source')) {
          const box = child.getBoundingClientRect()
          if (box.right > bounds.right + 1 || box.left < bounds.left - 1 || box.bottom > footer.top + 1) errors.push(`${child.tagName}.${child.className} 超出安全区/页脚 ${Math.ceil(Math.max(box.right - bounds.right, bounds.left - box.left, box.bottom - footer.top))}px`)
          if (child.scrollWidth > child.clientWidth + 1) errors.push('文字横向溢出')
        }
        return [...new Set(errors)]
      })
      if (issues.length) throw new Error(`归藏第 ${index + 1} 页排版失败：${issues.join('；')}`)
      const name = `${prefix}-${String(index + 1).padStart(2, '0')}.png`
      const png = await board.screenshot({ type: 'png', animations: 'disabled', timeout: 30000 })
      if (png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT) throw new Error('归藏图片尺寸错误')
      await writeFile(join(filesDir, name), png)
      cards.push({ no: index + 1, title: planned.title, caption: planned.kind === 'cover' ? production.title : planned.title, status: 'done', src: `media-desk-lanjing/files/${name}`, width: WIDTH, height: HEIGHT })
    }
    return { cards, cardHtml: { src: `media-desk-lanjing/files/${htmlName}`, status: 'done' }, skill: 'guizang-social-card-skill', theme: 'ikb' }
  } catch (err) {
    signal?.throwIfAborted()
    throw err
  } finally {
    signal?.removeEventListener('abort', abort)
    await browser.close()
  }
}
