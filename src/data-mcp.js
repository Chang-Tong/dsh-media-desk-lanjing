// Private connection settings stay outside the repository. Only the unified data-owned
// read tools below can be called; model output never chooses commands, SQL or credentials.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const DEFAULT_DATA_MCP_CONFIG = join(homedir(), '.dsh', 'media-desk-lanjing', 'data-mcp.json')
export const DATA_MCP_READ_TOOLS = Object.freeze([
  'lanjing_data_catalog', 'lanjing_website_articles', 'lanjing_workbench',
  'lanjing_room_options', 'lanjing_rooms', 'lanjing_yearbooks',
  'lanjing_net_sign_overview', 'lanjing_projects', 'lanjing_project',
  'lanjing_project_trend', 'lanjing_land', 'lanjing_land_detail',
])
const READ_TOOLS = new Set(DATA_MCP_READ_TOOLS)
const MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT = 90_000
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, name) => Object.hasOwn(value, name)
const FAILURES = {
  unconfigured: 'Data MCP is not configured. Check the private sidecar configuration.',
  invalid_config: 'Data MCP private configuration is invalid.',
  blocked_tool: 'This tool is outside the fixed read-only allowlist.',
  invalid_arguments: 'Arguments do not match the bounded read-only tool contract.',
  tool_unavailable: 'The configured server does not advertise this read-only tool.',
  readonly_required: 'The server must explicitly advertise this tool as read-only.',
  timeout: 'Data MCP exceeded the operation timeout.',
  aborted: 'Data MCP was cancelled.',
  process_failed: 'Data MCP could not start the configured process.',
  process_exited: 'Data MCP exited before the operation completed.',
  protocol_error: 'Data MCP returned an invalid protocol response.',
  invalid_evidence: 'The net-sign response does not satisfy the remote canonical read-only evidence contract.',
  response_too_large: 'Data MCP response exceeded the size limit.',
  tool_error: 'The read-only data source rejected or could not complete this query.',
  source_unavailable: 'The requested data source is unavailable.',
  access_denied: 'The current data identity does not have access to this source.',
  website_authentication_or_permission_denied: 'The website session is expired or lacks permission.',
  website_authentication_required: 'An existing authorized website session is required.',
  backend_source_unavailable: 'The authorized workbench source is unavailable.',
  postgresql_reader_not_configured: 'The server has no configured PostgreSQL reader.',
  website_not_configured: 'The server has no configured published website source.',
  presale_query_excludes_current_existing_projects: 'This presale query excludes projects currently in the existing-home stage.',
  no_matches: 'The query returned no matching records; no business conclusion is available.',
  unsupported_scope: 'The requested scope has no supported automatic evidence query. Choose an explicit read tool.',
  query_budget_exceeded: 'The question needs more than four read queries. Narrow the requested sources.',
}
function failure(code) {
  const error = new Error(FAILURES[code] || FAILURES.tool_error)
  error.code = own(FAILURES, code) ? code : 'tool_error'
  return error
}
function gapFor(error, tool) {
  const code = own(FAILURES, error?.code) ? error.code : 'tool_error'
  return { code, message: FAILURES[code], ...(tool && READ_TOOLS.has(tool) ? { tool } : {}) }
}
function failedStatus(error) {
  if (error?.code === 'unconfigured') return 'unconfigured'
  if (error?.code === 'timeout' || error?.code === 'aborted') return error.code
  if (['blocked_tool', 'invalid_arguments', 'readonly_required', 'unsupported_scope'].includes(error?.code)) return 'blocked'
  return 'error'
}
function packet(status, facts = [], gaps = [], extra = {}) {
  return { status, fetchedAt: new Date().toISOString(), facts, gaps, ...extra }
}
function toolFailure(value) {
  // Remote error text can contain credentials/hosts. Only return known fixed codes.
  const text = JSON.stringify(value)
  const code = Object.keys(FAILURES).find(key => key.length > 8 && text.includes(key))
  return failure(code || 'tool_error')
}
function boundedText(value, maximum = 80, required = false) {
  return typeof value === 'string' && value.length <= maximum && (!required || value.trim().length > 0) && !/[\x00-\x1f]/.test(value)
}
function integer(value, low, high) {
  return Number.isSafeInteger(value) && value >= low && value <= high
}

