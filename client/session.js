// 和工作台外层的对话服务打交道：技能要「直接调用」，就得能开一个新的 DSH 对话。
let workspace = null

/** 浏览器半片 apply 时调一次，拿 uiWorkspace（宿主会话服务）。拿不到就退回复制调用语。 */
export function bindWorkspace(ctx) {
  // 不同 DSH 版本注入的宿主服务不同；拿不到就只是退回复制调用语，不能让整页崩掉。
  if (typeof ctx?.inject !== 'function') return
  try {
    ctx.inject(['uiWorkspace'], (inner) => {
      workspace = inner.uiWorkspace ?? null
      return () => {
        workspace = null
      }
    })
  } catch {
    workspace = null
  }
}

export function canStartSession() {
  return typeof workspace?.startSession === 'function'
}

/** 在 DSH 里开一个新对话，把技能调用语作为第一条消息。 */
export function startSkillSession(prompt) {
  if (!canStartSession()) return false
  workspace.startSession(undefined, { prompt, whenDraftExists: 'replace' })
  return true
}
