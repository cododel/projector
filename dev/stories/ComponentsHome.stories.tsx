import React,{useState} from 'react';
import type {Meta,StoryObj} from '@storybook/react-vite';
import {expect,fn} from 'storybook/test';
import {HomeWorkspacePane} from '../../src/renderer/PlanWorkspacePane';
import {Stage} from '../fixtures/components';
import {CatalogSheet} from '../fixtures/CatalogSheet';
function Fixture(args:React.ComponentProps<typeof HomeWorkspacePane>){const [busy,setBusy]=useState(args.busy);return <Stage><HomeWorkspacePane {...args} busy={busy} onOpen={value=>{args.onOpen(value);setBusy(true);}}/></Stage>;}
const meta={title:'Workspace/Home',component:Fixture,args:{address:'',busy:false,onAddress:fn(),onOpen:fn(),onFocus:fn()}} satisfies Meta<typeof Fixture>;
export default meta;type Story=StoryObj<typeof meta>;
export const Empty:Story={parameters:{catalog:{states:["home-pane.empty"],transitions:[]}}};
export const Address:Story={args:{address:'https://example.invalid/catalog'},parameters:{catalog:{states:["home-pane.address"],transitions:[]}}};
export const LongAddress:Story={args:{address:'https://example.invalid/a/very/long/path/to/a/page?catalog=long-address-and-safe-local-callback'},parameters:{catalog:{states:["home-pane.long-address"],transitions:[]}}};
export const Busy:Story={args:{address:'https://example.invalid/catalog',busy:true},parameters:{catalog:{states:["home-pane.busy"],transitions:[]}},play:async({canvas})=>{await expect(canvas.getByRole('button',{name:'Open'})).toBeDisabled();}};
export const EditAndOpen:Story={parameters:{catalog:{states:[],transitions:["home-pane.edit", "home-pane.open"]}},play:async({canvas,userEvent,args})=>{await userEvent.type(canvas.getByRole('textbox',{name:'New tab address'}),'https://example.invalid/catalog');await expect(args.onAddress).toHaveBeenCalled();await userEvent.keyboard('{Enter}');await expect(args.onOpen).toHaveBeenCalledWith('https://example.invalid/catalog');await expect(canvas.getByRole('button',{name:'Open'})).toBeDisabled();}};
export const StateSheet:Story={render:()=> <CatalogSheet frames={['empty','address','long-address','busy'].map(name=>({label:name,storyId:`workspace-home--${name}`,static:true}))}/>};
