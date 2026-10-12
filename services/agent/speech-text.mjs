/** Display and speech are separate projections; URLs and citations are not spoken. */
export function toSpeechText(text) {
  return text.replace(/```[\s\S]*?```/g,' ')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g,(_,label)=>/^https?:\/\//.test(label)?new URL(label).hostname:label)
    .replace(/https?:\/\/[^\s<>，。！？；、）]+/g,' ')
    .replace(/\[\d+(?:\s*[,，-]\s*\d+)*\]/g,'')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm,'')
    .replace(/[*_`~]/g,'').replace(/\s+/g,' ').trim();
}
