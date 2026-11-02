import {toSpeechText} from '../agent/speech-text.mjs';

/** The same projection is used for live prefixes and the authoritative result. */
export function replySpeechText(text) {
  const speech=toSpeechText(text.replace(/```[\s\S]*?```/g,'').replace(/\[([^\]\n]*)\]\((?!https?:)[^\n)]*\)/g,'$1'));
  return speech.length>600?speech.slice(0,560)+'。完整结果已保留在文字界面。':speech;
}

/** Hold incomplete Markdown/URLs and speak only stable sentence or clause boundaries. */
export function replySpeechPrefix(text) {
  let safe=0;
  for(let i=0;i<text.length;i++){
    if(text.startsWith('```',i)){
      const end=text.indexOf('```',i+3);if(end<0)break;i=end+2;continue;
    }
    if(text[i]==='`'){
      const end=text.indexOf('`',i+1);if(end<0)break;i=end;continue;
    }
    if(text[i]==='['){
      const end=text.indexOf(']',i+1);if(end<0||end===text.length-1)break;
      i=end;
      if(text[i+1]==='('){
        let depth=1,j=i+2;for(;j<text.length&&depth;j++){if(text[j]==='(')depth++;else if(text[j]===')')depth--;}
        if(depth)break;i=j-1;
      }
      continue;
    }
    if(/^https?:\/\//.test(text.slice(i))){
      const end=text.slice(i).search(/[\s<>\[\]，。！？；、）"']/);if(end<0)break;i+=end-1;continue;
    }
    if(/[。！？；!?;\n]/.test(text[i]) || (text[i]==='.'&&/\s/.test(text[i+1]??'')) ||
      (i-safe>=80&&/[，,]/.test(text[i])))safe=i+1;
  }
  // The last 40 characters remain undecided until the existing 600-char summary
  // rule can be evaluated. Emitted prefixes can therefore never be retracted.
  return replySpeechText(text.slice(0,safe)).slice(0,560).replace(/[\uD800-\uDBFF]$/,'');
}
