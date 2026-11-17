// 灵感源频道：每天推送的房产内容灵感分类。
// id 是数据里的稳定值；label 给界面显示；icon 用于卡片和列表装饰。
export const CHANNELS = [
  { id: 'beijing-news', label: '北京新闻', icon: '🏙️' },
  { id: 'china-news', label: '全国新闻', icon: '🗺️' },
  { id: 'overseas-news', label: '海外新闻', icon: '🌏' },
  { id: 'macro', label: '宏观数据', icon: '📈' },
  { id: 'policy', label: '房产政策', icon: '📜' },
  { id: 'land-auction', label: '北京土拍', icon: '🏗️' },
  { id: 'memes', label: '社区热梗', icon: '🔥' },
  { id: 'server-insights', label: '服务器洞察', icon: '🗄️' },
  { id: 'writing-prompts', label: '写作问题', icon: '✍️' },
]

export const CHANNEL_IDS = CHANNELS.map(row => row.id)

export function channelLabel(id) {
  return CHANNELS.find(row => row.id === id)?.label ?? String(id)
}

export function channelIcon(id) {
  return CHANNELS.find(row => row.id === id)?.icon ?? '📌'
}

/** 存进灵感条目 tags 的频道标记，方便在灵感墙和筛选里一眼认出。 */
export function channelTag(id) {
  return `灵感源·${channelLabel(id)}`
}
