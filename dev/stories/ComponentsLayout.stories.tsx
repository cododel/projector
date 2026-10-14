import {CatalogSheet} from '../fixtures/CatalogSheet';
import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { ShellLayout, ShellSidebar, ShellWorkspace } from '../../src/renderer/shell/ShellLayout';
import { WindowTitlebar } from '../../src/renderer/shell/WindowTitlebar';
import { HomeWorkspacePane } from '../../src/renderer/PlanWorkspacePane';
import { SidebarResizer } from '../../src/renderer/SidebarResizer';
function Fixture({side,initialWidth}:{side:'left'|'right';initialWidth:number}) {
 const [width,setWidth]=useState(initialWidth); const [committed,setCommitted]=useState(initialWidth);
 const left=side==='left'?width:0,right=side==='right'?width:0;
 return <ShellLayout leftVisible={left>0} rightVisible={right>0} style={{height:430,width:'100%', '--left-sidebar-width':`${left}px`,'--right-sidebar-width':`${right}px`,'--left-sidebar-content-width':`${left}px`,'--right-sidebar-content-width':`${right}px`} as React.CSSProperties}>
  <WindowTitlebar leftSidebarVisible={left>0} rightSidebarVisible={right>0} sidebarToggle={()=>null} tabs={null}/>
  <ShellSidebar side={side}><h2>{side==='left'?'Projects':'Feedback'}</h2><p>Sidebar width: <output>{width}</output> px</p></ShellSidebar>
  <ShellWorkspace><HomeWorkspacePane address="" busy={false} onAddress={()=>{}} onOpen={()=>{}} onFocus={()=>{}}/></ShellWorkspace>
  <SidebarResizer side={side} width={width} position={width} onStart={()=>{}} onPreview={setWidth} onCommit={async n=>{setWidth(n);setCommitted(n);}} onCancel={()=>setWidth(committed)}/>
 </ShellLayout>;
}
const meta={title:'Layout/Sidebar resizer',component:Fixture,args:{side:'left',initialWidth:250}} satisfies Meta<typeof Fixture>;
export default meta;type Story=StoryObj<typeof meta>;
export const Left:Story={parameters:{catalog:{states:["sidebar-resizer.left"],transitions:[]}}};
export const Right:Story={args:{side:'right',initialWidth:310},parameters:{catalog:{states:["sidebar-resizer.right"],transitions:[]}}};
export const Minimum:Story={args:{initialWidth:200},parameters:{catalog:{states:["sidebar-resizer.minimum"],transitions:[]}}};
export const Maximum:Story={args:{initialWidth:500},parameters:{catalog:{states:["sidebar-resizer.maximum"],transitions:[]}}};
export const Collapsed:Story={args:{initialWidth:0},parameters:{catalog:{states:["sidebar-resizer.collapsed"],transitions:[]}}};
export const Keyboard:Story={parameters:{catalog:{states:[],transitions:["sidebar-resizer.keyboard", "sidebar-resizer.reset"]}},play:async({canvas,userEvent})=>{const separator=canvas.getByRole('separator');separator.focus();await userEvent.keyboard('{End}');await expect(separator).toHaveAttribute('aria-valuenow','500');await userEvent.dblClick(separator);await expect(separator).toHaveAttribute('aria-valuenow','250');await userEvent.keyboard('{Home}{ArrowRight}');await expect(separator).toHaveAttribute('aria-valuenow','210');}};
export const Drag:Story={parameters:{catalog:{states:["sidebar-resizer.drag"],transitions:["sidebar-resizer.resize", "sidebar-resizer.commit", "sidebar-resizer.cancel", "sidebar-resizer.collapse"]}},play:async({canvas,userEvent})=>{const separator=canvas.getByRole('separator');const rect=separator.getBoundingClientRect();await userEvent.pointer([{keys:'[MouseLeft>]',target:separator,coords:{clientX:rect.x+3,clientY:rect.y+12}},{target:separator,coords:{clientX:rect.x+53,clientY:rect.y+12}}]);await expect(separator).toHaveClass('resizing');await userEvent.pointer({keys:'[/MouseLeft]',target:separator});await waitFor(()=>expect(separator).toHaveAttribute('aria-valuenow','300'));await userEvent.pointer({keys:'[MouseLeft>]',target:separator,coords:{clientX:rect.x+3,clientY:rect.y+12}});await userEvent.keyboard('{Escape}');await expect(separator).not.toHaveClass('resizing');await userEvent.pointer({keys:'[/MouseLeft]',target:separator});await userEvent.pointer([{keys:'[MouseLeft>]',target:separator,coords:{clientX:rect.x+3,clientY:rect.y+12}},{target:separator,coords:{clientX:rect.x-300,clientY:rect.y+12}},{keys:'[/MouseLeft]',target:separator}]);await expect(separator).toHaveAttribute('aria-valuenow','0');}};

export const StateSheet:Story={render:()=> <CatalogSheet height={500} frames={['left', 'right', 'minimum', 'maximum', 'collapsed'].map(name=>({label:name,storyId:`layout-sidebar-resizer--${name}`,static:true}))}/>};
