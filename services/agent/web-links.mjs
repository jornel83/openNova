/** Project HTTP links once, preserving balanced URL parentheses and prose punctuation. */
export function mapWebLinks(text,{markdown=(label,url)=>`[${label}](${url})`,bare=url=>url}={}) {
  const starts=/\[([^\]\n]+)\]\((?=https?:\/\/)|https?:\/\//g;
  let out='',cursor=0,match;
  while((match=starts.exec(text))) {
    const label=match[1],start=label===undefined?match.index:starts.lastIndex;
    let end=start,depth=0;
    for(;end<text.length;end++) {
      const char=text[end];
      if(/[\s<>\[\]，。！？；、）"']/.test(char))break;
      if(char==='(')depth++;
      else if(char===')'){if(!depth)break;depth--;}
    }
    if(label!==undefined && text[end]!==')') {
      // Malformed Markdown: leave the label as prose and scan its URL normally.
      starts.lastIndex=start;continue;
    }
    if(label===undefined)while(end>start && /[.,;:!?]/.test(text[end-1]))end--;
    const url=text.slice(start,end);
    out+=text.slice(cursor,match.index)+(label===undefined?bare(url):markdown(label,url));
    cursor=end+(label===undefined?0:1);starts.lastIndex=cursor;
  }
  return out+text.slice(cursor);
}
