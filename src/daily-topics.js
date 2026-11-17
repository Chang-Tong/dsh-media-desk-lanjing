import { CHANNEL_IDS, channelLabel } from './channels.js'
import { isMaterial } from './editorial.js'

export const DAILY_SOURCES = [
  { id: 'all', label: '综合推荐' },
  { id: 'net-sign', label: '网签' },
  { id: 'new-homes', label: '新盘动态' },
  { id: 'market', label: '市场动态' },
  { id: 'land-policy', label: '土拍与政策' },
  { id: 'community', label: '社区热议' },
]

const TYPES = {
  'net-sign': [
    [/近.?7日|近七日|完整|覆盖|补录|回退|修订/, '网签数据覆盖到哪一步？哪些比较现在还做不了？'],
    [/单日|净增|净签|差分/, '这次网签变化由谁贡献？怎么排查集中录入？'],
    [/库存|去化|可售/, '这些去化与库存数字，对同板块选盘有何影响？'],
    [/.*/, '这个统计范围内发生了什么变化？看房人该核对哪组数据？'],
  ],
  'new-homes': [
    [/预售|开盘|入市|加推|认购|促销/, '这一轮新房供应，给同预算买家增加了哪些选择？'],
    [/规划|公示|审批|方案/, '规划里的哪些变化，会影响实际居住和同板块比较？'],
    [/.*/, '这条新盘动态，会改变哪一类买家的看房清单？'],
  ],
  market: [
    [/利率|按揭|房贷|公积金/, '这项变化会不会改写月供？先看适用范围和比较条件。'],
    [/成交|价格|房价|租金|销售/, '这个市场变化来自成交结构还是同类房源？还能用什么交叉核对？'],
    [/.*/, '这条市场信号对北京看房有什么参考？哪些结论不能照搬？'],
  ],
  'land-policy': [
    [/地块|土拍|宅地|挂牌|竞价/, '这宗地的挂牌条件透露了什么？对未来新盘能判断到哪一步？'],
    [/.*/, '谁会受这项政策影响？实际买房时要核对哪几个条件？'],
  ],
  community: [[/.*/, '把营销说法拆开看，买家有哪些可以当场核实的问题？']],
}
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
export const beijingDay = (now = new Date()) => dateFormat.format(now)
const dayOf = item => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? '')) return item.date
  const date = new Date(item.createdAt ?? '')
  return Number.isNaN(date.getTime()) ? '' : beijingDay(date)
}
const validChannel = channel => CHANNEL_IDS.includes(channel) && channel !== 'writing-prompts'

function classify(item) {
  const { channel, title } = item
  if (channel === 'land-auction' || channel === 'policy' || (channel === 'server-insights' && /^(?:土拍|住宅地块)|待出让|宅地|工业用地/.test(title))) return 'land-policy'
  if (channel === 'server-insights' || (channel === 'beijing-news' && /网签/.test(title) && !/预售|新盘|开盘/.test(title))) return 'net-sign'
  if (channel === 'beijing-news' && /新盘|新房|住宅|预售|开盘|入市|加推|楼盘|入住通知|总平面图/.test(title)) return 'new-homes'
  if (channel === 'memes') return 'community'
  return 'market'
}

function priority(candidate) {
  const { row, type } = candidate
  if (type === 'land-policy') {
    if (/工业用地|高处坠落|责任估价师|返回\d+条/.test(row.title)) return -3
    if (row.channel === 'land-auction' && /宅地|住宅/.test(row.title)) return 3
  }
  if (type === 'market' && ['overseas-news', 'china-news'].includes(row.channel)) return -1
  if (type === 'community' && /北京/.test(row.title)) return 1
  return 0
}

const uniqueKey = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')

