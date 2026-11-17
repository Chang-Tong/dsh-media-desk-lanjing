import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readWorkspaceSkill, readWorkspaceSkills } from '../src/host.js'

const PROVIDER = 'realestateintelligent-skill'

const summaries = [
  { name: 'land-report-agent', description: '土拍报告 Agent', source: 'custom', provider: PROVIDER },
  { name: 'building-net-sign-report', description: '房号级网签报告', whenToUse: '要房号明细时', source: 'custom', provider: PROVIDER },
  // 全局通用技能：不该出现在这个工作台的技能页
  { name: 'lark-doc', description: '飞书文档', source: 'user-agents', provider: 'filesystem' },
]

const bodies = {
  'land-report-agent': '# 土拍/板块报告 Agent\n\n正文',
  'building-net-sign-report': '# 房号级网签报告\n\n正文',
}

const service = {
  list: async () => summaries,
  get: async name => {
    const row = summaries.find(item => item.name === name)
    if (!row) return undefined
    return { ...row, content: bodies[name], path: `/skills/${name}/SKILL.md`, resourceBase: { kind: 'directory', path: `/skills/${name}` } }
  },
}

const ctxWith = skills => ({ get: key => (key === 'skills' ? skills : undefined) })

test('readWorkspaceSkills 只留项目技能：别的 provider 全过滤掉，并说明隐藏了几个', async () => {
  const result = await readWorkspaceSkills(ctxWith(service))
  assert.equal(result.count, 2)
  assert.equal(result.hidden, 1)
  assert.deepEqual(result.skills.map(row => row.name), ['building-net-sign-report', 'land-report-agent'])
  assert.equal(result.skills[0].description, '房号级网签报告')
  assert.equal(result.skills[0].whenToUse, '要房号明细时')
  assert.equal(result.skills[0].provider, PROVIDER)
  // 列表不返回正文：界面按需单取
  assert.equal(result.skills[0].content, undefined)
})

test('readWorkspaceSkill 返回正文与来源路径', async () => {
  const skill = await readWorkspaceSkill(ctxWith(service), 'land-report-agent')
  assert.equal(skill.name, 'land-report-agent')
  assert.match(skill.content, /土拍\/板块报告 Agent/)
  assert.equal(skill.path, '/skills/land-report-agent/SKILL.md')
})

test('readWorkspaceSkill 缺名 400、找不到 404', async () => {
  await assert.rejects(readWorkspaceSkill(ctxWith(service), '  '), error => error.status === 400)
  await assert.rejects(readWorkspaceSkill(ctxWith(service), 'not-a-skill'), error => error.status === 404)
})

test('没有技能服务时明确报 503，不冒充空目录', async () => {
  await assert.rejects(readWorkspaceSkills({ get: () => undefined }), error => error.status === 503)
})
