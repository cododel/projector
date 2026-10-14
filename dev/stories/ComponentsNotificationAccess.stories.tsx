import {CatalogSheet} from '../fixtures/CatalogSheet';
import React from 'react';
import type {Meta,StoryObj} from '@storybook/react-vite';
import {expect,fn} from 'storybook/test';
import {NotificationAccess} from '../../src/renderer/NotificationAccess';
import type {NotificationTransport} from '../../src/shared/notifications';
import {Isolated} from '../fixtures/components';
const transport:NotificationTransport={publish:async()=>{},onCommand:()=>()=>{},focus:fn()};
function Fixture({count,available,dialog}:{count:number;available:boolean;dialog:boolean}){return <Isolated count={count} transport={available?transport:undefined} showNotices={false}>{dialog?<section className="modal" role="dialog" aria-label="Local dialog"><div className="modal-heading"><h2>Local dialog</h2><NotificationAccess/></div></section>:<NotificationAccess/>}</Isolated>;}
const meta={title:'Notifications/Access',component:Fixture,args:{count:0,available:true,dialog:false}} satisfies Meta<typeof Fixture>;
export default meta;type Story=StoryObj<typeof meta>;
export const Empty:Story={parameters:{catalog:{states:["notification-access.empty"],transitions:[]}},play:async({canvas})=>{await expect(canvas.queryByRole('button')).not.toBeInTheDocument();}};
export const Count:Story={args:{count:3},parameters:{catalog:{states:["notification-access.count"],transitions:["notification-access.focus"]}},play:async({canvas,userEvent})=>{await userEvent.click(canvas.getByRole('button',{name:'Notifications · 3'}));await expect(transport.focus).toHaveBeenCalled();}};
export const NoTransport:Story={args:{count:3,available:false},parameters:{catalog:{states:["notification-access.no-transport"],transitions:[]}},play:async({canvas})=>{await expect(canvas.queryByRole('button')).not.toBeInTheDocument();}};
export const Dialog:Story={args:{count:1,dialog:true},parameters:{catalog:{states:["notification-access.dialog"],transitions:[]}}};

export const StateSheet:Story={render:()=> <CatalogSheet height={220} frames={['empty', 'count', 'no-transport', 'dialog'].map(name=>({label:name,storyId:`notifications-access--${name}`,static:true}))}/>};
