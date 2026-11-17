// 本地文件命令队列：把自动化/验收请求以 JSON 文件写入 Store.root/editorial-requests/<id>.json，
// 由 host 每几秒调用的 tick() 串行消费，结果原子写入 Store.root/editorial-results/<id>.json。
//
// 设计要点：
//  - 白名单动作，绝不执行任意 exec/路径命令；校验 id、动作、大小、符号链接。
//  - 崩溃安全：先在同一 Store 持久化命令状态再派发；启动先恢复「已认领但未完成」的旧命令，
//    不盲目重跑破坏性副作用，而是给出 needs_review/不确定结果；status（只读）可安全重试。
//  - 同一 tick 不重叠、命令串行处理；命令结果先持久化进 Store 再原子写结果文件，
//    结果文件写失败时下次 tick 只重写文件、不重跑动作。
//  - 无效文件返回结构化错误但不阻塞队列；绝不删除持久化记录。
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recoverPreviewRequest } from './preview-request.js'

const ACTIONS = new Set(['status', 'topics', 'propose', 'review', 'browser-approval', 'record-draft', 'resume-creation', 'revise-production', 'recover-preview-request'])
const ID_RE = /^[a-zA-Z0-9_-]{1,100}$/
const MAX_BYTES = 128 * 1024 // 128KB

