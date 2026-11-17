#!/usr/bin/env node
// 灵感源 CLI 摄入：把生成器产出的 JSON 幂等写进灵感墙。
// 用法：node scripts/ingest-sources.mjs <json文件> [--store <状态目录>]
// JSON 契约与 /sources/ingest 一致：{ channel, date, items: [{ title, body, url, source, tags }] }
// 默认操作 ~/.dsh/media-desk-lanjing/state.json，不经过 HTTP，重复运行只跳过已有条目。
import { readFile } from 'node:fs/promises'
import { Store } from '../src/store.js'
import { ingest } from '../src/sources.js'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/ingest-sources.mjs <json文件> [--store <状态目录>]')
  process.exit(2)
}
const storeIndex = process.argv.indexOf('--store')
const root = storeIndex > -1 ? process.argv[storeIndex + 1] : undefined

const body = JSON.parse(await readFile(file, 'utf8'))
const store = new Store(root)
const result = await ingest(store, body)
const { state, ...receipt } = result
console.log(JSON.stringify(receipt, null, 2))
if (receipt.errors.length) process.exitCode = 1
