import {toSpeechText} from '../../agent/speech-text.mjs';
export function projectResearchReply({text,requestId,sources,research}){
 const selected=sources.forReply(requestId,text).map(s=>({...s,...s.excerpt?{excerpt:s.excerpt.slice(0,800)}:{}}));
 const speech=toSpeechText(text.replace(/\[([^\]\n]*)\]\((?!https?:)[^\n)]*\)/g,'$1'));
 const speechText=speech.length>600?speech.slice(0,560)+'。完整结果已保留在文字界面。':speech;
 return {text,speechText,sources:selected,...research?{research:{...research,phase:'finished'}}:{}};
}
