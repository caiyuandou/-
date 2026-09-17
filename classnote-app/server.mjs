import {saveAudio} from './audio-upload.mjs';
import {feishuClient} from './feishu.mjs';
import http from 'node:http';
import {readFileSync,writeFileSync,statSync,createReadStream} from 'node:fs';
import {join,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {storage,fail,str,parseTranscript,validateReport,validateStudentReport} from './core.mjs';
import {aiClient,protect,reportPrompt,studentPrompt} from './ai.mjs';
const ROOT=dirname(fileURLToPath(import.meta.url));
export function createApp({dataDir=process.env.CLASSNOTE_DATA_DIR||join(ROOT,'data'),fetchImpl=fetch}={}){
 const {db,get,list,put,config,safeConfig,saveConfig}=storage(dataDir);const {remote,ai}=aiClient(config,fetchImpl);const locks=new Set();const feishu=feishuClient(config,saveConfig,fetchImpl);
 const course=id=>{const c=get(id);if(!c||c.kind!=='course')fail('课程不存在',404);return c;};
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const body=async(req,limit=2*1024*1024)=>{let total=0;const parts=[];for await(const p of req){total+=p.length;if(total>limit)fail('文件过大，请压缩或分段后导入。',413);parts.push(p);}return Buffer.concat(parts);};
 const read=async req=>{try{return JSON.parse((await body(req)).toString());}catch(e){if(e.status)throw e;fail('请求格式不正确');}};
 const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 try{
 const host=req.headers.host||'';if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))return json(res,403,{error:'此版本仅允许本机访问。'});
 const path=new URL(req.url,'http://'+host).pathname;
 if(!['GET','HEAD'].includes(req.method)){if(req.headers.origin&&req.headers.origin!=='http://'+host)return json(res,403,{error:'请求来源不受信任'});if(req.headers['x-classnote-request']!=='1')return json(res,403,{error:'请求校验失败'});}
 if(path==='/api/bootstrap'&&req.method==='GET')return json(res,200,{courses:list('course').map(c=>({id:c.id,title:c.title,subject:c.subject,level:c.level,archived:c.archived,createdAt:c.createdAt,updatedAt:c.updatedAt,hasAudio:!!c.audio,hasReport:!!c.report,hasTranscript:!!c.transcript,questions:c.report?.questions.length||0})),tasks:list('task'),attempts:list('attempt').map(a=>({courseId:a.courseId,questionId:a.questionId,correct:a.correct,createdAt:a.createdAt})),settings:safeConfig()});
 if(path==='/api/feishu/settings'&&req.method==='PUT'){
  const b=await read(req),appId=str(b.appId,100),secret=str(b.secret,1000);if(!/^cli_[a-zA-Z0-9]+$/.test(appId))fail('App ID 格式不正确');
  let folder=str(b.folder,1000);if(folder.startsWith('https://')){try{const u=new URL(folder);if(!u.hostname.endsWith('.feishu.cn'))fail('请使用飞书云空间文件夹链接');folder=u.pathname.match(/\/folder\/([a-zA-Z0-9]+)/)?.[1]||'';}catch{fail('文件夹链接不正确');}}
  if(folder&&!/^[a-zA-Z0-9]+$/.test(folder))fail('请填写文件夹链接或文件夹 token');
  if(appId!==config.feishuAppId||secret&&secret!==config.feishuSecret)feishu.disconnect();
  config.feishuAppId=appId;config.feishuFolder=folder;if(secret)config.feishuSecret=secret;saveConfig();return json(res,200,safeConfig());
 }
 if(path==='/api/feishu/connect'&&req.method==='POST'){const a=feishu.begin('http://'+host);res.setHeader('Set-Cookie','classnote_oauth='+a.cookie+'; HttpOnly; SameSite=Lax; Path=/api/feishu; Max-Age=600');return json(res,200,{url:a.url});}
 if(path==='/api/feishu/disconnect'&&req.method==='POST'){feishu.disconnect();return json(res,200,{ok:true});}
 if(path==='/api/feishu/callback'&&req.method==='GET'){
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('classnote_oauth='))?.slice('classnote_oauth='.length);
  await feishu.callback(new URL(req.url,'http://'+host).searchParams,cookie);
  res.writeHead(303,{'Location':'/#settings','Cache-Control':'no-store','Set-Cookie':'classnote_oauth=; HttpOnly; SameSite=Lax; Path=/api/feishu; Max-Age=0'});return res.end();
 }
 if(path==='/api/settings'&&req.method==='GET')return json(res,200,safeConfig());
 if(path==='/api/settings'&&req.method==='PUT'){const b=await read(req);config.model=str(b.model,100)||config.model;config.asrModel=str(b.asrModel,120)||config.asrModel;for(const k of ['deepseekKey','asrKey'])if(str(b[k],1000))config[k]=str(b[k],1000);if(b.clearDeepseek)config.deepseekKey='';if(b.clearAsr)config.asrKey='';saveConfig();return json(res,200,safeConfig());}
 if(path==='/api/settings/test'&&req.method==='POST'){const reply=await ai('请只回复“连接成功”。',{message:'连接测试'},false);return json(res,200,{message:'DeepSeek 已连接',reply:reply.slice(0,100)});}
 if(path==='/api/courses'&&req.method==='POST'){const b=await read(req);if(!str(b.title,120))fail('请填写课程名称');return json(res,201,put('course',{id:randomUUID(),kind:'course',title:str(b.title,120),subject:str(b.subject,30)||'其他',level:str(b.level,30)||'高中',focus:str(b.focus,1000),transcript:'',segments:[],notes:'',report:null,chat:[],cards:{},archived:false,createdAt:Date.now(),updatedAt:Date.now(),revision:0}));}
 if(path==='/api/mistakes'&&req.method==='GET'){const latest=new Map();for(const a of list('attempt').sort((a,b)=>a.createdAt-b.createdAt))latest.set(a.questionId,a);const out=[];for(const a of latest.values()){if(a.correct)continue;const c=get(a.courseId);if(!c||c.archived)continue;const q=c.report?.questions.find(q=>q.id===a.questionId);if(q)out.push({...a,question:q,courseTitle:c.title});}return json(res,200,out);}
 if(path==='/api/tasks'&&req.method==='POST'){const b=await read(req);if(!str(b.title,200))fail('请填写任务');if(!/^\d{4}-\d{2}-\d{2}$/.test(b.date||'')||Number.isNaN(Date.parse(b.date)))fail('请选择日期');if(b.courseId)course(b.courseId);return json(res,201,put('task',{id:randomUUID(),kind:'task',title:str(b.title,200),courseId:b.courseId||null,date:b.date,minutes:Math.min(120,Math.max(5,Number(b.minutes)||20)),done:false,createdAt:Date.now()}));}
 const tm=path.match(/^\/api\/tasks\/([\w-]+)$/);if(tm&&req.method==='PATCH'){const t=get(tm[1]);if(!t||t.kind!=='task')fail('任务不存在',404);const b=await read(req);if(typeof b.done!=='boolean')fail('任务状态无效');t.done=b.done;t.completedAt=b.done?Date.now():null;return json(res,200,put('task',t));}
 const m=path.match(/^\/api\/courses\/([\w-]+)(?:\/([\w-]+))?$/);
 if(m){
 const c=course(m[1]),action=m[2];
 if(['feishu-start','feishu-sync'].includes(action)&&req.method==='POST'){
  if(locks.has(c.id))fail('此课程正在处理中，请稍后重试。',409);locks.add(c.id);
  try{
   if(action==='feishu-start'){
    if(!c.audio)fail('请先上传课堂录音');
    if(c.feishu?.audioName===c.audio.name&&c.feishu.minuteToken)return json(res,200,c);
    if(c.feishu?.audioName!==c.audio.name)c.feishu={audioName:c.audio.name};
    if(c.feishu.status==='uncertain')fail('上次生成请求未得到确认。请先到飞书妙记查看，避免重复生成。');
    if(!c.feishu.fileToken){c.feishu.fileToken=await feishu.upload(join(dataDir,'audio',c.audio.name),c.audio.filename);put('course',c);}
    c.feishu.status='uncertain';put('course',c);
    try{Object.assign(c.feishu,await feishu.generate(c.feishu.fileToken),{status:'processing'});}catch(e){if(e.feishuCode===99991679){c.feishu.status='authorization_required';put('course',c);}throw e;}c.updatedAt=Date.now();put('course',c);return json(res,200,c);
   }
   if(!c.feishu?.minuteToken)fail('请先生成飞书记录');
   if(c.feishu.audioName!==c.audio?.name)fail('录音已经更换，请为新录音生成记录。');

   const result=await feishu.result(c.feishu.minuteToken);
   if(result.ready){if(result.transcript.length>60000)fail('转写文字超过本版 60000 字限制，请在飞书中查看或分段导入。');const firstImport=!c.feishu.importedAt&&c.feishu.status!=='ready';c.feishu.result=result;c.feishu.status='ready';c.feishu.importedAt=c.feishu.importedAt||Date.now();c.feishu.phase=result.summary.trim()?'complete':'summarizing';c.feishu.lastError='';c.feishu.syncedAt=Date.now();if(firstImport){c.transcript=result.transcript;c.segments=parseTranscript(c.transcript);c.report=null;c.chat=[];c.cards={};c.revision++;}c.updatedAt=Date.now();put('course',c);}
   return json(res,200,c);
  }catch(e){if(c.feishu){c.feishu.lastError=e.message;c.feishu.errorAt=Date.now();put('course',c);}throw e;}finally{locks.delete(c.id);}
 }
 if(!action&&req.method==='GET')return json(res,200,c);
 if(!action&&req.method==='PUT'){if(locks.has(c.id))fail('课程正在处理，请稍后编辑。',409);const b=await read(req);for(const k of ['title','subject','level','focus','notes'])if(typeof b[k]==='string')c[k]=str(b[k],k==='notes'?50000:k==='focus'?1000:120);if(!c.title)fail('课程名称不能为空');if(typeof b.archived==='boolean')c.archived=b.archived;if(typeof b.transcript==='string'&&b.transcript!==c.transcript){if(b.transcript.length>60000)fail('课堂文字最多60000字，请拆成多节。');c.transcript=b.transcript.trim();c.segments=parseTranscript(c.transcript);c.report=null;c.chat=[];c.cards={};c.revision++;}c.updatedAt=Date.now();return json(res,200,put('course',c));}


 if(action==='audio'&&req.method==='POST'){if(locks.has(c.id))fail('课程正在处理。',409);const filename=decodeURIComponent(req.headers['x-filename']||''),ext=extname(filename).toLowerCase();if(!['.mp3','.wav','.m4a','.ogg','.webm','.flac'].includes(ext))fail('音频格式不支持');locks.add(c.id);try{const name=randomUUID()+ext;const size=await saveAudio(req,join(dataDir,'audio',name));c.audio={name,filename:str(filename,250),size};c.updatedAt=Date.now();put('course',c);return json(res,200,c);}finally{locks.delete(c.id);}}
 if(action==='audio'&&req.method==='GET'){if(!c.audio)fail('没有录音',404);const f=join(dataDir,'audio',c.audio.name),size=statSync(f).size;const types={'.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.webm':'audio/webm','.flac':'audio/flac'};const headers={'Content-Type':types[extname(f)],'Accept-Ranges':'bytes','Cache-Control':'private, no-store'};const range=req.headers.range;if(range){const x=range.match(/^bytes=(\d*)-(\d*)$/);if(!x||(!x[1]&&!x[2])){res.writeHead(416,{'Content-Range':'bytes */'+size});return res.end();}const start=x[1]?Number(x[1]):Math.max(0,size-Number(x[2])),end=x[1]?(x[2]?Math.min(size-1,Number(x[2])):size-1):size-1;if(start>=size||end<start){res.writeHead(416,{'Content-Range':'bytes */'+size});return res.end();}res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':'bytes '+start+'-'+end+'/'+size});createReadStream(f,{start,end}).pipe(res);return;}res.writeHead(200,{...headers,'Content-Length':size});createReadStream(f).pipe(res);return;}
 if(['transcribe','generate','ask'].includes(action)&&req.method==='POST'){
 if(locks.has(c.id))fail('此课程已有任务处理中。',409);
 if(action==='transcribe'&&!config.asrKey)fail('请配置语音识别服务，或直接导入课堂文字。DeepSeek 负责文字分析。',503);
 if(action==='transcribe'&&!c.audio)fail('请先导入录音');
 if(action!=='transcribe'&&!c.segments.length)fail('请先保存课堂文字或转写录音。');
 locks.add(c.id);try{
 if(action==='transcribe'){if(c.audio.size>50*1024*1024)fail('此语音识别服务最多支持 50 MB，请改用飞书课堂记录，或压缩、分段后转写。',413);const form=new FormData();form.append('file',new Blob([readFileSync(join(dataDir,'audio',c.audio.name))]),c.audio.filename);form.append('model',config.asrModel);const r=await remote('https://api.siliconflow.cn/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+config.asrKey},body:form},'语音识别');if(typeof r.text!=='string'||!r.text.trim())fail('未识别到有效语音。',502);if(r.text.length>60000)fail('转写过长，请拆分音频。',502);c.transcript=r.text;c.segments=parseTranscript(r.text);c.report=null;c.chat=[];c.cards={};c.revision++;c.updatedAt=Date.now();put('course',c);return json(res,200,c);}
 if(action==='generate'){const r=await ai(studentPrompt,{title:c.title,subject:c.subject,level:c.level,focus:c.focus,segments:c.segments.map((segment,index)=>({index,...segment}))});validateReport(r,c.segments.length);validateStudentReport(r,c.segments);r.studentVersion=1;r.questions=r.questions.map(q=>({...q,id:randomUUID()}));r.cards=r.cards.map(q=>({...q,id:randomUUID()}));r.generatedAt=Date.now();c.report=r;c.cards={};c.updatedAt=Date.now();put('course',c);return json(res,200,c);}
 const b=await read(req);if(!str(b.question,1000))fail('请填写问题');const a=await ai(protect+' JSON格式为 {"answer":"解释","sources":[0]}，只引用支持回答的片段。',{question:str(b.question,1000),segments:c.segments,history:c.chat.slice(-6).map(x=>({question:x.question,answer:x.answer}))});if(typeof a.answer!=='string'||!Array.isArray(a.sources)||a.sources.some(i=>!Number.isInteger(i)||!c.segments[i]))fail('回答引用格式异常。',502);c.chat.push({id:randomUUID(),question:str(b.question,1000),answer:a.answer,sources:a.sources,createdAt:Date.now()});c.chat=c.chat.slice(-40);put('course',c);return json(res,200,c);
 }finally{locks.delete(c.id);}}
 if(action==='answer'&&req.method==='POST'){const b=await read(req),q=c.report?.questions.find(q=>q.id===b.questionId);if(!q||!Number.isInteger(b.choice)||b.choice<0||b.choice>3)fail('题目或答案无效');return json(res,200,put('attempt',{id:randomUUID(),kind:'attempt',courseId:c.id,questionId:q.id,choice:b.choice,correct:q.answer===b.choice,createdAt:Date.now()}));}
 if(action==='card'&&req.method==='POST'){const b=await read(req);if(!c.report?.cards.some(q=>q.id===b.cardId))fail('卡片不存在');if(typeof b.known!=='boolean')fail('状态无效');c.cards[b.cardId]={known:b.known,at:Date.now()};put('course',c);return json(res,200,c.cards);}
 }
 if(path.startsWith('/api/'))return json(res,404,{error:'接口不存在'});
 if(req.method!=='GET')return json(res,405,{error:'操作不支持'});
 const name=({'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/icon.svg':'icon.svg'})[path];if(!name)return json(res,404,{error:'页面不存在'});
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
 res.writeHead(200,{'Content-Type':mime[extname(name)],'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});res.end(readFileSync(join(ROOT,'public',name)));
 }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'处理失败，请稍后重试。'});else res.end();}
 });
 return {server,close:()=>db.close()};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const app=createApp();app.server.listen(Number(process.env.PORT)||4321,'127.0.0.1',()=>console.log('听课本已启动：http://127.0.0.1:'+(process.env.PORT||4321)));}

