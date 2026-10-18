import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button,DiffBlock} from '@deepseek-ai/dsh-client-ui-primitives';
import {BotMark} from '@opennova/ds-bot/mark.js';
import {Bubbles} from '@opennova/ds-bot/cells.js';
import {UserMessageCell,USER_MESSAGE_CSS} from '@opennova/ds-bot/user-message.js';
import {SHELL_CSS,CONVERSATION_CSS} from '@opennova/ds-bot/styles.js';
import {installLocale} from '@opennova/ds-bot/i18n.js';
import {WebApi,errorText} from './api.mjs';
import './app.css';

// The upstream components use a small locale service; retain their own Chinese copy.
let dictionary={};
installLocale({getLocale:()=>({active:'zh'}),register:(_ns,_lang,values)=>{dictionary=values;},
  bind:()=>((key,params={})=>(dictionary[key]||key).replace(/\{(\w+)\}/g,(all,k)=>params[k]??all))});
const nativeStyle=document.createElement('style');nativeStyle.textContent=SHELL_CSS+CONVERSATION_CSS+USER_MESSAGE_CSS;document.head.prepend(nativeStyle);
document.body.dataset.btMotion='quiet';
const api=new WebApi();
const statusLabels={cancelled:'已取消',pending:'旧方案未执行',applying:'正在保存',applied:'已保存',rejected:'已拒绝',conflict:'需要重新核对',failed:'执行失败',completed:'已完成',running:'执行中',timed_out:'已超时',interrupted:'已中断'};
const diffLabels={copy:'复制差异',copied:'已复制',codeLabel:'文件修改',wrapLabel:'自动换行',unwrapLabel:'取消换行',collapseAria:'收起差异',expandAria:n=>`展开剩余 ${n} 行`,collapse:'收起',expand:n=>`展开剩余 ${n} 行`};
const storage={get(){try{return JSON.parse(sessionStorage.getItem('opennova.web.outbox')||'null');}catch{return null;}},set(value){try{value?sessionStorage.setItem('opennova.web.outbox',JSON.stringify(value)):sessionStorage.removeItem('opennova.web.outbox');}catch{}}};

function Operation({item,disabled,onAction}) {
  const [error,setError]=useState(''),[working,setWorking]=useState(false);
  const recoverable=item.kind!=='tool'&&item.status==='applying'&&!disabled&&!working;
  async function retry(){setWorking(true);setError('');try{await onAction('approve',item.id);}catch(e){setError(errorText(e));}finally{setWorking(false);}}
  if(item.kind==='tool'&&item.operation!=='file')return <article className="approval-card" aria-label={'操作记录 '+item.tool}>
    <div className="approval-title"><strong>{item.description||item.tool}</strong><span className={'status '+item.status}>{statusLabels[item.status]||item.status}</span></div>
    {item.command&&<pre className="tool-output">{item.command}</pre>}
    <p className="subtle operation-path">{item.cwd}</p>
    {item.operation==='shell'&&<p className="subtle">退出码：{item.exitCode??'—'}{item.timeoutMs?' · 时限 '+Math.round(item.timeoutMs/1000)+' 秒':''}</p>}
    <details open={item.operation==='shell'}><summary>执行输出</summary><pre className="tool-output">{item.operation==='shell'?[item.stdout,item.stderr].filter(Boolean).join('\n')||item.output||'等待命令结束…':item.output||'执行中…'}</pre></details>
    {(item.stdoutPath||item.stderrPath)&&<p className="subtle operation-path">完整日志：{item.stdoutPath||item.stderrPath}</p>}
    {item.error&&<p className="error">{item.error}</p>}
  </article>;
  return <article className="approval-card" aria-label={'操作记录 '+(item.path||'记忆')}>
    <div className="approval-title"><strong>{item.path||'记忆修改'}</strong><span className={'status '+item.status}>{recoverable?'保存状态待核对':item.tool==='forget'&&item.status==='applied'?'已删除':statusLabels[item.status]||item.status}</span></div>
    {item.operation==='file'?item.previewValid?<DiffBlock diffs={item.diffs||[{path:item.path,oldText:item.beforeContent,newText:item.content}]} labels={diffLabels} maxLines={18}/>:<p role="alert">当前记录没有可用差异预览，请读取文件核对。</p>:
      <div className="memory-change">{(item.target?.text||item.args?.entry)&&<p><span>原记录</span>{item.target?.text||item.args.entry}</p>}{item.tool==='forget'?<p>{item.status==='applied'?'已删除这条有效记忆。':'删除记忆的操作记录。'}</p>:<p><span>保存内容</span>{item.args?.text}</p>}</div>}
    {item.previewTruncated&&<p className="subtle">差异预览已截断；完整文件已保存。</p>}
    {item.status==='pending'&&<p className="subtle">这是旧版本未执行的方案；需要执行时可直接告诉 OpenNova。</p>}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
    {recoverable&&<p className="subtle">上次保存未完成，可重试并核对实际结果。</p>}
    {error&&<p role="alert" className="error">{error}</p>}
    {recoverable&&<Button className="nova-primary" disabled={item.previewValid===false} onClick={retry}>重试保存</Button>}
  </article>;
}

