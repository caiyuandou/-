import {randomBytes} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {fail} from './core.mjs';

const API='https://open.feishu.cn/open-apis';
export function feishuClient(config,save,fetchImpl=fetch){
 const pending=new Map();let refreshing;
 const credentials=()=>{if(!config.feishuAppId||!config.feishuSecret)fail('请先保存飞书 App ID 和 App Secret。');};
 async function request(path,options={}){
  let r;try{r=await fetchImpl(API+path,{...options,signal:AbortSignal.timeout(120000),redirect:'error'});}catch{fail('飞书连接失败或超时，请稍后重试。',502);}
  let b;try{b=await r.json();}catch{fail('飞书返回了无法识别的结果。',502);}
  if(b.code===99991679){const scopes=(b.error?.permission_violations||[]).map(v=>v.subject).filter(v=>typeof v==='string'&&/^[a-zA-Z0-9_:.-]+$/.test(v));throw Object.assign(new Error('飞书缺少用户授权：'+(scopes.join('、')||'所需接口权限')+'。请在飞书后台开通对应用户身份权限并发布，再回设置页重新连接飞书。'),{status:502,feishuCode:b.code});}
  if(!r.ok||b.code||b.error){const detail=String(b.msg||b.error_description||'');if(/quota|credit|balance|额度|余额/i.test(detail))throw Object.assign(new Error('飞书服务额度不足，请到飞书确认转写或智能纪要权益后重试。'),{status:502,feishuCode:b.code});if(r.status===401)throw Object.assign(new Error('飞书授权失效，请到设置页重新授权。'),{status:401,feishuCode:b.code});const e=Object.assign(new Error('飞书请求失败（'+(b.code||r.status)+'）。请在飞书查看该记录或稍后重试；错误码可用于排查。'),{status:502,feishuCode:b.code});throw e;}
  return b.data??b;
 }
 async function tokenRequest(body){
  credentials();const b=await request('/authen/v2/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:config.feishuAppId,client_secret:config.feishuSecret,...body})});
  if(!b.access_token)fail('飞书未返回用户访问凭证，请重新授权。',502);
  config.feishuAccess=b.access_token;config.feishuRefresh=b.refresh_token||'';config.feishuExpires=Date.now()+(Number(b.expires_in)||7200)*1000;save();return b.access_token;
 }
 async function token(){
  if(config.feishuAccess&&Date.now()<config.feishuExpires-60000)return config.feishuAccess;
  if(!config.feishuRefresh)fail('请先在设置页连接飞书，或重新登录授权。',401);
  if(!refreshing)refreshing=tokenRequest({grant_type:'refresh_token',refresh_token:config.feishuRefresh}).finally(()=>refreshing=null);
  return refreshing;
 }
 async function call(path,options={}){return request(path,{...options,headers:{...options.headers,Authorization:'Bearer '+await token()}});}
 const post=(path,b)=>call(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
 function begin(origin){
  credentials();const state=randomBytes(32).toString('hex'),cookie=randomBytes(32).toString('hex');
  for(const [k,v]of pending)if(v.expires<Date.now())pending.delete(k);
  if(pending.size>20)fail('登录请求过多，请稍后重试。');
  const redirect=origin+'/api/feishu/callback';pending.set(state,{cookie,redirect,expires:Date.now()+600000});
  const url=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  // Request the user permissions required for upload, conversion, and results.
  url.search=new URLSearchParams({client_id:config.feishuAppId,response_type:'code',redirect_uri:redirect,state,scope:'drive:file:upload minutes:minutes.upload:write minutes:minutes.artifacts:read'}).toString();
  return{url:url.href,cookie};
 }
 async function callback(params,cookie){
  const state=params.get('state'),entry=pending.get(state);
  if(!entry||entry.expires<Date.now()||entry.cookie!==cookie)fail('登录校验失效，请从听课本设置页重新连接飞书。',403);
  pending.delete(state);if(params.get('error')||!params.get('code'))fail('飞书授权未完成，请返回设置页重试。');
  await tokenRequest({grant_type:'authorization_code',code:params.get('code'),redirect_uri:entry.redirect});
 }
 function disconnect(){pending.clear();config.feishuAccess='';config.feishuRefresh='';config.feishuExpires=0;save();}
 async function upload(path,filename){
  if(!config.feishuFolder)fail('请先在设置中填写飞书录音文件夹链接。');
  const size=statSync(path).size;const fields={file_name:filename,parent_type:'explorer',parent_node:config.feishuFolder,size};
  if(size<=20*1024*1024){const bytes=readFileSync(path);const form=new FormData();for(const[k,v]of Object.entries(fields))form.append(k,String(v));form.append('file',new Blob([bytes]),filename);const b=await call('/drive/v1/files/upload_all',{method:'POST',body:form});if(!b.file_token)fail('上传成功但未返回文件编号。',502);return b.file_token;}
  const p=await post('/drive/v1/files/upload_prepare',fields);
  if(!p.upload_id||!Number.isInteger(p.block_size)||p.block_size<=0||p.block_num!==Math.ceil(size/p.block_size))fail('飞书分片上传参数异常。',502);
  const file=await open(path,'r');try{for(let seq=0;seq<p.block_num;seq++){const chunk=Buffer.alloc(Math.min(p.block_size,size-seq*p.block_size));let offset=0;while(offset<chunk.length){const {bytesRead}=await file.read(chunk,offset,chunk.length-offset,seq*p.block_size+offset);if(!bytesRead)fail('录音文件读取不完整，请重新导入。');offset+=bytesRead;}const form=new FormData();form.append('upload_id',p.upload_id);form.append('seq',String(seq));form.append('size',String(chunk.length));form.append('file',new Blob([chunk]),filename);await call('/drive/v1/files/upload_part',{method:'POST',body:form});}}finally{await file.close();}
  const b=await post('/drive/v1/files/upload_finish',{upload_id:p.upload_id,block_num:p.block_num});if(!b.file_token)fail('飞书没有返回上传文件编号。',502);return b.file_token;
 }
 async function generate(fileToken){const b=await post('/minutes/v1/minutes/upload',{file_token:fileToken});let url;try{url=new URL(b.minute_url);}catch{fail('飞书未返回有效妙记链接。请到飞书检查生成状态，避免重复提交。',502);}if(url.protocol!=='https:'||!url.hostname.endsWith('.feishu.cn'))fail('飞书返回的妙记链接无效。',502);const id=url.pathname.match(/\/minutes\/([a-zA-Z0-9]+)\/?$/)?.[1];if(!id)fail('妙记编号格式异常。',502);return{minuteToken:id,url:url.href};}
 async function result(id){if(!/^[a-zA-Z0-9]+$/.test(id))fail('妙记编号无效');try{const b=await call('/minutes/v1/minutes/'+id+'/artifacts');return{ready:typeof b.transcript==='string'&&!!b.transcript.trim(),summary:typeof b.summary==='string'?b.summary:'',transcript:typeof b.transcript==='string'?b.transcript:'',chapters:Array.isArray(b.minute_chapters)?b.minute_chapters:[],todos:Array.isArray(b.minute_todos)?b.minute_todos:[],keywords:Array.isArray(b.keywords)?b.keywords:[]};}catch(e){if(e.feishuCode===2091003)return{ready:false};throw e;}}
 return{begin,callback,disconnect,upload,generate,result};
}
