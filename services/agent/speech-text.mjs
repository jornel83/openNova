/** Display and speech are separate projections; URLs and citations are not spoken. */
import {mapWebLinks} from './web-links.mjs';
export function toSpeechText(text) {
  const markdown=label=>{
    if(/^https?:\/\//.test(label)){try{return new URL(label).hostname;}catch{return '';}}
    return mapWebLinks(label,{bare:()=> ' '});
  };
  return mapWebLinks(text.replace(/```[\s\S]*?```/g,' '),{markdown,bare:()=> ' '})
    .replace(/\[\d+(?:\s*[,，-]\s*\d+)*\]/g,'')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm,'')
    .replace(/[*_`~]/g,'').replace(/\s+/g,' ').trim();
}
