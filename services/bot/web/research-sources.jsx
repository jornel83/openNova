import React from 'react';
import {sourceCards} from './research-view.mjs';
export function ResearchSources({sources}){
 const cards=sourceCards(sources);if(!cards.length)return null;
 return <details className="research-sources"><summary>参考来源 · {cards.length}</summary><ol>{cards.map(card=><li key={card.key}>
  <a href={card.url} target="_blank" rel="noopener noreferrer">{card.title}</a>
  <span className="research-evidence">{card.evidenceLabel}{card.truncated?' · 内容有截断':''}</span>
  <div className="research-times">{[card.publishedLabel,card.retrievedLabel].filter(Boolean).join(' · ')}</div>
  {card.excerpt&&<p>{card.excerpt}</p>}
 </li>)}</ol></details>;
}
