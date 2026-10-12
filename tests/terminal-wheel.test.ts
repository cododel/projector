import { expect, it } from 'vitest';
import {
  TerminalWheelAccumulator,
  type TerminalWheelMetrics,
} from '../src/renderer/terminal-wheel';

const metrics: TerminalWheelMetrics = {
  rowHeight: 20,
  rows: 24,
  sensitivity: 1,
  fastSensitivity: 5,
};

it('preserves proportional pixel movement instead of emitting only one TUI line', () => {
  const wheel = new TerminalWheelAccumulator();
  expect(wheel.update({ deltaY: 100, deltaMode: 0 }, metrics)).toBe(5);
  expect(wheel.take()).toBe(5);
});

it.each([
  { deltaMode: 1 as const, deltaY: 3, expected: 3 },
  { deltaMode: 2 as const, deltaY: -1, expected: -24 },
])('converts line and page units: $deltaMode', ({ deltaMode, deltaY, expected }) => {
  const wheel = new TerminalWheelAccumulator();
  expect(wheel.update({ deltaY, deltaMode }, metrics)).toBe(expected);
});

it('accumulates tiny gestures across frames without slowing pixels', () => {
  const wheel = new TerminalWheelAccumulator();
  for (let index = 0; index < 9; index++) {
    wheel.update({ deltaY: 2, deltaMode: 0 }, metrics);
    expect(wheel.take()).toBe(0);
  }
  wheel.update({ deltaY: 2, deltaMode: 0 }, metrics);
  expect(wheel.take()).toBe(1);
  expect(wheel.pending).toBe(0);
});

it('drops queued movement and fractions when direction reverses', () => {
  const wheel = new TerminalWheelAccumulator();
  wheel.update({ deltaY: 110, deltaMode: 0 }, metrics);
  expect(wheel.update({ deltaY: -10, deltaMode: 0 }, metrics)).toBe(0);
  expect(wheel.update({ deltaY: -10, deltaMode: 0 }, metrics)).toBe(-1);
  expect(wheel.take()).toBe(-1);
});

it.each(['altKey', 'ctrlKey'] as const)(
  'applies the existing fast multiplier with %s',
  (modifier) => {
    const wheel = new TerminalWheelAccumulator();
    expect(wheel.update({ deltaY: 20, deltaMode: 0, [modifier]: true }, metrics)).toBe(5);
    wheel.reset();
    expect(wheel.update({ deltaY: 20, deltaMode: 0, altKey: true, ctrlKey: true }, metrics)).toBe(
      5,
    );
  },
);

it('ignores horizontal and Shift gestures without altering pending vertical movement', () => {
  const wheel = new TerminalWheelAccumulator();
  wheel.update({ deltaY: 10, deltaMode: 0 }, metrics);
  expect(wheel.update({ deltaY: -100, deltaMode: 0, shiftKey: true }, metrics)).toBe(0);
  expect(wheel.update({ deltaY: -100, deltaMode: 0, deltaX: 1 }, metrics)).toBe(0);
  expect(wheel.update({ deltaY: 10, deltaMode: 0 }, metrics)).toBe(1);
});

it('caps backlog at two terminal heights and emits at most 16 lines per take', () => {
  const wheel = new TerminalWheelAccumulator();
  expect(wheel.update({ deltaY: 100000, deltaMode: 0 }, metrics)).toBe(48);
  expect(wheel.take()).toBe(16);
  expect(wheel.take()).toBe(16);
  expect(wheel.take()).toBe(16);
  expect(wheel.take()).toBe(0);
  wheel.update({ deltaY: 20, deltaMode: 0 }, metrics);
  expect(wheel.take()).toBe(1);
});

it.each(['rowHeight', 'rows', 'sensitivity', 'fastSensitivity'] as const)(
  'resets stale state when %s changes',
  (key) => {
    const wheel = new TerminalWheelAccumulator();
    wheel.update({ deltaY: 110, deltaMode: 0 }, metrics);
    const changed = { ...metrics, [key]: metrics[key] * 2 };
    expect(wheel.update({ deltaY: 0, deltaMode: 0 }, changed)).toBe(0);
    expect(wheel.pending).toBe(0);
    wheel.update({ deltaY: changed.rowHeight, deltaMode: 0 }, changed);
    expect(wheel.take()).toBe(changed.sensitivity);
  },
);

it('explicit reset removes fractions and queued lines for disposal or mode changes', () => {
  const wheel = new TerminalWheelAccumulator();
  wheel.update({ deltaY: 110, deltaMode: 0 }, metrics);
  wheel.reset();
  expect(wheel.pending).toBe(0);
  wheel.update({ deltaY: 10, deltaMode: 0 }, metrics);
  expect(wheel.take()).toBe(0);
});

it('ignores invalid events, resets invalid metrics, and handles finite overflow safely', () => {
  const wheel = new TerminalWheelAccumulator();
  wheel.update({ deltaY: 100, deltaMode: 0 }, metrics);
  expect(wheel.update({ deltaY: NaN, deltaMode: 0 }, metrics)).toBe(0);
  expect(wheel.pending).toBe(5);
  expect(wheel.update({ deltaY: 100, deltaMode: 0 }, { ...metrics, rowHeight: 0 })).toBe(0);
  expect(wheel.pending).toBe(0);
  wheel.update({ deltaY: Number.MAX_VALUE, deltaMode: 2 }, metrics);
  expect(wheel.pending).toBe(48);
  expect(wheel.take(NaN)).toBe(0);
  expect(wheel.take(-1)).toBe(0);
  expect(wheel.take(2.9)).toBe(2);
});
