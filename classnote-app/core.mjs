import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
export const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const str=(x,max=1000)=>typeof x==='string'?x.trim().slice(0,max):'';
export function parseTranscript(text){
 const segments=[];let pending=null,speakerTime=null;const sec=t=>t.replace(',','.').split(':').reduce((a,x)=>a*60+Number(x),0);
 const lines=text.replace(/\r/g,'').split('\n').filter(x=>x.trim());for(let lineIndex=0;lineIndex<lines.length;lineIndex++){const l=lines[lineIndex];if((/^\d+$/.test(l.trim())&&lines[lineIndex+1]?.includes('-->'))||l.trim()==='WEBVTT')continue;const speaker=l.match(/^(?:Speaker\s+\d+|说话人\s*\d+)\s+(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*(.*)$/i);if(speaker){pending=sec(speaker[1]);speakerTime=pending;if(speaker[2].trim())segments.push({start:pending,text:speaker[2].trim()});continue;}const t=l.match(/(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*-->/);if(t){speakerTime=null;pending=sec(t[1]);continue;}const i=l.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(.+)/);if(i){speakerTime=null;segments.push({start:sec(i[1]),text:i[2]});pending=null;}else{for(const p of l.match(/[\s\S]{1,600}/g)||[])segments.push({start:pending??speakerTime,text:p.trim()});pending=null;}}
 return segments;
}
export function validateReport(r,n){
 if(!r||typeof r.summary!=='string'||!r.summary.trim())fail('模型没有返回课程摘要，请重试。',502);
 for(const [field,keys]of Object.entries({outline:['title','detail'],terms:['term','explanation'],questions:['question','explanation'],cards:['front','back']})){
 if(!Array.isArray(r[field])||r[field].length>30)fail('模型报告格式不完整，请重试。',502);
 for(const item of r[field]){if(keys.some(k=>typeof item[k]!=='string'||!item[k].trim())||!Number.isInteger(item.source)||item.source<0||item.source>=n)fail('报告中存在无效原文引用，请重试。',502);
 if(field==='questions'&&(!Array.isArray(item.options)||item.options.length!==4||item.options.some(x=>typeof x!=='string')||!Number.isInteger(item.answer)||item.answer<0||item.answer>3))fail('练习题格式不正确，请重试。',502);}}
 if(!Array.isArray(r.pitfalls)||r.pitfalls.some(x=>typeof x!=='string')||!Array.isArray(r.review)||r.review.some(x=>typeof x.title!=='string'||!Number.isInteger(x.minutes)||x.minutes<1||x.minutes>120))fail('复习建议格式不正确，请重试。',502);return r;
}
export function storage(dir){
 mkdirSync(join(dir,'audio'),{recursive:true});const db=new DatabaseSync(join(dir,'classnote.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY,type TEXT,body TEXT);CREATE TABLE IF NOT EXISTS config (id TEXT PRIMARY KEY,body TEXT)');
 const get=id=>{const r=db.prepare('SELECT body FROM docs WHERE id=?').get(id);return r?JSON.parse(r.body):null;};
 const list=type=>db.prepare('SELECT body FROM docs WHERE type=?').all(type).map(r=>JSON.parse(r.body));
 const put=(type,o)=>{db.prepare('INSERT OR REPLACE INTO docs VALUES (?,?,?)').run(o.id,type,JSON.stringify(o));return o;};
 const keyPath=join(dir,'.key');if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600});const master=readFileSync(keyPath);
 const encrypt=v=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',master,iv);const data=Buffer.concat([c.update(v,'utf8'),c.final()]);return{iv:iv.toString('base64'),data:data.toString('base64'),tag:c.getAuthTag().toString('base64')};};
 const decrypt=v=>{try{const d=createDecipheriv('aes-256-gcm',master,Buffer.from(v.iv,'base64'));d.setAuthTag(Buffer.from(v.tag,'base64'));return Buffer.concat([d.update(Buffer.from(v.data,'base64')),d.final()]).toString();}catch{return '';}};
 const secretFields=['deepseekKey','asrKey','feishuSecret','feishuAccess','feishuRefresh'];
 let config={feishuAppId:'cli_aa20261fbff95bb5',feishuFolder:'',feishuSecret:'',feishuAccess:'',feishuRefresh:'',feishuExpires:0,model:'deepseek-flash',asrModel:'FunAudioLLM/SenseVoiceSmall',deepseekKey:'',asrKey:''};
 const saved=db.prepare("SELECT body FROM config WHERE id='settings'").get();if(saved){const x=JSON.parse(saved.body);config={...config,...x};for(const k of secretFields)config[k]=x[k]?decrypt(x[k]):'';}
 config.deepseekKey=process.env.DEEPSEEK_API_KEY||config.deepseekKey;config.asrKey=process.env.SILICONFLOW_API_KEY||config.asrKey;
 const safeConfig=()=>({model:config.model,asrModel:config.asrModel,deepseekConfigured:!!config.deepseekKey,asrConfigured:!!config.asrKey,feishuAppId:config.feishuAppId,feishuFolder:config.feishuFolder,feishuConfigured:!!config.feishuSecret,feishuConnected:!!config.feishuAccess&&(Date.now()<config.feishuExpires||!!config.feishuRefresh)});
 const saveConfig=()=>{const out={...config};for(const k of secretFields)out[k]=encrypt(config[k]||'');db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run('settings',JSON.stringify(out));};
 return{db,get,list,put,config,safeConfig,saveConfig};
}


export function validateStudentReport(r,segments){
 for(const key of ['objectives','examples','quotes','checks']){if(r[key]===undefined)r[key]=[];if(!Array.isArray(r[key])||r[key].length>10)fail('学生报告格式异常，请重试。',502);for(const item of r[key]){if(!item||!Number.isInteger(item.source)||!segments[item.source])fail('学生报告原文引用无效，请重试。',502);const fields=key==='quotes'?['text']:key==='examples'?['title','problem','conclusion']:['title'];if(fields.some(k=>typeof item[k]!=='string'||!item[k].trim()))fail('学生报告内容不完整，请重试。',502);if(key==='examples'&&(!Array.isArray(item.steps)||!item.steps.length||item.steps.length>10||item.steps.some(v=>typeof v!=='string'||!v.trim())))fail('例题步骤格式异常，请重试。',502);if(key==='quotes'&&!segments[item.source].text.includes(item.text))fail('老师原话与课堂原文不一致，请重试。',502);}}
 return r;
}
