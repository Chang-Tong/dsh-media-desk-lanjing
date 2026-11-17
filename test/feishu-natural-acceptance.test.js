import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import{join}from'node:path';import{tmpdir}from'node:os';
const base=process.env.WORKBENCH || fileURLToPath(new URL('..', import.meta.url));const{Store}=await import(base+'/src/store.js');const{createFeishuEditorial}=await import(base+'/src/feishu-editorial.js');
const real='我觉得你可以利用库存和网上的资料，去猜测他为什么传出这些资料，他是这么一个打法，为什么户均在 160 左右？他为什么要这么做？是补缺了什么空白吗？还是说现有的市场证明这样更有潜力、去化更快呢？\n\n朝着这个方向写一下。写完之后，把稿子和图发给我看看，如果没问题的话，你就帮我发布。';
const scenarios=[
[real,1],['按这个方向开始写',1],['先写一版给我看',1],
['这个角度挺好，我们再讨论一下',0],['好',0],['先不要开始创作',0],['如果数据齐了再开始创作',0],['他说“按这个方向开始写”，我还没决定',0],['现在开始创作吗？',0],['开始创作？先别写，我还有问题。',0],['先别开始创作。等我确认再写。',0],['请解释“开始创作”是什么意思',0]
];
let pass=0; const failed=[];
for(const [input,want]of scenarios){
 const root=await mkdtemp(join(tmpdir(),'lanjing-natural-accept-'));try{
 const store=new Store(root);await store.mutate('',s=>{s.items=[{id:'t',recordType:'topic',title:'酒仙桥0013-1',body:'研究规划',status:'outline'}];s.editorialWorkflow={feishu:{enabled:true,chatId:'oc_test',ownerId:'ou_test',since:'2026-11-14T00:00:00+08:00'}}});
 let starts=0;const messages=[];const sent=[];
 const ed=createFeishuEditorial({store,now:()=>new Date('2026-11-14T06:00:00Z'),producer:{start:async()=>{starts++;return true},isRunning:()=>false,status:()=>({running:false}),cancel(){}},callText:async()=>({text:JSON.stringify({reply:'收到',brief:'宸园143平已经卖光，存草稿并发布。'})}),transport:{readMessages:async()=>({messages,hasMore:false}),sendMessage:async m=>{sent.push(m);return 'sent_'+sent.length}}});
 await ed.propose({topicId:'t',brief:'以来源为准，160平方米是推测；先审稿，仅草稿逐次确认。'});
 messages.push({message_id:'m',chat_id:'oc_test',content:input,content_type:'plain',create_time:'2026-11-14 13:36',sender:{id:'ou_test',sender_type:'user'}});
 await ed.tick();assert.equal(starts,want,input);await ed.tick();assert.equal(starts,want,'重复不能再生成');
 const t=(await store.read()).items[0];assert.equal(t.browserApproval,undefined);if(want)assert.ok(!t.editorialBrief.includes('143平已经卖光'),'模型虚构事实不得进入生成简报');
 pass++;console.log('PASS',input.slice(0,35));
 }catch(e){failed.push(e.message); console.error("FAIL",e.message)}finally{await rm(root,{recursive:true,force:true})}
}
console.log('PASS cases',pass); assert.equal(failed.length,0,failed.join('\n'));
