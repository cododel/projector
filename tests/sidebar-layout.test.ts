import { expect, it } from 'vitest';
import { sidebarWidth, fitSidebars, sidebarDragWidth } from '../src/shared/sidebar-layout';
it('bounds widths without snapping near the default', () => {
  expect(sidebarWidth(100, 'left')).toBe(200);
  expect(sidebarWidth(210, 'left')).toBe(210);
  expect(sidebarWidth(100, 'right')).toBe(250);
  expect(sidebarWidth(900, 'right')).toBe(500);
  expect(sidebarWidth(321, 'right')).toBe(321);
  expect(sidebarWidth(323, 'right')).toBe(323);
  expect(sidebarWidth(260, 'right')).toBe(260);
});
it('fits narrow windows without losing requested dimensions or hidden-sidebar space', () => {
  expect(fitSidebars(500, 500, 980)).toEqual({ left: 260, right: 300 });
  expect(fitSidebars(500, 0, 980)).toEqual({ left: 500, right: 0 });
  expect(fitSidebars(500, 500, 1600)).toEqual({ left: 500, right: 500 });
});

it('collapses below 70 percent of minimum and restores above the threshold without snapping', () => {
  expect(sidebarDragWidth(139, 'left')).toBe(0);
  expect(sidebarDragWidth(140, 'left')).toBe(200);
  expect(sidebarDragWidth(141, 'left')).toBe(200);
  expect(sidebarDragWidth(174, 'right')).toBe(0);
  expect(sidebarDragWidth(175, 'right')).toBe(250);
  expect(sidebarDragWidth(176, 'right')).toBe(250);
  expect(sidebarDragWidth(260, 'right')).toBe(260);
  expect(sidebarDragWidth(-50, 'right')).toBe(0);
  expect(sidebarDragWidth(600, 'right')).toBe(500);
});
