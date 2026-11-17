import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store.js'
import { createFeishuEditorial } from '../src/feishu-editorial.js'
import { createSeriesRunner } from '../src/series-runner.js'

const OWNER = 'ou_owner_111'
const CHAT = 'oc_chat_111'

function pathValue(r) {
  if (r == null) return null
  if (typeof r === 'string' && r) return r
  if (typeof r === 'object') return r.src ?? r.path ?? r.url ?? r.file ?? null
  return null
}
function fingerprint(prod) {
  const relevant = { title: prod?.title ?? '', article: prod?.article ?? '', coverText: prod?.coverText ?? '', cover: prod?.cover != null ? pathValue(prod.cover) : null, images: (prod?.images ?? []).map(pathValue), cards: (prod?.cards ?? []).map(pathValue), slides: (prod?.slides ?? []).map(pathValue), shots: (prod?.shots ?? []).map(pathValue), video: prod?.videoSrc ?? prod?.video ?? null }
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex')
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-feishu-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => {
    state.items = [{ id: 'topic-1', recordType: 'topic', title: '北京首付比例', body: '', editorialBrief: '', status: 'outline', platform: '小红书' }]
  })
  return store
}

async function enable(store, extra = {}) {
  await store.mutate('', state => {
    state.editorialWorkflow = { feishu: { enabled: true, chatId: CHAT, ownerId: OWNER, since: '2026-11-14 00:00', ...extra } }
  }, { undoable: false })
}

/** 分页 transport：页 1 返回第一条 + hasMore，页 2 返回其余。 */
function pagedTransport(messages = [], sendSideEffect) {
  const sends = []
  return {
    sends,
    transport: {
      async readMessages({ chatId }) {
        const rows = messages.filter(m => m.chat_id === chatId)
        if (rows.length <= 1) return { messages: rows, hasMore: false, nextPageToken: undefined }
        return { messages: rows.slice(0, 1), hasMore: true, nextPageToken: 'p2', pending: rows.slice(1) }
      },
      async sendMessage({ chatId, text, card, idempotencyKey }) {
        if (sendSideEffect) sendSideEffect({ chatId, text, idempotencyKey })
        const id = `msg_sent_${sends.length + 1}`
        sends.push({ chatId, text, card, idempotencyKey, messageId: id })
        return id
      },
    },
  }
}

/** 不分页，直接全部返回。 */
function flatTransport(messages = [], sendSideEffect) {
  const sends = []
  return {
    sends,
    transport: {
      async readMessages({ chatId }) {
        const rows = messages.filter(m => m.chat_id === chatId)
        return { messages: rows, hasMore: false, nextPageToken: undefined }
      },
      async sendMessage({ chatId, text, card, idempotencyKey }) {
        if (sendSideEffect) sendSideEffect({ chatId, text, idempotencyKey })
        const id = `msg_sent_${sends.length + 1}`
        sends.push({ chatId, text, card, idempotencyKey, messageId: id })
        return id
      },
    },
  }
}

const m = (id, text, time = '2026-11-14 10:00', extra = {}) => ({ message_id: id, chat_id: CHAT, content: text, content_type: 'plain', create_time: time, sender: { id: OWNER, sender_type: 'user' }, ...extra })
const em = text => ({ text, model: 'test' })

function mockProducer() {
  const starts = []
  return {
    starts,
    async start(id, opts) { starts.push({ id, opts }); return true },
    isRunning() { return false },
    cancel() {},
    status() { return { running: false } },
  }
}

const NOW = '2026-11-14T03:00:00Z'

