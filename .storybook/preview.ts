import React from 'react';
import { waitFor } from 'storybook/test';
import type { Preview } from '@storybook/react-vite';
import '../src/renderer/style.css';
import '../dev/catalog.css';

const preview: Preview = {
  tags: ['autodocs'],
  afterEach: async ({ id, canvasElement }) => {
    const sheet = canvasElement.querySelector('[data-catalog-sheet-total]');
    if (sheet) await waitFor(() => { if (sheet.getAttribute('data-catalog-sheet-ready') !== 'true') throw new Error(`State sheet is awaiting ${sheet.getAttribute('data-catalog-sheet-current')}.`); }, { timeout: 25000 });
    // Same-origin parent validates sender and story ID before admitting the next frame.
    const parentOrigin = document.referrer ? new URL(document.referrer).origin : window.location.origin;
    window.parent.postMessage({ type: 'catalog-story-ready', id }, parentOrigin);
  },
  decorators: [Story => React.createElement('div', { 'data-catalog-rendered': 'true', className: new URLSearchParams(location.search).get('embed') === 'true' ? 'catalog-static-frame' : undefined, style: { display: 'contents' } }, React.createElement(Story))],
  parameters: {
    layout: 'padded',
    controls: { expanded: true },
    a11y: { test: 'error' },
    options: { storySort: { order: ['Catalog', 'Notifications', 'Sessions'] } },
  },
};
export default preview;
