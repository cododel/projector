import {CatalogSheet} from '../fixtures/CatalogSheet';
import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { WorkspaceSplit } from '../../src/renderer/WorkspaceSplit';
import { HomeWorkspacePane } from '../../src/renderer/PlanWorkspacePane';
import type { PaneNode } from '../../src/shared/application-workspace';
import { Stage } from '../fixtures/components';
const pane=(id:string):PaneNode=>({id,kind:'pane',content:{kind:'session',sessionId:id}});
function Fixture({kind,ratio}:{kind:'single'|'horizontal'|'vertical'|'nested';ratio:number}){
 const [node,setNode]=useState<PaneNode>(()=>kind==='single'?pane('first'):{id:'split',kind:'split',axis:kind==='vertical'?'vertical':'horizontal',ratio,first:pane('first'),second:kind==='nested'?{id:'nested',kind:'split',axis:'vertical',ratio:.5,first:pane('second'),second:pane('third')}:pane('second')});
 const [active,setActive]=useState('first');
 function update(n:PaneNode,id:string,value:number):PaneNode{return n.kind==='pane'?n:{...n,ratio:n.id===id?value:n.ratio,first:update(n.first,id,value),second:update(n.second,id,value)}}
 return <Stage><WorkspaceSplit node={node} activePaneId={active} onRatio={async(id,value)=>setNode(n=>update(n,id,value))} renderPane={n=><HomeWorkspacePane address="" busy={false} onAddress={()=>{}} onOpen={()=>{}} onFocus={()=>setActive(n.id)}/>}/></Stage>;
}
const meta={title:'Layout/Workspace split',component:Fixture,args:{kind:'horizontal',ratio:.5}} satisfies Meta<typeof Fixture>;
export default meta;type Story=StoryObj<typeof meta>;
export const Single:Story={args:{kind:'single'},parameters:{catalog:{states:["workspace-split.single", "workspace-split.active"],transitions:[]}}};
export const Horizontal:Story={parameters:{catalog:{states:["workspace-split.horizontal"],transitions:[]}}};
export const Vertical:Story={args:{kind:'vertical'},parameters:{catalog:{states:["workspace-split.vertical"],transitions:[]}}};
export const Nested:Story={args:{kind:'nested'},parameters:{catalog:{states:["workspace-split.nested"],transitions:[]}}};
export const Minimum:Story={args:{ratio:.1},parameters:{catalog:{states:["workspace-split.minimum"],transitions:[]}}};
export const Maximum:Story={args:{ratio:.9},parameters:{catalog:{states:["workspace-split.maximum"],transitions:[]}}};
export const Keyboard:Story={parameters:{catalog:{states:[],transitions:["workspace-split.keyboard"]}},play:async({canvas,userEvent})=>{const divider=canvas.getByRole('separator');divider.focus();await userEvent.keyboard('{ArrowRight>8/}');await expect(divider).toHaveAttribute('aria-valuenow','90');}};
export const Drag:Story={parameters:{catalog:{states:["workspace-split.drag"],transitions:["workspace-split.resize", "workspace-split.commit", "workspace-split.cancel"]}},play:async({canvas,userEvent,canvasElement})=>{const divider=canvas.getByRole('separator');const rect=canvasElement.querySelector('.workspace-split')!.getBoundingClientRect();await userEvent.pointer([{keys:'[MouseLeft>]',target:divider,coords:{clientX:rect.x+rect.width/2,clientY:rect.y+30}},{target:divider,coords:{clientX:rect.x+rect.width*.7,clientY:rect.y+30}}]);await expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThan(65);await userEvent.pointer({keys:'[/MouseLeft]',target:divider});await expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThan(65);await userEvent.pointer({keys:'[MouseLeft>]',target:divider});divider.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}));await userEvent.pointer({keys:'[/MouseLeft]',target:divider});await expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThan(65);}};

export const StateSheet:Story={render:()=> <CatalogSheet height={500} frames={['single', 'horizontal', 'vertical', 'nested', 'minimum', 'maximum'].map(name=>({label:name,storyId:`layout-workspace-split--${name}`,static:true}))}/>};