/** Independent validation also blocks hidden flags and SQL/command fields on read tools. */
function validateArguments(name, args) {
  if (!READ_TOOLS.has(name)) throw failure('blocked_tool')
  if (!isObject(args) || Object.getPrototypeOf(args) !== Object.prototype) throw failure('invalid_arguments')
  const text = maximum => value => boundedText(value, maximum)
  const requiredText = maximum => value => boundedText(value, maximum, true)
  const limit = value => integer(value, 1, 100)
  const offset = value => integer(value, 0, 10_000)
  const specs = {
    lanjing_data_catalog: {}, lanjing_net_sign_overview: {},
    lanjing_website_articles: { kind: value => ['all', 'news', 'research'].includes(value), slug: value => typeof value === 'string' && (value === '' || /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)), query: text(80), limit, offset },
    lanjing_workbench: { dataset: value => ['analytics', 'reference'].includes(value), section: value => value === '' || typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,5}$/.test(value), limit, offset },
    lanjing_room_options: { query: text(80) },
    lanjing_rooms: {
      targets: value => Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every(requiredText(160)),
      filters: value => isObject(value) && Object.entries(value).every(([key, item]) => ['status', 'layout', 'area_min', 'area_max', 'budget_min', 'budget_max', 'as_of'].includes(key) && (boundedText(item, 100) || typeof item === 'number' && Number.isFinite(item))),
    },
    lanjing_yearbooks: { query: text(80), edition: value => value === null || integer(value, 1, 2 ** 31 - 1) },
    lanjing_projects: { keyword: text(80), district: text(80), limit },
    lanjing_project: { record_name: requiredText(160) },
    lanjing_project_trend: { record_name: requiredText(160), days: value => integer(value, 1, 365) },
    lanjing_land: { keyword: text(80), county: text(80), limit },
    lanjing_land_detail: { landid: requiredText(160) },
  }
  const required = { lanjing_workbench: ['dataset'], lanjing_rooms: ['targets'], lanjing_project: ['record_name'], lanjing_project_trend: ['record_name'], lanjing_land_detail: ['landid'] }
  const spec = specs[name]
  if (Object.entries(args).some(([key, value]) => !own(spec, key) || !spec[key](value)) || (required[name] || []).some(key => !own(args, key))) throw failure('invalid_arguments')
  return structuredClone(args)
}

async function privateJson(file) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw failure('invalid_config')
  let content
  try { content = await readFile(file, 'utf8') } catch (error) { throw failure(error.code === 'ENOENT' ? 'unconfigured' : 'invalid_config') }
  if (Buffer.byteLength(content) > MAX_BYTES) throw failure('invalid_config')
  try {
    const value = JSON.parse(content)
    if (!isObject(value)) throw failure('invalid_config')
    return value
  } catch { throw failure('invalid_config') }
}

