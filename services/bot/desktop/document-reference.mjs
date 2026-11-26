/**
 * Guard the legacy current=true selector when the user's own message explicitly
 * identifies a single open desktop document. The model can also select
 * currentOpen directly for paraphrases. Mixed references stay distinct.
 */
export function prefersOpenDesktopDocument(text){
  if(typeof text!=='string')return false;
  const input=text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g,'').replace(/[ \t]+/g,'');
  if(/(?:Nova.{0,6}(?:关联|打开|选中)|上一份|上次(?:关联|打开)|[与和跟].{0,12}(?:文件|文档|PDF)|比较|分别|两份|不是|并非|不想|不需|不要|不用|别读|无需)/i.test(input))return false;
  if(!/(?:读|讲解|解释|总结|概括|分析|提取|梳理|核对|看下|看一下)/.test(input))return false;
  return /(?:我(?:现在|当前|此刻)?(?:正在|正)(?:打开|阅读|看)(?:着)?的|(?:当前|现在|此刻)(?:我)?(?:正(?:在)?)?(?:打开|看着)的|正在(?:打开|阅读|看)的|(?:在|用)?(?:WPS|预览|Acrobat|Word|Excel|桌面)(?:应用|阅读器)?(?:中|里|上)?(?:我)?(?:现在|当前|刚才)?(?:正(?:在)?)?(?:打开|查看|阅读|看)(?:着)?的)(?:那一?|这一?|一)?(?:份|个|张|篇)?(?:PDF|Word|Excel|文档|文件|表格|图片|论文)/i.test(input);
}
