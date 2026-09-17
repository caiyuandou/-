import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';
const base=fileURLToPath(new URL('../.test-data/',import.meta.url));
test('飞书授权绑定浏览器、拒绝重放、分片上传、等待产物和凭证保护',async()=>{
 const dir=mkdtempSync(join(base,'feishu-'));let uploads=0,generates=0,ready=false,parts=0,tokenCalls=0;
 const reply=x=>new Response(JSON.stringify({code:0,data:x}));
 const mock=async(url,o)=>{
  if(url.endsWith('/oauth/token')){tokenCalls++;const b=JSON.parse(o.body);assert.equal(b.client_secret,'fake-secret-for-test');assert.equal(b.grant_type,'authorization_code');return new Response(JSON.stringify({code:0,access_token:'fake-access',refresh_token:'fake-refresh',expires_in:7200}));}
  assert.equal(o.headers.Authorization,'Bearer fake-access');
  if(url.endsWith('/upload_prepare')){uploads++;const b=JSON.parse(o.body);assert.equal(b.parent_node,'folder123');return reply({upload_id:'up1',block_size:4*1024*1024,block_num:6});}
  if(url.endsWith('/upload_part')){assert.equal(Number(o.body.get('seq')),parts++);return reply({});}
  if(url.endsWith('/upload_finish'))return reply({file_token:'file123'});
  if(url.endsWith('/minutes/upload')){generates++;assert.equal(JSON.parse(o.body).file_token,'file123');return reply({minute_url:'https://test.feishu.cn/minutes/minute123'});}
  if(url.endsWith('/artifacts'))return ready?reply({transcript:'[00:12] 牛顿第二定律',summary:'力与加速度的关系',minute_chapters:[],minute_todos:[]}):new Response(JSON.stringify({code:2091003}));
  throw Error('Unexpected '+url);
 };
 const app=createApp({dataDir:dir,fetchImpl:mock});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.server.address().port;
 const req=async(p,method='GET',data)=>{const r=await fetch(origin+'/api'+p,{method,headers:{'X-Classnote-Request':'1','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {r,b:await r.json()};};
 try{
  assert.equal((await req('/feishu/connect','POST',{})).r.status,400);
  await req('/feishu/settings','PUT',{appId:'cli_test',secret:'fake-secret-for-test',folder:'https://test.feishu.cn/drive/folder/folder123'});
  const start=await req('/feishu/connect','POST',{});const u=new URL(start.b.url),cookie=start.r.headers.get('set-cookie').split(';')[0];const callback=origin+'/api/feishu/callback?state='+u.searchParams.get('state')+'&code=test-code';
  assert.equal((await fetch(callback)).status,403);assert.equal(tokenCalls,0);
  assert.equal((await fetch(callback,{headers:{Cookie:cookie},redirect:'manual'})).status,303);
  assert.equal((await fetch(callback,{headers:{Cookie:cookie},redirect:'manual'})).status,403);
  const settings=await req('/settings');assert.equal(settings.b.feishuConnected,true);assert.ok(!JSON.stringify(settings.b).includes('fake-'));
  const c=(await req('/courses','POST',{title:'物理'})).b;
  await req('/courses/'+c.id,'PUT',{notes:'自己的笔记',transcript:'旧原文'});
  const upload=await fetch(origin+'/api/courses/'+c.id+'/audio',{method:'POST',headers:{'X-Classnote-Request':'1','X-Filename':'lesson.mp3'},body:Buffer.alloc(21*1024*1024)});assert.equal(upload.status,200);
  assert.equal((await req('/courses/'+c.id+'/feishu-start','POST',{})).r.status,200);
  await req('/courses/'+c.id+'/feishu-start','POST',{});assert.equal(generates,1);assert.equal(uploads,1);assert.equal(parts,6);
  const pending=await req('/courses/'+c.id+'/feishu-sync','POST',{});assert.equal(pending.b.transcript,'旧原文');assert.equal(pending.b.feishu.status,'processing');
  ready=true;const done=(await req('/courses/'+c.id+'/feishu-sync','POST',{})).b;assert.equal(done.transcript,'[00:12] 牛顿第二定律');assert.equal(done.segments[0].start,12);assert.equal(done.notes,'自己的笔记');assert.equal(done.feishu.result.summary,'力与加速度的关系');
  await req('/courses/'+c.id,'PUT',{transcript:'人工校对后的课堂原文',notes:'保留我的笔记'});
  const again=(await req('/courses/'+c.id+'/feishu-sync','POST',{})).b;assert.equal(again.transcript,'人工校对后的课堂原文');assert.equal(again.notes,'保留我的笔记');assert.equal(again.feishu.phase,'complete');
  await req('/feishu/disconnect','POST',{});assert.equal((await req('/settings')).b.feishuConnected,false);
  assert.ok(!readFileSync(join(dir,'classnote.sqlite')).includes(Buffer.from('fake-secret-for-test')));
 }finally{await new Promise(r=>app.server.close(r));app.close();}
});
