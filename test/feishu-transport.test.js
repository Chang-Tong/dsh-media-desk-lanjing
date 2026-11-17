// feishu-transport 测试：用假可执行文件走真实的 execFile 路径，验证参数拼装、分页、ok 强制与幂等键。
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readMessages, sendMessage } from '../src/feishu-transport.js'

/**
 * 生成一个假 lark-cli：把收到的全部参数追写到 logFile，并按 handler(args) 返回 JSON 作为 stdout。
 * 假脚本在独立子进程运行，用烘焙进源码的 log 路径观察真实参数拼装。
 */
async function fakeExecutable(t, handler, { raw = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lark-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const logFile = join(dir, 'args.log')
  const path = join(dir, 'lark-cli.cjs')
  const body = raw ? `process.stdout.write(String((${handler})(args)))` : `process.stdout.write(JSON.stringify((${handler})(args)))`
  const source = `#!/usr/bin/env node\nconst fs=require('fs');const LOG=${JSON.stringify(logFile)};const [,,...args]=process.argv;fs.appendFileSync(LOG,args.join(' ')+'\\n');${body}`
  await writeFile(path, source)
  await chmod(path, 0o755)
  return { exe: path, logFile }
}

test('readMessages 拼装升序/自 since/分页参数，并解析 ok/data', async t => {
  const { exe, logFile } = await fakeExecutable(t, args => ({
    ok: true,
    data: {
      has_more: args.includes('--page-token'),
      page_token: args.includes('--page-token') ? undefined : 'next-token',
      messages: [{ message_id: 'om_x', chat_id: 'oc_c', content: 'hi', msg_type: 'text', create_time: '2026-11-14 10:00', sender: { id: 'ou_a', sender_type: 'user' } }],
    },
  }))
  const r1 = await readMessages({ chatId: 'oc_c', since: '2026-11-14 09:00', executable: exe })
  assert.equal(r1.hasMore, false)
  assert.equal(r1.messages.length, 1)
  const r2 = await readMessages({ chatId: 'oc_c', since: '2026-11-14 09:00', pageToken: 'tok-1', executable: exe })
  assert.equal(r2.hasMore, true)
  const log = await readFile(logFile, 'utf8')
  const first = log.split('\n')[0]
  assert.match(first, /--sort asc/)
  assert.match(first, /--start 2026-11-14 09:00/)
  assert.match(first, /--page-size 50/)
  assert.match(log, /--page-token tok-1/)
})

test('sendMessage 携带幂等键并返回 message_id（发送不传 --format，真实 lark-cli 默认 JSON）', async t => {
  // 真实 lark-cli 1.0.28「im +messages-send --help」没有 --format，传了会报 unknown flag；
  // 替身模拟实际默认 JSON 返回，且校验发送参数绝不含 --format。
  const { exe, logFile } = await fakeExecutable(t, args => {
    if (args.includes('--format')) throw new Error('发送参数不得包含 --format')
    return { ok: true, data: { message_id: 'msg_sent_1' } }
  })
  const id = await sendMessage({ chatId: 'oc_c', text: '你好', idempotencyKey: 'idem-xyz', executable: exe })
  assert.equal(id, 'msg_sent_1')
  const log = await readFile(logFile, 'utf8')
  assert.match(log, /--idempotency-key idem-xyz/)
  assert.match(log, /--text 你好/)
  assert.doesNotMatch(log, /--format/)
})

test('ok 不为 true / 非法 JSON / 缺 message_id 都会抛错', async t => {
  const bad1 = await fakeExecutable(t, () => ({ ok: false, data: {} }))
  await assert.rejects(() => sendMessage({ chatId: 'c', text: 'x', idempotencyKey: 'k', executable: bad1.exe }), /ok/)
  const bad2 = await fakeExecutable(t, () => 'not-json{{{', { raw: true })
  await assert.rejects(() => readMessages({ chatId: 'c', since: '2026-01-01 00:00', executable: bad2.exe }), /JSON/)
  const bad3 = await fakeExecutable(t, () => ({ ok: true, data: {} }))
  await assert.rejects(() => sendMessage({ chatId: 'c', text: 'x', idempotencyKey: 'k', executable: bad3.exe }), /message_id/)
})

test('必需参数缺失即抛错', async t => {
  await assert.rejects(() => readMessages({ chatId: 'c' }), /since/)
  await assert.rejects(() => sendMessage({ chatId: 'c', text: 'x' }), /idempotencyKey/)
})
