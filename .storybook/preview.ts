import type { Preview } from '@storybook/react-vite';
import '../src/renderer/style.css';
import '../dev/catalog.css';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    controls: { expanded: true },
    a11y: { test: 'error' },
    options: { storySort: { order: ['Catalog', 'Notifications', 'Sessions'] } },
  },
};
export default preview;