test('默认 absent 配置：status 不崩溃，tick 不写入不发送', async t => {
  const store = await fixture(t)
  const { transport, sends } = flatTransport([m('m1', '确认创作 abc')])
  const ed = createFeishuEditorial({ store, producer: mockProducer(), callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  const st = await ed.status()
  assert.equal(st.enabled, false)
  const st2 = await ed.status()
  assert.deepEqual(st, st2)
  await ed.tick()
  assert.equal(sends.length, 0)
  const state = await store.read()
  assert.ok(!state.editorialWorkflow?.feishu?.processedIds, 'absent 配置不得落写入')
  assert.equal(state.editorialWorkflow, undefined)
})

test('提议不立即生产；错误/旧 token 绝不启动；重放不二次启动；done/outdated 可经新确认再生成', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  assert.equal(producer.starts.length, 0, 'propose 不立即生产')
  const item1 = (await store.read()).items.find(r => r.id === 'topic-1')
  const good = item1.editorialConfirmation.token
  assert.ok(good.length >= 12 && /^[0-9a-f]+$/.test(good), '短线随机 hex token')

  // 错误 token → 不生产
  await tickWith(store, producer, [m('bad', `确认创作 000000000000`, '2026-11-14 10:01')])
  assert.equal(producer.starts.length, 0, '错误 token 不生产')
  // 旧（失效）token → 不生产：先修订出新 token，再用旧 token
  // 注意：Store 返回的是同一活对象，须在修订前立刻取值，否则会读到修订后的新 token。
  const oldToken = (await store.read()).items.find(r => r.id === 'topic-1').editorialConfirmation.token
  await tickWith(store, producer, [m('nat', '请加新规', '2026-11-14 10:02')], async () => em(JSON.stringify({ reply: '已调整', brief: '首付比例，含新规' })))
  const newToken = (await store.read()).items.find(r => r.id === 'topic-1').editorialConfirmation.token
  assert.notEqual(oldToken, newToken)
  await tickWith(store, producer, [m('oldreplay', `确认创作 ${oldToken}`, '2026-11-14 10:03')])
  assert.equal(producer.starts.length, 0, '旧 token 不生产')

  // 新 token → 生产一次
  await tickWith(store, producer, [m('ok', `确认创作 ${newToken}`, '2026-11-14 10:04')])
  assert.equal(producer.starts.length, 1)
  const savedToken = (await store.read()).items.find(r => r.id === 'topic-1').editorialConfirmation.token
  assert.equal(savedToken, newToken)

  // 重放同一 token → 不二次启动
  await tickWith(store, producer, [m('dup', `确认创作 ${newToken}`, '2026-11-14 10:05')])
  assert.equal(producer.starts.length, 1, '重放确认不可二次启动')

  // done/outdated 后经新 propose（新 token）可再生成
  await store.mutate('', state => {
    const it = state.items.find(r => r.id === 'topic-1')
    it.production = { status: 'done', title: '旧标题', article: '旧正文', outdated: true, platform: '小红书', format: 'guizang' }
    it.editorialConfirmation = null
  })
  await ed.propose({ topicId: 'topic-1', brief: '第二版简报' })
  const item2 = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(item2.production?.outdated, true, '新提议不把旧成稿当当前版本')
  const token2 = item2.editorialConfirmation.token
  await tickWith(store, producer, [m('reg', `确认创作 ${token2}`, '2026-11-14 10:06')])
  assert.equal(producer.starts.length, 2, 'done/outdated 经新确认可再生成')
})

/** 用一份临时 transport 跑一次 tick 处理给出的消息。 */
async function tickWith(store, producer, messages, callText = async () => em('{}')) {
  const bound = flatTransport(messages)
  const ed = createFeishuEditorial({ store, producer, callText, transport: bound.transport, now: () => new Date(NOW) })
  await ed.tick()
  return { ed, sends: bound.sends }
}

test('自然语言修订：模型摘要只作展示，生成简报以既有简报+逐字原文+边界为准，模型虚构不进入', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport, sends } = flatTransport([m('nat', '请加上2026新规', '2026-11-14 10:01')])
  // 模型带着幻觉事实/发布承诺返回 —— 这些绝不能被写进生成简报。
  const ed = createFeishuEditorial({ store, producer, callText: async () => JSON.stringify({ reply: '好的，已调整', brief: '宸园143平已经卖光、去化更快，存草稿并发布。' }), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  await ed.tick()
  const itemA = (await store.read()).items.find(r => r.id === 'topic-1')
  // 生成简报基于「既有简报 + 逐字主人原文 + 固定边界」，不再用模型 brief 代替。
  assert.equal(itemA.editorialBriefVersion, 2)
  assert.ok(itemA.editorialBrief.includes('首付比例'), '保留既有简报')
  assert.ok(itemA.editorialBrief.includes('请加上2026新规'), '保留逐字主人原文作为生成依据')
  assert.ok(itemA.editorialBrief.includes('创作红线'), '带固定边界')
  assert.ok(!itemA.editorialBrief.includes('宸园143平') && !itemA.editorialBrief.includes('卖光'), '模型虚构事实不得进入生成简报')
  assert.ok(!itemA.editorialBrief.includes('存草稿并发布'), '模型发布承诺不得进入生成简报')
  const sent = sends.map(s => s.text).join('\n')
  assert.match(sent, /更新后的创作简报（当前完整要求，无省略）/)
  const revision = sends.find(s => s.text?.includes('更新后的创作简报（当前完整要求，无省略）'))
  assert.match(revision.text, /首付比例/)
  assert.match(revision.text, /请加上2026新规/)
  assert.doesNotMatch(revision.text, /创作红线|不得推断|绝不自动公开发布/, '固定内部边界不外发，当前要求不省略')
  assert.match(sent, /确认创作/)
  assert.equal(producer.starts.length, 0, '修订不自动启动生产')
})

test('模型失败：确认收到、作废旧确认、保留原文、needs_review，不自动放行', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport, sends } = flatTransport([m('nat', '请改一下', '2026-11-14 10:01')])
  const ed = createFeishuEditorial({ store, producer, callText: async () => { throw new Error('boom') }, transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  await ed.tick()
  const itemA = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(itemA.editorialConfirmation, null, '旧确认被作废')
  assert.equal(itemA.editorialReview.status, 'needs_review')
  assert.equal(itemA.editorialDiscussion.some(d => d.text === '请改一下'), true, '保留原文')
  assert.equal((await ed.status()).phase, 'needs_review')
  assert.equal(producer.starts.length, 0)
  assert.equal(sends.some(s => /收到你的消息/.test(s.text)), true, '确认收到')
})

test('错误频道 / 决策命令 / 单选题 A-D 被忽略，不作为 brief', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const wrongChat = { message_id: 'w1', chat_id: 'oc_other', content: '确认创作 000000000000', content_type: 'plain', create_time: '2026-11-14 10:00', sender: { id: OWNER, sender_type: 'user' } }
  const decide = m('w2', '决策 选 A', '2026-11-14 10:01')
  const singleLetter = m('w3', 'A', '2026-11-14 10:02')
  const { transport } = flatTransport([wrongChat, decide, singleLetter])
  const ed = createFeishuEditorial({ store, producer, callText: async () => JSON.stringify({ reply: 'x', brief: '不应被采用' }), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  await ed.tick()
  const itemA = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(itemA.editorialBrief, '首付比例', '其它命令不改 brief')
  assert.equal(producer.starts.length, 0)
})

test('生成完成 → ready_for_review（pending 不自动 passed）；哈希变化需重新评审', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  const tok0 = (await store.read()).items.find(r => r.id === 'topic-1').editorialConfirmation.token
  // 需先确认开始生成，poll 才会认定这是本桥发起的当次生产。
  await tickWith(store, producer, [m('go', `确认创作 ${tok0}`, '2026-11-14 10:01')])
  await store.mutate('', state => { state.items.find(r => r.id === 'topic-1').production = { status: 'done', title: '标题', article: '正文', platform: '小红书', format: 'guizang' } })
  await ed.tick()
  const after = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(after.readyForReview, true)
  assert.equal(after.editorialReview.status, 'pending', '完成不自动 passed')
  assert.equal((await ed.status()).reviewStatus, 'pending')
  // 改动产物 → 哈希变化 → 拒绝申请（即使评审通过）
  await store.mutate('', state => {
    const it = state.items.find(r => r.id === 'topic-1')
    it.editorialReview = { status: 'passed', artifactHash: fingerprint(it.production), at: new Date().toISOString(), source: 'operator', }
    it.production.article = '改动后的正文'
  })
  await assert.rejects(ed.requestBrowserApproval('topic-1'), /产物哈希/)
})

test('浏览器批推：需 reached 评审、哈希匹配；review 结果持久化；批准后 approvedBy=主人、models 固定、绝不 publish', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport, sends } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  await store.mutate('', state => {
    const it = state.items.find(r => r.id === 'topic-1')
    it.production = { status: 'done', title: '首付比例新规', article: '正文', platform: '小红书', format: 'guizang' }
    it.readyForReview = true
    it.completedNotified = true
  })
  // 未评审 → 拒绝申请
  await assert.rejects(ed.requestBrowserApproval('topic-1'), /尚未通过核验/)
  // 用错误哈希评审 → 拒绝
  const prod1 = (await store.read()).items.find(r => r.id === 'topic-1').production
  await assert.rejects(ed.review({ topicId: 'topic-1', artifactHash: 'badhash', status: 'passed' }), /产物哈希/)
  // 正确哈希评审通过
  await ed.review({ topicId: 'topic-1', artifactHash: fingerprint(prod1), status: 'passed' })
  const st = await ed.status()
  assert.equal(st.reviewStatus, 'passed')
  // 申请批推（未确认时 phase）
  await ed.requestBrowserApproval('topic-1')
  const itemA = (await store.read()).items.find(r => r.id === 'topic-1')
  const token = itemA.browserApproval.token
  assert.ok(token.length >= 12)
  // 用错误 token 确认 → 不批准
  await tickWith(store, producer, [m('badgu', `确认草稿 000000000000`, '2026-11-14 10:01')])
  assert.equal((await store.read()).items.find(r => r.id === 'topic-1').browserApproval.status, 'pending')
  // 正确 token 确认
  await tickWith(store, producer, [m('gu', `确认草稿 ${token}`, '2026-11-14 10:02')])
  const after = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(after.browserApproval.status, 'approved')
  assert.equal(after.browserApproval.approvedBy, OWNER, 'approvedBy 是主人而非模型')
  assert.equal(after.browserApproval.device, 'Air', '设备固定 Air')
  assert.equal(after.browserApproval.model, 'gpt-6.1-terra', '模型固定 gpt-6.1-terra')
  assert.equal(producer.starts.length, 0)
  // 绝不执行 xhs 适配器 / publish：只发送审批卡片（含「仅保存…不公开发布」），不直接发布
  const cardSent = sends.find(s => s.card)
  assert.ok(cardSent, '应发送审批卡片')
  const cardJson = JSON.stringify(cardSent.card)
  assert.match(cardJson, /确认保存草稿/)
  assert.match(cardJson, /暂不保存/)
  assert.match(cardJson, /仅保存小红书草稿，公开发布由你完成/)
  // 文本确认路径仍给出 ack（经独立 transport 发送），确认草稿仍合法回退
  assert.equal(producer.starts.length, 0)
})

