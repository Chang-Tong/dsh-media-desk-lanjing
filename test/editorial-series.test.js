import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { beijingDay, dailyTopics, seriesWeek } from '../src/daily-topics.js'
import { selectTopic } from '../src/topic-workflow.js'
import { createSeriesRunner } from '../src/series-runner.js'
import { createXhsDrafts } from '../src/xhs-draft.js'
import { createBuyPoints } from '../src/buy-points.js'
import { Store } from '../src/store.js'
import { Producer } from '../src/produce.js'

const MONDAY = new Date('2026-11-16T01:05:00Z')
const material = (id, channel, title, extra = {}) => ({
  id, channel, title, recordType: 'material', kind: 'note', status: 'idea', date: '2026-11-16',
  evidenceStatus: 'verified', source: '测试证据', body: '用于测试的材料', ...extra,
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lanjing-editorial-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  await store.mutate('', state => { state.items = [
    material('data-1', 'server-insights', '北京住宅网签净增', { url: 'https://example.com/net' }),
    material('data-2', 'server-insights', '同一原文的另一标题', { url: 'https://example.com/net#section' }),
    material('project', 'beijing-news', '某新盘公布预售计划'),
    material('market', 'macro', '某月利率调查'),
    material('land', 'land-auction', '北京住宅地块挂牌'),
    material('buzz', 'memes', '北京看房热点'),
    material('future', 'beijing-news', '某未来新盘预售', { date: '2026-11-17' }),
    material('unverified', 'writing-prompts', '无来源的旧建议'),
  ] })
  return store
}

test('按北京时间选题，综合覆盖五类，排除重复、未来和无证据的旧建议', async t => {
  const store = await fixture(t)
  const { items } = await store.read()
  assert.equal(beijingDay(new Date('2026-11-15T16:01:00Z')), '2026-11-16')
  assert.deepEqual(dailyTopics(items, 'all', MONDAY).topics.map(row => row.label), ['网签','新盘动态','市场动态','土拍与政策','社区热议'])
  assert.equal(dailyTopics(items, 'net-sign', MONDAY).topics.length, 1)
  assert.deepEqual(dailyTopics(items, 'new-homes', MONDAY).topics.map(row => row.id), ['project'])
  assert.equal(seriesWeek(new Date('2026-11-15T23:00:00Z'))[0].date, '2026-11-16')
  const request = { id: 'project', source: 'new-homes', now: MONDAY }
  const [a, b] = await Promise.all([selectTopic(store, request), selectTopic(store, request)])
  assert.equal(a.id, b.id)
  const topic = (await store.read()).items.find(row => row.id === a.id)
  assert.equal(topic.sourceMaterials[0].id, 'project')
  assert.equal(topic.outputFormat, 'guizang')
  assert.equal(topic.platform, '小红书')
})

test('系列默认不运行，启用后选题、生成图文、核对回执并且同日不会重复存草稿', async t => {
  const store = await fixture(t)
  const pngName = 'gz_123a-01.png'
  let starts = 0
  const producer = new Producer({
    store, settings: { read: async () => ({ voice: '' }) },
    callText: async () => { starts++; return { text: '# 网签看什么\n\n请先核对比较口径。', model: 'test' } },
    research: async () => ({ status: 'ok', facts: [{ tool: 'lanjing_net_sign_overview', result: { total: null } }], gaps: [] }),
    renderCards: async () => {
      await mkdir(store.filesDir, { recursive: true })
      await writeFile(join(store.filesDir, pngName), Buffer.from('89504e470d0a1a0a0000', 'hex'))
      return { cards: [{ src: 'media-desk-lanjing/files/' + pngName }], cardHtml: { src: 'fixture' } }
    },
  })
  let saves = 0
  const xhsDrafts = createXhsDrafts({ store, adapter: async () => ({
    async saveDraftFiles({ title, body, images }) {
      saves++
      assert.equal(title, '网签看什么')
      assert.match(body, /比较口径/)
      assert.deepEqual(images, [join(store.filesDir, pngName)])
      return { saved: true, message: '平台测试替身回执' }
    },
  }) })
  const series = createSeriesRunner({ store, producer, xhsDrafts, now: () => MONDAY })
  await series.tick()
  assert.equal(starts, 0)
  await series.setEnabled(true)
  await Promise.all([series.tick(), series.tick()])
  const run = (await series.status()).slots[0]
  assert.equal(run.status, 'generating')
  await producer.jobs.get(run.topicId)?.promise
  const production = (await store.read()).items.find(row => row.id === run.topicId).production
  assert.equal(production?.status, 'done', production?.error)
  await series.setEnabled(false)
  await series.tick()
  assert.equal(saves, 0)
  await series.setEnabled(true)
  await series.tick()
  await series.tick()
  await xhsDrafts.save(run.topicId)
  assert.equal(starts, 1)
  assert.equal(saves, 1)
  assert.equal((await series.status()).slots[0].status, 'draft_saved')
  assert.equal((await store.read()).items.find(row => row.id === run.topicId).status, 'ready')
})

test('没有平台回执时禁止无确认重试，正文被编辑后要求先重排', async t => {
  const store = await fixture(t)
  const pngName = 'gz_234b-01.png'
  await writeFile(join(store.filesDir, pngName), Buffer.from('89504e470d0a1a0a0000', 'hex'))
  const { id } = await selectTopic(store, { id: 'project', source: 'new-homes', now: MONDAY })
  await store.mutate('', state => { state.items.find(row => row.id === id).production = {
    platform: '小红书', format: 'guizang', status: 'done', title: '示例标题', article: '示例正文', cards: [{ src: 'media-desk-lanjing/files/' + pngName }],
  } })
  let attempts = 0
  const xhsDrafts = createXhsDrafts({ store, adapter: async () => ({
    saveDraftFiles: async () => { attempts++; return { uncertain: true, message: '无回执' } },
  }) })
  assert.equal((await xhsDrafts.save(id)).status, 'uncertain')
  assert.equal((await xhsDrafts.save(id)).status, 'uncertain')
  assert.equal(attempts, 1)
  await xhsDrafts.save(id, { retryUncertain: true })
  assert.equal(attempts, 2)
  await store.mutate('', state => { state.items.find(row => row.id === id).production.layoutOutdated = true })
  await assert.rejects(xhsDrafts.save(id), /先更新图卡/)
  assert.equal(attempts, 2)
})

test('埋点缓存读取即使无缓存或带调试参数也不会触发 CloudBase', async t => {
  const store = await fixture(t)
  let calls = 0
  const buyPoints = createBuyPoints({ cacheDir: join(store.root, 'cache'), script: '/test/funnel.js', envId: 'test', run: async () => { calls++; throw new Error('fixture') } })
  assert.equal((await buyPoints.funnel({ days: 7, cacheOnly: true, warm: 1 })).code, 'no_cache')
  assert.equal(calls, 0)
})
