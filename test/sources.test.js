import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { ingest, normalizeEntry } from '../src/sources.js'

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-lanjing-src-'))
  return new Store(dir)
}

function feedItems() {
  return [
    { title: '北京二手房挂牌量创新高', body: '某机构统计……', url: 'https://example.com/a1', source: '第一财经', tags: ['二手房'] },
    { title: '无链接的洞察', body: '朝阳某盘昨日新增网签 12 套' },
  ]
}

test('ingest：频道无效直接拒绝', async () => {
  const store = await tempStore()
  await assert.rejects(() => ingest(store, { channel: 'nope', items: [] }), /频道无效/)
})

test('ingest：写入频道与频道标签，web/ note 分流', async () => {
  const store = await tempStore()
  const result = await ingest(store, { channel: 'beijing-news', date: '2026-11-06', items: feedItems() })
  assert.equal(result.added, 2)
  const rows = result.state.items.filter(i => i.channel === 'beijing-news')
  assert.equal(rows.length, 2)
  const web = rows.find(i => i.url)
  assert.equal(web.kind, 'web')
  assert.ok(web.tags.includes('灵感源·北京新闻'))
  const note = rows.find(i => !i.url)
  assert.equal(note.kind, 'note')
})

test('ingest：幂等，重复推送只跳过已有条目', async () => {
  const store = await tempStore()
  await ingest(store, { channel: 'beijing-news', date: '2026-11-06', items: feedItems() })
  const again = await ingest(store, { channel: 'beijing-news', date: '2026-11-06', items: feedItems() })
  assert.equal(again.added, 0)
  assert.equal(again.skipped, 2)
  const rows = again.state.items.filter(i => i.channel === 'beijing-news')
  assert.equal(rows.length, 2)
})

test('normalizeEntry：空条目返回 null', () => {
  assert.equal(normalizeEntry({}, 'macro', '2026-11-06'), null)
  assert.equal(normalizeEntry({ title: '  ' }, 'macro', '2026-11-06'), null)
})

test('normalizeEntry：非 http 链接降级为 note', () => {
  const row = normalizeEntry({ title: '数据', url: 'ftp://x' }, 'macro', '2026-11-06')
  assert.equal(row.op.kind, 'note')
  assert.equal(row.op.url, null)
})
