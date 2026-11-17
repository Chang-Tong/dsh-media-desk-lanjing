#!/usr/bin/env node
// Live, read-only diagnostics. Config values and raw server errors are never printed.
// node scripts/query-data-mcp.mjs status
// node scripts/query-data-mcp.mjs query lanjing_net_sign_overview '{}'
// node scripts/query-data-mcp.mjs evidence '北京最新住宅网签' --output /private/evidence.json
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DataMcp } from '../src/data-mcp.js'

const USAGE = 'Usage: query-data-mcp.mjs status | query <read-tool> [json-arguments] | evidence <question> [--config <private-file>] [--output <outside-repo.json>] [--timeout <ms>]'

async function main() {
  const args = process.argv.slice(2)
  const flags = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (['--config', '--output', '--timeout'].includes(token)) {
      if (!args[index + 1] || args[index + 1].startsWith('--') || flags[token]) throw new Error('invalid_cli')
      flags[token] = args[++index]
    } else if (token.startsWith('--')) throw new Error('invalid_cli')
    else positional.push(token)
  }
  const [mode, name, raw] = positional
  if (!['status', 'query', 'evidence'].includes(mode) || mode === 'status' && positional.length !== 1 || mode === 'query' && (!name || positional.length > 3) || mode === 'evidence' && (!name || positional.length !== 2)) throw new Error('invalid_cli')
  let output
  if (flags['--output']) {
    output = resolve(flags['--output'])
    const repository = await realpath(fileURLToPath(new URL('..', import.meta.url)))
    // Resolve existing parents before writing so a symlink cannot put live evidence in Git.
    const pending = []
    let parent = dirname(output)
    while (true) {
      try { parent = await realpath(parent); break }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('invalid_output')
        pending.unshift(parent.split(sep).pop())
        const next = dirname(parent)
        if (next === parent) throw new Error('invalid_output')
        parent = next
      }
    }
    const resolved = resolve(parent, ...pending, output.split(sep).pop())
    const path = relative(repository, resolved)
    if (!path || !path.startsWith(`..${sep}`) && !isAbsolute(path)) throw new Error('invalid_output')
  }
  let queryArgs
  try { queryArgs = raw === undefined ? {} : JSON.parse(raw) } catch { throw new Error('invalid_cli') }
  const timeoutMs = flags['--timeout'] === undefined ? undefined : Number(flags['--timeout'])
  const client = new DataMcp({ ...(flags['--config'] ? { configFile: resolve(flags['--config']) } : {}), timeoutMs })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let result
  try {
    result = mode === 'status' ? await client.status({ signal: controller.signal })
      : mode === 'query' ? await client.query(name, queryArgs, { signal: controller.signal })
        : await client.collectEvidence({ question: name, signal: controller.signal })
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (output) {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    // Refuse existing files/symlinks rather than overwriting prior evidence.
    await writeFile(output, text, { mode: 0o600, flag: 'wx' })
  }
  process.stdout.write(text)
  process.exitCode = result.status === 'ok' ? 0 : result.status === 'partial' ? 3 : 1
}

main().catch(error => {
  process.stderr.write(error.message === 'invalid_cli' ? `${USAGE}\n` : error.message === 'invalid_output' ? 'Evidence output must be outside the source repository.\n' : 'Data MCP diagnostic could not complete. Check the private configuration and output location.\n')
  process.exitCode = 2
})