test('发送失败重试：outbox 保留 failed，退避后重试成功并回填 proposalMessageId', async t => {
  const store = await fixture(t)
  await enable(store)
  let sendCalls = 0
  const transport = {
    async readMessages() { return { messages: [], hasMore: false, nextPageToken: undefined } },
    async sendMessage({ text }) { sendCalls++; if (sendCalls === 1) throw new Error('net down'); return `msg_sent_x${sendCalls}` },
  }
  const ed = createFeishuEditorial({ store, producer: mockProducer(), callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.tick()
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' }) // 首次发送失败
  assert.equal(sendCalls, 1)
  let st = await ed.status()
  assert.equal(st.outbox.some(o => o.status === 'failed'), true, 'failed 项被暴露且保留')
  // 时间推进到退避之后，重试成功
  const later = '2026-11-14T03:01:00Z'
  const ed2 = createFeishuEditorial({ store, producer: mockProducer(), callText: async () => em('{}'), transport, now: () => new Date(later) })
  await ed2.tick()
  assert.equal(sendCalls, 2, '退避后重试')
  const state = await store.read()
  assert.ok(state.editorialWorkflow.feishu.proposalMessageId, '发送成功后回填 proposalMessageId')
  st = await ed2.status()
  assert.equal(st.outbox.filter(o => o.status === 'pending').length, 0)
})

test('幂等 / restart：同 seed 不同重复发送；outbox 有界不挤掉待发', async t => {
  const store = await fixture(t)
  await enable(store)
  const keys = new Set()
  const { transport, sends } = flatTransport()
  const ed = createFeishuEditorial({ store, producer: mockProducer(), callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  await ed.tick()
  await ed.tick()
  for (const s of sends) keys.add(s.idempotencyKey)
  assert.equal(keys.size, sends.length, '同一 outbox 项不重复发送')
  const state = await store.read()
  assert.ok(state.editorialWorkflow.feishu.outbox.length >= 1)
})

test('series 确认接管：creationRequiresConfirmation 阻止自动启用与 tick', async t => {
  const store = await fixture(t)
  await enable(store)
  await store.mutate('', state => { state.editorialWorkflow.creationRequiresConfirmation = true; state.editorialWorkflow.browserRequiresConfirmation = true })
  const producer = mockProducer()
  const series = createSeriesRunner({ store, producer, xhsDrafts: { save: async () => ({}), login: async () => ({}) }, now: () => new Date(NOW) })
  await assert.rejects(series.setEnabled(true), /409|创作确认/)
  // tick 被阻止 —— 无副作用
  await store.mutate('', state => { state.editorialSeries = { enabled: true, runs: {} } })
  await series.tick()
  const state2 = await store.read()
  assert.equal(state2.editorialSeries.enabled, true)
  // browserRequiresConfirmation 门由 host 层校验（xhs/draft、xhs/login 409），这里验证状态可读
  assert.equal(state2.editorialWorkflow.browserRequiresConfirmation, true)
})

test('stop 后不再发送（in-flight 保护）', async t => {
  const store = await fixture(t)
  await enable(store)
  const { transport, sends } = flatTransport([m('nat', '改一下', '2026-11-14 10:01')])
  const producer = mockProducer()
  let modelCalls = 0
  const ed = createFeishuEditorial({ store, producer, callText: async () => { modelCalls++; return em(JSON.stringify({ reply: 'y', brief: '新版简简报' })) }, transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  const stop = ed.start()
  stop() // 已 stop
  await ed.tick() // tick 开头就 return，不处理消息、不发送
  assert.equal((await store.read()).items.find(r => r.id === 'topic-1').editorialBrief, '首付比例', 'stop 后不接受修订')
})

/** 走到「已批准浏览器批推」的完整准备：生成→评审→申请→确认草稿。返回 ed 与 token。 */
async function toApproved(store, producer, ed) {
  await store.mutate('', state => {
    const it = state.items.find(r => r.id === 'topic-1')
    it.production = { status: 'done', format: 'guizang', title: '标题', article: '正文', cards: [{ src: 'a' }, { src: 'b' }], cover: { src: 'a' }, images: [{ src: 'b' }] }
    it.readyForReview = true
    it.completedNotified = true
  })
  const hash = fingerprint((await store.read()).items.find(r => r.id === 'topic-1').production)
  await ed.review({ topicId: 'topic-1', artifactHash: hash, status: 'passed' })
  await ed.requestBrowserApproval('topic-1')
  const token = (await store.read()).items.find(r => r.id === 'topic-1').browserApproval.token
  await tickWith(store, producer, [m('gu', `确认草稿 ${token}`, '2026-11-14 10:01')])
  return hash
}

test('recordDraft：仅 Air/gpt-6.1-terra 且三项回读为真才 saved；批准单次消费，之后新 propose 可继续；执行期不换 token', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  const tok0 = (await store.read()).items.find(r => r.id === 'topic-1').editorialConfirmation.token
  await tickWith(store, producer, [m('go', `确认创作 ${tok0}`, '2026-11-14 10:00')])
  const hash = await toApproved(store, producer, ed)
  // 错误的执行器（非 Air）拒绝
  await assert.rejects(() => ed.recordDraft({ topicId: 'topic-1', artifactHash: hash, status: 'draft_saved', evidence: { device: 'Mini', model: 'gpt-6.1-terra', title: true, body: true, media: true } }), /执行器/)
  // 正确执行器 + 三项全真 → saved，批准置为 consumed
  await ed.recordDraft({ topicId: 'topic-1', artifactHash: hash, status: 'draft_saved', evidence: { device: 'Air', model: 'gpt-6.1-terra', title: true, body: true, media: true } })
  let st = await ed.status()
  assert.equal(st.phase, 'draft_saved')
  assert.equal(st.draftReceipt.draftTitle, '标题')
  const item = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(item.browserApproval.status, 'consumed', '批准一次性消费')
  // 重复同一 consumed 结果不能复用批准
  await assert.rejects(() => ed.recordDraft({ topicId: 'topic-1', artifactHash: hash, status: 'draft_saved', evidence: { device: 'Air', model: 'gpt-6.1-terra', title: true, body: true, media: true } }), /没有已被主人批准/)
  // 下一题可直接 propose
  await ed.propose({ topicId: 'topic-1', brief: '下一篇的新要求' })
  st = await ed.status()
  assert.equal(st.phase, 'awaiting_creation_confirmation')
})

test('proposeTopics：选择不启动、旧批次不能再改、同 batchId 幂等、越界回执', async t => {
  const store = await fixture(t)
  await enable(store)
  await store.mutate('', state => {
    state.items.push({ id: 'topic-2', recordType: 'topic', title: '第二题', body: '', editorialBrief: '', status: 'outline', platform: '小红书' })
  })
  const producer = mockProducer()
  const { transport, sends } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.proposeTopics({ batchId: 'day1', topics: [{ topicId: 'topic-1', brief: '第一题要求' }, { topicId: 'topic-2', brief: '第二题要求' }] })
  let st = await ed.status()
  assert.equal(st.phase, 'awaiting_topic_choice')
  assert.equal(producer.starts.length, 0)
  // 选择 2 → 活动题变为 topic-2，不启动
  await tickWith(store, producer, [m('sel2', '2', '2026-11-14 10:01')])
  st = await ed.status()
  assert.equal(st.activeTopicId, 'topic-2')
  assert.equal(st.phase, 'awaiting_creation_confirmation')
  assert.equal(producer.starts.length, 0)
  const token2 = (await store.read()).items.find(r => r.id === 'topic-2').editorialConfirmation.token
  // 旧批次再选 1 → 已消费，不能改
  await tickWith(store, producer, [m('sel1', '1', '2026-11-14 10:02')])
  const item1 = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(item1.editorialConfirmation, undefined, '旧批次选择不能给未选题下发确认')
  assert.equal((await store.read()).items.find(r => r.id === 'topic-2').editorialConfirmation.token, token2)
  // 越界回执
  await ed.proposeTopics({ batchId: 'day2', topics: [{ topicId: 'topic-1', brief: 'x1' }] })
  await tickWith(store, producer, [m('bad', '5', '2026-11-14 10:03')])
  st = await ed.status()
  assert.equal(st.phase, 'awaiting_topic_choice', '越界不回退、不修订')
  // 同 batchId 幂等：不重复发送/不重复建题
  const sentCount = sends.length
  await ed.proposeTopics({ batchId: 'day2', topics: [{ topicId: 'topic-1', brief: 'x1' }] })
  assert.equal(sends.length, sentCount, '同 batchId 不重复发送')
})

test('批次口语选择只作用于新题：旧稿及历史回执不变，确认展示当前全部要求且可安全重放', async t => {
  const store = await fixture(t)
  await enable(store, { activeTopicId: 'topic-1' })
  await store.mutate('', state => {
    state.items.push(
      { id: 'topic-2', recordType: 'topic', title: '新题一', body: '新题一正文', status: 'outline', platform: '小红书' },
      { id: 'topic-3', recordType: 'topic', title: '新题二', body: '新题二正文', status: 'outline', platform: '小红书' },
    )
    const old = state.items.find(r => r.id === 'topic-1')
    old.editorialBrief = '旧题简报'
    old.editorialBriefVersion = 4
    old.editorialConfirmation = { token: 'old-creation-token', briefVersion: 4, brief: '旧题简报', dispatch: 'started' }
    old.production = { status: 'done', format: 'guizang', title: '旧稿标题不可展示', article: '旧稿正文不可展示', platform: '小红书' }
    old.readyForReview = true
    old.completedNotified = true
    old.editorialDiscussion = [{ messageId: 'old-message', text: '旧稿历史消息', reply: '旧稿历史回执', status: 'processed' }]
    old.browserApproval = { status: 'consumed', token: 'old-browser-token', approvedBy: OWNER }
    old.draftReceipt = { status: 'draft_saved', evidence: { title: true, body: true, media: true }, approvedBy: OWNER }
  })
  await store.mutate('', state => {
    const old = state.items.find(r => r.id === 'topic-1')
    const hash = fingerprint(old.production)
    old.editorialReview = { status: 'passed', artifactHash: hash, source: 'operator' }
    old.browserApproval.artifactHash = hash
    old.draftReceipt.artifactHash = hash
  })

  const producer = mockProducer()
  const { transport } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  const fullBrief = '新题核心：只依据真实网签。\n\n【主人原文】\n第一轮补充：只看官方数据\n\n【主人原文】\n第二轮补充：突出区域差异'
  await ed.proposeTopics({ batchId: 'choice-regression', topics: [
    { topicId: 'topic-2', brief: '新题一简报' },
    { topicId: 'topic-3', brief: fullBrief },
  ] })
  const oldBefore = structuredClone((await store.read()).items.find(r => r.id === 'topic-1'))
  const outboxBefore = (await store.read()).editorialWorkflow.feishu.outbox.map(r => r.id)
  let modelCalls = 0
  const { sends } = await tickWith(store, producer, [m('choice-colloquial', '2 吧', '2026-11-14 10:01')], async () => {
    modelCalls++
    return em(JSON.stringify({ reply: '不应修订旧稿', brief: '不应采用' }))
  })

  let state = await store.read()
  let cfg = state.editorialWorkflow.feishu
  const selected = state.items.find(r => r.id === 'topic-3')
  assert.equal(cfg.activeTopicId, 'topic-3')
  assert.equal(cfg.batch.phase, 'selected')
  assert.equal(cfg.batch.selectedTopicId, 'topic-3')
  assert.deepEqual(state.items.find(r => r.id === 'topic-1'), oldBefore, '选择不得作废旧成稿、授权、评审或历史回执')
  assert.equal(modelCalls, 0, '明确选择不得进入旧稿模型修订')
  assert.equal(producer.starts.length, 0, '选择只发确认，不启动创作')
  assert.equal(selected.editorialBrief, fullBrief, '展示精简不得截断供创作使用的完整简报')
  assert.equal(selected.editorialBriefVersion, 1)
  assert.equal(selected.editorialConfirmation.brief, fullBrief)
  assert.equal(selected.editorialConfirmation.briefVersion, selected.editorialBriefVersion)
  assert.equal(selected.editorialConfirmation.dispatch, undefined)
  assert.ok(outboxBefore.every(id => cfg.outbox.some(r => r.id === id)), '历史 outbox 回执仍保留')

  const proposal = sends.find(s => s.text?.includes('选题：新题二'))
  assert.ok(proposal, '应发送新题确认文本')
  assert.match(proposal.text, /创作简报（当前完整要求，无省略）/)
  assert.match(proposal.text, /新题核心：只依据真实网签/)
  assert.match(proposal.text, /第一轮补充：只看官方数据/)
  assert.match(proposal.text, /第二轮补充：突出区域差异/)
  assert.match(proposal.text, new RegExp(selected.editorialConfirmation.token))
  assert.doesNotMatch(proposal.text, /旧稿标题不可展示|旧稿正文不可展示|创作红线|不得推断|绝不自动公开发布/)

  const tokenBeforeReplay = selected.editorialConfirmation.token
  const replay = await tickWith(store, producer, [m('choice-colloquial', '2 吧', '2026-11-14 10:01')])
  state = await store.read()
  cfg = state.editorialWorkflow.feishu
  assert.equal(replay.sends.length, 0, '相同 messageId 重放不重复发送')
  assert.equal(state.items.find(r => r.id === 'topic-3').editorialBriefVersion, 1)
  assert.equal(state.items.find(r => r.id === 'topic-3').editorialConfirmation.token, tokenBeforeReplay)
  assert.deepEqual(state.items.find(r => r.id === 'topic-1'), oldBefore, '重放也不得损伤旧稿')
  assert.equal(producer.starts.length, 0)
})

test('批次明确选择的常见全句变体可选中，疑问、附加指令和修改条件均不选择也不修旧稿', async t => {
  const cases = [
    { text: '选第2个', selected: true },
    { text: '选第二个', selected: true },
    { text: '我就选 2 项吧', selected: true },
    { text: '请选第2个', selected: true },
    { text: '选项2', selected: true },
    { text: '选第2个，但把标题改得更口语', selected: false },
    { text: '2 吧，然后直接开始创作', selected: false },
    { text: '如果数据齐全就选2', selected: false },
    { text: '选2？', selected: false },
    { text: '2 和 3 哪个更适合', selected: false },
    { text: '我觉得2不错，但还想比较一下', selected: false },
    { text: '第2个的标题需要改', selected: false },
    { text: '2 吧？', selected: false },
  ]
  for (const [i, c] of cases.entries()) {
    await t.test(c.text, async tt => {
      const store = await fixture(tt)
      await enable(store, { activeTopicId: 'topic-1' })
      await store.mutate('', state => {
        state.items.push(
          { id: 'topic-2', recordType: 'topic', title: '候选二', body: '', status: 'outline' },
          { id: 'topic-3', recordType: 'topic', title: '候选三', body: '', status: 'outline' },
        )
        const old = state.items.find(r => r.id === 'topic-1')
        old.editorialBrief = '旧题简报'
        old.editorialBriefVersion = 2
        old.editorialConfirmation = { token: 'old-creation-token', briefVersion: 2, brief: '旧题简报', dispatch: 'started' }
        old.production = { status: 'done', format: 'guizang', title: '旧题', article: '旧文' }
        old.readyForReview = true
        old.completedNotified = true
        old.editorialDiscussion = [{ messageId: 'receipt', text: '历史消息', reply: '历史回执', status: 'processed' }]
        old.draftReceipt = { status: 'draft_saved', artifactHash: fingerprint(old.production) }
      })
      const producer = mockProducer()
      const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
      await ed.proposeTopics({ batchId: `choice-syntax-${i}`, topics: [
        { topicId: 'topic-2', brief: '候选二简报' }, { topicId: 'topic-3', brief: '候选三简报' },
      ] })
      const oldBefore = structuredClone((await store.read()).items.find(r => r.id === 'topic-1'))
      let modelCalls = 0
      const { sends } = await tickWith(store, producer, [m(`choice-syntax-message-${i}`, c.text, '2026-11-14 10:02')], async () => {
        modelCalls++
        return em(JSON.stringify({ reply: '不应修订', brief: '不应采用' }))
      })
      const state = await store.read()
      const cfg = state.editorialWorkflow.feishu
      assert.equal(cfg.activeTopicId, c.selected ? 'topic-3' : 'topic-1')
      assert.equal(cfg.batch.phase, c.selected ? 'selected' : 'awaiting_topic_choice')
      assert.deepEqual(state.items.find(r => r.id === 'topic-1'), oldBefore)
      assert.equal(modelCalls, 0, '选择式歧义句不得当成旧稿修订')
      assert.equal(producer.starts.length, 0)
      if (!c.selected) {
        assert.equal(sends.length, 1, '歧义句必须回复请明确选题，不得静默吞掉')
        assert.match(sends[0].text, /等待明确选题/)
        assert.match(sends[0].text, /未修改旧稿/)
        const audit = cfg.pendingChoiceInbox?.find(row => row.messageId === `choice-syntax-message-${i}`)
        assert.equal(audit?.text, c.text, '选择式歧义原文须在批次级审计区完整保留')
        assert.equal(audit?.batchId, `choice-syntax-${i}`)
        assert.equal(audit?.status, 'needs_explicit_choice')
      }
    })
  }
})

test('待选期间普通数字讨论有回执且原文可审计，不修改旧稿、不调用模型或创作', async t => {
  const cases = ['10月网签如何', '预算1000万，能写哪些板块？', '2026年政策和2025年相比有什么变化？', '这个角度还能再讨论吗']
  for (const [i, text] of cases.entries()) {
    await t.test(text, async tt => {
      const store = await fixture(tt)
      await enable(store, { activeTopicId: 'topic-1' })
      await store.mutate('', state => {
        state.items.push(
          { id: 'topic-2', recordType: 'topic', title: '候选二', body: '', status: 'outline' },
          { id: 'topic-3', recordType: 'topic', title: '候选三', body: '', status: 'outline' },
        )
        const old = state.items.find(r => r.id === 'topic-1')
        old.editorialBrief = '旧题简报'
        old.editorialBriefVersion = 3
        old.editorialConfirmation = { token: 'oldtoken123456', briefVersion: 3, brief: '旧题简报', dispatch: 'started' }
        old.production = { status: 'done', format: 'guizang', title: '旧题', article: '旧文' }
        old.readyForReview = true
        old.completedNotified = true
        old.editorialReview = { status: 'passed', artifactHash: fingerprint(old.production), source: 'operator' }
        old.editorialDiscussion = [{ messageId: 'old-receipt', text: '旧消息', reply: '旧回执', status: 'processed' }]
        old.draftReceipt = { status: 'draft_saved', artifactHash: fingerprint(old.production) }
      })
      const producer = mockProducer()
      const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
      await ed.proposeTopics({ batchId: `numeric-discussion-${i}`, topics: [
        { topicId: 'topic-2', brief: '候选二简报' }, { topicId: 'topic-3', brief: '候选三简报' },
      ] })
      const oldBefore = structuredClone((await store.read()).items.find(r => r.id === 'topic-1'))
      let modelCalls = 0
      const messageId = `numeric-discussion-message-${i}`
      const { sends } = await tickWith(store, producer, [m(messageId, text, '2026-11-14 10:02')], async () => {
        modelCalls++
        return em(JSON.stringify({ reply: '不应修订', brief: '不应采用' }))
      })
      const state = await store.read()
      const cfg = state.editorialWorkflow.feishu
      assert.equal(cfg.activeTopicId, 'topic-1')
      assert.equal(cfg.batch.phase, 'awaiting_topic_choice')
      assert.deepEqual(state.items.find(r => r.id === 'topic-1'), oldBefore, '普通讨论不得追加到旧题或作废旧回执')
      assert.equal(modelCalls, 0)
      assert.equal(producer.starts.length, 0)
      assert.equal(sends.length, 1, '普通讨论不得静默吞掉')
      assert.match(sends[0].text, /等待明确选题/)
      assert.match(sends[0].text, /普通讨论不会丢失/)
      assert.match(sends[0].text, /未修改旧稿/)
      const audit = cfg.pendingChoiceInbox?.find(row => row.messageId === messageId)
      assert.equal(audit?.text, text, '必须保留当前用户原文，而非只存摘要')
      assert.equal(audit?.batchId, `numeric-discussion-${i}`)
      assert.equal(audit?.activeTopicIdAtReceipt, 'topic-1')
      assert.equal(audit?.status, 'needs_explicit_choice')
      assert.ok(cfg.processedIds.includes(messageId))

      const replay = await tickWith(store, producer, [m(messageId, text, '2026-11-14 10:02')])
      assert.equal(replay.sends.length, 0, '相同真实 messageId 重放不重复回执')
      assert.equal((await store.read()).editorialWorkflow.feishu.pendingChoiceInbox.filter(row => row.messageId === messageId).length, 1)
      assert.deepEqual((await store.read()).items.find(r => r.id === 'topic-1'), oldBefore)
    })
  }
})

test('多轮补充与长简报确认完整展示全部当前要求，无600字截断或只留最后一条', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const messages = []
  const { transport, sends } = flatTransport(messages)
  const ed = createFeishuEditorial({
    store, producer, transport, now: () => new Date(NOW),
    callText: async () => em(JSON.stringify({ reply: '模型摘要不得替代原文', brief: '有效模型简报' })),
  })
  const base = `基础要求起点：只依据真实来源。\n${'基础背景：引用真实来源；'.repeat(160)}\n基础要求终点：保留全部限制。`
  const first = `第一轮补充起点：保留出处。\n${'第一轮要求：保留数据出处；'.repeat(100)}\n第一轮补充终点：不得自行推断。`
  const second = `第二轮补充起点：解释差异。\n${'第二轮要求：解释区域差异；'.repeat(100)}\n第二轮补充终点：预算1000万只作边界。`
  await ed.propose({ topicId: 'topic-1', brief: base })
  const initial = sends.find(row => row.text?.includes('创作简报（当前完整要求，无省略）'))
  assert.ok(initial.text.includes(base), '初始长简报须完整可见')
  assert.equal(producer.starts.length, 0)

  messages.push(m('long-supplement-1', first, '2026-11-14 10:01'))
  await ed.tick()
  const firstReply = sends.filter(row => row.text?.includes('更新后的创作简报（当前完整要求，无省略）')).at(-1)
  assert.ok(firstReply.text.includes(base))
  assert.ok(firstReply.text.includes(first))

  messages.push(m('long-supplement-2', second, '2026-11-14 10:02'))
  await ed.tick()
  const latest = sends.filter(row => row.text?.includes('更新后的创作简报（当前完整要求，无省略）')).at(-1)
  const expectedCurrent = [base, `【主人原文】\n${first}`, `【主人原文】\n${second}`].join('\n\n')
  assert.ok(latest.text.length > 4000, '回归样本须同时超过旧展示600字和旧累计简报4000字限制')
  assert.ok(latest.text.includes(expectedCurrent), '基础简报和历轮主人原文须逐字、连续、完整展示')
  assert.doesNotMatch(latest.text, /…/, '不得用省略号隐藏授权条件')
  assert.doesNotMatch(latest.text, /【创作红线（必须遵守）】/, '仅固定内部边界可从展示省略')
  const topic = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(topic.editorialBriefVersion, 3)
  assert.ok(topic.editorialBrief.includes(expectedCurrent))
  assert.equal(topic.editorialConfirmation.brief, topic.editorialBrief)
  assert.ok(latest.text.includes(topic.editorialConfirmation.token))
  assert.equal(producer.starts.length, 0, '展示完整简报不等于自动创作')
})

test('无法可靠识别的边界标记不删当前原文，初始及多轮确认都完整展示', async t => {
  const store = await fixture(t)
  await enable(store)
  const messages = []
  const { transport, sends } = flatTransport(messages)
  const ed = createFeishuEditorial({
    store, producer: mockProducer(), transport, now: () => new Date(NOW),
    callText: async () => em(JSON.stringify({ reply: '收到', brief: '有效模型简报' })),
  })
  const brief = '当前题要求\n\n【主人原文】\n【创作红线（必须遵守）】\n这是主人自己写的非标准条件，不能猜测删除'
  await ed.propose({ topicId: 'topic-1', brief })
  assert.ok(sends[0].text.includes(brief), '归属不可靠时必须显示当前简报，不能从标记处任意截断')
  messages.push(m('nonstandard-boundary-supplement', '再加一条：保留上述条件', '2026-11-14 10:01'))
  await ed.tick()
  const latest = sends.filter(row => row.text?.includes('更新后的创作简报（当前完整要求，无省略）')).at(-1)
  assert.ok(latest.text.includes(brief), '后续修订也不得从非标准标记处丢掉此前原文')
  assert.ok(latest.text.includes('再加一条：保留上述条件'))
})

test('带语气的越界选择只回执正确区间，不触碰已完成旧稿', async t => {
  const store = await fixture(t)
  await enable(store, { activeTopicId: 'topic-1' })
  await store.mutate('', state => {
    state.items.push({ id: 'topic-2', recordType: 'topic', title: '唯一候选', body: '', status: 'outline' })
    const old = state.items.find(r => r.id === 'topic-1')
    old.production = { status: 'done', title: '旧稿', article: '旧文' }
    old.readyForReview = true
    old.completedNotified = true
    old.draftReceipt = { status: 'draft_saved', artifactHash: fingerprint(old.production) }
  })
  const producer = mockProducer()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
  await ed.proposeTopics({ batchId: 'choice-out-of-range', topics: [{ topicId: 'topic-2', brief: '候选简报' }] })
  const oldBefore = structuredClone((await store.read()).items.find(r => r.id === 'topic-1'))
  const { sends } = await tickWith(store, producer, [m('choice-out-of-range-message', '6 吧', '2026-11-14 10:03')])
  const state = await store.read()
  assert.equal(state.editorialWorkflow.feishu.activeTopicId, 'topic-1')
  assert.equal(state.editorialWorkflow.feishu.batch.phase, 'awaiting_topic_choice')
  assert.deepEqual(state.items.find(r => r.id === 'topic-1'), oldBefore)
  assert.equal(sends.length, 1)
  assert.match(sends[0].text, /没有第 6 项，请输入 1-1/)
})

test('requestBrowserApproval：已批准且哈希一致时不换 token（幂等返回 status）', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  await ed.propose({ topicId: 'topic-1', brief: '首付比例' })
  const tok0 = (await store.read()).items.find(r => r.id === 'topic-1').editorialConfirmation.token
  await tickWith(store, producer, [m('go', `确认创作 ${tok0}`, '2026-11-14 10:00')])
  await toApproved(store, producer, ed)
  const before = (await store.read()).items.find(r => r.id === 'topic-1').browserApproval.token
  const st = await ed.requestBrowserApproval('topic-1')
  assert.equal(st.phase, 'browser_approved', '已批准时幂等返回 status')
  const after = (await store.read()).items.find(r => r.id === 'topic-1').browserApproval.token
  assert.equal(after, before, '执行期不更换 token')
})

test('proposeTopics 新建候选：持久成题，同 batchId 幂等不重复建题、不重复发', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = mockProducer()
  const { transport, sends } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  const payload = (batchId) => ({ batchId, topics: [{ title: '新候选题', brief: '新候选简报' }] })
  await ed.proposeTopics(payload('dayA'))
  let state = await store.read()
  const created = state.items.filter(r => r.recordType === 'topic' && r.id !== 'topic-1')
  assert.equal(created.length, 1, '新建一个候选题')
  assert.equal(created[0].title, '新候选题')
  assert.equal(created[0].editorialBrief, undefined)
  const sentCount = sends.length
  // 同 batchId 重放：已存在批次，直接返回，不重复建题/不重复发
  await ed.proposeTopics(payload('dayA'))
  state = await store.read()
  assert.equal(state.items.filter(r => r.recordType === 'topic' && r.id !== 'topic-1').length, 1, '同 batchId 不重复建题')
  assert.equal(sends.length, sentCount, '同 batchId 不重复发送')
  // 不同 batchId 再建 → 再新增一个候选（各自独立）
  await ed.proposeTopics(payload('dayB'))
  state = await store.read()
  assert.equal(state.items.filter(r => r.recordType === 'topic' && r.id !== 'topic-1').length, 2, '不同 batchId 各自新建')
})

test('proposeTopics 新网页快照无需 Store 原记录即可保留；白名单字段与 http(s) 校验，title/body 限长', async t => {
  const store = await fixture(t) // 只有 topic-1，没有 material 记录
  await enable(store)
  const producer = mockProducer()
  const { transport, sends } = flatTransport()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
  const snapshot = {
    id: 'snap-1',
    title: '今日网签快照标题',
    body: '这是一段当日采集的原文快照，不需要 Store 先有这条素材记录。',
    url: 'https://example.com/news/1',
    source: '网签机构',
    channel: 'transaction',
    date: '2026-11-14',
    publishedAt: '2026-11-14 09:30',
    retrievedAt: '2026-11-14 11:00',
    evidenceStatus: 'verified',
    arbitraryField: 'x',
    evil: { '__proto__': { polluted: true } },
  }
  const illegalUrlRow = { url: 'ftp://nope', title: '' } // 非法 url 且无 title/body → 整行丢弃
  const longTitle = '超长'.repeat(70) // 140 字 > 120
  const longBody = 'x'.repeat(13000) // > 12000
  const payload = {
    batchId: 'snap-batch',
    topics: [{
      brief: '整合当日网签快照创作',
      title: longTitle, body: longBody, url: 'not-a-url',
      sourceMaterials: [snapshot, illegalUrlRow],
      sourceIds: ['mat-nonexistent'], // 仅允许真实 material，这里应被丢弃
    }],
  }
  await ed.proposeTopics(payload)
  const state = await store.read()
  const created = state.items.find(r => r.recordType === 'topic' && r.id !== 'topic-1')
  assert.ok(created, '新建候选题')
  // title/body 限长
  assert.equal(created.title.length, 120, 'title 截断到 120')
  assert.equal(created.body.length, 12000, 'body 截断到 12000')
  // 非法 url（顶层候选 url）不落库
  assert.equal(created.url, undefined, '非法 url 忽略')
  // sourceIds 仅允许真实 material：不存在的 id 被丢弃
  assert.deepEqual(created.sourceIds, [])
  // 新快照被保留并保留来源/日期字段，丢弃任意字段与非法 url 行
  assert.equal(created.sourceMaterials.length, 1, '仅合法快照保留')
  const kept = created.sourceMaterials[0]
  assert.equal(kept.publishedAt, '2026-11-14 09:30')
  assert.equal(kept.retrievedAt, '2026-11-14 11:00')
  assert.equal(kept.evidenceStatus, 'verified')
  assert.equal(kept.source, '网签机构')
  assert.equal(kept.date, '2026-11-14')
  assert.equal(kept.url, 'https://example.com/news/1')
  assert.equal(kept.arbitraryField, undefined, '任意字段被丢弃')
  assert.equal(kept.evil, undefined, '嵌套对象被丢弃')
  // 同 batchId 幂等：不重复建题/不重复发
  const sentCount = sends.length
  await ed.proposeTopics(payload)
  const state2 = await store.read()
  assert.equal(state2.items.filter(r => r.recordType === 'topic' && r.id !== 'topic-1').length, 1, '同 batchId 不重复建题')
  assert.equal(sends.length, sentCount, '同 batchId 不重复发送')
})

// ---------- reviseProduction ----------

/** 把 topic-1 置为「当前活动、归藏完稿」状态并返回指纹。 */
async function doneProduction(store, producer, { production = {}, active = true } = {}) {
  await store.mutate('', state => {
    const c = state.editorialWorkflow.feishu
    if (active) c.activeTopicId = 'topic-1'
    const it = state.items.find(r => r.id === 'topic-1')
    it.production = {
      status: 'done', format: 'guizang', title: '旧标题', article: '旧正文',
      cover: { src: 'a' }, cards: [{ src: 'a' }, { src: 'b' }], images: [{ src: 'b' }],
      ...production,
    }
    it.readyForReview = true
    it.completedNotified = true
  })
  return fingerprint((await store.read()).items.find(r => r.id === 'topic-1').production)
}

function revProducer({ relayout = true } = {}) {
  const rels = []
  return {
    rels,
    async start(id, opts) { return true },
    isRunning() { return false },
    cancel() {},
    status() { return { running: false } },
    async relayout(id) { rels.push(id); if (relayout === false) return false; return true },
  }
}

function relayoutThrowProducer() {
  const rels = []
  return {
    rels,
    async start(id, opts) { return true },
    isRunning() { return false },
    cancel() {},
    status() { return { running: false } },
    async relayout(id) { rels.push(id); throw new Error('relayout boom') },
  }
}

test('reviseProduction：修订内容/保留历史/needs_review/不自动通过/触重排', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = revProducer()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
  const hash = await doneProduction(store, producer)
  const st = await ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: ' 新标题 ', article: ' 新正文内容 ' })
  assert.equal(st.revised, true)
  assert.equal(st.relayoutStarted, true)
  assert.equal(st.layoutOutdated, true, '修订后布局待重排，由运行器清除')
  assert.equal(st.reviewStatus, 'needs_review', '修订后仅 needs_review，绝不自动 passed')
  assert.deepEqual(producer.rels, ['topic-1'])
  const item = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(item.production.title, '新标题', '标题 trim 后落库')
  assert.equal(item.production.article, '新正文内容', '正文 trim 后落库')
  assert.equal(item.production.coverText, '新标题')
  assert.equal(item.production.layoutOutdated, true, '重排由运行器完成前 layoutOutdated 保持 true')
  // append-only 历史：记录修订前的旧标题/正文/哈希且不截断。
  assert.equal(item.editorialRevisions.length, 1)
  assert.equal(item.editorialRevisions[0].title, '旧标题')
  assert.equal(item.editorialRevisions[0].article, '旧正文')
  assert.equal(item.editorialRevisions[0].artifactHash, hash)
  // 再次修订 → 历史累积，不覆盖、不截断。
  const hash2 = fingerprint(item.production)
  await ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash2, title: '第三版', article: '第三版正文' })
  const item2 = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(item2.editorialRevisions.length, 2, '历史 append-only 不截断')
  assert.equal(item2.editorialReview.status, 'needs_review')
  assert.equal((await ed.status()).phase, 'needs_review')
})

