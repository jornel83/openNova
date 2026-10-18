import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '@deepseek-ai/dsh-client-ui-primitives';
import {Bubbles} from '@opennova/ds-bot/cells.js';
import {UserMessageCell,USER_MESSAGE_CSS} from '@opennova/ds-bot/user-message.js';
import {SHELL_CSS,CONVERSATION_CSS} from '@opennova/ds-bot/styles.js';
import {installLocale} from '@opennova/ds-bot/i18n.js';
import {WebApi,errorText} from './api.mjs';
import {NovaRing} from './nova-ring.jsx';
import {ContextChip} from './context-chip.jsx';
import {OperationCard} from './operation-card.jsx';
import {Icon} from './icons.jsx';
import './app.css';

// The upstream components use a small locale service; retain their own Chinese copy.
let dictionary={};
installLocale({getLocale:()=>({active:'zh'}),register:(_ns,_lang,values)=>{dictionary=values;},
  bind:()=>((key,params={})=>(dictionary[key]||key).replace(/\{(\w+)\}/g,(all,k)=>params[k]??all))});
const nativeStyle=document.createElement('style');nativeStyle.textContent=SHELL_CSS+CONVERSATION_CSS+USER_MESSAGE_CSS;document.head.prepend(nativeStyle);
document.body.dataset.btMotion='quiet';document.body.dataset.dsDarkTheme='';
const api=new WebApi();
function savedDraft(){try{return sessionStorage.getItem('opennova.web.draft')??storage.get()?.text??'';}catch{return '';}}
const storage={get(){try{return JSON.parse(sessionStorage.getItem('opennova.web.outbox')||'null');}catch{return null;}},set(value){try{value?sessionStorage.setItem('opennova.web.outbox',JSON.stringify(value)):sessionStorage.removeItem('opennova.web.outbox');}catch{}}};