export function createEditorialCommands({ store, editorial }) {
  const root = store.root
  const requestsDir = join(root, 'editorial-requests')
  const resultsDir = join(root, 'editorial-results')
  let ticking = false

  const dispatch = {
    'status': () => editorial.status(),
    'topics': payload => editorial.proposeTopics(payload),
    'propose': payload => editorial.propose(payload),
    'review': payload => editorial.review(payload),
    'browser-approval': payload => editorial.requestBrowserApproval(payload?.topicId),
    'record-draft': payload => editorial.recordDraft(payload),
    'resume-creation': payload => editorial.resumeCreation(payload),
    'revise-production': payload => editorial.reviseProduction(payload),
    'recover-preview-request': payload => recoverPreviewRequest({ ...payload, store }),
  }

  async function ensureDirs() {
    await mkdir(requestsDir, { recursive: true, mode: 0o700 })
    await mkdir(resultsDir, { recursive: true, mode: 0o700 })
    // 目录可能已被 CLI/其它进程预建，逐次强制 0700；跳过符号链接，避免改动链接目标权限。
    await forceMode(requestsDir)
    await forceMode(resultsDir)
  }

  // 仅对真实目录（非符号链接）强制 0700。
  async function forceMode(dir) {
    try {
      const st = await lstat(dir)
      if (!st.isSymbolicLink()) await chmod(dir, 0o700)
    } catch { /* 目录不存在等，忽略 */ }
  }

  async function fileExists(path) {
    try { await lstat(path); return true } catch { return false }
  }

  async function readStatus(id) {
    const state = await store.read()
    return state.editorialCommands?.[id] ?? null
  }

  async function claim(id, action) {
    await store.mutate('命令认领', state => {
      state.editorialCommands ??= {}
      state.editorialCommands[id] = { id, action, status: 'running', at: new Date().toISOString() }
    }, { undoable: false })
  }

  async function persistResult(id, action, result) {
    await store.mutate('命令结果', state => {
      state.editorialCommands ??= {}
      state.editorialCommands[id] = { id, action, status: 'done', at: new Date().toISOString(), result }
    }, { undoable: false })
  }

  // 原子写结果文件（临时文件 + rename）。失败时结果已在 Store 持久化，下个 tick 会重写文件。
  async function writeResult(result) {
    const id = result.id
    const file = join(resultsDir, `${id}.json`)
    const tmp = join(resultsDir, `.${id}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`)
    await writeFile(tmp, JSON.stringify(result), { mode: 0o600 })
    await rename(tmp, file)
  }

  // 校验请求文件并读取 {id,action,payload}；非法内容抛错。
  async function readRequest(id) {
    const file = join(requestsDir, `${id}.json`)
    const st = await lstat(file)
    if (st.isSymbolicLink()) throw Object.assign(new Error('拒绝符号链接命令文件'), { code: 'ESYMLINK' })
    if (!st.isFile()) throw Object.assign(new Error('命令文件不是普通文件'), { code: 'ENOTFILE' })
    if (st.size > MAX_BYTES) throw Object.assign(new Error(`命令文件超过 ${MAX_BYTES} 字节上限`), { code: 'ETOOLARGE' })
    const raw = await readFile(file, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw Object.assign(new Error(`命令文件超过 ${MAX_BYTES} 字节上限`), { code: 'ETOOLARGE' })
    const cmd = JSON.parse(raw)
    if (!cmd || typeof cmd !== 'object') throw new Error('命令内容不是对象')
    if (cmd.id !== id) throw new Error(`命令内 id 与文件名不一致`)
    if (!ACTIONS.has(cmd.action)) throw new Error(`不允许的命令动作: ${String(cmd.action)}`)
    return cmd
  }

  // 消费单个命令：认领 → 派发 → 持久化结果 → 原子写结果文件。
  async function processFile(id) {
    let cmd
    try {
      cmd = await readRequest(id)
    } catch (err) {
      const result = { id, ok: false, error: `无效命令文件: ${err?.message ?? String(err)}` }
      await persistResult(id, 'invalid', result)
      await writeResult(result)
      return
    }
    const handler = dispatch[cmd.action]
    await claim(id, cmd.action) // 先持久化状态再派发
    let result
    try {
      const out = await handler(cmd.payload ?? {})
      result = { id, ok: true, result: out }
    } catch (err) {
      result = { id, ok: false, error: err?.message ?? String(err) }
    }
    await persistResult(id, cmd.action, result)
    try {
      await writeResult(result)
    } catch {
      // 成功结果已在 Store 持久化为 done；本次写文件失败不覆盖成功记录，
      // 下一步 tick 的 recover 会只重写结果文件，绝不重跑动作。
    }
  }

  // 列出请求目录下合法 id 对应的文件（非法文件名直接跳过，不阻塞队列）。
  async function listRequestIds() {
    let names
    try { names = await readdir(requestsDir) } catch { return [] }
    const ids = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (ID_RE.test(id)) ids.push(id)
    }
    return ids.sort()
  }

  // 启动恢复：只处理「此前已认领」(running) 或已 done 但结果文件缺失的旧命令，绝不触碰当前在途命令。
  async function recover(ids) {
    for (const id of ids) {
      try {
        const st = await readStatus(id)
        const hasResult = await fileExists(join(resultsDir, `${id}.json`))
        if (st?.status === 'done') {
          // 结果文件缺失 → 只重写结果文件，绝不重跑动作。
          if (!hasResult && st.result) {
            try { await writeResult(st.result) } catch { /* 写失败不中止其它命令，下次再试 */ }
          }
          continue
        }
        if (st?.status === 'running') {
          if (hasResult) continue // 结果已落盘，只是状态标记滞后
          // 已认领但未完成：不盲目重跑破坏性副作用。
          if (st.action === 'status') {
            // 只读命令可安全重试。
            await processFile(id)
            continue
          }
          const result = {
            id,
            ok: false,
            interrupted: true,
            error: `命令「${st.action ?? 'unknown'}」此前已开始但未完成（进程中断）。为避免重复执行副作用，未自动重跑，请人工复核。`,
          }
          await persistResult(id, st.action, result)
          await writeResult(result)
          continue
        }
      } catch {
        // 单条恢复异常不得中止其它命令的恢复。
      }
      // 无 Store 状态：由主流程按「新命令」处理。
    }
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      await ensureDirs()
      const ids = await listRequestIds()
      await recover(ids)
      // 新命令：尚未被认领且无结果文件。
      for (const id of ids) {
        try {
          const st = await readStatus(id)
          if (st) continue // running/done 已在 recover 处理
          if (await fileExists(join(resultsDir, `${id}.json`))) continue
          await processFile(id)
        } catch (err) {
          // 单条命令异常不得毒化队列。
          try {
            const result = { id, ok: false, error: `处理命令失败: ${err?.message ?? String(err)}` }
            await persistResult(id, 'unknown', result)
            await writeResult(result)
          } catch { /* 忽略二次失败 */ }
        }
      }
    } finally {
      ticking = false
    }
  }

  return { tick }
}
