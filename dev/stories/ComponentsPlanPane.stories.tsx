import {CatalogSheet} from '../fixtures/CatalogSheet';
import React from 'react';
import type {Meta,StoryObj} from '@storybook/react-vite';
import {expect,fn,waitFor} from 'storybook/test';
import {PlanDocumentPane} from '../../src/renderer/PlanWorkspacePane';
import {Isolated,Stage} from '../fixtures/components';
const meta={title:'Workspace/Plan pane',component:PlanDocumentPane,decorators:[(Story,context)=>context.id.endsWith('--state-sheet')?<Story/>:<Isolated><Stage><Story/></Stage></Isolated>],args:{content:{kind:'plan',artifactId:'catalog-plan',tab:{kind:'document',id:'catalog-document',revisionId:null}},paneId:'catalog-plan-pane',workspaceKey:'catalog-project/plans',bridge:{invoke:fn(async()=>({}))},refreshToken:{},register:fn(),onFocus:fn(),onNewTab:fn(),onCopy:fn(),message:'Publish the first document into this private workspace.',initialWaiting:true},parameters:{docs:{description:{component:'Actual private plan waiting UI. The initialWaiting input avoids mounting the native projector:// document before the local adapter resolves. Actual document states have Document stories; native protocol loading is separately inventoried.'}}}} satisfies Meta<typeof PlanDocumentPane>;
export default meta;type Story=StoryObj<typeof meta>;
export const Waiting:Story={parameters:{catalog:{states:["plan-pane.waiting"],transitions:[]}}};
export const CopyMessage:Story={parameters:{catalog:{states:["plan-pane.copy-message"],transitions:["plan-pane.copy", "plan-pane.new-tab"]}},play:async({canvas,userEvent,args})=>{await userEvent.click(canvas.getByRole('button',{name:'Copy message for agent'}));await expect(args.onCopy).toHaveBeenCalledOnce();await expect(canvas.getByRole('button',{name:'Copy message for agent'})).toHaveAttribute('title',args.message);await userEvent.click(canvas.getByRole('button',{name:'New tab'}));await expect(args.onNewTab).toHaveBeenCalledOnce();}};
export const LoadFailure:Story={args:{bridge:{invoke:fn(async()=>{throw new Error('Synthetic plan document read failed');})}},parameters:{catalog:{states:["plan-pane.load-failure"],transitions:[]}},play:async({canvas})=>{await waitFor(()=>expect(canvas.getByText('Synthetic plan document read failed')).toBeVisible());await expect(canvas.getByText('Waiting for your agent')).toBeVisible();}};

export const StateSheet:Story={render:()=> <CatalogSheet height={500} frames={['waiting', 'copy-message', 'load-failure'].map(name=>({label:name,storyId:`workspace-plan-pane--${name}`}))}/>};
