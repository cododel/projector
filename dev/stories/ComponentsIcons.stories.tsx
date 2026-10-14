import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from '../../src/renderer/Icon';
const names = ['edit','delete','folder','sidebar-left','sidebar-right','more','plus','refresh','close','back','forward','external','split-right','split-down','terminal','down','right','stop'] as const;
const meta = { title: 'Components/Icons', component: Icon, args: { name: 'edit' }, parameters: { docs: { description: { component: 'All production glyphs, at their real 15px size and inherited foreground color.' } } } } satisfies Meta<typeof Icon>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StateSheet: Story = { parameters: {catalog:{states:["icons.edit", "icons.delete", "icons.folder", "icons.sidebar-left", "icons.sidebar-right", "icons.more", "icons.plus", "icons.refresh", "icons.close", "icons.back", "icons.forward", "icons.external", "icons.split-right", "icons.split-down", "icons.terminal", "icons.down", "icons.right", "icons.stop"],transitions:[]}}, render: () => <div style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(140px,1fr))',gap:20}}>{names.map(name => <div key={name}><Icon name={name}/> {name}</div>)}</div> };