test('reviseProduction：stalehash / 非字符串 / 空 / 超长 / 非归藏 / 已过期 / 非活动 / 禁用 全拒绝', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = revProducer()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
  const hash = await doneProduction(store, producer)
  // 错误哈希
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: 'badhash', title: 't', article: 'a' }), /产物哈希/)
  // 非字符串
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 123, article: 'a' }), /标题必须是字符串/)
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 't', article: null }), /正文必须是字符串/)
  // 空
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: '  ', article: 'a' }), /标题/)
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 't', article: '   ' }), /正文/)
  // 超长
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: '超'.repeat(21), article: 'a' }), /标题/)
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 't', article: 'x'.repeat(20001) }), /正文/)
  // 非归藏
  await doneProduction(store, producer, { production: { format: 'xhs' } })
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: fingerprint((await store.read()).items.find(r => r.id === 'topic-1').production), title: 't', article: 'a' }), /归藏/)
  // 过期
  await doneProduction(store, producer, { production: { outdated: true } })
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: fingerprint((await store.read()).items.find(r => r.id === 'topic-1').production), title: 't', article: 'a' }), /过期/)
  // 非活动题
  await store.mutate('', state => { state.editorialWorkflow.feishu.activeTopicId = 'topic-other' })
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 't', article: 'a' }), /当前活动选题/)
  // 禁用
  await store.mutate('', state => { state.editorialWorkflow.feishu.enabled = false })
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 't', article: 'a' }), /未启用/)
})

