import assert from 'node:assert/strict';

export function createNativeFileReader(){
  return async({bytes,mime,filename,question})=>{
    assert.equal(mime,'image/png');assert.equal(filename,'gif-contact-sheet.png');
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.match(question,/总帧数 40/);
    return {status:'partial',content:JSON.stringify({checkedFrameIndices:[0,39],verdict:'uncertain',conclusion:'离线 fixture 确认只审阅起止两张 PNG 样本帧。'})};
  };
}
