import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildCardHtml, locateGuizangSkill, planCards, renderGuizang } from '../src/guizang.js'
import { saveProduction } from '../src/export.js'

const synthetic = {
  title: '合成样本，先看统计口径', platform: '小红书', format: 'guizang',
  article: `## 口径不同，不能直接比较

以下是程序验收使用的合成数据，不是真实新闻。样本甲有 12 条虚构记录，样本乙有 8 条虚构记录。二者统计区域和时间范围不同，不能把差值解释为市场变化。[来源1][来源2]

## 查询时间与统计日期要分开

合成查询时间为 2026-01-05，虚构统计日期为 2026-01-03。页面应分别呈现这两个日期，不能把查询当天称为最新成交日。缺少覆盖信息时，应保留待核实说明。[数据:synthetic_readonly_stats]

## 空值不能填成零

测试数据中的 total 为 null，表示全量尚未取得。partial_sum 只是局部样本小计，应保留原始范围和缺口。快照差值也不能当作逐笔成交。这里所有数字仅用于程序测试。

## 仍需核对完整性

这套合成资料用于验证多来源排版、日期保留和脚本隔离。真实写作时，只有原始来源和实际数据工具返回的内容能作为事实。本文不表达任何现实市场结论。`,
  sourceMaterials: [
    { id: 'synthetic-a', title: '合成资料甲：虚构样本与统计日期', source: '程序测试资料', date: '2026-01-03', evidenceStatus: 'synthetic' },
    { id: 'synthetic-b', title: '合成资料乙：对比范围与完整性说明', source: '程序测试资料', date: '2026-01-04', evidenceStatus: 'synthetic' },
  ],
}

async function seedOrSkip(t) {
  let root
  try { root = await locateGuizangSkill() } catch { t.skip('需要已安装的归藏设计插件，离线单元测试不自动安装'); return null }
  return { root, seed: await readFile(join(root, 'assets', 'template-swiss-card.html'), 'utf8') }
}

test('归藏分页只使用现有正文，按原顺序保留内容', () => {
  const p = planCards(synthetic)
  assert.equal(p[0].kind, 'cover')
  assert.ok(p.length >= 3)
  const body = p.slice(1).flatMap(page => page.rows).map(row => row.body).join('')
  assert.match(body, /12 条虚构记录/)
  assert.match(body, /total 为 null/)
  assert.match(body, /partial_sum/)
  assert.match(body, /synthetic_readonly_stats/)
  assert.ok(p.slice(1).every(page => page.rows.length >= 1 && page.rows.every(row => row.title === page.title)))
  assert.match(body, /本文不表达任何现实市场结论/)
  assert.throws(() => planCards({ title: '只有标题', article: '' }), /正文为空/)
})

test('独立加粗小标题用于后续正文，不生成只有标题的空内容行', () => {
  const pages = planCards({ title: '文章标题', article: '**产品面积**\n\n这里是第一段。\n\n**同预算比较**\n下一段保留**正文强调**。' })
  assert.deepEqual(pages.slice(1).flatMap(page => page.rows), [
    { title: '产品面积', body: '这里是第一段。' },
    { title: '同预算比较', body: '下一段保留正文强调。' },
  ])
})

test('短导语由封面承载，各页保留一个问题且不再次复述导语', () => {
  const pages = planCards({ title: '测试标题', article: '这是一段完整导语。\n\n**总价问题**\n\n第一段解释。\n\n第二段解释。\n\n**房间问题**\n\n第三段解释。' })
  assert.equal(pages[0].teaser, '这是一段完整导语。')
  assert.deepEqual(pages.slice(1).map(page => page.title), ['总价问题', '房间问题'])
  assert.equal(pages.slice(1).flatMap(page => page.rows).map(row => row.body).join(''), '第一段解释。第二段解释。第三段解释。')
})

test('归藏复制已安装 Swiss seed，保留 token 并转义 HTML/命令，移除脚本网络依赖', async t => {
  const installed = await seedOrSkip(t)
  if (!installed) return
  const hostile = { ...synthetic, title: '合成 <$&> 标题', article: '## 合成安全测试\n\n<script>globalThis.pwned=true</script> $1 $& </main><img src="http://127.0.0.1/secret" onerror="alert(1)">。资料只能作为文字，不可以执行。' }
  const html = buildCardHtml(installed.seed, hostile)
  const tokens = /\/\* GZ:TOKENS:START[\s\S]*?GZ:TOKENS:END \*\//
  assert.equal(html.match(tokens)?.[0], installed.seed.match(tokens)?.[0])
  assert.match(html, /data-recipe="S01"/)
  assert.match(html, /data-recipe="S07"/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /\$1 \$&amp;/)
  assert.doesNotMatch(html, /<script\b|<link\b|<img\b/)
  assert.match(html, /default-src 'none'/)
  assert.equal((html.match(/<main\b/g) ?? []).length, 1)
  assert.equal((html.match(/<\/main>/g) ?? []).length, 1)
  assert.throws(() => buildCardHtml('<html>incorrect seed</html>', synthetic), /结构不兼容/)
})

test('实际本地渲染 1080×1440 PNG，并导出独立 HTML/来源包', { timeout: 60000 }, async t => {
  const installed = await seedOrSkip(t)
  if (!installed) return
  const dir = await mkdtemp(join(tmpdir(), 'lanjing-guizang-visual-'))
  const filesDir = join(dir, 'files')
  try {
    const before = await readFile(join(installed.root, 'assets', 'template-swiss-card.html'), 'utf8')
    const rendered = await renderGuizang(synthetic, { filesDir, skillDir: installed.root })
    assert.ok(rendered.cards.length >= 3)
    assert.equal(rendered.skill, 'guizang-social-card-skill')
    for (const card of rendered.cards) {
      const png = await readFile(join(filesDir, card.src.split('/').pop()))
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(png.readUInt32BE(16), 1080)
      assert.equal(png.readUInt32BE(20), 1440)
      assert.equal(card.status, 'done')
    }
    const html = await readFile(join(filesDir, rendered.cardHtml.src.split('/').pop()), 'utf8')
    assert.doesNotMatch(html, /<script\b|<link\b/)
    assert.match(html, /合成资料甲/)
    assert.equal(await readFile(join(installed.root, 'assets', 'template-swiss-card.html'), 'utf8'), before)
    const saved = await saveProduction({ ...synthetic, ...rendered, sourceIds: ['synthetic-a', 'synthetic-b'] }, { filesDir, exportDir: join(dir, 'export') })
    assert.equal(saved.files.filter(name => name.endsWith('.png')).length, rendered.cards.length)
    assert.ok(saved.files.some(name => name.endsWith('.html')))
    if (process.env.LANJING_KEEP_GZ_TEST === '1') {
      console.log(`SYNTHETIC_GUIZANG_DIR=${dir}`)
      console.log(`SYNTHETIC_GUIZANG_IMAGES=${JSON.stringify(rendered.cards.map(card => join(filesDir, card.src.split('/').pop())))}`)
    }
  } finally {
    if (process.env.LANJING_KEEP_GZ_TEST !== '1') {
      assert.ok(dir.startsWith(join(tmpdir(), 'lanjing-guizang-visual-')))
      await rm(dir, { recursive: true, force: true })
    }
  }
})