test('reviseProduction：批准中拒绝；pending 批推被置 invalidated 且保留历史', async t => {
  const store = await fixture(t)
  await enable(store)
  const producer = revProducer()
  const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
  // approved 拒绝
  const hash = await doneProduction(store, producer)
  await store.mutate('', state => {
    state.items.find(r => r.id === 'topic-1').browserApproval = { status: 'approved', token: 'tok', hash, approvedBy: 'x', device: 'Air', model: 'gpt-6.1-terra' }
  })
  await assert.rejects(ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 't', article: 'a' }), /批推正在执行中/)
  // pending 批推 → 修订后 invalidated，保留 token/hash 历史字段
  await store.mutate('', state => { delete state.items.find(r => r.id === 'topic-1').browserApproval })
  await doneProduction(store, producer)
  await store.mutate('', state => {
    state.items.find(r => r.id === 'topic-1').browserApproval = { status: 'pending', token: 'tokp', hash, messageId: 'msg1' }
  })
  const base = fingerprint((await store.read()).items.find(r => r.id === 'topic-1').production)
  await ed.reviseProduction({ topicId: 'topic-1', artifactHash: base, title: '新题', article: '新文' })
  const item = (await store.read()).items.find(r => r.id === 'topic-1')
  assert.equal(item.browserApproval.status, 'invalidated')
  assert.equal(item.browserApproval.token, 'tokp', '保留 token 历史字段')
  assert.equal(item.browserApproval.messageId, 'msg1', '保留 messageId 历史字段')
  assert.ok(item.browserApproval.invalidatedAt)
  assert.equal(item.editorialRevisions[0].title, '旧标题')
})

