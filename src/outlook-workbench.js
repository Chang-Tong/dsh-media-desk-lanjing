import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const projection = new URL('./outlook-receipts.py', import.meta.url)
const sshArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', 'realestate-prod', '/usr/bin/python3 -']
const MAX_RECEIPT_BYTES = 2_000_000
const FRESH_FOR_MS = 30_000

function decodeReceipt(contents) {
  const result = JSON.parse(contents)
  if (result?.version !== 1 || !Array.isArray(result.runs)) throw new Error('Invalid receipt response')
  return result
}

async function readRemote() {
  const script = await readFile(projection)
  return new Promise((resolve, reject) => {
    const process = spawn('/usr/bin/ssh', sshArgs, { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    let bytes = 0
    const timer = setTimeout(() => process.kill('SIGKILL'), 14_000)
    process.stdin.on('error', () => {})
    process.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_RECEIPT_BYTES) process.kill('SIGKILL')
      else chunks.push(chunk)
    })
    process.on('error', reject)
    process.on('close', code => {
      clearTimeout(timer)
      if (code !== 0 || bytes > MAX_RECEIPT_BYTES) return reject(new Error('Receipt read failed'))
      try {
        resolve(decodeReceipt(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Invalid receipt response'))
      }
    })
    process.stdin.end(script)
  })
}

export function createOutlookWorkbench(store, { fetchReceipt = readRemote } = {}) {
  const cacheFile = join(store.root, 'outlook-receipt-cache-v1.json')
  let lastSuccess = null
  let request = null
  async function cachedReceipt() {
    if (lastSuccess) return lastSuccess.value
    try {
      if ((await stat(cacheFile)).size > MAX_RECEIPT_BYTES) return null
      return decodeReceipt(await readFile(cacheFile, 'utf8'))
    } catch { return null }
  }

  async function cacheReceipt(value) {
    const temporary = `${cacheFile}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      await rename(temporary, cacheFile)
    } catch {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }

  async function refresh() {
    if (!request) request = fetchReceipt().then(async value => {
      lastSuccess = { value, readAt: Date.now() }
      await cacheReceipt(value)
      return value
    }).finally(() => { request = null })
    return request
  }

  async function read({ force = false } = {}) {
    const state = await store.read()
    let receipt = await cachedReceipt()
    let error = null
    if (force || !lastSuccess || Date.now() - lastSuccess.readAt >= FRESH_FOR_MS) {
      try { receipt = await refresh() }
      catch { error = '暂时无法读取服务器采集回执，请重试。' }
    }
    return { receipt, error, drafts: state.outlookReviewDrafts ?? [] }
  }

  async function saveDraft(body) {
    const { id, revision } = body ?? {}
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const summary = typeof body?.summary === 'string' ? body.summary.trim() : ''
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1
      || !title || title.length > 200 || !summary || summary.length > 1200) {
      throw Object.assign(new Error('请填写标题（最多 200 字）和摘要（最多 1,200 字）。'), { status: 400 })
    }
    let receipt
    try { receipt = await refresh() }
    catch {
      receipt = await cachedReceipt()
      if (!receipt) throw Object.assign(new Error('当前没有可用回执，原有审核稿仍保留。'), { status: 503 })
    }
    const versions = receipt.runs.flatMap(row => row.items).filter(item => item.id === id)
    const candidate = versions.find(item => item.revision === revision)
    if (!candidate || candidate.published || candidate.reviewStatus !== 'pending'
      || versions.some(item => item.revision > revision)) {
      throw Object.assign(new Error('候选版本或状态已变更，请刷新后重新核对。'), { status: 409 })
    }
    return store.mutate('保存新房动态审核稿', state => {
      state.outlookReviewDrafts ??= []
      const value = { id, revision, title, summary, savedAt: new Date().toISOString() }
      const index = state.outlookReviewDrafts.findIndex(draft => draft.id === id && draft.revision === revision)
      if (index < 0) state.outlookReviewDrafts.push(value)
      else state.outlookReviewDrafts[index] = value
      return value
    }, { undoable: false })
  }
  return { read, saveDraft }
}
