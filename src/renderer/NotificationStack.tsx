import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { VisibleLifetime, type Notification, type NotificationOverlayBridge } from '../shared/notifications';
import './notifications.css';

function Alert({ notice, leaving, visible, bridge, lifetime, exitTop, windowFocused, nativeHover }: {
  notice: Notification; leaving: boolean; visible: boolean; bridge: NotificationOverlayBridge; lifetime: VisibleLifetime; exitTop?: number; windowFocused: boolean; nativeHover?: boolean;
}): React.JSX.Element {
  const element = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [inView, setInView] = useState(false);
  const [details, setDetails] = useState(false);
  useLayoutEffect(() => {
    // Layout height excludes the entry scale; measuring the transformed box
    // clips the card and moves sibling origins by about 6% during mounting.
    const measure = () => setHeight(content.current!.offsetHeight + 2);
    measure(); const observer = new ResizeObserver(measure); observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setInView(entries[0].intersectionRatio >= 0.99), { threshold: [0, 0.99, 1] });
    observer.observe(element.current!); return () => observer.disconnect();
  }, []);
  const automatic = notice.level === 'info' && notice.lifetime === 'visible' && !notice.actions.length && !notice.pending;
  useEffect(() => {
    const running = automatic && visible && inView && !(hover || nativeHover) && !(focus && windowFocused) && !leaving;
    const remaining = lifetime.update(performance.now(), running);
    if (!running) return;
    const timer = setTimeout(() => bridge.command({ type: 'dismiss', id: notice.id }), remaining);
    return () => { clearTimeout(timer); lifetime.update(performance.now(), false); };
  }, [automatic, visible, inView, hover, nativeHover, focus, windowFocused, leaving, bridge, notice.id, lifetime]);
  return <article ref={element} className={`notification-alert ${notice.level}${leaving ? ' leaving' : ''}`}
    style={{ height, ...(exitTop !== undefined ? { position: 'absolute', top: exitTop, left: 12, width: 'calc(100% - 24px)' } : {}) }} data-notification-id={notice.id} data-operation={notice.operation}
    onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    onFocusCapture={() => setFocus(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false); }}>
    <div ref={content} className="notification-alert-content">
      <svg className="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        {notice.level === 'warning' ? <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5M12 17v1" /></>
          : notice.level === 'error' ? <><circle cx="12" cy="12" r="9" /><path d="m8 8 8 8M16 8l-8 8" /></>
            : <><circle cx="12" cy="12" r="9" /><path d="M12 10v7M12 7v1" /></>}
      </svg>
      <div className="alert-copy" role={notice.level === 'error' ? 'alert' : 'status'} aria-live={notice.level === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
        <strong>{notice.title}</strong>{notice.repeats > 1 && <span className="alert-repeat" aria-label={`Repeated ${notice.repeats} times`}>×{notice.repeats}</span>}
        {notice.body && <p>{notice.body}</p>}
        {notice.details && <><button className="alert-details-toggle" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide details' : 'Show details'}</button>{details && <pre>{notice.details}</pre>}</>}
        {notice.actions.length > 0 && <div className="alert-actions">{notice.actions.map(action => <button key={action.id} disabled={notice.pending || leaving} onClick={() => bridge.command({ type: 'action', id: notice.id, actionId: action.id })}>{notice.pending ? (action.pendingLabel ?? 'Working…') : action.label}</button>)}</div>}
      </div>
      <button className="alert-dismiss" aria-label={`Dismiss ${notice.title}`} disabled={leaving} onClick={() => bridge.command({ type: 'dismiss', id: notice.id })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>
  </article>;
}

export function NotificationStack({ notifications, visible, maxHeight, bridge, hoveredId }: {
  notifications: Notification[]; visible: boolean; maxHeight: number; bridge: NotificationOverlayBridge; hoveredId?: string | null;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [leaving, setLeaving] = useState<{ notice: Notification; top: number }[]>([]);
  const [windowFocused, setWindowFocused] = useState(document.hasFocus());
  const previous = useRef<Notification[]>([]);
  const stack = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const reflows = useRef(new Map<string, Animation>());
  const lastHeight = useRef(0);
  const retained = useRef(new Map<string, VisibleLifetime>());
  const lifetime = (id: string) => {
    if (!retained.current.has(id)) retained.current.set(id, new VisibleLifetime());
    return retained.current.get(id)!;
  };
  useEffect(() => {
    const focus = () => setWindowFocused(true), blur = () => setWindowFocused(false);
    window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
  }, []);
  useLayoutEffect(() => {
    const removed = previous.current.filter(n => !notifications.some(current => current.id === n.id));
    previous.current = notifications;
    if (removed.length) setLeaving(current => [...current.filter(n => !removed.some(r => r.id === n.notice.id)),
      ...removed.filter(n => positions.current.has(n.id)).map(notice => ({ notice, top: positions.current.get(notice.id)! }))]);
  }, [notifications]);
  useEffect(() => {
    if (!leaving.length) return;
    const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    const timer = setTimeout(() => setLeaving([]), delay); return () => clearTimeout(timer);
  }, [leaving]);
  useEffect(() => {
    const live = new Set([...notifications.map(n => n.id), ...leaving.map(n => n.notice.id)]);
    for (const id of retained.current.keys()) if (!live.has(id)) retained.current.delete(id);
  }, [notifications, leaving]);
  const displayed = expanded ? notifications : notifications.slice(0, 3);
  useLayoutEffect(() => {
    const root = stack.current!;
    const reflow = () => {
      const next = new Map<string, number>();
      for (const element of root.querySelectorAll<HTMLElement>('.notification-alert')) {
        const id = element.dataset.notificationId!; const y = element.offsetTop;
        next.set(id, y); const before = positions.current.get(id);
        if (before !== undefined && before !== y) {
          const running = reflows.current.get(id);
          const translate = running ? Number.parseFloat(getComputedStyle(element).translate.split(' ').at(-1) ?? '0') || 0 : 0;
          running?.cancel(); reflows.current.delete(id);
          if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
            reflows.current.set(id, element.animate([{ translate: `0 ${before + translate - y}px` }, { translate: '0 0' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' }));
        }
      }
      for (const [id, animation] of reflows.current) if (!next.has(id)) { animation.cancel(); reflows.current.delete(id); }
      positions.current = next;
    };
    reflow();
    // Alert height is measured by its own component. Those layout changes do
    // not render this parent, so keep the reflow origin current before painting.
    const observer = new ResizeObserver(reflow);
    observer.observe(root);
    for (const element of root.querySelectorAll('.notification-alert')) observer.observe(element);
    return () => observer.disconnect();
  });
  useEffect(() => {
    const animations = reflows.current;
    const cancel = () => { for (const animation of animations.values()) animation.cancel(); animations.clear(); };
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => { if (preference.matches) cancel(); };
    preference.addEventListener('change', change);
    return () => { preference.removeEventListener('change', change); cancel(); };
  }, []);
  useLayoutEffect(() => {
    const measure = () => {
      const height = stack.current!.offsetHeight;
      if (previous.current.length) lastHeight.current = height;
      bridge.command({ type: 'layout', width: 544, height: height + 16 });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(stack.current!);
    return () => observer.disconnect();
  }, [bridge]);
  return <div ref={stack} className="notification-stack" aria-label="Notifications"
    style={{ maxHeight: Math.max(1, maxHeight - 16), minHeight: leaving.length && !notifications.length ? Math.min(lastHeight.current, maxHeight - 16) : undefined }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); bridge.command({ type: 'blur' }); } }}>
    {displayed.map(notice => <Alert key={notice.id} notice={notice} lifetime={lifetime(notice.id)} leaving={false} visible={visible} windowFocused={windowFocused} nativeHover={hoveredId === undefined ? undefined : hoveredId === notice.id} bridge={bridge} />)}
    {leaving.filter(n => !notifications.some(current => current.id === n.notice.id)).map(({ notice, top }) => <Alert key={notice.id} notice={notice} lifetime={lifetime(notice.id)} leaving exitTop={top} visible={false} windowFocused={windowFocused} bridge={bridge} />)}
    {notifications.length > 3 && <button className="notification-overflow" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show latest' : `More · ${notifications.length - 3}`}</button>}
  </div>;
}