async function connectionSettings(file, overrideTimeout) {
  const config = await privateJson(file)
  if (config.enabled === false) throw failure('unconfigured')
  let entry = config.connection
  if (isObject(config.source)) {
    const source = await privateJson(config.source.file)
    entry = config.source.server ? source.mcpServers?.[config.source.server] ?? source.mcp?.[config.source.server] : source
    // OpenCode's local stdio entries store executable and argv together.
    if (isObject(entry) && entry.type === 'local' && Array.isArray(entry.command)) {
      entry = { ...entry, command: entry.command[0], args: entry.command.slice(1), env: entry.environment }
    }
  }
  if (!isObject(entry) || entry.enabled === false || entry.disabled === true || !['stdio', 'local', undefined].includes(entry.type)
      || typeof entry.command !== 'string' || !entry.command || !Array.isArray(entry.args ?? [])
      || (entry.args ?? []).length > 100 || (entry.args ?? []).some(value => typeof value !== 'string' || value.includes('\0'))
      || entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd))
      || entry.env !== undefined && (!isObject(entry.env) || Object.entries(entry.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string'))
  ) throw failure('invalid_config')
  const timeoutMs = overrideTimeout ?? config.timeoutMs ?? DEFAULT_TIMEOUT
  if (!integer(timeoutMs, 10, 180_000)) throw failure('invalid_config')
  const secrets = [...(entry.args ?? []).filter(value => value.length >= 8 && value !== 'lanjing-data'), ...Object.values(entry.env ?? {}).filter(value => value.length >= 4)]
  return { command: entry.command, args: entry.args ?? [], cwd: entry.cwd, env: entry.env ?? {}, timeoutMs, secrets }
}

const PRIVATE_KEYS = /^(?:.*(?:token|password|secret|credential|cookie).*|authorization|headers|endpoint|hostname|host|dsn|database|database_url|backend_url|principal|command|args|env|config_path|cookie_file|database_file|audit_file)$/i
function redact(value, secrets, depth = 0) {
  if (depth > 40) throw failure('response_too_large')
  if (typeof value === 'string') {
    let safe = value
    for (const secret of secrets) safe = safe.split(secret).join('[redacted]')
    safe = safe.replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"<>]*@[^\s"<>]*/gi, '[redacted]')
      .replace(/\b(?:https?|ssh):\/\/(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?[^\s"<>]*/gi, '[redacted]')
    return safe
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets, depth + 1))
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, PRIVATE_KEYS.test(key) ? '[redacted]' : redact(item, secrets, depth + 1)]))
  return value
}

