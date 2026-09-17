import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTranscript} from '../core.mjs';
test('飞书说话人时间支持毫秒、连续段落与原有字幕格式',()=>{
 const s=parseTranscript('Speaker 1 00:06:20.730\n定义域和对应法则。\n值域随之确定。\nSpeaker 2 00:08:17.000 接下来看例题');
 assert.equal(s[0].start,380.73);assert.equal(s[1].start,380.73);assert.equal(s[2].start,497);
 assert.equal(parseTranscript('[00:12] 原文')[0].start,12);
 assert.equal(parseTranscript('1\n00:00:12,500 --> 00:00:15,000\n字幕')[0].start,12.5);
 assert.equal(parseTranscript('普通文字')[0].start,null);
});
