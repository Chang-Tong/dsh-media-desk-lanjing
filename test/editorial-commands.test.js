import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createEditorialCommands } from '../src/editorial-commands.js'
import { Store } from '../src/store.js'

const execFileP = promisify(execFile)
const CLI = fileURLToPath(new URL('../scripts/editorial-request.mjs', import.meta.url))

function fakeBridge(calls = []) {
  const record = (name, max) => (payload) => {
    if (calls.length >= (max ?? Infinity)) throw new Error(`不应重复调用 ${name}`)
    calls.push(name)
    return { called: name, payload, at: new Date().toISOString() }
  }
  return {
    editorial: {
      status: record('status'),
      proposeTopics: record('topics'),
      propose: record('propose'),
      review: record('review'),
      requestBrowserApproval: record('browser-approval'),
      recordDraft: record('record-draft'),
      resumeCreation: record('resume-creation'),
      reviseProduction: record('revise-production'),
    },
    calls,
  }
}

async function fixture(t, bridge = fakeBridge()) {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cmd-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  const cmds = createEditorialCommands({ store, editorial: bridge.editorial })
  return { root, store, cmds, ...bridge }
}

const writeRequest = async (root, id, content) => {
  await mkdir(join(root, 'editorial-requests'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'editorial-requests', `${id}.json`), JSON.stringify(content), { mode: 0o600 })
}

const resultOf = async (root, id) =>
  JSON.parse(await readFile(join(root, 'editorial-results', `${id}.json`), 'utf8'))

test('成功：提交请求后 tick 调用桥方法并原子写入结果', async t => {
  const { root, cmds, calls } = await fixture(t)
  await writeRequest(root, 'abc', { id: 'abc', action: 'propose', payload: { topicId: 't1', brief: 'b' } })
  await cmds.tick()
  const result = await resultOf(root, 'abc')
  assert.equal(result.ok, true)
  assert.equal(result.id, 'abc')
  assert.deepEqual(result.result.called, 'propose')
  assert.deepEqual(result.result.payload, { topicId: 't1', brief: 'b' })
  assert.deepEqual(calls, ['propose'])
  // 状态也在同一 Store 持久化。
  const state = await (new Store(root)).read()
  assert.equal(state.editorialCommands.abc.status, 'done')
  assert.equal(state.editorialCommands.abc.result.ok, true)
  // tick 不重叠：连续 tick 不会重复处理。
  await cmds.tick()
  assert.deepEqual(calls, ['propose'])
})

test('同一 id 不重复执行副作用（结果已存在即跳过）', async t => {
  const { root, store, cmds, calls } = await fixture(t)
  await writeRequest(root, 'dup', { id: 'dup', action: 'propose', payload: { topicId: 't1' } })
  await cmds.tick()
  assert.equal(calls.length, 1)
  // 人为重写同样 id 的请求文件（模拟再次提交），tick 不得重复执行。
  await writeRequest(root, 'dup', { id: 'dup', action: 'propose', payload: { topicId: 't1' } })
  await cmds.tick()
  assert.equal(calls.length, 1)
  const first = await resultOf(root, 'dup')
  const after = await resultOf(root, 'dup')
  assert.deepEqual(after, first)
  void store
})

test('白名单映射：status/topics/review/browser-approval/record-draft 分发正确', async t => {
  const { root, cmds, calls } = await fixture(t)
  await writeRequest(root, 's', { id: 's', action: 'status', payload: {} })
  await writeRequest(root, 'top', { id: 'top', action: 'topics', payload: { topics: [{ topicId: 't' }] } })
  await writeRequest(root, 'r', { id: 'r', action: 'review', payload: { topicId: 't', artifactHash: 'h', status: 'passed' } })
  await writeRequest(root, 'ba', { id: 'ba', action: 'browser-approval', payload: { topicId: 't' } })
  await writeRequest(root, 'rd', { id: 'rd', action: 'record-draft', payload: { topicId: 't', status: 'saved' } })
  await cmds.tick()
  const seen = calls.slice()
  assert.deepEqual(seen.sort(), ['status', 'topics', 'review', 'browser-approval', 'record-draft'].sort())
  assert.equal((await resultOf(root, 'ba')).result.called, 'browser-approval')
  // dispatch 把 topicId 字符串传给 requestBrowserApproval，result.payload 即该字符串 't'。
  assert.equal((await resultOf(root, 'ba')).result.payload, 't')
  assert.equal((await resultOf(root, 'rd')).result.called, 'record-draft')
})

