// 飞书原生交互式审批卡片（issue #88）：把「确认草稿 <token>」文本输入替换为
// 可点击的「确认保存草稿 / 暂不保存」按钮。卡片结构是纯函数：输入事实字段，
// 输出 Feishu card JSON；绝不在此处执行 producer/浏览器副作用。
//
// 安全契约：
// - 卡片只声明「仅保存小红书草稿，公开发布由你完成」，绝不声称草稿已保存。
// - action button 的 value 携带 {kind, topicId, artifactHash, token, decision}，
//   由回调侧与 Store 中真实 token/hash 强绑定后才会放行（见 feishu-editorial.onCardAction）。
// - 无 URL、无外链跳转、无第二个输入码：一次点击即为唯一授权。
// - update_multi:true：同一会话多次点击更新同一张卡，不产生重复动作/重复确认。

import { createHash } from 'node:crypto'

export const CARD_KIND = 'lanjing_draft_approval'
export const CARD_DEVICE = 'Air'
export const CARD_MODEL = 'gpt-6.1-terra'

// 卡片 value 字段的稳定指纹（仅用于幂等/去重，不含任何机密信息）。
function valueFingerprint(topicId, artifactHash, token, decision) {
  return createHash('sha256').update(`lanjing:card:${topicId}:${artifactHash}:${token}:${decision}`).digest('hex').slice(0, 32)
}

/**
 * 待确认审批卡片：标题 + 实际媒体清单元数量 + 设备 Air / 模型 GPT-6.1 Terra
 * + 「仅保存小红书草稿，公开发布由你完成」。两个原生按钮，value 携带决策。
 * @param {{title:string, mediaCount:number, topicId:string, artifactHash:string, token:string}} opts
 * @returns {object} Feishu card JSON
 */
export function buildApprovalCard({ title, mediaCount, topicId, artifactHash, token }) {
  const baseInfo = {
    kind: CARD_KIND,
    topicId,
    artifactHash,
    token,
  }
  const approve = { ...baseInfo, decision: 'approve' }
  const defer = { ...baseInfo, decision: 'defer' }
  const body = [
    '**成稿已就绪**，请在卡片上选择：',
    '',
    `标题：${title}`,
    `媒体数量：${mediaCount}`,
    `设备：${CARD_DEVICE} · 模型：${CARD_MODEL}`,
    '',
    '> 仅保存小红书草稿，公开发布由你完成。',
  ].join('\n')
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '等待你在飞书确认草稿' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: body },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '确认保存草稿' },
            type: 'primary',
            value: { ...approve, value_hash: valueFingerprint(topicId, artifactHash, token, 'approve') },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '暂不保存' },
            type: 'default',
            value: { ...defer, value_hash: valueFingerprint(topicId, artifactHash, token, 'defer') },
          },
        ],
      },
    ],
  }
}

/**
 * 已处理的卡片（点过确认/暂缓，或文本确认后）：移除按钮，只保留结果文案。
 * 绝不声称草稿已保存——审批只是授权，实际存稿由收到的 runner 执行。
 * @param {{decision:'approve'|'defer'}} opts
 */
export function buildConfirmedCard({ decision }) {
  const content = decision === 'approve'
    ? '已确认，等待 Air 保存草稿（仅存小红书本地草稿，不公开发布）。'
    : '已暂缓，不会保存草稿。'
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template: decision === 'approve' ? 'green' : 'grey',
      title: { tag: 'plain_text', content: decision === 'approve' ? '确认保存草稿' : '暂不保存' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content },
      },
    ],
  }
}

/** 序列化为 Feishu 交互消息 content 用的 JSON 字符串。 */
export function approvalCardJson(opts) {
  return JSON.stringify(buildApprovalCard(opts))
}

/** 解析回调里的 action_value（JSON 字符串）并校验基本形状；失败返回 null。 */
export function parseCardActionValue(raw) {
  if (typeof raw !== 'string') return null
  let v
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const { kind, topicId, artifactHash, token, decision } = v
  const ok = kind === CARD_KIND
    && typeof topicId === 'string' && topicId.length > 0
    && typeof artifactHash === 'string' && /^[0-9a-f]{16,}$/.test(artifactHash)
    && typeof token === 'string' && token.length > 0
    && (decision === 'approve' || decision === 'defer')
  return ok ? { kind, topicId, artifactHash, token, decision } : null
}
