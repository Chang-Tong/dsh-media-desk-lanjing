// 埋点转化 Host 逻辑：用注入的执行器替身覆盖，不联网、不跑 tcb、不碰真实 CloudBase。
// 缓存新鲜度与每日 03:00 预热用注入的假时钟 / 假 timer 验证，不依赖真实时间。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBuyPoints, isDiskCacheFresh, lastWarmBoundary, mockBuyPointsSnapshot, nextWarmBoundary, normalizeBuyPoints, parseScriptOutput, scriptCandidates } from '../src/buy-points.js'

/** 本地时间构造（用户机器在 Asia/Shanghai；这里只依赖本地时区，不做 UTC 换算）。 */
function at(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

function fakeClock(startMs) {
  let current = startMs
  return {
    now: () => current,
    set: (ms) => { current = ms },
    advance: (ms) => { current += ms },
  }
}

/** 假 timer：记录 delay / 是否被 clear / unref 调用次数，测试自己决定什么时候「到点」。 */
function fakeTimers() {
  const all = []
  let nextId = 1
  const api = {
    setTimeout(fn, delay) {
      const timer = { id: nextId++, fn, delay, cleared: false, unrefCalls: 0 }
      timer.unref = () => { timer.unrefCalls += 1 }
      all.push(timer)
      return timer
    },
    clearTimeout(timer) { if (timer) timer.cleared = true },
    pending: () => all.filter(timer => !timer.cleared),
    fire(timer) {
      timer.cleared = true
      timer.fn()
    },
  }
  return api
}

/** 等后台刷新把它那一次磁盘写入落完，避免删临时目录时和写盘抢目录（ENOTEMPTY）。 */
async function settle(ms = 30) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** 轮询等待条件成立（用 setImmediate，不用计时）。 */
async function waitFor(predicate, ticks = 400) {
  for (let i = 0; i < ticks; i += 1) {
    if (await predicate()) return true
    await new Promise(resolve => setImmediate(resolve))
  }
  return false
}

/** 形状对齐数据仓 scripts/conversion-funnel.js 的真实输出（数字取自 2026-11-10 的 7 天窗口实跑），全是聚合计数。 */
function snapshot(days = 7) {
  const stages = (rows) => rows.map((row, index) => ({
    key: row.key,
    label: row.label,
    actors: row.actors,
    events: row.actors,
    fromPrev: index === 0 || !rows[index - 1].actors ? null : Number((row.actors / rows[index - 1].actors).toFixed(4)),
    ofFirst: rows[0].actors ? Number((row.actors / rows[0].actors).toFixed(4)) : null,
    unordered: row.actors,
    ...(row.pending ? { pending: true } : {}),
    ...(row.detached ? { detached: true } : {}),
  }))
  const primary = stages([
    { key: 'session', label: '打开小程序', actors: 402 },
    { key: 'view', label: '浏览页面', actors: 401 },
    { key: 'entry_shown', label: '服务入口曝光', actors: 355 },
    { key: 'entry_clicked', label: '进入服务', actors: 1 },
    { key: 'form', label: '打开表单', actors: 0 },
    { key: 'attempt', label: '提交留资', actors: 0 },
  ])
  const research = stages([
    { key: 'session', label: '打开小程序', actors: 402 },
    { key: 'detail', label: '看楼盘详情', actors: 249 },
    { key: 'deep', label: '看户型/楼栋/关注/对比/解锁', actors: 0, pending: true, detached: true },
    { key: 'lead', label: '留资成功', actors: 1 },
  ])
  return {
    ok: true,
    generatedAt: '2026-11-09T16:57:49.030Z',
    timezone: 'Asia/Shanghai',
    range: { days, from: '2026-11-04', to: '2026-11-10' },
    source: { envId: 'test-env', collection: 'product_events', readOnly: true, schema: 3 },
    scope: '会话级有序漏斗；排除已识别管理员与 develop/trial；渠道为自报标签，不作财务归因',
    outcome: { saved: 1, contact: 2 },
    funnels: [
      { key: 'primary', label: '主转化漏斗', stages: primary },
      { key: 'research', label: '研究深度漏斗', stages: research },
    ],
    dropoff: [
      { funnel: 'primary', from: 'session', to: 'view', lost: 1, rate: 0.0025, passRate: 0.9975 },
      { funnel: 'primary', from: 'view', to: 'entry_shown', lost: 46, rate: 0.1147, passRate: 0.8853 },
      { funnel: 'primary', from: 'entry_shown', to: 'entry_clicked', lost: 354, rate: 0.9972, passRate: 0.0028 },
      { funnel: 'primary', from: 'entry_clicked', to: 'form', lost: 1, rate: 1, passRate: 0 },
      { funnel: 'primary', from: 'form', to: 'attempt', lost: 0, rate: null, passRate: null },
      { funnel: 'research', from: 'session', to: 'detail', lost: 153, rate: 0.3806, passRate: 0.6194 },
      { funnel: 'research', from: 'detail', to: 'lead', lost: 248, rate: 0.996, passRate: 0.004 },
    ],
    trend: ['04', '05', '06', '07', '08', '09'].map((day) => ({
      date: `2026-11-${day}`,
      primary: [10, 10, 9, 0, 0, 0],
      research: [10, 6, 0, 0],
      sessions: 10,
    })),
    breakdown: [
      { dimension: 'source', rows: [{ value: 'other_page', sessions: 209, stages: [209, 208, 181, 0, 0, 0] }] },
      { dimension: 'pageKey', rows: [{ value: 'pages/home/index', sessions: 365, stages: [364, 364, 328, 1, 0, 0] }] },
      { dimension: 'budgetBand', rows: [{ value: 'unknown', sessions: 403, stages: [402, 401, 355, 1, 0, 0] }] },
    ],
    events: [{ name: 'app_session_started', count: 402 }],
    warnings: ['部分埋点事件尚未上线，对应级为 0 表示未采集而非零转化（见 stage.pending）'],
    unavailable: [],
    extra: {
      outcome: { saved: 1, contact: 2 },
      legacyInspection: { started: 434, reportViewed: 356, linked: false, note: '旧埋点流，无 sessionHash/schemaVersion' },
    },
  }
}

/** 每个用例一个临时目录：脚本替身文件真实存在，执行器由用例注入，缓存落在临时目录。 */
async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lanjing-buy-points-test-'))
  const file = join(dir, 'conversion-funnel-stand-in.js')
  await writeFile(file, '// 合成测试：替身脚本只占位，真正的执行器由用例注入\n', 'utf8')
  const calls = []
  const instance = createBuyPoints({
    env: options.env ?? {},
    envId: options.envId === undefined ? 'test-env' : options.envId,
    script: options.script === undefined ? file : options.script,
    cacheDir: options.cacheDir ?? join(dir, 'cache'),
    timeoutMs: options.timeoutMs,
    mock: options.mock,
    now: options.now,
    timers: options.timers,
    log: options.log ?? { warn: () => {}, error: () => {} },
    run: async (input) => {
      calls.push(input)
      if (options.run) return options.run(input)
      return snapshot(input.days)
    },
  })
  return {
    dir,
    file,
    instance,
    calls,
    close: async () => {
      // 只删自己建的临时目录
      assert.ok(dir.startsWith(join(tmpdir(), 'lanjing-buy-points-test-')))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('正常快照：字段名不变，数字照抄，meta 标明不是示例也不是缓存', async () => {
  const fix = await fixture()
  try {
    const data = await fix.instance.funnel({ days: 7 })
    assert.equal(data.ok, true)
    assert.deepEqual(data.funnels.map(row => row.key), ['primary', 'research'])
    assert.deepEqual(data.funnels[0].stages.map(row => row.actors), [402, 401, 355, 1, 0, 0])
    assert.deepEqual(data.funnels[1].stages.map(row => row.actors), [402, 249, 0, 1])
    assert.equal(data.funnels[1].stages[2].pending, true)
    assert.equal(data.funnels[1].stages[2].detached, true)
    assert.deepEqual(data.outcome, { saved: 1, contact: 2 })
    assert.equal(data.dropoff.find(row => row.from === 'entry_shown').rate, 0.9972)
    assert.equal(data.dropoff.find(row => row.from === 'form').rate, null)
    assert.equal(data.trend.length, 6)
    assert.deepEqual(data.unavailable, [])
    assert.equal(data.range.from, '2026-11-04')
    // 真实 0 就是 0，不能被当成缺失
    assert.equal(data.funnels[0].stages[4].actors, 0)
    assert.equal(data.meta.mock, false)
    assert.equal(data.meta.cached, false)
    assert.equal(data.meta.cachedAt, null)
    assert.equal(fix.calls.length, 1)
    assert.equal(fix.calls[0].envId, 'test-env')
    assert.equal(fix.calls[0].days, 7)
    assert.equal(fix.calls[0].timeoutMs, 120_000)
  } finally {
    await fix.close()
  }
})

test('脚本缺失：返回 not_configured，不返回任何 0 占位的数据', async () => {
  const fix = await fixture({ script: join(tmpdir(), 'lanjing-no-such-script-xyz.js') })
  try {
    const data = await fix.instance.funnel({ days: 7 })
    assert.equal(data.ok, false)
    assert.equal(data.code, 'not_configured')
    assert.match(data.message, /埋点转化还没有接入/)
    assert.ok(data.missing.includes('script'))
    assert.equal(data.funnels, undefined)
    assert.equal(data.outcome, undefined)
    assert.equal(fix.calls.length, 0)
    const status = await fix.instance.status()
    assert.equal(status.scriptExists, false)
    assert.equal(status.envId, 'test-env')
    assert.deepEqual(status.days, [7, 14, 30])
  } finally {
    await fix.close()
  }
})

test('环境未配置：缺 envId 也是 not_configured', async () => {
  const fix = await fixture({ envId: '' })
  try {
    const data = await fix.instance.funnel({ days: 7 })
    assert.equal(data.ok, false)
    assert.equal(data.code, 'not_configured')
    assert.deepEqual(data.missing, ['envId'])
    assert.equal(fix.calls.length, 0)
  } finally {
    await fix.close()
  }
})

test('有磁盘缓存就先返回快照：标 cached / cachedAt / revalidating，wait=1 再拿降级原因', async () => {
  const fix = await fixture()
  try {
    const first = await fix.instance.funnel({ days: 7 })
    assert.equal(first.ok, true)
    assert.equal(first.meta.cached, false)
    assert.equal(first.meta.revalidating, false)
    // 新实例共用缓存目录：内存缓存是空的，先回磁盘快照，同时后台刷新
    const offline = createBuyPoints({
      env: {},
      envId: 'test-env',
      script: fix.file,
      cacheDir: join(fix.dir, 'cache'),
      run: async () => { throw new Error('模拟离线：远端调用失败') },
    })
    const second = await offline.funnel({ days: 7 })
    assert.equal(second.ok, true)
    assert.equal(second.meta.cached, true)
    assert.equal(second.meta.revalidating, true)
    assert.ok(second.meta.cachedAt)
    assert.equal(second.meta.degradeReason, null)
    assert.deepEqual(second.funnels[0].stages.map(row => row.actors), [402, 401, 355, 1, 0, 0])
    // wait=1 挂在同一个后台刷新上：刷新失败时回退缓存并标原因，不是空页面
    const waited = await offline.funnel({ days: 7, wait: '1' })
    assert.equal(waited.ok, true)
    assert.equal(waited.meta.cached, true)
    assert.match(waited.meta.degradeReason, /模拟离线/)
    assert.equal(waited.meta.revalidating, false)
    // 降级的缓存快照不进内存：下一次请求继续尝试真实脚本
    const third = await offline.funnel({ days: 7 })
    assert.equal(third.meta.cached, true)
  } finally {
    await fix.close()
  }
})

test('执行失败且没有缓存：返回 script_failed，不编数字', async () => {
  const fix = await fixture({ run: async () => { throw Object.assign(new Error('tcb 报错：ACL 拒绝'), { stderr: 'AccessDenied' }) } })
  try {
    const data = await fix.instance.funnel({ days: 7 })
    assert.equal(data.ok, false)
    assert.equal(data.code, 'script_failed')
    assert.match(data.message, /ACL 拒绝/)
    assert.equal(data.timedOut, false)
    assert.equal(data.stderr, 'AccessDenied')
    assert.equal(data.funnels, undefined)
  } finally {
    await fix.close()
  }
})

test('超时：标 timedOut，且超时时长可由 LANJING_CONVERSION_TIMEOUT_MS 覆盖', async () => {
  const fix = await fixture({
    env: { LANJING_CONVERSION_TIMEOUT_MS: '5000' },
    run: async () => { throw Object.assign(new Error('脚本执行超时（5 秒）'), { timedOut: true }) },
  })
  try {
    const data = await fix.instance.funnel({ days: 7 })
    assert.equal(data.ok, false)
    assert.equal(data.code, 'script_failed')
    assert.equal(data.timedOut, true)
    assert.equal(fix.calls[0].timeoutMs, 5000)
    const status = await fix.instance.status()
    assert.equal(status.timeoutMs, 5000)
  } finally {
    await fix.close()
  }
})

test('超时但有缓存：先返回缓存快照，wait=1 标出超时降级原因', async () => {
  const fix = await fixture()
  try {
    await fix.instance.funnel({ days: 14 })
    const timedOut = createBuyPoints({
      env: {},
      envId: 'test-env',
      script: fix.file,
      cacheDir: join(fix.dir, 'cache'),
      run: async () => { throw Object.assign(new Error('脚本执行超时（120 秒）'), { timedOut: true }) },
    })
    const data = await timedOut.funnel({ days: 14 })
    assert.equal(data.ok, true)
    assert.equal(data.meta.cached, true)
    assert.equal(data.meta.revalidating, true)
    const waited = await timedOut.funnel({ days: 14, wait: '1' })
    assert.equal(waited.ok, true)
    assert.equal(waited.meta.cached, true)
    assert.match(waited.meta.degradeReason, /超时/)
  } finally {
    await fix.close()
  }
})

test('字段缺失进 unavailable：不用 0 冒充，stages 为 null 时保留整条漏斗', async () => {
  const raw = snapshot()
  delete raw.outcome
  delete raw.extra.outcome
  raw.trend = null
  raw.dropoff = []
  // 单个维度取数失败保留槽位（rows: null），整块 breakdown 缺失才算 unavailable
  raw.breakdown = [{ dimension: 'source', rows: null }]
  raw.funnels[1].stages = null
  const data = normalizeBuyPoints(raw, { days: 7 })
  assert.equal(data.ok, true)
  for (const field of ['outcome', 'trend', 'dropoff', 'research']) assert.ok(data.unavailable.includes(field), `unavailable 应包含 ${field}`)
  assert.ok(!data.unavailable.includes('breakdown'))
  assert.deepEqual(data.outcome, { saved: null, contact: null })
  assert.equal(data.trend, null)
  assert.equal(data.breakdown[0].rows, null)
  assert.equal(data.funnels[1].stages, null)
  assert.ok(normalizeBuyPoints({ ...snapshot(), breakdown: null }, { days: 7 }).unavailable.includes('breakdown'))
  // 首级、有数的一级照常返回
  assert.equal(data.funnels[0].stages[0].actors, 402)
  // 缺失的级必须是 null，不是 0
  const hole = snapshot()
  hole.funnels[0].stages[3].actors = null
  assert.equal(normalizeBuyPoints(hole, { days: 7 }).funnels[0].stages[3].actors, null)
  // 脚本自己说 ok:false 时整页失败，也不能填 0
  const bad = { ok: false, error: { code: 'analytics_unavailable', message: 'CloudBase 调用失败' } }
  assert.throws(() => normalizeBuyPoints(bad, { days: 7 }), /CloudBase 调用失败/)
})

test('days 只接受 7 / 14 / 30，其余一律 invalid_days', async () => {
  const fix = await fixture()
  try {
    for (const days of [9, 0, -7, 1.5, 'abc', '7.5', 31]) {
      const data = await fix.instance.funnel({ days })
      assert.equal(data.ok, false, `days=${days} 应当被拒绝`)
      assert.equal(data.code, 'invalid_days')
      assert.deepEqual(data.allowed, [7, 14, 30])
    }
    assert.equal(fix.calls.length, 0)
    // 不传窗口按 7 天
    const fallback = await fix.instance.funnel({ days: null })
    assert.equal(fallback.ok, true)
    assert.equal(fix.calls[0].days, 7)
    // 查询串里是字符串也认
    const text = await fix.instance.funnel({ days: '14' })
    assert.equal(text.ok, true)
    assert.equal(fix.calls[1].days, 14)
  } finally {
    await fix.close()
  }
})

test('窗口不一致：脚本返回的天数和请求的不同也要失败，不将就', async () => {
  const fix = await fixture({ run: async () => snapshot(14) })
  try {
    const data = await fix.instance.funnel({ days: 7 })
    assert.equal(data.ok, false)
    assert.equal(data.code, 'script_failed')
    assert.match(data.message, /窗口 14 天/)
  } finally {
    await fix.close()
  }
})

test('mock 模式：固定示例快照 + meta.mock，形状和真实契约一致', async () => {
  const fix = await fixture({ mock: true })
  try {
    const data = await fix.instance.funnel({ days: 7 })
    assert.equal(data.ok, true)
    assert.equal(data.meta.mock, true)
    assert.deepEqual(data.funnels[0].stages.map(row => row.actors), [402, 401, 355, 1, 0, 0])
    assert.deepEqual(data.funnels[1].stages.map(row => row.actors), [402, 249, 0, 1])
    assert.equal(data.funnels[1].stages[2].pending, true)
    assert.equal(data.funnels[1].stages[2].detached, true)
    assert.deepEqual(data.outcome, { saved: 1, contact: 2 })
    assert.ok(data.warnings.length >= 4)
    assert.deepEqual(data.unavailable, [])
    assert.equal(data.dropoff.filter(row => row.funnel === 'research').length, 2)
    // mock 不调用执行器
    assert.equal(fix.calls.length, 0)
    // 示例数据也遵守「缺数据日期不出现 + 缺口用 null」：30 天里有 3 天缺口
    const wide = await fix.instance.funnel({ days: 30 })
    assert.equal(wide.trend.length, 30)
    assert.equal(wide.trend.filter(row => row.primary.some(value => value === null)).length, 3)
    assert.equal(mockBuyPointsSnapshot(7).range.days, 7)
  } finally {
    await fix.close()
  }
})

test('内存缓存：同一窗口 6 小时内不重复跑脚本', async () => {
  const fix = await fixture()
  try {
    await fix.instance.funnel({ days: 7 })
    await fix.instance.funnel({ days: 7 })
    assert.equal(fix.calls.length, 1)
    await fix.instance.funnel({ days: 14 })
    assert.equal(fix.calls.length, 2)
  } finally {
    await fix.close()
  }
})

test('缓存优先：磁盘快照先回，后台刷新只跑一次，wait=1 静默换成新数据', async () => {
  const fix = await fixture()
  try {
    // 先跑一次，把磁盘缓存写出来
    await fix.instance.funnel({ days: 7 })
    let release
    const gate = new Promise(resolveGate => { release = resolveGate })
    let started = 0
    const slow = createBuyPoints({
      env: {},
      envId: 'test-env',
      script: fix.file,
      cacheDir: join(fix.dir, 'cache'),
      run: async (input) => {
        started += 1
        await gate
        return snapshot(input.days)
      },
    })
    const cached = await slow.funnel({ days: 7 })
    assert.equal(cached.ok, true)
    assert.equal(cached.meta.cached, true)
    assert.equal(cached.meta.revalidating, true)
    assert.ok(cached.meta.cachedAt)
    // 两个 wait=1 请求共用同一个后台刷新
    const waitA = slow.funnel({ days: 7, wait: '1' })
    const waitB = slow.funnel({ days: 7, wait: '1' })
    await new Promise(resolve => setTimeout(resolve, 10))
    release()
    const [freshA, freshB] = await Promise.all([waitA, waitB])
    assert.equal(started, 1)
    for (const fresh of [freshA, freshB]) {
      assert.equal(fresh.ok, true)
      assert.equal(fresh.meta.cached, false)
      assert.equal(fresh.meta.revalidating, false)
      assert.deepEqual(fresh.funnels[0].stages.map(row => row.actors), [402, 401, 355, 1, 0, 0])
    }
    // 刷新成功后内存缓存新鲜，再请求不再跑脚本
    const after = await slow.funnel({ days: 7 })
    assert.equal(after.meta.cached, false)
    assert.equal(started, 1)
  } finally {
    await fix.close()
  }
})

test('首屏并发：同一个窗口只跑一次脚本，两个请求拿到同一份结果', async () => {
  const fix = await fixture()
  try {
    const [a, b] = await Promise.all([
      fix.instance.funnel({ days: 14 }),
      fix.instance.funnel({ days: 14 }),
    ])
    assert.equal(fix.calls.length, 1)
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.deepEqual(a.funnels[0].stages.map(row => row.actors), b.funnels[0].stages.map(row => row.actors))
  } finally {
    await fix.close()
  }
})

test('fresh=1 强制刷新：跳过内存与磁盘缓存，重新跑脚本', async () => {
  const fix = await fixture()
  try {
    await fix.instance.funnel({ days: 7 })
    assert.equal(fix.calls.length, 1)
    const refreshed = await fix.instance.funnel({ days: 7, fresh: '1' })
    assert.equal(refreshed.meta.cached, false)
    assert.equal(fix.calls.length, 2)
    // 强制刷新失败时仍有磁盘快照兜底
    const broken = createBuyPoints({
      env: {},
      envId: 'test-env',
      script: fix.file,
      cacheDir: join(fix.dir, 'cache'),
      run: async () => { throw new Error('模拟强制刷新失败') },
    })
    const fallback = await broken.funnel({ days: 7, fresh: '1' })
    assert.equal(fallback.ok, true)
    assert.equal(fallback.meta.cached, true)
    assert.match(fallback.meta.degradeReason, /模拟强制刷新失败/)
  } finally {
    await fix.close()
  }
})

test('events 缺失进 unavailable：是「未获取」而不是 0 条事件', () => {
  const raw = snapshot()
  raw.events = null
  const data = normalizeBuyPoints(raw, { days: 7 })
  assert.equal(data.events, null)
  assert.ok(data.unavailable.includes('events'))
  const empty = snapshot()
  empty.events = []
  assert.deepEqual(normalizeBuyPoints(empty, { days: 7 }).events, [])
  assert.ok(normalizeBuyPoints(empty, { days: 7 }).unavailable.includes('events'))
  // 有事件清单时照抄条数，不补 0
  const normal = normalizeBuyPoints(snapshot(), { days: 7 })
  assert.deepEqual(normal.events, [{ name: 'app_session_started', count: 402 }])
  assert.ok(!normal.unavailable.includes('events'))
})

test('脚本 stdout 里混着日志时，仍取得到那段 JSON', () => {
  assert.deepEqual(parseScriptOutput('{"ok":true}'), { ok: true })
  assert.deepEqual(parseScriptOutput('8 条聚合顺序执行…\n{"ok":true,"days":7}\n'), { ok: true, days: 7 })
  assert.throws(() => parseScriptOutput('   '), /没有输出内容/)
  assert.throws(() => parseScriptOutput('not json at all'), /不是 JSON/)
})

test('脚本候选路径：环境变量优先，且都是 scripts/conversion-funnel.js', () => {
  const rows = scriptCandidates({ LANJING_CONVERSION_SCRIPT: '/tmp/synthetic-path/conversion-funnel.js' })
  assert.equal(rows[0], '/tmp/synthetic-path/conversion-funnel.js')
  for (const row of rows) assert.match(row, /conversion-funnel\.js$/)
  assert.ok(new Set(rows).size === rows.length)
})

// ---------- 缓存时长：内存 6 小时、磁盘有效到次日 03:00 ----------
test('内存缓存 TTL 6 小时：5 小时 59 分仍命中，超过 6 小时重新跑脚本', async () => {
  const clock = fakeClock(at(2026, 11, 10, 10, 0))
  const fix = await fixture({ now: clock.now })
  try {
    const first = await fix.instance.funnel({ days: 7 })
    assert.equal(first.meta.cached, false)
    assert.equal(fix.calls.length, 1)
    clock.advance(5 * 3600 * 1000 + 59 * 60 * 1000)
    const hit = await fix.instance.funnel({ days: 7 })
    assert.equal(fix.calls.length, 1, '6 小时内不应重跑脚本')
    assert.equal(hit.meta.cached, false)
    assert.equal(hit.meta.cacheFresh, true)
    assert.ok(hit.meta.cacheAgeMs >= 5 * 3600 * 1000, 'meta.cacheAgeMs 要反映缓存年龄')
    clock.advance(2 * 60 * 1000) // 6 小时 01 分
    await fix.instance.funnel({ days: 7 })
    // 内存过期后走「磁盘快照 + 后台刷新」，后台刷新会再跑一次脚本
    for (let i = 0; i < 200 && fix.calls.length < 2; i += 1) await new Promise(resolve => setImmediate(resolve))
    assert.equal(fix.calls.length, 2, '超过 6 小时应重新取数')
    const status = await fix.instance.status()
    assert.equal(status.memoryTtlMs, 21_600_000)
    await settle()
  } finally {
    await fix.close()
  }
})

test('磁盘缓存新鲜度：03:00 前的快照（即使超过 6 小时）算新鲜，03:00 之后算过期但仍先返回', async () => {
  // 底层判定：写入后的第一个本地 03:00 为界
  const writtenAt = at(2026, 11, 10, 20, 0)
  assert.equal(nextWarmBoundary(writtenAt), at(2026, 11, 11, 3, 0))
  assert.equal(nextWarmBoundary(at(2026, 11, 11, 3, 0)), at(2026, 11, 12, 3, 0), '正好 03:00 时取下一天')
  assert.equal(lastWarmBoundary(at(2026, 11, 11, 3, 1)), at(2026, 11, 11, 3, 0))
  assert.equal(lastWarmBoundary(at(2026, 11, 11, 2, 59)), at(2026, 11, 10, 3, 0))
  assert.equal(isDiskCacheFresh(writtenAt, at(2026, 11, 11, 2, 59)), true, '02:59 还算新鲜（已超过 6 小时）')
  assert.equal(isDiskCacheFresh(writtenAt, at(2026, 11, 11, 3, 1)), false, '03:01 之后算过期')

  // 走真实取数路径：20:00 写盘，02:59 / 03:01 各读一次
  const clock = fakeClock(writtenAt)
  const fix = await fixture({ now: clock.now })
  try {
    await fix.instance.funnel({ days: 7 })
    assert.equal(fix.calls.length, 1)

    const early = createBuyPoints({
      env: {}, envId: 'test-env', script: fix.file, cacheDir: join(fix.dir, 'cache'),
      now: () => at(2026, 11, 11, 2, 59),
      run: async (input) => snapshot(input.days),
    })
    const before = await early.funnel({ days: 7 })
    assert.equal(before.ok, true)
    assert.equal(before.meta.cached, true)
    assert.equal(before.meta.cacheFresh, true)
    assert.equal(before.meta.stale, false)
    assert.equal(before.meta.cacheExpiresAt, new Date(at(2026, 11, 11, 3, 0)).toISOString())

    const late = createBuyPoints({
      env: {}, envId: 'test-env', script: fix.file, cacheDir: join(fix.dir, 'cache'),
      now: () => at(2026, 11, 11, 3, 1),
      run: async (input) => snapshot(input.days),
    })
    const after = await late.funnel({ days: 7 })
    assert.equal(after.ok, true, '过期也先用旧快照，不换空页面')
    assert.equal(after.meta.cached, true)
    assert.equal(after.meta.revalidating, true)
    assert.equal(after.meta.cacheFresh, false)
    assert.equal(after.meta.stale, true)
    assert.equal(after.funnels[0].stages[0].actors, 402)
    // 两次读盘都触发了后台刷新，等它们把缓存写完再删临时目录
    await settle()
  } finally {
    await fix.close()
  }
})

// ---------- 每日 03:00 预热 ----------
test('每日 03:00 预热：到点串行跑 7/14/30、timer 都 unref、完成后排次日', async () => {
  const clock = fakeClock(at(2026, 11, 10, 10, 0))
  const timerApi = fakeTimers()
  const fix = await fixture({ now: clock.now, timers: timerApi })
  try {
    const { nextWarmAt, catchUp } = fix.instance.scheduleWarm()
    assert.equal(nextWarmAt, new Date(at(2026, 11, 11, 3, 0)).toISOString())
    // 没有预热记录 → 启动补跑一次
    const caught = await catchUp
    assert.equal(caught.skipped, false)
    assert.deepEqual(fix.calls.map(call => call.days), [7, 14, 30])
    // 补跑完成后排了次日 03:00 的 timer，且 unref 过
    const pending = timerApi.pending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].delay, 17 * 3600 * 1000)
    assert.ok(pending[0].unrefCalls >= 1)

    // 到点：再跑一轮三个窗口
    clock.set(at(2026, 11, 11, 3, 0))
    const timer = pending[0]
    timerApi.fire(timer)
    const daily = fix.instance.warm() // 复用正在跑的这次预热，不另起一次
    const result = await daily
    assert.equal(result.ok, true)
    assert.deepEqual(fix.calls.slice(3).map(call => call.days), [7, 14, 30])
    assert.deepEqual(result.windows.map(window => [window.days, window.ok]), [[7, true], [14, true], [30, true]])

    // 完成后排下一天 03:00（不是 setInterval）
    const next = timerApi.pending()
    assert.equal(next.length, 1)
    assert.equal(next[0].delay, 24 * 3600 * 1000)
    assert.ok(next[0].unrefCalls >= 1)

    // 预热结果落盘
    const state = JSON.parse(await readFile(join(fix.dir, 'cache', 'warm-state.json'), 'utf8'))
    assert.equal(state.lastWarmOk, true)
    assert.equal(Date.parse(state.lastWarmAt), at(2026, 11, 11, 3, 0))
    assert.deepEqual(state.windows.map(window => window.days), [7, 14, 30])

    // status 里能查到预热信息
    const status = await fix.instance.status()
    assert.deepEqual(status.warm.windows, [7, 14, 30])
    assert.equal(status.warm.lastWarmOk, true)
    assert.equal(status.warm.lastWarmAt, new Date(at(2026, 11, 11, 3, 0)).toISOString())
    assert.equal(status.warm.nextWarmAt, new Date(at(2026, 11, 12, 3, 0)).toISOString())
  } finally {
    fix.instance.stopWarm()
    await fix.close()
  }
})

test('预热失败隔离：单窗口失败只记日志、不抛、不影响其它窗口，也不疯狂重试', async () => {
  const clock = fakeClock(at(2026, 11, 10, 10, 0))
  const timerApi = fakeTimers()
  const warnings = []
  const fix = await fixture({
    now: clock.now,
    timers: timerApi,
    log: { warn: (...args) => { warnings.push(args.join(' ')) }, error: () => {} },
    run: async (input) => {
      if (input.days === 14) throw new Error('14 天窗口模拟失败')
      return snapshot(input.days)
    },
  })
  try {
    const { catchUp } = fix.instance.scheduleWarm()
    const result = await catchUp
    assert.equal(result.ok, false)
    // 三个窗口都只跑一次；14 天失败不阻止 30 天
    assert.deepEqual(fix.calls.map(call => call.days), [7, 14, 30])
    assert.deepEqual(result.windows.map(window => [window.days, window.ok]), [[7, true], [14, false], [30, true]])
    assert.match(warnings.join('\n'), /14 天窗口模拟失败/)
    // 失败后仍然排了次日 timer（不靠重试补）
    assert.equal(timerApi.pending().length, 1)
    assert.equal(fix.calls.filter(call => call.days === 14).length, 1)
    // 失败也落盘，只登记一次尝试
    const state = JSON.parse(await readFile(join(fix.dir, 'cache', 'warm-state.json'), 'utf8'))
    assert.equal(state.lastWarmOk, false)
  } finally {
    fix.instance.stopWarm()
    await fix.close()
  }
})

test('启动补跑只在必要时发生：当天 03:00 后已有记录就跳过，记录过期或没有记录才补跑', async () => {
  const clock = fakeClock(at(2026, 11, 10, 10, 0))
  const timerApi = fakeTimers()
  const fix = await fixture({ now: clock.now, timers: timerApi })
  try {
    await fix.instance.scheduleWarm().catchUp
    assert.deepEqual(fix.calls.map(call => call.days), [7, 14, 30])
    const statePath = join(fix.dir, 'cache', 'warm-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.ok(Date.parse(state.lastWarmAt) >= at(2026, 11, 10, 3, 0))
    fix.instance.stopWarm()

    // 同一天第二个实例：今天已经预热过 → 只排 timer，不补跑
    const sameDay = await fixture({ now: clock.now, timers: fakeTimers(), cacheDir: join(fix.dir, 'cache'), script: fix.file })
    try {
      const sameResult = await sameDay.instance.scheduleWarm().catchUp
      assert.equal(sameResult.skipped, true)
      assert.equal(sameDay.calls.length, 0)
    } finally {
      sameDay.instance.stopWarm()
      await sameDay.close()
    }

    // 记录停在昨天 20:00（今天 03:00 之后没有预热过）→ 必须补跑
    await writeFile(statePath, JSON.stringify({ lastWarmAt: new Date(at(2026, 11, 9, 20, 0)).toISOString() }), 'utf8')
    const stale = await fixture({ now: clock.now, timers: fakeTimers(), cacheDir: join(fix.dir, 'cache'), script: fix.file })
    try {
      const staleResult = await stale.instance.scheduleWarm().catchUp
      assert.equal(staleResult.skipped, false)
      assert.deepEqual(stale.calls.map(call => call.days), [7, 14, 30])
    } finally {
      stale.instance.stopWarm()
      await stale.close()
    }

    // 没有 warm-state（首次安装）→ 也要补跑
    const freshDir = await mkdtemp(join(tmpdir(), 'lanjing-buy-points-test-'))
    try {
      const fresh = await fixture({ now: clock.now, timers: fakeTimers(), cacheDir: join(freshDir, 'cache'), script: fix.file })
      try {
        const freshResult = await fresh.instance.scheduleWarm().catchUp
        assert.equal(freshResult.skipped, false)
        assert.deepEqual(fresh.calls.map(call => call.days), [7, 14, 30])
      } finally {
        fresh.instance.stopWarm()
        await fresh.close()
      }
    } finally {
      await rm(freshDir, { recursive: true, force: true })
    }
  } finally {
    fix.instance.stopWarm()
    await fix.close()
  }
})

test('预热与用户请求共用 in-flight：用户正在拉 7 天，预热不重复跑 7 天', async () => {
  const clock = fakeClock(at(2026, 11, 10, 10, 0))
  const timerApi = fakeTimers()
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  const fix = await fixture({
    now: clock.now,
    timers: timerApi,
    run: async (input) => {
      if (input.days === 7) await gate
      return snapshot(input.days)
    },
  })
  try {
    const user = fix.instance.funnel({ days: 7 })
    // 等用户请求真的进入 in-flight（子进程替身已被调用）
    for (let i = 0; i < 200 && fix.calls.length < 1; i += 1) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(fix.calls.map(call => call.days), [7])
    const { catchUp } = fix.instance.scheduleWarm()
    await new Promise(resolve => setImmediate(resolve))
    release()
    await Promise.all([user, catchUp])
    assert.deepEqual(fix.calls.map(call => call.days), [7, 14, 30])
    assert.equal(fix.calls.filter(call => call.days === 7).length, 1, '7 天窗口只跑一次')
  } finally {
    fix.instance.stopWarm()
    await fix.close()
  }
})

test('warm=1 调试参数：触发一次后台预热并标 meta.warmTriggered，默认不触发', async () => {
  const fix = await fixture()
  try {
    const plain = await fix.instance.funnel({ days: 7 })
    assert.equal(plain.meta.warmTriggered, undefined)
    assert.equal(fix.calls.length, 1)
    const triggered = await fix.instance.funnel({ days: 7, warm: '1' })
    assert.equal(triggered.meta.warmTriggered, true)
    // 等后台预热把三个窗口跑完，并等它把 warm-state 写完（否则删目录会和写盘抢）
    const statePath = join(fix.dir, 'cache', 'warm-state.json')
    assert.ok(await waitFor(() => fix.calls.length >= 4), '后台预热应跑 7/14/30')
    assert.deepEqual(fix.calls.slice(1).map(call => call.days), [7, 14, 30])
    assert.ok(await waitFor(async () => {
      try {
        await readFile(statePath, 'utf8')
        return true
      } catch {
        return false
      }
    }), '预热完成后应写 warm-state.json')
    await settle()
  } finally {
    await fix.close()
  }
})

// ---------- 新契约字段透传 ----------
test('新契约字段原样透传：freshness/previous/flow/eventTrend/retention/project 维度，缺省是 null 且不判非法', () => {
  const raw = snapshot()
  raw.freshness = { lastEventAt: '2026-11-10T09:41:00.000Z', ageMinutes: 19, stale: false }
  raw.previous = {
    range: { days: 7, from: '2026-10-28', to: '2026-11-03' },
    funnels: [{
      key: 'primary',
      stages: [
        { key: 'session', actors: 388, delta: 14, deltaRate: 0.0361 },
        { key: 'view', actors: 402, delta: -1, deltaRate: -0.0025 },
      ],
    }],
  }
  raw.breakdown = [
    { dimension: 'project', rows: [{ value: '项目A', sessions: 96, stages: [96, 96, 88, 1, 0, 0] }] },
    ...raw.breakdown,
  ]
  raw.flow = [{ source: 'other_page', pageKey: 'pages/home/index', sessions: 209, entered: 0 }]
  raw.eventTrend = [{ date: '2026-11-10', counts: { app_session_started: 402, view_page: null } }]
  raw.retention = { accounts: 402, newAccounts: 358, returningAccounts: 44, nextDayReturnRate: 0.183 }

  const data = normalizeBuyPoints(raw, { days: 7 })
  assert.deepEqual(data.freshness, { lastEventAt: '2026-11-10T09:41:00.000Z', ageMinutes: 19, stale: false })
  assert.deepEqual(data.previous.range, { days: 7, from: '2026-10-28', to: '2026-11-03' })
  assert.deepEqual(data.previous.funnels[0].stages[1], { key: 'view', actors: 402, delta: -1, deltaRate: -0.0025 })
  assert.equal(data.breakdown.find(group => group.dimension === 'project').rows[0].sessions, 96)
  assert.deepEqual(data.flow, [{ source: 'other_page', pageKey: 'pages/home/index', sessions: 209, entered: 0 }])
  assert.deepEqual(data.eventTrend, [{ date: '2026-11-10', counts: { app_session_started: 402, view_page: null } }])
  assert.deepEqual(data.retention, { accounts: 402, newAccounts: 358, returningAccounts: 44, nextDayReturnRate: 0.183 })
  // 新字段不改变 unavailable 语义：字段齐时不会被误判成缺失
  assert.deepEqual(data.unavailable, [])
  // 老快照（数据仓还没上这些字段）照常合法，字段是 null，不补 0 / 不补空对象
  const plain = normalizeBuyPoints(snapshot(), { days: 7 })
  for (const key of ['freshness', 'previous', 'flow', 'eventTrend', 'retention']) assert.equal(plain[key], null, `${key} 缺省应为 null`)
  assert.deepEqual(plain.unavailable, [])
  // 只缺一半也保留另一半；ageMinutes 缺失不填 0
  const partial = normalizeBuyPoints({ ...snapshot(), freshness: { lastEventAt: '2026-11-10T09:41:00.000Z' }, previous: { funnels: [] }, flow: [] }, { days: 7 })
  assert.deepEqual(partial.freshness, { lastEventAt: '2026-11-10T09:41:00.000Z', ageMinutes: null, stale: false })
  assert.deepEqual(partial.previous, { range: null, funnels: [] })
  assert.deepEqual(partial.flow, [])
})

test('新契约字段进缓存快照：磁盘命中仍带 freshness / retention', async () => {
  const clock = fakeClock(at(2026, 11, 10, 10, 0))
  const fix = await fixture({
    now: clock.now,
    run: async (input) => ({
      ...snapshot(input.days),
      freshness: { lastEventAt: '2026-11-10T09:41:00.000Z', ageMinutes: 19, stale: false },
      retention: { accounts: 402, newAccounts: 358, returningAccounts: 44, nextDayReturnRate: 0.183 },
    }),
  })
  try {
    const first = await fix.instance.funnel({ days: 7 })
    assert.deepEqual(first.freshness.ageMinutes, 19)
    const offline = createBuyPoints({
      env: {},
      envId: 'test-env',
      script: fix.file,
      cacheDir: join(fix.dir, 'cache'),
      run: async () => { throw new Error('模拟离线') },
    })
    const hit = await offline.funnel({ days: 7 })
    assert.equal(hit.meta.cached, true)
    assert.deepEqual(hit.freshness, { lastEventAt: '2026-11-10T09:41:00.000Z', ageMinutes: 19, stale: false })
    assert.deepEqual(hit.retention, { accounts: 402, newAccounts: 358, returningAccounts: 44, nextDayReturnRate: 0.183 })
  } finally {
    await fix.close()
  }
})