/** 每日按北京时间更新；老素材照实标出日期，同一原文不重复占位。 */
export function dailyTopics(items, source = 'all', now = new Date(), { forSeries = false } = {}) {
  const day = beijingDay(now)
  const oldest = beijingDay(new Date(now.getTime() - (forSeries ? 3 : 6) * 86400000))
  const choice = DAILY_SOURCES.some(row => row.id === source)
  if (!choice && !validChannel(source)) return { day, topics: [] }
  const selected = new Map(items.filter(row => !isMaterial(row) && !row.mergedInto && row.dailyTopicKey).map(row => [row.dailyTopicKey, row.id]))
  const used = forSeries ? new Set(items.filter(row => !isMaterial(row)).flatMap(row => row.sourceIds ?? [])) : null
  const candidates = items.filter(row => isMaterial(row) && !row.sample && row.id && row.title && row.body && row.source && validChannel(row.channel)
    && dayOf(row) >= oldest && dayOf(row) <= day && (row.evidenceStatus === 'verified' || /^https?:\/\//.test(row.url || '')))
    .map(row => {
      const type = classify(row)
      return { row, type, date: dayOf(row), verified: row.evidenceStatus === 'verified', angle: TYPES[type].find(([match]) => match.test(row.title))[1] }
    })
    .filter(candidate => {
      const { type, row, verified } = candidate
      if (forSeries && (!verified || used.has(row.id) || priority(candidate) < 0)) return false
      return source === 'all' || (choice ? type === source : row.channel === source)
    })
    .sort((a, b) => Number(b.verified) - Number(a.verified) || priority(b) - priority(a) || b.date.localeCompare(a.date)
      || String(b.row.publishedAt || b.row.retrievedAt || '').localeCompare(String(a.row.publishedAt || a.row.retrievedAt || ''))
      || a.row.id.localeCompare(b.row.id))

  const picked = [], urls = new Set(), headlines = new Set()
  const add = candidate => {
    if (!candidate || picked.length >= 5) return false
    const { row } = candidate
    const url = row.url?.split('#')[0]
    const headline = uniqueKey(row.title)
    if (headlines.has(headline) || (url && urls.has(url))) return false
    picked.push(candidate); headlines.add(headline)
    if (url) urls.add(url)
    return true
  }
  if (source === 'all') {
    for (const { id } of DAILY_SOURCES.slice(1)) candidates.filter(row => row.type === id).some(add)
  }
  for (const candidate of candidates) add(candidate)
  return { day, topics: picked.map(({ row, type, date, angle, verified }) => ({
    id: row.id, topicId: selected.get(row.id) ?? null, title: row.title, date, angle, verified,
    source: row.source, label: DAILY_SOURCES.find(entry => entry.id === type)?.label || channelLabel(row.channel),
    ...(row.url ? { url: row.url } : {}),
  })) }
}

export const SERIES = [
  { weekday: 1, source: 'net-sign', name: '网签拆账', brief: '解释增量由谁贡献，区分补录、集中网签和持续变化。' },
  { weekday: 2, source: 'new-homes', name: '同预算怎么选', brief: '拆总价、通勤、户型和交付取舍；没有同口径证据时不硬做横评。' },
  { weekday: 3, source: 'land-policy', name: '一块地 / 一条新规', brief: '跟踪公告与实际适用条件；不从挂牌条件推断售价。' },
  { weekday: 4, source: 'market', name: '北京市场温度计', brief: '解释一个市场信号如何影响看房决策，说明范围与反证。' },
  { weekday: 5, source: 'new-homes', name: '周末看房清单', brief: '每期给出几个到现场能核对的居住问题；没有实勘就不声称实勘。' },
]
export const SERIES_HOUR = 9
export function seriesWeek(now = new Date()) {
  const date = new Date(beijingDay(now) + 'T00:00:00+08:00')
  const weekday = new Date(beijingDay(now) + 'T00:00:00Z').getUTCDay() || 7
  return SERIES.map(slot => ({ ...slot, date: beijingDay(new Date(date.getTime() + (slot.weekday - weekday) * 86400000)) }))
}
