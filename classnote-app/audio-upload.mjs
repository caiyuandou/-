import {open,unlink} from 'node:fs/promises';
import {fail} from './core.mjs';
export const MAX_AUDIO_BYTES=200*1024*1024;
export async function saveAudio(stream,path,limit=MAX_AUDIO_BYTES){
 if(Number(stream.headers?.['content-length'])>limit)fail('音频不能超过 200 MB。',413);
 const file=await open(path,'wx');let size=0,complete=false;
 try{for await(const chunk of stream){size+=chunk.length;if(size>limit)fail('音频不能超过 200 MB。',413);await file.writeFile(chunk);}if(!size)fail('音频为空');complete=true;return size;}
 finally{await file.close();if(!complete)await unlink(path).catch(()=>{});}
}
