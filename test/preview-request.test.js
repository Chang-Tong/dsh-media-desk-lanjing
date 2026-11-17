import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store.js'
import { createEditorialCommands } from '../src/editorial-commands.js'
import { isPreviewRequest, recoverPreviewRequest } from '../src/preview-request.js'

const digest = text => createHash('sha256').update(text).digest('hex')
const MESSAGE = 'om_preview'
const BRIEF = '已确认的简报\n\n【主人原文】\n看看稿件，发我一下-\n\n【创作红线（必须遵守）】\n- 仅保存草稿'
const prod = () => ({ status: 'done', outdated: true, layoutOutdated: false, title: '稿件', article: '已生成正文', coverText: '导语', cover: '/tmp/a.png', cards: ['/tmp/a.png'], startedAt: '2026-11-14T10:19:59.119Z', finishedAt: '2026-11-14T10:20:21.261Z' })
function productionHash(p) {
  return digest(JSON.stringify({ title: p.title, article: p.article, coverText: p.coverText, cover: p.cover, images: [], cards: p.cards, slides: [], shots: [], video: null }))
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'preview-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => {
    state.items = [{ id: 'topic', recordType: 'topic', body: '保留正文', production: prod(), readyForReview: false, editorialBrief: BRIEF, editorialBriefVersion: 10, editorialConfirmation: { brief: BRIEF, briefVersion: 10, token: 'obsolete' }, editorialDiscussion: [
      { messageId: 'om_confirm', confirmed: true, briefVersion: 9, at: '2026-11-14T10:19:59.090Z' },
      { messageId: MESSAGE, text: '看看稿件，发我一下-', status: 'processed', at: '2026-11-14T10:22:29.068Z' },
    ] }]
    state.editorialWorkflow = { feishu: { enabled: true, ownerId: 'ou_owner', chatId: 'oc_chat', activeTopicId: 'topic', phase: 'awaiting_creation_confirmation', processedIds: [MESSAGE] } }
  }, { undoable: false })
  return { root, store, payload: { topicId: 'topic', messageId: MESSAGE, artifactHash: productionHash(prod()), briefHash: digest(BRIEF) } }
}

test('preview classifier accepts only complete read-only requests', () => {
  for (const text of ['看看稿件，发我一下-', ' 把稿子发给我～ ', '看看稿件', '稿件发我一下', '看看稿子', '发我看一下稿件。']) assert.equal(isPreviewRequest(text), true, text)
  for (const text of ['不要把稿子发给我', '如果写好了把稿子发给我', '他说“看看稿件”', '看看稿件，再改一下', '确认创作，发给我', '看看稿件，然后保存', '', null, {}]) assert.equal(isPreviewRequest(text), false, String(text))
})

test('recovery changes only mistaken preview metadata, never approves, and is idempotent', async t => {
  const { store, payload } = await fixture(t)
  const before = structuredClone((await store.read()).items[0])
  assert.deepEqual(await recoverPreviewRequest({ store, ...payload }), { recovered: true, alreadyRecovered: false, topicId: 'topic', messageId: MESSAGE, artifactHash: payload.artifactHash })
  const state = await store.read(); const topic = state.items[0]
  assert.equal(topic.production.outdated, false)
  assert.equal(topic.readyForReview, true)
  assert.equal(state.editorialWorkflow.feishu.phase, 'awaiting_review')
  assert.equal(topic.editorialConfirmation, undefined)
  assert.equal(topic.editorialReview, undefined)
  assert.equal(topic.browserApproval, undefined)
  assert.equal(topic.draftReceipt, undefined)
  assert.equal(topic.editorialBrief, before.editorialBrief)
  assert.equal(topic.body, before.body)
  assert.equal(topic.editorialBriefVersion, before.editorialBriefVersion)
  assert.deepEqual({ ...topic.production, outdated: true }, before.production)
  assert.equal(topic.editorialDiscussion.at(-1).intent, 'preview_request')
  assert.equal((await recoverPreviewRequest({ store, ...payload })).alreadyRecovered, true)
  assert.equal(topic.previewRecoveries.length, 1)
})

