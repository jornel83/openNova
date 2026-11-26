/** Test transport: only a staged PNG is allowed to reach the internal reader. */
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export function createNativeFileReader(){
  return async({bytes,mime,filename,question})=>{
    assert.equal(mime,'image/png');assert.equal(filename,'gif-contact-sheet.png');
    assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');
    assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[960,792]);
    const source=question.match(/总帧数 (\d+)；检查页仅包含索引 ([\d、]+)。/u);
    assert.ok(source);assert.match(question,/伍宝的手势/);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    appendFileSync(process.env.OPENNOVA_GIF_REVIEW_TRACE,sha256+'\n');
    return {status:'partial',content:JSON.stringify({checkedFrameIndices:[0,Number(source[1])-1],verdict:'uncertain',conclusion:'测试传输仅确认首尾两帧。'}),limitation:'其他帧未确认。'};
  };
}
