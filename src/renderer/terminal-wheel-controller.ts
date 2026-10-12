import type { Terminal } from '@xterm/xterm';
import { TerminalWheelAccumulator } from './terminal-wheel';

/** Replay one-line events through xterm so its current encoding remains authoritative. */
export function terminalWheelController(
  terminal: Terminal,
  options: {
    ready(): boolean;
    batch(action: () => void): void;
  },
) {
  const accumulator = new TerminalWheelAccumulator();
  const generated = new WeakSet<WheelEvent>();
  let frame: number | null = null;
  let context = '';
  let last: WheelEvent | null = null;
  let disposed = false;
  const metrics = () => {
    const height =
      terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0;
    return {
      rowHeight: height / terminal.rows,
      rows: terminal.rows,
      sensitivity: terminal.options.scrollSensitivity ?? 1,
      fastSensitivity: terminal.options.fastScrollSensitivity ?? 5,
    };
  };
  const mode = () => `${terminal.buffer.active.type}/${terminal.modes.mouseTrackingMode}`;
  const reset = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    context = '';
    last = null;
    accumulator.reset();
  };
  const drain = () => {
    frame = null;
    if (disposed || !last || !options.ready()) {
      reset();
      return;
    }
    const current = metrics();
    const stamp = `${mode()}/${current.rowHeight}/${current.rows}/${current.sensitivity}/${current.fastSensitivity}`;
    if (!context.startsWith(stamp + '/')) {
      reset();
      return;
    }
    const count = accumulator.take(16);
    const original = last;
    const target = original.target;
    if (!(target instanceof Element) || !terminal.element?.contains(target)) {
      reset();
      return;
    }
    options.batch(() => {
      for (let index = 0; index < Math.abs(count); index++) {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: Math.sign(count),
          clientX: original.clientX,
          clientY: original.clientY,
          screenX: original.screenX,
          screenY: original.screenY,
          altKey: original.altKey,
          ctrlKey: original.ctrlKey,
          shiftKey: original.shiftKey,
          metaKey: original.metaKey,
        });
        generated.add(event);
        target.dispatchEvent(event);
      }
    });
    if (accumulator.pending) frame = requestAnimationFrame(drain);
  };
  terminal.attachCustomWheelEventHandler((event) => {
    if (generated.has(event)) return true;
    const tui =
      terminal.modes.mouseTrackingMode !== 'none' || terminal.buffer.active.type === 'alternate';
    if (!tui || event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) {
      reset();
      return true;
    }
    if (disposed || !options.ready()) {
      reset();
      event.preventDefault();
      return false;
    }
    const current = metrics();
    if (!(current.rowHeight > 0)) {
      reset();
      return true;
    }
    const stamp = `${mode()}/${current.rowHeight}/${current.rows}/${current.sensitivity}/${current.fastSensitivity}/${event.altKey}/${event.ctrlKey}/${event.metaKey}`;
    if (stamp !== context) {
      reset();
      context = stamp;
    }
    last = event;
    accumulator.update(
      {
        deltaY: event.deltaY,
        deltaMode: event.deltaMode as 0 | 1 | 2,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
      },
      current,
    );
    event.preventDefault();
    event.stopPropagation();
    if (accumulator.pending && frame === null) frame = requestAnimationFrame(drain);
    return false;
  });
  // Observe each DEC mouse-mode transition, including off/on in one parsed write.
  // Returning false leaves xterm's own parser and protocol setup authoritative.
  const trackingModes = new Map([
    [9, 'x10'],
    [1000, 'vt200'],
    [1002, 'drag'],
    [1003, 'any'],
  ]);
  const mouseMode = (enable: boolean) => (params: (number | number[])[]) => {
    if (
      params.some(
        (param) =>
          typeof param === 'number' &&
          trackingModes.has(param) &&
          (enable
            ? terminal.modes.mouseTrackingMode !== trackingModes.get(param)
            : terminal.modes.mouseTrackingMode !== 'none'),
      )
    )
      reset();
    return false;
  };
  const enableMouse = terminal.parser.registerCsiHandler(
    { prefix: '?', final: 'h' },
    mouseMode(true),
  );
  const disableMouse = terminal.parser.registerCsiHandler(
    { prefix: '?', final: 'l' },
    mouseMode(false),
  );
  const buffer = terminal.buffer.onBufferChange(reset);
  const resize = terminal.onResize(reset);
  // Recheck geometry and public modes after output parsing as well as before draining.
  const parsed = terminal.onWriteParsed(() => {
    if (!context) return;
    const current = metrics();
    const stamp = `${mode()}/${current.rowHeight}/${current.rows}/${current.sensitivity}/${current.fastSensitivity}`;
    if (!context.startsWith(stamp + '/')) reset();
  });
  return {
    reset,
    dispose() {
      disposed = true;
      reset();
      enableMouse.dispose();
      disableMouse.dispose();
      buffer.dispose();
      resize.dispose();
      parsed.dispose();
      terminal.attachCustomWheelEventHandler(() => true);
    },
  };
}