test('reviseProduction：relayout 抛错 / 返回 false 显式报错且保留修订与 layoutOutdated', async t => {
  const store = await fixture(t)
  await enable(store)
  const editor = createFeishuEditorial({ store, producer: revProducer(), callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
  const hash = await doneProduction(store, revProducer())
  // 返回 false
  {
    const producer = revProducer({ relayout: false })
    const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
    const st = await ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash, title: 'A版', article: 'A文' })
    assert.equal(st.relayoutStarted, false)
    assert.equal(st.layoutOutdated, true, '重排未启动保留 layoutOutdated')
    assert.match(st.error, /重排未启动/)
    const item = (await store.read()).items.find(r => r.id === 'topic-1')
    assert.equal(item.production.title, 'A版', '修订内容保留')
    assert.equal(item.production.layoutOutdated, true)
    assert.match((await ed.status()).lastError, /重排未启动/)
  }
  // 抛错
  {
    const producer = relayoutThrowProducer()
    const hash2 = fingerprint((await store.read()).items.find(r => r.id === 'topic-1').production)
    const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport: flatTransport().transport, now: () => new Date(NOW) })
    const st = await ed.reviseProduction({ topicId: 'topic-1', artifactHash: hash2, title: 'B版', article: 'B文' })
    assert.equal(st.relayoutStarted, false)
    assert.equal(st.layoutOutdated, true)
    assert.match(st.error, /重排失败/)
    assert.deepEqual(producer.rels, ['topic-1'])
    const item = (await store.read()).items.find(r => r.id === 'topic-1')
    assert.equal(item.production.title, 'B版', '抛错仍保留修订')
    assert.equal(item.production.layoutOutdated, true)
    assert.match((await ed.status()).lastError, /relayout boom/)
    // 修订 + 保留历史 + 不自动通过
    assert.equal(item.editorialReview.status, 'needs_review')
    assert.ok(item.editorialRevisions.length >= 1)
  }
})

