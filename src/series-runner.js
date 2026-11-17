import { beijingDay, dailyTopics, SERIES_HOUR, seriesWeek } from './daily-topics.js'
import { selectTopic } from './topic-workflow.js'

const hourFormat = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Shanghai' })
const prune = (runs, day) => Object.fromEntries(Object.entries(runs ?? {}).filter(([key]) => key >= day).slice(-60))

export function createSeriesRunner({ store, producer, xhsDrafts, now = () => new Date() }) {
  let ticking = false
  async function status() {
    const current = now()
    const state = await store.read()
    return {
      enabled: state.editorialSeries?.enabled === true,
      day: beijingDay(current),
      hour: SERIES_HOUR,
      slots: seriesWeek(current).map(slot => {
        const run = state.editorialSeries?.runs?.[slot.date]
        const topic = state.items.find(row => row.id === run?.topicId)
        return { ...slot, ...(run || {}), title: topic?.production?.title || topic?.title || null, xhsStatus: topic?.xhsDraft?.status ?? null }
      }),
    }
  }

  async function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('请选择开启或暂停自动草稿。'), { status: 400 })
    const state = await store.read()
    if (enabled && state.editorialWorkflow?.creationRequiresConfirmation === true) {
      throw Object.assign(new Error('创作确认开启中：自动排期被接管，请改用飞书确认创作流程。'), { status: 409 })
    }
    await store.mutate('', state => {
      state.editorialSeries = { ...state.editorialSeries, enabled }
    }, { undoable: false })
    return status()
  }

  async function record(day, data) {
    await store.mutate('', state => {
      const current = state.editorialSeries ??= {}
      current.runs = prune(current.runs, beijingDay(new Date(now().getTime() - 56 * 86400000)))
      current.runs[day] = { ...current.runs[day], ...data, updatedAt: now().toISOString() }
    }, { undoable: false })
  }

  async function tick() {
    if (ticking) return
    ticking = true
    let day
    try {
      const screen = await store.read()
      if (screen.editorialWorkflow?.creationRequiresConfirmation === true) return // 创作确认流程接管自动排期
      const current = now()
      const hour = Number(hourFormat.format(current))
      if (hour < SERIES_HOUR || hour >= 19) return
      day = beijingDay(current)
      const slot = seriesWeek(current).find(row => row.date === day)
      if (!slot) return
      const state = await store.read()
      if (!state.editorialSeries?.enabled) return
      const existing = state.editorialSeries.runs?.[day]
      if (existing?.status === 'generating') {
        if (producer.isRunning(existing.topicId)) return
        const item = state.items.find(row => row.id === existing.topicId)
        if (!item || item.production?.status !== 'done') {
          await record(day, { status: 'failed', message: item?.production?.error || '生成未完成，可打开选题手动继续。' })
          return
        }
        if (!(await store.read()).editorialSeries?.enabled) return
        const receipt = await xhsDrafts.save(existing.topicId)
        await record(day, { status: receipt.status, message: receipt.message })
        return
      }
      if (existing && existing.status !== 'waiting') return
      const candidate = dailyTopics(state.items, slot.source, current, { forSeries: true }).topics[0]
      if (!candidate) {
        if (existing?.status !== 'waiting') await record(day, { status: 'waiting', message: '等有近期、已核实且未使用的素材后再写。' })
        return
      }
      const { id } = await selectTopic(store, { id: candidate.id, source: slot.source, slot, now: current })
      await producer.start(id, { platform: '小红书', format: 'guizang', useData: slot.source === 'net-sign' })
    } catch (error) {
      if (day && error.status !== 409) await record(day, { status: 'failed', message: error.message })
    } finally { ticking = false }
  }

  async function resumeLoginBlocked() {
    const day = beijingDay(now())
    await store.mutate('', state => {
      const run = state.editorialSeries?.runs?.[day]
      if (state.editorialSeries?.enabled && run?.status === 'needs_login') {
        run.status = 'generating'
        run.message = '登录已恢复，准备同步已完成的图文。'
      }
    }, { undoable: false })
  }

  function start() {
    const wake = () => tick().catch(error => console.warn('[media-desk-lanjing] 系列任务：', error.message))
    const timer = setInterval(wake, 30_000)
    timer.unref()
    return () => clearInterval(timer)
  }
  return { start, status, setEnabled, tick, resumeLoginBlocked }
}