function App(){
  const [snapshot,setSnapshot]=useState(null),[online,setOnline]=useState(false),[draft,setDraft]=useState(()=>storage.get()?.text||''),[error,setError]=useState(''),[sending,setSending]=useState(false),[panel,setPanel]=useState(()=>window.matchMedia("(min-width: 1100px)").matches),[limit,setLimit]=useState(50),[outbox,setOutbox]=useState(storage.get);
  const inflight=useRef(false),outgoing=useRef(outbox),count=useRef(0),applied=useRef(0),scroll=useRef(),stick=useRef(true),input=useRef();
  const setOutgoing=value=>{outgoing.current=value;storage.set(value);setOutbox(value);};
  async function refresh(){
    const order=++count.current;
    try{
      const next=await api.call('snapshot',{limit});
      if(order<applied.current)return;applied.current=order;setSnapshot(next);setOnline(true);
      const pending=outgoing.current;
      if(pending&&next.messages.some(m=>m.id===pending.id)){setOutgoing(null);setDraft(value=>value===pending.text?'':value);}
    }catch(e){if(order>=applied.current){applied.current=order;setOnline(false);}throw e;}
  }
  useEffect(()=>{let stopped=false,timer;const poll=async()=>{try{await refresh();}catch{}if(!stopped)timer=setTimeout(poll,document.hidden?5000:1000);};void poll();return()=>{stopped=true;clearTimeout(timer);};},[limit]);
  const messages=snapshot?.messages||[],approvals=snapshot?.approvals||[],issues=approvals.filter(p=>['applying','failed','conflict'].includes(p.status));
  const bot={id:snapshot?.health.botId||'opennova',name:'OpenNova',color:'blue',avatar:{shape:'drop'}},sessionId=snapshot?.health.sessionId||bot.id;
  const roster={bots:[bot],byId:{[bot.id]:bot,[sessionId]:bot},roomsById:{}};
  const busy=!!snapshot?.busy;
  const actions={openSession:()=>{},quote:(_id,text)=>{setDraft(text.split('\n').map(line=>'> '+line).join('\n')+'\n\n');input.current?.focus();}};
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[messages.length,messages.at(-1)?.status,messages.at(-1)?.text]);
  async function send(event){
    event?.preventDefault();if(inflight.current||busy||!online||(!outgoing.current&&!draft.trim()))return;
    inflight.current=true;setSending(true);setError('');
    const record=outgoing.current||{id:crypto.randomUUID(),text:draft};setOutgoing(record);
    try{await api.call('ask',record);setOutgoing(null);setDraft(value=>value===record.text?'':value);stick.current=true;await refresh();}
    catch(e){setError(errorText(e));if(e.code&&e.code!=='network')setOutgoing(null);}
    finally{inflight.current=false;setSending(false);input.current?.focus();}
  }
  async function action(name,id){const result=await api.call(name,{id});await refresh();return result;}
  return <div className={'nova-app '+(panel?'with-panel':'')}>
    <aside className="nova-sidebar"><div className="brand">OpenNova<span>AI 助手</span></div><button className="bot-tile" onClick={()=>input.current?.focus()}><BotMark bot={bot} size={42} state={busy?'think':'idle'}/><span><strong>OpenNova</strong><small>工作协同与日常陪伴</small></span></button><p className="shared-note">网页与语音共用这段对话。<br/>切换入口，继续聊就好。</p><button className="review-link" onClick={()=>setPanel(!panel)}>操作记录 <span>{issues.length}</span></button><div className="sidebar-footer"><span className={'connection-dot '+(online?'on':'')}/>{online?'已连接':'正在连接'}<small>基于 DeepSeek-Bot</small></div></aside>
    <main className="nova-main"><header className="chat-header"><div><BotMark bot={bot} size={27} state={busy?'think':'idle'}/><strong>OpenNova</strong><span>{busy?'正在处理…':'与你继续交流'}</span></div><Button className="nova-secondary" onClick={()=>setPanel(!panel)}>操作记录{issues.length?' · '+issues.length:''}</Button></header>
      {!online&&<div className="connection-banner" role="status">正在连接 Bot 服务。服务恢复后会自动接续，已保存的对话仍会保留。</div>}
      <div className="chat-scroll" ref={scroll} onScroll={()=>{const s=scroll.current;stick.current=s.scrollHeight-s.scrollTop-s.clientHeight<100;}}><div className="chat-content">
        {snapshot?.hasMore&&limit<500&&<Button className="history-more nova-secondary" onClick={()=>{stick.current=false;setLimit(Math.min(500,limit+50));}}>加载更早的对话</Button>}
        {snapshot&&!messages.length&&<div className="welcome"><BotMark bot={bot} size={76}/><h1>你好，我们从哪里开始？</h1><p>可以继续刚才的语音话题，也可以让我读取、编辑项目文件。</p></div>}
        {messages.map(message=><section className="exchange" key={message.id} data-request-id={message.id}><div className="message-meta">{message.source==='voice'?'语音':message.source==='web'?'网页':'终端'} · {new Date(message.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div><UserMessageCell node={{data:{content:[{type:'text',text:message.input}],time:message.createdAt}}} sessionId={sessionId} useRoster={select=>select(roster)} actions={actions}/>
          {message.status==='completed'?<div className="assistant-message"><Bubbles texts={[message.text||'本轮已完成。']} roster={roster} selfId={bot.id} sessionId={sessionId} actions={actions}/></div>:<p className={'turn-status '+(['queued','running'].includes(message.status)?'working':'')} role="status">{message.status==='queued'?'正在等待…':message.status==='running'?(message.tool?'正在处理：'+message.tool:'正在思考…'):errorText({message:message.error||message.status,code:message.status})}</p>}</section>)}
      </div></div>
      <form className="composer-area" onSubmit={send}>{error&&<div className="error" role="alert">{error}</div>}{outbox&&!sending&&<div className="subtle">上一条消息的发送状态待确认。重试会发送原消息，编辑中的新草稿会保留。</div>}<div className="composer"><textarea ref={input} aria-label="发送给 OpenNova" placeholder="输入消息，继续这段对话…" value={draft} maxLength={8000} rows={3} onChange={e=>{setDraft(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();void send();}}}/><div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span>{snapshot?.activeId?<Button className="nova-secondary" onClick={()=>{void action('cancel',snapshot.activeId).catch(e=>setError(errorText(e)));}}>停止回复</Button>:<Button type="submit" className="nova-primary" disabled={!online||busy||sending||(!outbox&&!draft.trim())}>{sending?'发送中…':outbox?'重试发送':'发送'}</Button>}</div></div><p className="composer-hint">可直接修改工程、运行测试；执行结果见操作记录。</p></form>
    </main>
    {panel&&<aside className="approval-panel" aria-label="操作记录"><header><div><strong>操作记录</strong><p>查看执行结果和内容差异</p></div><Button className="nova-secondary" aria-label="关闭操作记录" onClick={()=>setPanel(false)}>×</Button></header>{!approvals.length&&<div className="empty-approvals">暂无操作记录</div>}{approvals.map(p=><Operation key={p.id} item={p} disabled={busy||!online} onAction={action}/>)}</aside>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
