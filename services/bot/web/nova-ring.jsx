import React from 'react';
export function NovaRing({state='idle',reducedMotion=false}) {
 return <div className="nova-ring" data-state={state} data-reduced-motion={reducedMotion||undefined} aria-hidden="true">
  <svg viewBox="0 0 72 72" fill="none"><circle className="ring-track" cx="36" cy="36" r="35"/>
   <circle className="ring-orbit" cx="36" cy="36" r="28" strokeDasharray="2 4"/>
   <circle className="ring-arc" cx="36" cy="36" r="35" strokeDasharray="36 74 18 92"/>
   <circle className="ring-core" cx="36" cy="36" r="16"/>
  </svg><span className="ring-light"/>
 </div>;
}
