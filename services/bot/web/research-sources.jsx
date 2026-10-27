import React from 'react';
import {sourceCards,derivationCards} from './research-view.mjs';
export function ResearchSources({sources,derivations}){
 const cards=sourceCards(sources),scripts=derivationCards(derivations);if(!cards.length&&!scripts.length)return null;
 return <details className="research-sources"><summary>参考来源 · {cards.length+scripts.length}</summary><ol>{cards.map(card=><li key={card.key} id={card.key}>
  <a href={card.url} target="_blank" rel="noopener noreferrer">{card.title}</a>
  <span className="research-evidence">{card.evidenceLabel}{card.truncated?' · 内容有截断':''}</span>
  {card.httpLabel&&<div className="research-times">{card.httpLabel}</div>}<div className="research-times">{[card.publishedLabel,card.retrievedLabel].filter(Boolean).join(' · ')}</div>
  {card.excerpt&&<p>{card.excerpt}</p>}
 </li>)}{scripts.map(card=><li key={card.key}><span className="research-evidence">{card.evidenceLabel}</span><p>{card.summary}</p><p className="subtle">{card.warning}</p><div className="research-times">{card.inputObservationIds.map(id=><a key={id} href={"#"+id}>输入来源 {id.slice(0,8)} </a>)}</div><p className="subtle operation-path">{card.artifactPath}</p></li>)}</ol></details>;
}
