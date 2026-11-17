import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, lstat } from 'node:fs/promises'
import { dshHome } from './store.js'

const unavailable = () => new Error('找不到揽京内容工作台的草稿组件，请检查桌面版插件安装。')
const missing = message => Object.assign(new Error(message), { status: 400 })

async function defaultAdapter() {
  const profiles = [process.env.DSH_PROFILE_DIR, process.env.DSH_PROFILE_HOME, join(dshHome(), 'profiles', 'desktop')]
  const resolvers = [createRequire(import.meta.url), ...profiles.filter(Boolean).map(dir => createRequire(join(dir, 'package.json')))]
  for (const resolve of resolvers) {
    try {
      const file = resolve.resolve('dsh-lanjing-desk/xhs-drafts')
      return await import(pathToFileURL(file).href)
    } catch (error) {
      if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error?.code)) throw error
    }
  }
  throw unavailable()
}

function plainBody(markdown) {
  return markdown
    .replace(/!\[([^\]]*)\]\(https?:[^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(https?:[^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[数据:lanjing_([\w]+)\]/g, '[数据：揽京数据库 $1]')
    .trim()
}

const length = text => Array.from(text).length
function inputFor(item) {
  const p = item?.production
  if (p?.status !== 'done' || p.platform !== '小红书' || p.format !== 'guizang') throw missing('先完成小红书归藏图文。')
  if (p.outdated || p.layoutOutdated) throw missing('文案或素材已修改，请先更新图卡。')
  const title = p.title?.trim() || ''
  const body = plainBody(p.article || '')
  if (!title || length(title) > 20) throw missing('小红书标题请改成 1–20 字，再重新排版。')
  if (!body || length(body) > 1000) throw missing('小红书正文请控制在 1–1000 字，再重新排版。')
  const names = (p.cards ?? []).map(card => /^media-desk-lanjing\/files\/(gz_[a-f0-9-]+-\d{2}\.png)$/.exec(card.src)?.[1])
  if (!names.length || names.length > 18 || names.some(name => !name) || new Set(names).size !== names.length) throw missing('请先生成 1–18 张完整的归藏 PNG 图卡。')
  const fingerprint = createHash('sha256').update(JSON.stringify([title, body])).digest('hex')
  return { title, body, names, fingerprint }
}

export function createXhsDrafts({ store, adapter = defaultAdapter, root = process.env.LANJING_DATA_DIR || join(dshHome(), 'lanjing-desk') }) {
  const cfg = { dirs: { browser: join(root, 'browser') } }
  let active = false
  const exclusive = async fn => {
    if (active) throw Object.assign(new Error('小红书正在同步或等待登录，请稍后重试。'), { status: 409 })
    active = true
    try { return await fn() } finally { active = false }
  }
  const saveReceipt = (id, receipt) => store.mutate('', state => {
    const target = state.items.find(row => row.id === id)
    if (target) target.xhsDraft = receipt
    return receipt
  }, { undoable: false })
  return {
    login: () => exclusive(async () => {
      const { loggedIn, error, cookieSaved } = await (await adapter()).login({ cfg })
      return { loggedIn, message: loggedIn ? cookieSaved ? '小红书已登录，Cookie 已保存在本机。' : '小红书已登录，可以同步草稿。' : error || '尚未登录，请重新打开小红书登录窗口。' }
    }),
    save: (id, { retryUncertain = false } = {}) => exclusive(async () => {
      const state = await store.read()
      const item = state.items.find(row => row.id === id && !row.sample)
      const { title, body, names, fingerprint } = inputFor(item)
      const previous = item.xhsDraft
      if (previous?.status === 'draft_saved' && previous.fingerprint === fingerprint) return previous
      if ((previous?.status === 'syncing' || previous?.status === 'uncertain') && !retryUncertain) {
        return { ...previous, status: 'uncertain', message: '上次保存尚未确认。请先去草稿箱核对，确认没有后再重试。' }
      }
      const images = await Promise.all(names.map(async name => {
        const file = join(store.filesDir, name)
        const info = await lstat(file).catch(() => null)
        if (!info?.isFile() || info.size > 10_000_000) throw missing('图卡文件缺失或过大，请重新排版。')
        const image = await readFile(file)
        if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw missing('图卡文件不是有效 PNG，请重新排版。')
        return file
      }))
      const api = await adapter()
      const at = new Date().toISOString()
      await saveReceipt(id, { status: 'syncing', at, fingerprint })
      let result
      try { result = await api.saveDraftFiles({ cfg, title, body, images }) }
      catch { result = { uncertain: true, message: '没有收到保存回执，请先到创作者中心核对草稿箱。' } }
      const status = result.saved ? 'draft_saved' : result.needsLogin ? 'needs_login' : result.uncertain ? 'uncertain' : 'failed'
      return saveReceipt(id, { status, message: result.message, at, fingerprint })
    }),
  }
}