const invalidations = [
  ['later revision', (s) => s.items[0].editorialDiscussion.push({ messageId: 'new', status: 'processed', text: '改一下' })],
  ['non-preview request', (s) => { s.items[0].editorialDiscussion.at(-1).text = '不要发稿' }],
  ['unprocessed message', (s) => { s.editorialWorkflow.feishu.processedIds = [] }],
  ['wrong sequence', (s) => { s.items[0].editorialDiscussion[0].confirmed = false }],
  ['wrong confirmed version', (s) => { s.items[0].editorialDiscussion[0].briefVersion = 8 }],
  ['missing owner', (s) => { delete s.editorialWorkflow.feishu.ownerId }],
  ['wrong active topic', (s) => { s.editorialWorkflow.feishu.activeTopicId = 'other' }],
  ['wrong phase', (s) => { s.editorialWorkflow.feishu.phase = 'draft_saved' }],
  ['started before authorization', (s) => { s.items[0].production.startedAt = '2026-11-14T10:18:00Z' }],
  ['finished after preview', (s) => { s.items[0].production.finishedAt = '2026-11-14T10:23:00Z' }],
  ['malformed timestamp', (s) => { s.items[0].production.finishedAt = 'bad' }],
  ['changed article', (s) => { s.items[0].production.article = '更改过的正文' }],
  ['changed brief', (s) => { s.items[0].editorialBrief += '改总价' }],
  ['stale layout', (s) => { s.items[0].production.layoutOutdated = true }],
  ['pending approval', (s) => { s.items[0].browserApproval = { status: 'pending' } }],
  ['approved browser', (s) => { s.items[0].browserApproval = { status: 'approved' } }],
  ['saved receipt', (s) => { s.items[0].draftReceipt = { status: 'draft_saved' } }],
  ['confirmation mismatch', (s) => { s.items[0].editorialConfirmation.brief = '别的简报' }],
]
for (const [name, change] of invalidations) test(`rejects ${name} without partial recovery`, async t => {
  const { store, payload } = await fixture(t)
  await store.mutate('', change, { undoable: false })
  const before = structuredClone(await store.read())
  await assert.rejects(recoverPreviewRequest({ store, ...payload }), /不能恢复/)
  assert.deepEqual(await store.read(), before)
})

test('rejects wrong IDs/hashes and forged marker even with current brief hash', async t => {
  const { store, payload } = await fixture(t)
  for (const changes of [{ messageId: 'other' }, { topicId: 'other' }, { artifactHash: 'a'.repeat(64) }, { briefHash: 'b'.repeat(64) }]) await assert.rejects(recoverPreviewRequest({ store, ...payload, ...changes }), /不能恢复/)
  await store.mutate('', s => { s.items[0].editorialBrief = '无查看原文的简报'; s.items[0].editorialConfirmation.brief = s.items[0].editorialBrief }, { undoable: false })
  await assert.rejects(recoverPreviewRequest({ store, ...payload, briefHash: digest('无查看原文的简报') }), /简报末尾/)
})

test('Host command queue dispatches guarded recovery and persists actual receipt', async t => {
  const { root, store, payload } = await fixture(t)
  const requests = join(root, 'editorial-requests')
  await mkdir(requests, { recursive: true })
  await writeFile(join(requests, 'recover-view.json'), JSON.stringify({ id: 'recover-view', action: 'recover-preview-request', payload }))
  const commands = createEditorialCommands({ store, editorial: {} })
  await commands.tick()
  const result = JSON.parse(await readFile(join(root, 'editorial-results', 'recover-view.json'), 'utf8'))
  assert.equal(result.ok, true)
  assert.equal(result.result.recovered, true)
  assert.equal((await store.read()).items[0].production.outdated, false)
})