test('revise-production 命令路由到桥方法', async t => {
  const { root, cmds, calls } = await fixture(t)
  await writeRequest(root, 'rev', { id: 'rev', action: 'revise-production', payload: { topicId: 't', artifactHash: 'h', title: '新标题', article: '新正文' } })
  await cmds.tick()
  const result = await resultOf(root, 'rev')
  assert.equal(result.ok, true)
  assert.equal(result.result.called, 'revise-production')
  assert.deepEqual(result.result.payload, { topicId: 't', artifactHash: 'h', title: '新标题', article: '新正文' })
  assert.deepEqual(calls, ['revise-production'])
})

test('拒绝不合法动作/文件名不一致，且不毒化队列', async t => {
  const { root, cmds, calls } = await fixture(t)
  await writeRequest(root, 'evil', { id: 'evil', action: 'rm -rf /', payload: {} })
  await writeRequest(root, 'mismatch', { id: 'other', action: 'propose', payload: {} })
  await writeRequest(root, 'good', { id: 'good', action: 'propose', payload: {} })
  await cmds.tick()
  const evil = await resultOf(root, 'evil')
  assert.equal(evil.ok, false)
  assert.match(evil.error, /不允许的命令动作/)
  const mismatch = await resultOf(root, 'mismatch')
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.error, /文件名不一致/)
  // good 仍然被处理。
  assert.equal((await resultOf(root, 'good')).ok, true)
  assert.deepEqual(calls, ['propose'])
})

test('非法 id 文件名被跳过，不产生结果也不抛错', async t => {
  const { root, cmds, calls } = await fixture(t)
  await writeRequest(root, 'bad name!', { id: 'bad name!', action: 'propose', payload: {} })
  await writeFile(join(root, 'editorial-requests', 'notjson.txt'), 'x')
  await cmds.tick()
  assert.deepEqual(calls, [])
  assert.deepEqual(await readdir(join(root, 'editorial-results')), [])
})

test('拒绝符号链接请求文件', async t => {
  const { root, cmds, calls } = await fixture(t)
  await writeRequest(root, 'real', { id: 'real', action: 'propose', payload: {} })
  await symlink(join(root, 'editorial-requests', 'real.json'), join(root, 'editorial-requests', 'link.json'))
  await cmds.tick()
  const link = await resultOf(root, 'link')
  assert.equal(link.ok, false)
  assert.match(link.error, /符号链接/)
  // 真实文件仍正常处理。
  assert.equal((await resultOf(root, 'real')).ok, true)
  assert.deepEqual(calls, ['propose'])
})

test('拒绝超过 128KB 的请求文件', async t => {
  const { root, cmds } = await fixture(t)
  const huge = 'x'.repeat(129 * 1024)
  await writeRequest(root, 'big', { id: 'big', action: 'propose', payload: { big: huge } })
  await cmds.tick()
  const result = await resultOf(root, 'big')
  assert.equal(result.ok, false)
  assert.match(result.error, /字节上限/)
})

test('桥方法抛错 → 结果记录失败且不重复执行', async t => {
  const throwing = {
    editorial: {
      status: async () => ({ phase: 'idle' }),
      proposeTopics: async () => ({}),
      propose: async () => { throw new Error('桥内部失败') },
      review: async () => ({}),
      requestBrowserApproval: async () => ({}),
      recordDraft: async () => ({}),
    },
  }
  const { root, store, cmds } = await fixture(t, throwing)
  await writeRequest(root, 'f', { id: 'f', action: 'propose', payload: {} })
  await cmds.tick()
  const result = await resultOf(root, 'f')
  assert.equal(result.ok, false)
  assert.match(result.error, /桥内部失败/)
  const state = await (new Store(root)).read()
  assert.equal(state.editorialCommands.f.result.ok, false)
  void store
})

test('崩溃恢复：已认领(running)且无结果的旧命令不重跑，给出 needs_review/不确定结果', async t => {
  const { root, store, cmds, calls } = await fixture(t)
  await writeRequest(root, 'cr', { id: 'cr', action: 'propose', payload: { topicId: 't1' } })
  // 模拟崩溃前的认领：Store 已持久化 running，结果文件不存在。
  await store.mutate('', state => {
    state.editorialCommands = { cr: { id: 'cr', action: 'propose', status: 'running', at: new Date().toISOString() } }
  }, { undoable: false })
  await cmds.tick()
  assert.deepEqual(calls, []) // 绝不重跑破坏性副作用
  const result = await resultOf(root, 'cr')
  assert.equal(result.ok, false)
  assert.equal(result.interrupted, true)
  assert.match(result.error, /复核/)
})

