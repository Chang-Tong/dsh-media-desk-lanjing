import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSeed } from '../src/seed.js'
import { applyOps } from '../src/ops.js'
import { migrateEditorialState, isMaterial, isTopic, topicsUsing } from '../src/editorial.js'
import { Store } from '../src/store.js'
import { ingest } from '../src/sources.js'
import { insightsFromEvidence } from '../src/server-insights.js'

const material = (id,extra={}) => ({id,title:`新闻${id}`,body:`原始材料${id}`,url:`https://example.org/${id}`,kind:'web',channel:'overseas-news',status:'idea',createdAt:'2026-11-06T08:00:00Z',tags:[],...extra})
function fixture(rows=[]) { return {...buildSeed(new Date()), items:rows} }

test('旧数据升级保留排期id、原文和已使用关系，重复加载不复制',()=>{
 const state=fixture([material('uk',{status:'outline',scheduledAt:'2026-11-10T12:00:00Z'}),material('sg'),{id:'web',kind:'web',url:'https://example.org/us',title:'洛杉矶市长住房政策',status:'idea'}])
 migrateEditorialState(state)
 assert.equal(state.items.find(i=>i.id==='uk').scheduledAt,'2026-11-10T12:00:00Z')
 assert.equal(state.items.filter(isMaterial).length,3)
 const src=state.items.find(i=>i.id==='src_uk')
 assert.equal(topicsUsing(state.items,src.id)[0].id,'uk')
 assert.equal(state.items.find(i=>i.id==='web').channel,'overseas-news')
 assert.equal(state.items.filter(isTopic).length,1)
 migrateEditorialState(state);assert.equal(state.items.length,4)
})

test('两条素材消费为一个独立选题，原始内容不被修改，可添加第三条',()=>{
 const state=fixture([material('a',{recordType:'material'}),material('b',{recordType:'material'}),material('c',{recordType:'material'})])
 const before=JSON.stringify(state.items)
 const result=applyOps(state,[{op:'consume_sources',sourceIds:['a','b'],title:'海外市场与北京买房',scheduledAt:'2026-11-10T12:00:00Z'}])
 assert.deepEqual(result.errors,[])
 const topic=state.items.find(i=>i.id===result.receipts[0].target)
 assert.deepEqual(topic.sourceIds,['a','b']);assert.equal(topic.sourceMaterials.length,2)
 assert.equal(topic.status,'outline');assert.equal(topic.outputFormat,'text')
 assert.equal(JSON.stringify(state.items.filter(isMaterial)),before)
 assert.equal(topic.production,undefined)
 applyOps(state,[{op:'consume_sources',sourceIds:['c','a'],targetId:topic.id}])
 assert.deepEqual(topic.sourceIds,['a','b','c']);assert.equal(topicsUsing(state.items,'a').length,1)
})

test('不接受失效引用，不让素材直接排期或生成状态，不删除已关联原文',()=>{
 const state=fixture([material('a',{recordType:'material'})])
 assert.match(applyOps(state,[{op:'consume_sources',sourceIds:['a','missing']}]).errors[0],/不存在/)
 assert.equal(state.items.length,1)
 assert.match(applyOps(state,[{op:'schedule_item',id:'a',scheduledAt:'2026-11-10T12:00:00Z'}]).errors[0],/选题/)
 applyOps(state,[{op:'consume_sources',sourceIds:['a']}])
 assert.match(applyOps(state,[{op:'delete_item',id:'a'}]).errors[0],/来源/)
})

test('同日选题可合并为一篇，删除合辑会恢复原选题，素材始终可见',()=>{
 const state=fixture([material('a',{recordType:'material'}),material('b',{recordType:'material'})])
 const ids=['a','b'].map(id=>applyOps(state,[{op:'consume_sources',sourceIds:[id],title:`选题${id}`}]).receipts[0].target)
 const r=applyOps(state,[{op:'merge_topics',topicIds:ids,title:'合辑'}])
 assert.deepEqual(r.errors,[])
 const merged=state.items.find(i=>i.id===r.receipts[0].target)
 assert.equal(state.items.filter(isTopic).length,1)
 assert.deepEqual(merged.sourceIds,['a','b'])
 assert.equal(state.items.filter(isMaterial).length,2)
 applyOps(state,[{op:'delete_item',id:merged.id}])
 assert.equal(state.items.filter(isTopic).length,2)
})

test('摄入并发去重与消费撤销不丢失素材，日期不是当日摄入时间',async()=>{
 const store=new Store(await mkdtemp(join(tmpdir(),'editorial-')))
 const body={channel:'overseas-news',date:'2026-11-01',items:[{title:'旧新闻',body:'必须保留的原始正文',url:'https://example.org/news'}]}
 const [a,b]=await Promise.all([ingest(store,body),ingest(store,body)])
 assert.equal(a.added+b.added,1)
 const source=(await store.read()).items.find(isMaterial)
 assert.equal(source.date,'2026-11-01')
 await store.mutate('加入选题',state=>applyOps(state,[{op:'consume_sources',sourceIds:[source.id]}]))
 await store.undoLast()
 const after=await store.read()
 assert.equal(topicsUsing(after.items,source.id).length,0)
 assert.equal(after.items.find(i=>i.id===source.id).body,body.items[0].body)
})

test('服务器洞察保留近7日缺口，拒绝伪造来源与空值，不重算canonical',()=>{
 const p={status:'ok',fetchedAt:'2026-11-07T00:00:00Z',facts:[{tool:'lanjing_net_sign_overview',result:{result:{source:'remote_django',transaction_read_only:true,contract_version:'skill-evidence/v1',latest_dates:{transaction_residential:'2026-11-06',snapshot:'2026-11-06'},snapshot:{project_count:134,approved_units:null,signed_units:10,available_units:null},recent_7d:{complete:false,completeProjectCount:107,expectedProjectCount:134,total:null,partial_sum:244,windowStart:'2026-10-31',windowEnd:'2026-11-06'}}}}]}
 const rows=insightsFromEvidence(p)
 assert.equal(rows.length,1);assert.match(rows[0].title,/107\/134/)
 assert.doesNotMatch(rows[0].body,/244|可售 0/)
 p.facts[0].result.result.source='local';assert.deepEqual(insightsFromEvidence(p),[])
})
