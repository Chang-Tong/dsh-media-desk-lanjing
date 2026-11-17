#!/usr/bin/env node
// 本地文件命令队列的提交/轮询客户端，与 src/editorial-commands.js 配套。
// 把 {id,action,payload} 原子写入 Store.root/editorial-requests/<id>.json，轮询
// Store.root/editorial-results/<id>.json 直至完成或超时。无需主进程鉴权 cookie 或 HTTP。
//
// 用法：
//   node scripts/editorial-request.mjs --action propose --input /abs/payload.json \
//        [--id stableid] [--timeout 60] [--root /path/to/store]
// 动作：status | topics | propose | review | browser-approval | record-draft | resume-creation | revise-production | recover-preview-request
// 完成输出 {id, ok, result|error}；超时输出 {"status":"pending","id":...}。
// 同 --id 幂等：已有结果则直接返回，绝不重复提交/覆盖冲突的同 id 负载。
import { lstat, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { dshHome } from '../src/store.js'

const ACTIONS = ['status', 'topics', 'propose', 'review', 'browser-approval', 'record-draft', 'resume-creation', 'revise-production', 'recover-preview-request']
const ID_RE = /^[a-zA-Z0-9_-]{1,100}$/
const MAX_BYTES = 128 * 1024
const DEFAULT_TIMEOUT = 60
const POLL_MS = 200

const KNOWN_FLAGS = new Set(['action', 'input', 'id', 'timeout', 'root'])

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    if (!KNOWN_FLAGS.has(key)) fail(`未知参数 --${key}`)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1 } else { args[key] = true }
  }
  return args
}

async function exists(path) {
  try { await lstat(path); return true } catch { return false }
}

// 读取既有请求文件并校验：拒绝符号链接，解析 JSON。
async function readExistingRequest(file) {
  const st = await lstat(file)
  if (st.isSymbolicLink()) fail(`拒绝符号链接请求文件: ${file}`)
  if (!st.isFile()) fail(`请求文件不是普通文件: ${file}`)
  return JSON.parse(await readFile(file, 'utf8'))
}

function fail(message) {
  console.error(`[editorial-request] ${message}`)
  process.exit(2)
}

async function readPayload(path) {
  if (!isAbsolute(path)) fail(`--input 必须为绝对路径: ${path}`)
  if (!(await exists(path))) fail(`载荷文件不存在: ${path}`)
  const st = await lstat(path)
  if (st.isSymbolicLink()) fail(`拒绝符号链接载荷文件: ${path}`)
  if (!st.isFile()) fail(`载荷文件不是普通文件: ${path}`)
  if (st.size > MAX_BYTES) fail(`载荷文件超过 ${MAX_BYTES} 字节上限`)
  const raw = await readFile(path, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) fail(`载荷文件超过 ${MAX_BYTES} 字节上限`)
  return JSON.parse(raw)
}

function genId() {
  return `req_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`
}

// POSIX 上以「硬链接」实现原子 create-if-not-exists 独占写入；目标已存在则失败、绝不覆盖。
async function linkExclusive(tmp, target) {
  try {
    await link(tmp, target)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

async function run(argv) {
  const args = parseArgs(argv)
  const action = args.action
  if (typeof action !== 'string' || !ACTIONS.includes(action)) fail(`--action 必须是 ${ACTIONS.join(' | ')} 之一`)
  if (typeof args.input !== 'string') fail('缺少 --input /abs/payload.json')
  const payload = await readPayload(args.input)

  let timeout = DEFAULT_TIMEOUT
  if (args.timeout !== undefined) {
    const n = Number(args.timeout)
    if (!Number.isInteger(n) || n < 1 || n > DEFAULT_TIMEOUT) fail(`--timeout 须为 1–${DEFAULT_TIMEOUT} 秒整数`)
    timeout = n
  }

  const root = typeof args.root === 'string' ? args.root : join(dshHome(), 'media-desk-lanjing')
  if (!isAbsolute(root)) fail(`--root 必须为绝对路径: ${root}`)
  const requestsDir = join(root, 'editorial-requests')
  const resultsDir = join(root, 'editorial-results')
  await mkdir(requestsDir, { recursive: true, mode: 0o700 })
  await mkdir(resultsDir, { recursive: true, mode: 0o700 })

  // 确定 id 与既有状态（同 id 幂等，不重复提交）。
  let id = typeof args.id === 'string' ? args.id : genId()
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('--id 须匹配 /^[a-zA-Z0-9_-]{1,100}$/（最长 100 字符）')

  const requestFile = join(requestsDir, `${id}.json`)
  const resultFile = join(resultsDir, `${id}.json`)
  const mine = { id, action, payload }

  // 既有请求存在：先校验（非符号链接）并比较 canonical action+payload，冲突即拒绝（exit 2）。
  const existingReq = await exists(requestFile) ? await readExistingRequest(requestFile) : null
  if (existingReq) {
    const same = existingReq.action === action && JSON.stringify(existingReq.payload ?? {}) === JSON.stringify(payload ?? {})
    if (!same) fail(`同 id 命令冲突，未覆盖: ${id}`)
  }

  // 已完成结果：直接返回既有结果（已通过上方同 id 冲突校验；没有既有请求时无法比较，按幂等返回）。
  if (await exists(resultFile)) {
    const existingResult = JSON.parse(await readFile(resultFile, 'utf8'))
    process.stdout.write(JSON.stringify(existingResult))
    process.stdout.write('\n')
    return
  }

  if (!existingReq) {
    const body = JSON.stringify(mine)
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) fail(`命令超过 ${MAX_BYTES} 字节上限（含信封）`)
    const tmp = join(requestsDir, `.${id}.${process.pid}.${Date.now().toString(36)}.tmp`)
    await writeFile(tmp, body, { mode: 0o600 })
    const wrote = await linkExclusive(tmp, requestFile)
    await unlink(tmp).catch(() => {})
    if (!wrote) fail(`同 id 命令已存在，未覆盖: ${id}`)
  }
  // 若请求文件已存在且与本次一致，仅轮询既有请求，不重写。

  const deadline = Date.now() + timeout * 1000
  while (Date.now() < deadline) {
    if (await exists(resultFile)) {
      const result = JSON.parse(await readFile(resultFile, 'utf8'))
      process.stdout.write(JSON.stringify(result))
      process.stdout.write('\n')
      return
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  // 超时：不声称成功。
  process.stdout.write(JSON.stringify({ status: 'pending', id }))
  process.stdout.write('\n')
}

run(process.argv)