test('崩溃恢复：只读 status 重试安全', async t => {
  const { root, store, cmds, calls } = await fixture(t)
  await writeRequest(root, 'st', { id: 'st', action: 'status', payload: {} })
  await store.mutate('', state => {
    state.editorialCommands = { st: { id: 'st', action: 'status', status: 'running', at: new Date().toISOString() } }
  }, { undoable: false })
  await cmds.tick()
  assert.deepEqual(calls, ['status'])
  assert.equal((await resultOf(root, 'st')).ok, true)
})

test('结果文件缺失但 Store 已 done：只重写文件，不重跑动作', async t => {
  const { root, store, cmds, calls } = await fixture(t)
  await writeRequest(root, 'rw', { id: 'rw', action: 'propose', payload: {} })
  await cmds.tick()
  assert.equal(calls.length, 1)
  const first = await resultOf(root, 'rw')
  // 模拟结果文件丢失但 Store 仍 done。
  await rm(join(root, 'editorial-results', 'rw.json'))
  await cmds.tick()
  assert.equal(calls.length, 1) // 未重跑
  const again = await resultOf(root, 'rw')
  assert.deepEqual(again, first)
  void store
})

test('目录权限 0700、请求/结果文件权限 0600', async t => {
  const { root, cmds } = await fixture(t)
  await writeRequest(root, 'perm', { id: 'perm', action: 'status', payload: {} })
  await cmds.tick()
  const reqMode = (await lstat(join(root, 'editorial-requests', 'perm.json'))).mode & 0o777
  const resMode = (await lstat(join(root, 'editorial-results', 'perm.json'))).mode & 0o777
  const dirMode = (await lstat(join(root, 'editorial-requests'))).mode & 0o777
  assert.equal(reqMode, 0o600)
  assert.equal(resMode, 0o600)
  assert.equal(dirMode, 0o700)
})

// ---------- CLI ----------
function runCli(t, { action, input, id, timeout, root }, whileRunning) {
  const argsList = ['--action', action, '--input', input, '--root', root]
  if (id !== undefined) argsList.push('--id', id)
  if (timeout !== undefined) argsList.push('--timeout', String(timeout))
  const child = spawn(process.execPath, [CLI, ...argsList], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  const done = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr: stderr.trim() })))
  return { done, tick: async () => { await whileRunning() } }
}

// 轮询直到请求文件出现（20ms×≤500 次，最长 10s），缺失即断言失败，确保写文件后才 tick。
async function waitForRequestFile(file) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { await lstat(file); return } catch { /* 尚未出现 */ }
    await new Promise(r => setTimeout(r, 20))
  }
  assert.fail(`CLI 请求文件未在 10s 内出现: ${file}`)
}

test('CLI 端到端：提交请求、tick 处理、返回完成结果', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  const { editorial, calls } = fakeBridge()
  const cmds = createEditorialCommands({ store, editorial })
  const payloadFile = join(root, 'payload.json')
  await writeFile(payloadFile, JSON.stringify({ topicId: 't1', brief: 'b' }))
  const cli = runCli(t, { action: 'propose', input: payloadFile, id: 'cli1', timeout: 15, root }, async () => {
    await waitForRequestFile(join(root, 'editorial-requests', 'cli1.json'))
    await cmds.tick()
  })
  await cli.tick()
  const { code, stdout } = await cli.done
  assert.equal(code, 0)
  const out = JSON.parse(stdout)
  assert.equal(out.id, 'cli1')
  assert.equal(out.ok, true)
  assert.equal(out.result.called, 'propose')
  assert.deepEqual(calls, ['propose'])
})

test('CLI 超时：无处理方时返回 {status:pending, id}', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cli-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payloadFile = join(root, 'payload.json')
  await writeFile(payloadFile, '{}')
  const cli = runCli(t, { action: 'status', input: payloadFile, timeout: 1, id: 'timeout1', root }, async () => {})
  const { code, stdout } = await cli.done
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(stdout), { status: 'pending', id: 'timeout1' })
})

