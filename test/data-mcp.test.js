import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PassThrough } from 'node:stream'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataMcp, DATA_MCP_READ_TOOLS } from '../src/data-mcp.js'

const advertised = DATA_MCP_READ_TOOLS.map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } }))
// Synthetic protocol fixtures, never a claim about actual production values.
const canonical = (extra = {}) => ({
  operation: 'overview', queried_at: '2026-01-03T00:00:00Z',
  result: { source: 'remote_django', database_vendor: 'postgresql', transaction_read_only: true, contract_version: 'skill-evidence/v1', latest_dates: { snapshot: '2026-01-02' }, as_of: '2026-01-02', sold: 0, price: null, ...extra },
})

async function clientFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'data-mcp-test-'))
  const sourceFile = join(root, 'existing-mcp.json')
  const configFile = join(root, 'data-mcp.json')
  await writeFile(sourceFile, JSON.stringify({ mcpServers: { 'lanjing-data': { command: '/test/ssh', args: ['private-test-host'], env: { TEST_TOKEN: 'private-test-token' } } } }))
  await writeFile(configFile, JSON.stringify({ source: { file: sourceFile, server: 'lanjing-data' }, timeoutMs: 1000 }))
  const messages = []
  const processes = []
  const spawnImpl = (command, args, spawnOptions) => {
    assert.equal(command, '/test/ssh')
    assert.deepEqual(args, ['private-test-host'])
    assert.equal(spawnOptions.shell, false)
    assert.equal(spawnOptions.env.TEST_TOKEN, 'private-test-token')
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killedWith = []
    child.close = () => {
      if (child.didClose) return
      child.didClose = true
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0)
    }
    child.kill = signal => {
      child.killedWith.push(signal)
      if (!options.ignoreTerm || signal === 'SIGKILL') queueMicrotask(child.close)
      return true
    }
    child.stdin.on('finish', () => { if (!options.ignoreEnd) queueMicrotask(child.close) })
    let input = ''
    child.stdin.on('data', chunk => {
      input += chunk.toString()
      let end
      while ((end = input.indexOf('\n')) !== -1) {
        const message = JSON.parse(input.slice(0, end))
        input = input.slice(end + 1)
        messages.push(message)
        const respond = result => queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`))
        if (options.hang === message.method) continue
        if (options.exit === message.method) { queueMicrotask(child.close); continue }
        if (options.badProtocol === message.method) { queueMicrotask(() => child.stdout.write('not-json private-test-token\n')); continue }
        if (message.method === 'initialize') respond({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lanjing-data', version: 'test' } })
        if (message.method === 'tools/list') respond({ tools: options.tools ?? advertised })
        if (message.method === 'tools/call') {
          const result = options.call ? options.call(message.params, child) : {
            structuredContent: canonical(),
          }
          if (result !== undefined) respond(result)
        }
      }
    })
    processes.push(child)
    return child
  }
  const client = new DataMcp({ configFile, spawnImpl, timeoutMs: options.timeoutMs, closeTimeoutMs: 10 })
  return { client, configFile, messages, processes }
}

test('status performs initialize and tools/list, exposes only annotated read tools and no config values', async () => {
  const fixture = await clientFixture({ tools: [...advertised, { name: 'run_sql', annotations: { readOnlyHint: true } }] })
  const result = await fixture.client.status()
  assert.equal(result.status, 'ok')
  assert.equal(result.configured, true)
  assert.equal(result.readOnly, true)
  assert.deepEqual(result.availableTools, DATA_MCP_READ_TOOLS)
  assert.deepEqual(fixture.messages.map(message => message.method), ['initialize', 'notifications/initialized', 'tools/list'])
  assert.ok(fixture.processes.every(child => child.didClose))
  assert.doesNotMatch(JSON.stringify(result), /private-test|\/test\/ssh/)
})

test('query preserves the original source timestamp, date, zero and null, then closes its session', async () => {
  const { client, processes, messages } = await clientFixture()
  const result = await client.query('lanjing_net_sign_overview')
  assert.equal(result.status, 'ok')
  assert.equal(result.facts[0].tool, 'lanjing_net_sign_overview')
  assert.equal(result.facts[0].result.queried_at, '2026-01-03T00:00:00Z')
  assert.deepEqual(result.facts[0].result.result, canonical().result)
  assert.ok(Date.parse(result.fetchedAt))
  assert.equal(messages.at(-1).method, 'tools/call')
  assert.ok(processes.every(child => child.didClose))
})

test('unknown/write/legacy tools and additional flags are blocked before starting any process', async () => {
  const { client, processes } = await clientFixture()
  for (const tool of ['run_sql', 'land_deep_report', 'market_overview', 'refresh', '__proto__']) {
    const result = await client.query(tool, {})
    assert.equal(result.status, 'blocked')
    assert.equal(result.gaps[0].code, 'blocked_tool')
  }
  for (const args of [{ sql: 'SELECT 1' }, { limit: 101 }, { keyword: 'x\ncommand' }, { refresh: true }]) {
    const result = await client.query('lanjing_projects', args)
    assert.equal(result.status, 'blocked')
    assert.equal(result.gaps[0].code, 'invalid_arguments')
  }
  assert.equal(processes.length, 0)
})

test('required parameters, room target count and filters are bounded independently of server schemas', async () => {
  const { client, processes } = await clientFixture()
  const invalid = [
    ['lanjing_project', {}], ['lanjing_project_trend', { record_name: 'example', days: 366 }],
    ['lanjing_workbench', { dataset: 'rooms' }],
    ['lanjing_rooms', { targets: ['one'], filters: { export: true } }],
    ['lanjing_rooms', { targets: ['1', '2', '3', '4', '5'] }],
    ['lanjing_land_detail', { landid: '' }],
  ]
  for (const [tool, args] of invalid) assert.equal((await client.query(tool, args)).gaps[0].code, 'invalid_arguments')
  assert.equal(processes.length, 0)
})

test('server must advertise the exact tool and explicitly mark it read-only', async () => {
  for (const [tools, code] of [[[], 'tool_unavailable'], [[{ name: 'lanjing_projects' }], 'readonly_required'], [[{ name: 'lanjing_projects', annotations: { readOnlyHint: true, destructiveHint: true } }], 'readonly_required']]) {
    const { client, messages } = await clientFixture({ tools })
    const result = await client.query('lanjing_projects', {})
    assert.equal(result.gaps[0].code, code)
    assert.equal(messages.some(message => message.method === 'tools/call'), false)
  }
})

test('missing private config returns unconfigured without leaking paths', async () => {
  const client = new DataMcp({ configFile: '/nonexistent/private-test-config.json' })
  const result = await client.status()
  assert.equal(result.status, 'unconfigured')
  assert.deepEqual(result.facts, [])
  assert.doesNotMatch(JSON.stringify(result), /private-test-config/)
})

test('configuration references are reread for every live request and invalid entries are not executed', async () => {
  const { client, configFile, processes } = await clientFixture()
  assert.equal((await client.status()).status, 'ok')
  await writeFile(configFile, JSON.stringify({ connection: { command: ['bad'], args: [] } }))
  const result = await client.status()
  assert.equal(result.status, 'error')
  assert.equal(result.gaps[0].code, 'invalid_config')
  assert.equal(processes.length, 1)
})

test('timeouts terminate the process, including SIGKILL escalation for an unresponsive child', async () => {
  const { client, processes } = await clientFixture({ hang: 'initialize', timeoutMs: 20, ignoreEnd: true, ignoreTerm: true })
  const result = await client.status()
  assert.equal(result.status, 'timeout')
  assert.equal(result.gaps[0].code, 'timeout')
  assert.ok(processes[0].killedWith.includes('SIGTERM'))
  assert.ok(processes[0].killedWith.includes('SIGKILL'))
  assert.equal(processes[0].didClose, true)
})

test('pre-aborted requests start no process; cancellation during a call closes the live session', async () => {
  const { client, processes } = await clientFixture({ hang: 'tools/call' })
  assert.equal((await client.query('lanjing_projects', {}, { signal: AbortSignal.abort() })).status, 'aborted')
  assert.equal(processes.length, 0)
  const controller = new AbortController()
  const pending = client.query('lanjing_projects', {}, { signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 20)
  const result = await pending
  clearTimeout(timer)
  assert.equal(result.status, 'aborted')
  assert.ok(processes.every(child => child.didClose))
})

test('unexpected exit and malformed protocol report a safe gap and always close', async () => {
  for (const options of [{ exit: 'tools/list' }, { badProtocol: 'tools/list' }]) {
    const { client, processes } = await clientFixture(options)
    const result = await client.status()
    assert.equal(result.status, 'error')
    assert.ok(['process_exited', 'protocol_error'].includes(result.gaps[0].code))
    assert.ok(processes.every(child => child.didClose))
    assert.doesNotMatch(JSON.stringify(result), /private-test/)
  }
})

test('MCP text JSON is supported and secret fields and echoed connection values are redacted', async () => {
  const { client } = await clientFixture({ call: () => ({ content: [{ type: 'text', text: JSON.stringify({ source: 'test-only', token: 'different-secret', principal: 'test-owner', note: 'private-test-host private-test-token', count: 0, missing: null }) }] }) })
  const result = await client.query('lanjing_data_catalog')
  assert.equal(result.status, 'ok')
  assert.equal(result.facts[0].result.token, '[redacted]')
  assert.equal(result.facts[0].result.count, 0)
  assert.equal(result.facts[0].result.missing, null)
  assert.doesNotMatch(JSON.stringify(result), /different-secret|private-test|test-owner/)
})

test('source permission failures preserve only recognized error categories, never raw diagnostics', async () => {
  const { client } = await clientFixture({ call: () => ({ isError: true, content: [{ type: 'text', text: 'website_authentication_or_permission_denied private-test-token https://private-test-host' }] }) })
  const result = await client.query('lanjing_workbench', { dataset: 'analytics', section: 'fundamentals' })
  assert.equal(result.status, 'error')
  assert.equal(result.gaps[0].code, 'website_authentication_or_permission_denied')
  assert.deepEqual(result.facts, [])
  assert.doesNotMatch(JSON.stringify(result), /private-test|https:/)
})

test('the default Beijing market question needs only the overview, with no workbench permission dependency', async () => {
  const { client, messages } = await clientFixture()
  const result = await client.collectEvidence({ question: '北京楼市观察', signals: [] })
  assert.equal(result.status, 'ok')
  assert.deepEqual(messages.filter(message => message.method === 'tools/call').map(message => message.params), [{ name: 'lanjing_net_sign_overview', arguments: {} }])
})

test('broad multi-source research is limited to four calls and reports excluded requests', async () => {
  const { client, messages } = await clientFixture()
  const result = await client.collectEvidence({ question: '朝阳区住宅土拍新闻宏观' })
  assert.equal(result.status, 'partial')
  assert.equal(messages.filter(message => message.method === 'tools/call').length, 4)
  assert.equal(result.gaps[0].code, 'query_budget_exceeded')
})

test('collectEvidence retains successful live facts with gaps when a second source fails', async () => {
  const { client, messages } = await clientFixture({ call: ({ name }) => name === 'lanjing_website_articles'
    ? { isError: true, content: [{ type: 'text', text: 'source_unavailable private-test-token' }] }
    : { structuredContent: canonical({ count: 3 }) } })
  const result = await client.collectEvidence({ question: '北京住宅网签政策', signals: [{ title: 'test material', body: 'unverified number 99999' }] })
  assert.equal(result.status, 'partial')
  assert.equal(result.facts.length, 1)
  assert.equal(result.gaps[0].tool, 'lanjing_website_articles')
  assert.equal(result.gaps[0].code, 'source_unavailable')
  assert.equal(messages.filter(message => message.method === 'initialize').length, 1)
  assert.doesNotMatch(JSON.stringify(result), /99999|private-test/)
})

test('empty evidence is a gap; source material cannot turn into a database result', async () => {
  const { client } = await clientFixture({ call: () => ({ structuredContent: { result: { total: 0, items: [] } } }) })
  const result = await client.collectEvidence({ question: '最新政策文章', signals: [{ title: '政策', body: '1000 records' }] })
  assert.equal(result.status, 'partial')
  assert.equal(result.gaps[0].code, 'no_matches')
  assert.doesNotMatch(JSON.stringify(result), /1000 records/)
})

test('resale and current-existing queries cannot be answered with presale evidence', async () => {
  const { client, processes } = await clientFixture()
  for (const question of ['北京二手房成交', '纯现房尾房还有多少', '北京现房还剩多少套', '期转现库存']) {
    const result = await client.collectEvidence({ question })
    assert.equal(result.status, 'blocked')
    assert.equal(result.gaps[0].code, 'unsupported_scope')
  }
  assert.equal(processes.length, 0)
})

test('canonical evidence rejects a local or non-read-only source even when the tool is advertised', async () => {
  for (const extra of [{ source: 'local_sqlite' }, { transaction_read_only: false }, { database_vendor: 'sqlite' }, { contract_version: 'unknown' }]) {
    const { client } = await clientFixture({ call: () => ({ structuredContent: canonical(extra) }) })
    const result = await client.query('lanjing_net_sign_overview')
    assert.equal(result.status, 'error')
    assert.equal(result.gaps[0].code, 'invalid_evidence')
    assert.deepEqual(result.facts, [])
  }
})

test('a real unresponsive stdio child is terminated before status returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'data-mcp-process-test-'))
  const configFile = join(root, 'data-mcp.json')
  await writeFile(configFile, JSON.stringify({ connection: { command: process.execPath, args: ['-e', "process.stdin.resume(); setInterval(() => {}, 1000)"] }, timeoutMs: 40 }))
  const client = new DataMcp({ configFile, closeTimeoutMs: 10 })
  // Read a child PID without adding a subprocess API to the production class.
  let childPid
  const { spawn } = await import('node:child_process')
  client.spawnImpl = (...args) => { const child = spawn(...args); childPid = child.pid; return child }
  const result = await client.status()
  assert.equal(result.status, 'timeout')
  assert.equal(typeof childPid, 'number')
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
})

test('CLI blocks unknown tools without opening production, and refuses evidence inside the source tree', async () => {
  const run = promisify(execFile)
  await assert.rejects(() => run(process.execPath, ['scripts/query-data-mcp.mjs', 'query', 'run_sql', '{}']), error => {
    assert.equal(error.code, 1)
    const result = JSON.parse(error.stdout)
    assert.equal(result.status, 'blocked')
    assert.equal(result.gaps[0].code, 'blocked_tool')
    return true
  })
  await assert.rejects(() => run(process.execPath, ['scripts/query-data-mcp.mjs', 'query', 'run_sql', '{}', '--output', 'test/unwritten-live-evidence.json']), error => {
    assert.equal(error.code, 2)
    assert.match(error.stderr, /outside the source repository/)
    return true
  })
})

test('district names gain the 区 suffix the remote store uses', async () => {
  const { client, messages } = await clientFixture()
  const result = await client.collectEvidence({ question: '海淀住宅网签' })
  assert.equal(result.status, 'ok')
  const call = messages.filter(message => message.method === 'tools/call').map(message => message.params).find(params => params.name === 'lanjing_projects')
  assert.deepEqual(call.arguments, { district: '海淀区', limit: 10 })
})

test('named projects in materials get keyword queries and a detail follow-up within budget', async () => {
  const { client, messages } = await clientFixture({
    call: ({ name }) => name === 'lanjing_projects'
      ? { structuredContent: { result: { total: 1, items: [{ record_name: '嘉华珺园', marketing_name: '保利建工嘉华天珺' }] } } }
      : { structuredContent: canonical() },
  })
  const result = await client.collectEvidence({
    question: '海淀顺销第一之谜',
    signals: [{ title: '10月海淀新房网签榜', body: '报道：瑜海澐颂241套居首，嘉华天珺38套自称顺销第一' }],
  })
  assert.equal(result.status, 'ok')
  const calls = messages.filter(message => message.method === 'tools/call').map(message => message.params)
  assert.deepEqual(calls.map(params => params.name), ['lanjing_net_sign_overview', 'lanjing_projects', 'lanjing_project', 'lanjing_projects'])
  assert.deepEqual(calls[1].arguments, { keyword: '瑜海澐颂', limit: 3 })
  assert.deepEqual(calls[2].arguments, { record_name: '嘉华珺园' })
  assert.deepEqual(calls[3].arguments, { keyword: '嘉华天珺', limit: 3 })
  assert.equal(calls.some(params => params.name === 'lanjing_website_articles'), false)
})

test('generic count phrases do not become project keywords', async () => {
  const { client, messages } = await clientFixture()
  await client.collectEvidence({ question: '北京住宅网签', signals: [{ title: '样本', body: '全月网签38套，成交面积上升' }] })
  const calls = messages.filter(message => message.method === 'tools/call').map(message => message.params)
  assert.equal(calls.some(params => params.arguments.keyword), false)
})

test('land evidence uses a bounded read search and preserves the service envelope', async () => {
  const { client, messages } = await clientFixture()
  const result = await client.collectEvidence({ question: '朝阳区土拍' })
  assert.equal(result.status, 'ok')
  assert.equal(result.facts[0].tool, 'lanjing_land')
  const call = messages.find(message => message.method === 'tools/call')
  assert.deepEqual(call.params.arguments, { county: '朝阳区', limit: 10 })
})
