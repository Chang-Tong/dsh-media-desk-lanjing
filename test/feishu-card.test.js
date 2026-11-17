import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { createFeishuEditorial } from '../src/feishu-editorial.js'
import { sendMessage, updateCard, startCardEvents } from '../src/feishu-transport.js'

const NOW = '2026-11-14T10:00:00.000Z'
async function setup(t, options={}) {
  const root = await mkdtemp(join(tmpdir(),'lanjing-card-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const store = new Store(root), sent=[], updates=[], messages=[]
  let failure = false
  const transport = {
    async readMessages(){return {messages,hasMore:false}},
    async sendMessage(p){sent.push(p); return `om_card_${sent.length}`},
    async updateCard(p){if(failure)throw new Error('network unavailable');updates.push(p)},
    ...options,
  }
  await store.mutate('', s=>{
    s.items=[{id:'topic',recordType:'topic',title:'原稿',body:'原简报',editorialBrief:'原简报',editorialBriefVersion:2,production:{status:'done',title:'酒仙桥四居',article:'已核验正文',format:'guizang',cards:['1.png','2.png']},readyForReview:true,completedNotified:true}]
    s.editorialWorkflow={feishu:{enabled:true,ownerId:'owner',chatId:'chat',activeTopicId:'topic',since:'2026-11-14 00:00',phase:'ready_for_review'}}
  })
  const ed=createFeishuEditorial({store,transport,producer:{start(){throw new Error('must never create')},isRunning(){return false}},callText:async()=>{throw new Error('must not invoke model')},now:()=>new Date(NOW)})
  await ed.review({topicId:'topic',artifactHash:(await ed.status()).artifactHash,status:'passed'})
  const item=async()=> (await store.read()).items[0]
  const event=async(decision='approve')=>{const a=(await item()).browserApproval;return {type:'card.action.trigger',host:'im_message',action_tag:'button',event_id:'evt1',timestamp:String(Date.parse(NOW)+100),operator_id:'owner',chat_id:'chat',message_id:a.cardMessageId,action_value:JSON.stringify({kind:'lanjing_draft_approval',topicId:'topic',artifactHash:a.artifactHash,token:a.token,decision})}}
  return {root,store,ed,item,event,sent,updates,messages,setFailure:v=>{failure=v}}
}

test('native card approval is single-use and changes only authorization, with durable receipt',async t=>{
 const f=await setup(t);await Promise.all([f.ed.requestBrowserApproval('topic'),f.ed.requestBrowserApproval('topic')])
 assert.equal(f.sent.length,1);assert.match(JSON.stringify(f.sent[0].card),/确认保存草稿/)
 const ev=await f.event();assert.deepEqual(await f.ed.onCardAction(ev),{ok:true,decision:'approve'})
 const a=(await f.item()).browserApproval;assert.equal(a.status,'approved');assert.equal(a.approvedBy,'owner');assert.equal(a.device,'Air');assert.equal(a.model,'gpt-6.1-terra')
 assert.equal((await f.item()).draftReceipt,undefined);assert.equal(f.updates.length,1);assert.doesNotMatch(JSON.stringify(f.updates[0].card),/"button"/)
 await f.ed.onCardAction(ev);await f.ed.onCardAction({...ev,event_id:'evt2'});assert.equal(f.updates.length,1)
 assert.equal((await f.store.read()).editorialWorkflow.feishu.cardEventReceipts.length,1)
})

test('defer removes buttons and never approves',async t=>{const f=await setup(t);await f.ed.requestBrowserApproval('topic');assert.equal((await f.ed.onCardAction(await f.event('defer'))).ok,true);assert.equal((await f.item()).browserApproval.status,'deferred');assert.equal((await f.ed.status()).browserApproved,false);assert.equal(f.updates.length,1)})

test('wrong identity/context/value/timestamp and unbound card cannot approve',async t=>{
 for(const variant of ['owner','chat','card','token','hash','old','malformed','unbound','changed-content','changed-review','outdated']) await t.test(variant,async t=>{
  const f=await setup(t);await f.ed.requestBrowserApproval('topic');const ev=await f.event()
  if(variant==='owner')ev.operator_id='intruder'
  if(variant==='chat')ev.chat_id='other'
  if(variant==='card')ev.message_id='other'
  if(variant==='old')ev.timestamp=String(Date.parse(NOW)-1)
  if(variant==='malformed')ev.action_value='{broken'
  if(variant==='token'||variant==='hash'){const v=JSON.parse(ev.action_value);v[variant==='hash'?'artifactHash':'token']='a'.repeat(64);ev.action_value=JSON.stringify(v)}
  if(['unbound','changed-content','changed-review','outdated'].includes(variant))await f.store.mutate('',s=>{const r=s.items[0];if(variant==='unbound')delete r.browserApproval.cardMessageId;if(variant==='changed-content')r.production.article='changed without resetting flags';if(variant==='changed-review')r.editorialReview.artifactHash='bad';if(variant==='outdated')r.production.outdated=true})
  assert.equal((await f.ed.onCardAction(ev)).ok,false);assert.equal((await f.item()).browserApproval.status,'pending');assert.equal(f.updates.length,0)
 })
})

test('text-pending migrates once, preserves token; update failure retries without approving twice',async t=>{
 const f=await setup(t),hash=(await f.ed.status()).artifactHash
 await f.store.mutate('',s=>{s.items[0].browserApproval={status:'pending',token:'legacy',artifactHash:hash,at:NOW}})
 await f.ed.requestBrowserApproval('topic');await f.ed.requestBrowserApproval('topic');assert.equal(f.sent.length,1);assert.equal((await f.item()).browserApproval.token,'legacy')
 f.setFailure(true);await f.ed.onCardAction(await f.event());assert.equal((await f.item()).browserApproval.status,'approved');assert.equal((await f.ed.status()).outbox[0].status,'failed')
 f.setFailure(false);await f.store.mutate('',s=>{for(const r of s.editorialWorkflow.feishu.outbox)if(r.status==='failed')r.nextRetryAt=NOW});await f.ed.tick();assert.equal(f.updates.length,1);assert.equal((await f.ed.status()).outbox.length,0)
})

test('draft-view reply preserves approved version and does not rewrite brief or call model',async t=>{
 const f=await setup(t);await f.ed.requestBrowserApproval('topic');const before=await f.item()
 f.messages.push({message_id:'view1',chat_id:'chat',sender:{id:'owner',sender_type:'user'},msg_type:'text',content:'看看稿件，发我一下-',create_time:'2026-11-14 18:01'})
 await f.ed.tick();const after=await f.item();for(const key of ['production','editorialBrief','editorialBriefVersion','editorialReview','browserApproval'])assert.deepEqual(after[key],before[key],key)
 assert.match(f.sent.at(-1).text,/已核验正文/)
})

test('listener command comes from bounded local configuration; not ready fails closed, stop rejects callbacks',async t=>{
 let captured,stops=0
 const f=await setup(t,{startCardEvents(opts){captured=opts;return async()=>{stops++}}})
 await writeFile(join(f.root,'card-event-command.json'),JSON.stringify({executable:'/usr/bin/ssh',argsPrefix:['-T','host','trusted-cli']}))
 await Promise.all([f.ed.manageCardEvents(),f.ed.manageCardEvents()]);assert.equal(captured.executable,'/usr/bin/ssh');assert.deepEqual(captured.argsPrefix,['-T','host','trusted-cli'])
 await assert.rejects(f.ed.requestBrowserApproval('topic'),/尚未就绪/)
 captured.onStatus('ready');await f.ed.requestBrowserApproval('topic');const ev=await f.event()
 const stop=f.ed.start();await stop();assert.equal(stops,1);assert.equal((await f.ed.onCardAction(ev)).reason,'stopped')
})

async function fakeCLI(t,source){const dir=await mkdtemp(join(tmpdir(),'fake-card-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'cli.cjs');await writeFile(path,source);return {dir,path}}
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(check){for(let i=0;i<100;i++){if(await check())return;await delay(20)}throw new Error('test deadline')}

test('transport card send/update uses typed arguments and complete serialized content',async t=>{
 const {dir,path}=await fakeCLI(t,`const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(__dirname+'/argv',JSON.stringify(a)+'\\n');console.log(JSON.stringify({ok:true,data:{message_id:'om_test'}}));`)
 // executable wrapper is a real child process and receives individual argv, never shell text.
 const wrapper=join(dir,'wrapper');await writeFile(wrapper,`#!/bin/sh\nexec '${process.execPath}' '${path}' "$@"\n`,{mode:0o700})
 const card={elements:[{tag:'div',text:{tag:'plain_text',content:'safe $() ` literal'}}]}
 await sendMessage({chatId:'chat',card,idempotencyKey:'stable',executable:wrapper});await updateCard({messageId:'om_test',card,executable:wrapper})
 const [send,patch]=(await readFile(join(dir,'argv'),'utf8')).trim().split('\n').map(JSON.parse)
 assert.equal(send[send.indexOf('--msg-type')+1],'interactive');assert.deepEqual(JSON.parse(send[send.indexOf('--content')+1]),card)
 assert.deepEqual(patch.slice(0,3),['im','messages','patch']);assert.deepEqual(JSON.parse(JSON.parse(patch[patch.indexOf('--data')+1]).content),card)
})

test('event stream keeps stdin open, serializes callbacks, honors prefix, reconnects and stops',async t=>{
 const {dir,path}=await fakeCLI(t,`const fs=require('fs');const p=__dirname+'/count';const n=+(fs.existsSync(p)?fs.readFileSync(p):0)+1;fs.writeFileSync(p,''+n);fs.writeFileSync(__dirname+'/args',JSON.stringify(process.argv.slice(2)));if(n===1){process.exit(3)}process.stdin.resume();process.stderr.write('[event] ready event_key=card.action.trigger\\n');setTimeout(()=>{process.stdout.write('{"n":1}\\n{"n":2}\\n')},30);process.stdin.on('end',()=>process.exit(0));`)
 const events=[],states=[];let running=0,max=0
 const stop=startCardEvents({executable:process.execPath,argsPrefix:[path,'prefix'],reconnectBaseMs:10,onStatus:s=>states.push(s),onEvent:async e=>{running++;max=Math.max(max,running);await delay(10);events.push(e.n);running--}})
 await until(()=>events.length===2);assert.deepEqual(events,[1,2]);assert.equal(max,1);assert.ok(states.includes('ready'));assert.equal(JSON.parse(await readFile(join(dir,'args'),'utf8'))[0],'prefix')
 await stop();const count=await readFile(join(dir,'count'),'utf8');await delay(40);assert.equal(await readFile(join(dir,'count'),'utf8'),count)
})

test('event startup ENOENT retries and cleanup resolves without SIGKILL',async()=>{
 const states=[];const stop=startCardEvents({executable:'/nonexistent/card-cli',reconnectBaseMs:10,onStatus:s=>states.push(s),onEvent:()=>assert.fail('no events')})
 await until(()=>states.filter(s=>s==='starting').length>=2);await stop();assert.ok(states.includes('stopped'))
})