test('CLI 同 id 幂等：已有结果直接返回，不重复提交', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cli-idem-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  const { editorial, calls } = fakeBridge()
  const cmds = createEditorialCommands({ store, editorial })
  const payloadFile = join(root, 'payload.json')
  await writeFile(payloadFile, JSON.stringify({ topicId: 't1' }))
  // 第一次：提交并完成。
  const first = runCli(t, { action: 'propose', input: payloadFile, id: 'idem', timeout: 15, root }, async () => {
    await waitForRequestFile(join(root, 'editorial-requests', 'idem.json'))
    await cmds.tick()
  })
  await first.tick()
  const firstOut = JSON.parse((await first.done).stdout)
  assert.equal(firstOut.ok, true)
  // 第二次同 id：应直接返回既有结果，不再写请求/不再调用桥。
  const reqCountAfterFirst = (await readdir(join(root, 'editorial-requests'))).length
  const second = await execFileP(process.execPath, [CLI, '--action', 'propose', '--input', payloadFile, '--id', 'idem', '--timeout', '15', '--root', root])
  const secondOut = JSON.parse(second.stdout)
  assert.deepEqual(secondOut, firstOut)
  assert.deepEqual(calls, ['propose'])
  const reqCountAfterSecond = (await readdir(join(root, 'editorial-requests'))).length
  assert.equal(reqCountAfterSecond, reqCountAfterFirst)
})

test('CLI 同 id 冲突（已完成）：不同 payload/action 拒绝且 exit 2', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cli-conflict-done-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  const { editorial } = fakeBridge()
  const cmds = createEditorialCommands({ store, editorial })
  const payloadA = join(root, 'a.json')
  const payloadB = join(root, 'b.json')
  await writeFile(payloadA, JSON.stringify({ topicId: 't1', brief: 'A' }))
  await writeFile(payloadB, JSON.stringify({ topicId: 't1', brief: 'B' }))
  // 首次提交并完成。
  const cli = runCli(t, { action: 'propose', input: payloadA, id: 'conf', timeout: 15, root }, async () => {
    await waitForRequestFile(join(root, 'editorial-requests', 'conf.json'))
    await cmds.tick()
  })
  await cli.tick()
  assert.equal(JSON.parse((await cli.done).stdout).ok, true)
  // 同 id 不同 payload → 冲突，exit 2。
  const conflict = execFileP(process.execPath, [CLI, '--action', 'propose', '--input', payloadB, '--id', 'conf', '--root', root])
  await assert.rejects(conflict, /同 id 命令冲突/)
  // 同 id 不同 action → 冲突，exit 2。
  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'status', '--input', payloadA, '--id', 'conf', '--root', root]),
    /同 id 命令冲突/
  )
})

test('CLI 同 id 冲突（pending）：请求未完成时不同 payload 拒绝且 exit 2', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cli-conflict-pending-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payloadA = join(root, 'a.json')
  const payloadB = join(root, 'b.json')
  await writeFile(payloadA, JSON.stringify({ topicId: 't1', brief: 'A' }))
  await writeFile(payloadB, JSON.stringify({ topicId: 't1', brief: 'B' }))
  // 只提交、不 tick（保持 pending）。
  const cli = runCli(t, { action: 'propose', input: payloadA, id: 'pend', timeout: 1, root }, async () => {})
  await waitForRequestFile(join(root, 'editorial-requests', 'pend.json'))
  // 同 id 不同 payload → 冲突，exit 2。
  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'propose', '--input', payloadB, '--id', 'pend', '--root', root]),
    /同 id 命令冲突/
  )
  // 同 id 相同内容仍可重复提交（幂等），不报冲突。
  const same = await execFileP(process.execPath, [CLI, '--action', 'propose', '--input', payloadA, '--id', 'pend', '--timeout', '1', '--root', root])
  assert.equal(JSON.parse(same.stdout).status, 'pending')
})

test('CLI 拒绝：相对 --root、未知参数、超限载荷', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cli-flags-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'payload.json'), '{}')
  // 相对 --root 拒绝。
  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'status', '--input', join(root, 'payload.json'), '--root', 'relative/store']),
    /--root 必须为绝对路径/
  )
  // 未知参数拒绝。
  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'status', '--input', join(root, 'payload.json'), '--root', root, '--bogus', 'x']),
    /未知参数 --bogus/
  )
  // 命令总字节超限（含信封）拒绝。
  const big = join(root, 'big.json')
  await writeFile(big, JSON.stringify({ big: 'x'.repeat(129 * 1024) }))
  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'propose', '--input', big, '--root', root]),
    /字节上限/
  )
})

test('CLI 拒绝：不存在的载荷、非法动作、超长 id', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-cli-reject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payloadFile = join(root, 'payload.json')
  await writeFile(payloadFile, '{}')

  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'exploit', '--input', payloadFile, '--root', root]),
    /--action 必须是/
  )
  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'propose', '--input', join(root, 'nope.json'), '--root', root]),
    /载荷文件不存在/
  )
  await assert.rejects(
    execFileP(process.execPath, [CLI, '--action', 'status', '--input', payloadFile, '--id', 'bad id!', '--root', root]),
    /--id 须匹配/
  )
})