/** Minimal newline-delimited JSON-RPC stdio transport; never invokes a shell. */
class StdioSession {
  constructor(settings, spawnImpl, signal) {
    this.pending = new Map()
    this.sequence = 0
    this.buffer = ''
    this.receivedBytes = 0
    this.decoder = new StringDecoder('utf8')
    this.closed = false
    this.fault = null
    this.detached = process.platform !== 'win32'
    try {
      this.child = spawnImpl(settings.command, settings.args, {
        cwd: settings.cwd, env: { ...process.env, ...settings.env },
        shell: false, detached: this.detached, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
    } catch { throw failure('process_failed') }
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    this.child.stdout.on('data', chunk => this.receive(chunk))
    this.child.stdout.on('error', () => this.fail(failure('process_exited')))
    this.child.stderr.on('data', () => {}) // Never persist or echo server/SSH diagnostics.
    this.child.stderr.on('error', () => {})
    this.child.stdin.on('error', () => this.fail(failure('process_exited')))
    this.child.on('error', () => { this.fail(failure('process_failed')); this.resolveExit() })
    this.child.on('close', () => { this.closed = true; this.fail(failure('process_exited')); this.resolveExit() })
    this.abort = () => { this.fail(failure(signal.reason?.code === 'timeout' ? 'timeout' : 'aborted')); this.kill('SIGTERM') }
    this.signal = signal
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
  }

  kill(signal) {
    if (this.closed) return
    try {
      if (this.detached && this.child.pid) process.kill(-this.child.pid, signal)
      else this.child.kill(signal)
    } catch { try { this.child.kill(signal) } catch { /* Already gone. */ } }
  }

  fail(error) {
    this.fault ||= error
    for (const request of this.pending.values()) request.reject(this.fault)
    this.pending.clear()
  }

  receive(chunk) {
    if (this.fault) return
    this.receivedBytes += chunk.length
    this.buffer += this.decoder.write(chunk)
    if (this.receivedBytes > MAX_BYTES * 5 || Buffer.byteLength(this.buffer) > MAX_BYTES) { this.fail(failure('response_too_large')); this.kill('SIGTERM'); return }
    let end
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { this.fail(failure('protocol_error')); this.kill('SIGTERM'); return }
      if (!isObject(message) || message.jsonrpc !== '2.0') { this.fail(failure('protocol_error')); this.kill('SIGTERM'); return }
      if (typeof message.method === 'string') {
        // No sampling, roots, shell, file access, or elicitation granted to the server.
        if (own(message, 'id')) {
          try { this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } }) }
          catch (error) { this.fail(error); this.kill('SIGTERM'); return }
        }
        continue
      }
      const request = this.pending.get(message.id)
      if (!request) continue
      this.pending.delete(message.id)
      if (message.error) request.reject(failure('protocol_error'))
      else if (!own(message, 'result')) request.reject(failure('protocol_error'))
      else request.resolve(message.result)
    }
  }

  write(message) {
    if (this.fault) throw this.fault
    if (this.closed || !this.child.stdin.writable) throw failure('process_exited')
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`) } catch { throw failure('process_exited') }
  }

  request(method, params) {
    if (this.fault) return Promise.reject(this.fault)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }

  async initialize() {
    const info = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-media-desk-lanjing', version: '0.1.0' } })
    if (!isObject(info) || !boundedText(info.protocolVersion, 40, true) || !isObject(info.capabilities?.tools)) throw failure('protocol_error')
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.protocolVersion = info.protocolVersion
    this.tools = new Map()
    let cursor
    for (let page = 0; page < 5; page += 1) {
      const list = await this.request('tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(list?.tools) || list.tools.length > 200) throw failure('protocol_error')
      for (const tool of list.tools) if (READ_TOOLS.has(tool?.name)) this.tools.set(tool.name, tool)
      if (!list.nextCursor) return
      if (!boundedText(list.nextCursor, 2048, true)) throw failure('protocol_error')
      cursor = list.nextCursor
    }
    throw failure('protocol_error')
  }

  async call(name, args, secrets) {
    const tool = this.tools.get(name)
    if (!tool) throw failure('tool_unavailable')
    if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) throw failure('readonly_required')
    const response = await this.request('tools/call', { name, arguments: args })
    if (!isObject(response)) throw failure('protocol_error')
    if (response.isError) throw toolFailure(response)
    let value = response.structuredContent
    if (value === undefined) {
      const text = (response.content ?? []).filter(item => item?.type === 'text').map(item => item.text).join('\n')
      if (!text) throw failure('protocol_error')
      try { value = JSON.parse(text) } catch { throw failure('protocol_error') }
    }
    if (!isObject(value) && !Array.isArray(value)) throw failure('protocol_error')
    if (name === 'lanjing_net_sign_overview') {
      const data = value.result
      if (!Number.isFinite(Date.parse(value.queried_at)) || !isObject(data)
          || data.source !== 'remote_django' || data.database_vendor !== 'postgresql'
          || data.transaction_read_only !== true || data.contract_version !== 'skill-evidence/v1'
          || !isObject(data.latest_dates)) throw failure('invalid_evidence')
    }
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw failure('response_too_large')
    return { tool: name, arguments: args, result: redact(value, secrets) }
  }

  async close(graceMs) {
    this.signal.removeEventListener('abort', this.abort)
    if (this.closed) return
    try { this.child.stdin.end() } catch { /* Already closing. */ }
    const wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); this.exited.then(() => { clearTimeout(timer); resolve() }) })
    await wait(graceMs)
    if (this.closed) return
    this.kill('SIGTERM')
    await wait(Math.min(graceMs, 250))
    if (!this.closed) { this.kill('SIGKILL'); await wait(100) }
  }
}

/** Keep planning deterministic and bounded. Source material is a clue, never a database fact. */
const DISTRICT_PATTERN = /(?:东城|西城|朝阳|海淀|丰台|石景山|通州|昌平|大兴|顺义|房山|门头沟|怀柔|平谷|密云|延庆)(?:区)?/
const PROJECT_NAME_STOP = /网签|成交|新房|住宅|项目|楼盘|房源|销售|月份?|年度?|排名|榜单|居首|套数|金额|面积|均价|环比|同比|东城|西城|朝阳|海淀|丰台|石景山|通州|昌平|大兴|顺义|房山|门头沟|怀柔|平谷|密云|延庆|北京|上海|广州|深圳/
function extractProjectCandidates(content) {
  const found = []
  for (const match of String(content).matchAll(/([一-龥]{2,8})(?=\d+(?:\.\d+)?\s*套)/g)) {
    const name = match[1]
    if (PROJECT_NAME_STOP.test(name) || found.includes(name)) continue
    found.push(name)
    if (found.length >= 2) break
  }
  return found
}

function evidencePlan(question, signals) {
  const rows = Array.isArray(signals) ? signals.slice(0, 20).filter(isObject) : []
  const content = [String(question ?? '').slice(0, 8000), ...rows.map(row => [row.title, row.body, ...(Array.isArray(row.tags) ? row.tags.slice(0, 10) : [])].filter(value => typeof value === 'string').join(' ').slice(0, 2000))].join('\n')
  const districtMatch = DISTRICT_PATTERN.exec(content)?.[0] ?? ''
  // The remote store keys districts with the 区 suffix; “海淀” matches nothing.
  const district = districtMatch ? districtMatch.endsWith('区') ? districtMatch : `${districtMatch}区` : ''
  const plan = []
  let truncated = false
  const add = (tool, args) => {
    if (plan.some(row => row.tool === tool && JSON.stringify(row.args) === JSON.stringify(args))) return
    if (plan.length >= 4) { truncated = true; return }
    plan.push({ tool, args })
  }
  const land = /土拍|地块|拿地|供地|土地|拍地|出让|楼面价|land auction/i.test(content)
  const housing = /网签|住宅|期房|新房|去化|库存|楼盘|项目|成交|房价|二手房|net.sign|presale/i.test(content)
  const website = /新闻|政策|文章|资讯|研究|报告|published|website|article/i.test(content)
  const macro = /人口|统计年鉴|年鉴|出生|城镇化|就业|收入|宏观|GDP|yearbook|population/i.test(content)
  // Named projects (“嘉华天珺38套…”) get targeted keyword queries; collectEvidence
  // follows a keyword hit with the project detail read while budget remains.
  // Generic website/district lists are skipped then: they would spend the
  // four-call budget without answering the named-project question.
  const candidates = housing ? extractProjectCandidates(content) : []
  if (housing || !land && !website && !macro) add('lanjing_net_sign_overview', {})
  for (const keyword of candidates) add('lanjing_projects', { keyword, limit: 3 })
  if (!candidates.length) {
    if (land) add('lanjing_land', { ...(district ? { county: district } : {}), limit: 10 })
    if (website) add('lanjing_website_articles', { kind: 'all', limit: 5 })
    if (housing && district) add('lanjing_projects', { district, limit: 10 })
  }
  if (macro) add('lanjing_yearbooks', { query: /人口|population/i.test(content) ? '人口' : '' })
  const project = rows.find(row => boundedText(row.record_name ?? row.recordName, 160, true))
  if (project && housing) add('lanjing_project', { record_name: project.record_name ?? project.recordName })
  // Existing-home transactions and resale totals have no compatible canonical tool here.
  const unsupported = /二手房|现房|期转现|resale|existing.home/i.test(content)
  return { plan, unsupported, truncated }
}

/**
 * All methods resolve {status, fetchedAt, facts:[{tool,arguments,result}], gaps:[]}.
 * Success is exactly status === 'ok'. `partial` keeps successful reads plus failures.
 * Every operation uses a fresh live MCP session and closes its process on every path.
 * Sidecar: {source:{file:'/absolute/private/mcp.json',server:'lanjing-data'},timeoutMs:90000}
 * It may also reference a plain {command,args,env?,cwd?} file by omitting `server`.
 */
export class DataMcp {
  constructor({ configFile = DEFAULT_DATA_MCP_CONFIG, timeoutMs, spawnImpl = spawn, closeTimeoutMs = 750 } = {}) {
    this.configFile = configFile
    this.timeoutMs = timeoutMs
    this.spawnImpl = spawnImpl
    this.closeTimeoutMs = integer(closeTimeoutMs, 10, 2000) ? closeTimeoutMs : 750
  }

  async run(signal, operation) {
    if (signal?.aborted) return packet('aborted', [], [gapFor(failure('aborted'))])
    let settings
    try { settings = await connectionSettings(this.configFile, this.timeoutMs) }
    catch (error) { return packet(failedStatus(error), [], [gapFor(error)], { configured: false }) }
    const controller = new AbortController()
    const abort = () => controller.abort(failure('aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(failure('timeout')), settings.timeoutMs)
    let session
    try {
      session = new StdioSession(settings, this.spawnImpl, controller.signal)
      await session.initialize()
      return await operation(session, settings)
    } catch (error) {
      return packet(failedStatus(error), [], [gapFor(error)], { configured: true })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (session) await session.close(this.closeTimeoutMs)
    }
  }

  async status({ signal } = {}) {
    return this.run(signal, async session => {
      const availableTools = [...session.tools.values()].filter(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true).map(tool => tool.name)
      if (!availableTools.length) throw failure('tool_unavailable')
      return packet('ok', [], [], { configured: true, transport: 'stdio', readOnly: true, protocolVersion: session.protocolVersion, availableTools })
    })
  }

  async query(name, args = {}, { signal } = {}) {
    let checked
    try { checked = validateArguments(name, args) }
    catch (error) { return packet(failedStatus(error), [], [gapFor(error)]) }
    return this.run(signal, async (session, settings) => {
      try { return packet('ok', [await session.call(name, checked, settings.secrets)]) }
      catch (error) { return packet(failedStatus(error), [], [gapFor(error, name)]) }
    })
  }

  async collectEvidence({ question = '', signals = [], signal } = {}) {
    const { plan, unsupported, truncated } = evidencePlan(question, signals)
    if (unsupported) return packet('blocked', [], [gapFor(failure('unsupported_scope'))])
    return this.run(signal, async (session, settings) => {
      const facts = []
      const gaps = truncated ? [gapFor(failure('query_budget_exceeded'))] : []
      let lastError
      let calls = 0
      const queue = [...plan]
      const detailsQueued = new Set()
      while (queue.length && calls < 4) {
        const request = queue.shift()
        calls += 1
        try {
          const fact = await session.call(request.tool, validateArguments(request.tool, request.args), settings.secrets)
          facts.push(fact)
          const data = fact.result?.result ?? fact.result
          if (data?.total === 0 && Array.isArray(data.items) && data.items.length === 0) gaps.push(gapFor(failure('no_matches'), request.tool))
          // A keyword hit names the record; spend remaining budget on its detail read.
          if (request.tool === 'lanjing_projects' && request.args.keyword && Array.isArray(data?.items)) {
            const hit = data.items.find(row => boundedText(row?.record_name, 160, true))
            if (hit && !detailsQueued.has(hit.record_name) && calls + queue.length < 4) {
              detailsQueued.add(hit.record_name)
              queue.unshift({ tool: 'lanjing_project', args: { record_name: hit.record_name } })
            }
          }
        } catch (error) {
          lastError = error
          gaps.push(gapFor(error, request.tool))
          if (['aborted', 'timeout', 'process_exited', 'process_failed', 'protocol_error', 'response_too_large'].includes(error.code)) break
        }
      }
      return packet(gaps.length ? facts.length ? 'partial' : failedStatus(lastError) : 'ok', facts, gaps, { scope: 'Read-only tool evidence; preserve each source period, project scope and completeness limits.' })
    })
  }
}
