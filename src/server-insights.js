// 确定性摘录真实 MCP 证据。只有存在的数字才出卡片，缺口保持缺口。
export function insightsFromEvidence(packet) {
  const fact = packet?.facts?.find(row => row.tool === 'lanjing_net_sign_overview')
  const data = fact?.result?.result
  if (!data || data.source !== 'remote_django' || data.transaction_read_only !== true || data.contract_version !== 'skill-evidence/v1') return []
  const date = data.latest_dates?.transaction_residential
  const snapshotDate = data.latest_dates?.snapshot
  const rows = []
  const present = (...values) => values.every(value => typeof value === 'number' && Number.isFinite(value))
  const push = (title, body, tags = ['服务器网签']) => rows.push({ title, body: `${body}\n依据：data MCP / lanjing_net_sign_overview。查询时间 ${packet.fetchedAt}。`, source: '揽京服务器 · data MCP', tags, evidenceStatus: 'verified' })
  const delta = data.daily_delta
  if (date && delta && present(delta.common_project_count, delta.net_units, delta.positive_units, delta.revision_units)) {
    push(`${date}：同批 ${delta.common_project_count} 项目网签记录净增加 ${delta.net_units} 套`, `与 ${data.latest_dates.transaction_previous || '前一日'} 能对上的同批项目比较，正向增加 ${delta.positive_units} 套，历史修订 ${delta.revision_units} 套。净变化不是逐笔成交，也不能直接称为全市当天成交量。可写角度：成交变化集中在哪些项目，修订对判断有什么影响。`)
  }
  const snapshot = data.snapshot
  if (snapshotDate && snapshot && present(snapshot.project_count, snapshot.approved_units, snapshot.signed_units, snapshot.available_units)) {
    push(`${snapshotDate}：${snapshot.project_count} 个期房项目盘面，可售 ${snapshot.available_units} 套`, `同日社区快照中，住宅批准 ${snapshot.approved_units} 套、已签约 ${snapshot.signed_units} 套、可售 ${snapshot.available_units} 套。范围仅为这 ${snapshot.project_count} 个项目，不代表北京全部住宅或现房库存。可写角度：库存是否集中在少数盘。`, ['服务器网签', '期房', '库存'])
  }
  const recent = data.recent_7d
  if (recent && present(recent.completeProjectCount, recent.expectedProjectCount)) {
    if (recent.complete === true && present(recent.total)) push(`${recent.windowStart} 至 ${recent.windowEnd}：完整窗口住宅网签 ${recent.total} 套`, `该数据源 ${recent.expectedProjectCount} 个项目窗口完整，保留工具的统计范围。新项目、修订与净变化仍须按工具返回口径解释。`, ['近7日', '完整窗口'])
    else push(`近 7 日仅 ${recent.completeProjectCount}/${recent.expectedProjectCount} 项目完整，暂不报完整总量`, `窗口 ${recent.windowStart || '未提供'} 至 ${recent.windowEnd || '未提供'}，工具返回 complete=false 或总量不可用。部分项目小计不能作为全市总数。可写角度：哪些观察需要等数据补齐，避免把不完整覆盖误判成市场变冷。`, ['近7日', '覆盖缺口'])
  }
  const completed = data.latest_dates?.data_period_completed
  if (completed && date && completed < date) push('后台账期状态落后于已采集业务数据', `住宅网签最新 ${date}，社区快照最新 ${snapshotDate || '未提供'}，但已完成账期标记为 ${completed}。这是后台状态差异，不能说最新业务数据不存在。写作时分别标注业务日期和账期状态。`, ['账期核查'])
  return rows
}