function App(){
  const [snapshot,setSnapshot]=useState(null),[online,setOnline]=useState(false),[draft,setDraft]=useState(savedDraft),[error,setError]=useState(''),[sending,setSending]=useState(false),[limit,setLimit]=useState(50),[outbox,setOutbox]=useState(storage.get);
  const inflight=useRef(false),outgoing=useRef(outbox),count=useRef(0),applied=useRef(0),scroll=useRef(),stick=useRef(true),input=useRef();
  const setOutgoing=value=>{outgoing.current=value;storage.set(value);setOutbox(value);};
  async function refresh(){
    const order=++count.current;
    try{
      const next=await api.call('snapshot',{limit});
      if(order<applied.current)return null;applied.current=order;setSnapshot(next);setOnline(true);
      const pending=outgoing.current;
      if(pending&&next.messages.some(m=>m.id===pending.id)){setOutgoing(null);setDraft(value=>value===pending.text?'':value);}
      return next;
    }catch(e){if(order>=applied.current){applied.current=order;setOnline(false);}throw e;}
  }
  useEffect(()=>{
    let stopped=false,pollTimer,retryTimer,eventTimer;const controller=new AbortController();
    const poll=async()=>{try{await refresh();}catch{}if(!stopped)pollTimer=setTimeout(poll,document.hidden?15000:5000);};
    const invalidate=()=>{if(stopped||eventTimer)return;eventTimer=setTimeout(()=>{eventTimer=null;if(!stopped)void refresh().catch(()=>{});},40);};
    const connect=async()=>{try{const next=await refresh();if(!stopped&&next?.cursor)await api.events(next.cursor,invalidate,{signal:controller.signal});}catch{}if(!stopped)retryTimer=setTimeout(connect,2000);};
    void connect();pollTimer=setTimeout(poll,5000);
    return()=>{stopped=true;controller.abort();clearTimeout(pollTimer);clearTimeout(retryTimer);clearTimeout(eventTimer);};
  },[limit]);
  const messages=snapshot?.messages||[],approvals=snapshot?.approvals||[];
  const operationsFor=id=>approvals.filter(p=>p.requestId===id).sort((a,b)=>a.createdAt-b.createdAt);
  const unlinked=approvals.filter(p=>!p.requestId);
  const active=messages.find(m=>m.id===snapshot?.activeId);
  const novaState=!online?'offline':snapshot?.busy?'thinking':'idle';
  const novaStatus=!online?'正在连接':snapshot?.busy?(active?.phase==='tool'?'正在工作':'正在思考'):'与你继续交流';
  const bot={id:snapshot?.health.botId||'opennova',name:'OpenNova',color:'blue',avatar:{shape:'drop'}},sessionId=snapshot?.health.sessionId||bot.id;
  const roster={bots:[bot],byId:{[bot.id]:bot,[sessionId]:bot},roomsById:{}};
  const busy=!!snapshot?.busy;
  useEffect(()=>{try{sessionStorage.setItem('opennova.web.draft',draft);}catch{}},[draft]);
  const actions={openSession:()=>{},quote:(_id,text)=>{setDraft(text.split('\n').map(line=>'> '+line).join('\n')+'\n\n');input.current?.focus();}};
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[messages.length,messages.at(-1)?.status,messages.at(-1)?.text,approvals.length]);
  useEffect(()=>{
    const content=scroll.current?.firstElementChild;if(!content)return;
    const observer=new ResizeObserver(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;});
    observer.observe(content);observer.observe(scroll.current);return()=>observer.disconnect();
  },[]);
  async function send(event){
    event?.preventDefault();if(inflight.current||busy||!online||(!outgoing.current&&!draft.trim()))return;
    inflight.current=true;setSending(true);setError('');
    const record=outgoing.current||{id:crypto.randomUUID(),text:draft};setOutgoing(record);
    try{await api.call('ask',record);setOutgoing(null);setDraft(value=>value===record.text?'':value);stick.current=true;await refresh();}
    catch(e){setError(errorText(e));if(e.code&&e.code!=='network')setOutgoing(null);}
    finally{inflight.current=false;setSending(false);input.current?.focus();}
  }
  async function reopen(fileId){
    setError('');try{await api.call('document-open',{id:crypto.randomUUID(),fileId});await refresh();}catch(e){setError(errorText(e));}
  }
  async function action(name,id){const result=await api.call(name,{id});await refresh();return result;}
  return <main className="nova-app">
    <header className="nova-header">
      <div className="window-heading"><span>OPENNOVA</span><span className={'connection '+(online?'online':'')}><i/>{online?'已连接':'连接中'}</span></div>
      <div className="nova-identity"><NovaRing state={novaState}/><h1>NOVA</h1><p role="status">{novaStatus}</p></div>
    </header>
    {!online&&<div className="connection-banner" role="status">连接中断时可以继续编辑，草稿会保留。正在自动重连…</div>}
    <div className="chat-scroll" ref={scroll} onScroll={()=>{const s=scroll.current;stick.current=s.scrollHeight-s.scrollTop-s.clientHeight<100;}}><div className="chat-content">
      {snapshot?.hasMore&&limit<500&&<Button className="history-more nova-secondary" onClick={()=>{stick.current=false;setLimit(Math.min(500,limit+50));}}>加载更早的对话</Button>}
      {snapshot&&!messages.length&&<div className="welcome"><span className="eyebrow">LET’S BUILD TOGETHER</span><h2>一起把想法变成现实</h2><p>聊聊你的想法，或从工作窗口里的一段内容开始。</p></div>}
      {messages.map(message=><section className="exchange" key={message.id} data-request-id={message.id}>
        <div className="message-meta">{message.source==='voice'?'语音':message.source==='web'?'文字':'终端'} · {new Date(message.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
        <UserMessageCell node={{data:{content:[{type:'text',text:message.input}],time:message.createdAt}}} sessionId={sessionId} useRoster={select=>select(roster)} actions={actions}/>
        <div className="assistant-message"><div className="speaker-label"><span/> NOVA</div>
          {!!operationsFor(message.id).length&&<div className="inline-operations" aria-label="本轮操作">{operationsFor(message.id).map(record=><OperationCard key={record.id} record={record} disabled={busy||!online} onAction={action}/>)}</div>}
          {message.status==='completed'?<Bubbles texts={[message.text||'本轮已完成。']} roster={roster} selfId={bot.id} sessionId={sessionId} actions={actions}/>:<p className={'turn-status '+(['queued','running'].includes(message.status)?'working':'')} role="status">{message.status==='queued'?'正在等待…':message.status==='running'?(message.phase==='tool'?'正在处理工作内容…':'正在思考…'):errorText({message:message.error||message.status,code:message.status})}</p>}
        </div>
      </section>)}
      {!!unlinked.length&&<details className="other-operations"><summary>其他操作记录 · {unlinked.length}</summary>{unlinked.map(record=><OperationCard key={record.id} record={record} disabled={busy||!online} onAction={action}/>)}</details>}
    </div></div>
    <div className="chat-bottom">
      <ContextChip context={snapshot?.desktop?.context||snapshot?.workContext} disabled={busy||!online} onOpenFile={reopen} onClear={()=>void action('context-clear').catch(e=>setError(errorText(e)))}/>
      <form className="composer-area" onSubmit={send}>
        {error&&<div className="error" role="alert">{error}</div>}
        {outbox&&!sending&&<p className="subtle">上一条消息的发送状态待确认。重试会发送原消息，新草稿会保留。</p>}
        <div className="composer"><textarea ref={input} aria-label="发送给 OpenNova" placeholder="说说你的想法…" value={draft} maxLength={8000} rows={2} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();void send();}}}/>
          <div className="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span>{snapshot?.activeId?<button type="button" className="stop-button" onClick={()=>{void action('cancel',snapshot.activeId).catch(e=>setError(errorText(e)));}}><Icon name="stop"/> 停止回复</button>:<button type="submit" className="send-button" title={outbox?'重试发送':'发送'} aria-label={sending?'发送中':outbox?'重试发送':'发送'} disabled={!online||busy||sending||(!outbox&&!draft.trim())}><Icon name="send"/></button>}</div>
        </div>
      </form>
      <div className="voice-footer"><span className="voice-symbol"><Icon name="micOff"/></span><div><span>语音未启动</span><small>文字与语音共用这段对话</small></div><span className="voice-idle" aria-hidden="true"><i/><i/><i/><i/><i/></span></div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
