import React, { useEffect, useRef, useState } from 'react';
/** Mount state frames sequentially: concurrent play functions share browser input devices. */
export interface CatalogFrame { label: string; storyId: string; static?: boolean; width?: number; height?: number }
export function CatalogSheet({ frames, height = 620 }: { frames: CatalogFrame[]; height?: number }): React.JSX.Element {
  const [ready, setReady] = useState(0);
  const elements = useRef<(HTMLIFrameElement | null)[]>([]);
  // Vitest's browser host is not the Storybook preview router. Its controlled
  // static server supplies child frames; ordinary Storybook stays same-origin.
  const frameOrigin = import.meta.env.VITE_CATALOG_FRAME_ORIGIN || location.origin;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== frameOrigin || event.data?.type !== 'catalog-story-ready') return;
      const index = elements.current.findIndex(element => element?.contentWindow === event.source);
      if (index >= 0 && frames[index]?.storyId === event.data.id) setReady(previous => index === previous ? previous + 1 : previous);
    };
    window.addEventListener('message',receive); return () => window.removeEventListener('message',receive);
  }, [frames, frameOrigin]);
  return <div className="catalog-grid catalog-isolated-sheet" data-catalog-sheet-total={frames.length} data-catalog-sheet-ready={ready >= frames.length} data-catalog-sheet-current={frames[ready]?.storyId ?? 'complete'}>
    {frames.slice(0,Math.min(frames.length,ready + 1)).map((frame,index) => <section key={frame.storyId}>
      <h2>{frame.label}</h2><iframe ref={element => { elements.current[index] = element; }} title={frame.label} src={`${frameOrigin}/iframe.html?id=${encodeURIComponent(frame.storyId)}&viewMode=story${frame.static ? '&embed=true' : ''}`} style={{ width:frame.width ?? 1200,maxWidth:'100%',height:frame.height ?? height,border:0 }} />
    </section>)}
  </div>;
}