test('BUG-repair 回归：确认创作，发给我 / 确认创作 为一次性创作指令；条件/否定/问句不触发且无浏览器批推', async t => {
  const cases = [
    { text: '确认创作，发给我', expected: 1 },
    { text: '确认创作', expected: 1 },
    { text: '如果确认创作，发给我', expected: 0 },
    { text: '不要确认创作，发给我', expected: 0 },
    { text: '确认创作，发给我？', expected: 0 },
  ]
  for (const [i, c] of cases.entries()) {
    await t.test(`case ${i}: ${c.text}`, async tt => {
      const store = await fixture(tt)
      await enable(store, { activeTopicId: 'topic-1' })
      const producer = mockProducer()
      const { transport } = flatTransport([m(`case${i}`, c.text, `2026-11-14 10:0${i}`)])
      const ed = createFeishuEditorial({ store, producer, callText: async () => em('{}'), transport, now: () => new Date(NOW) })
      await ed.tick()
      await ed.tick()
      assert.equal(producer.starts.length, c.expected, `「${c.text}」应触发创作 ${c.expected} 次`)
      const item0 = (await store.read()).items.find(r => r.id === 'topic-1')
      assert.equal(item0.browserApproval, undefined, `「${c.text}」不得产生浏览器批推`)
    })
  }
})
