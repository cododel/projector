import React from 'react';
import type { HarnessSession, HarnessSnapshot } from '../../src/shared/harness';
import type { TerminalRecord } from '../../src/shared/terminal';
export const project = { id: 'catalog-project', path: '/example/catalog-project', available: true };
export const session: HarnessSession = { id: 'catalog-session', harness: 'codex', projectId: project.id, cwd: project.path, title: 'Review interface states', updatedAt: 0, status: 'idle', processState: 'stopped' };
export const terminal: TerminalRecord = { id: 'catalog-terminal', projectId: project.id, cwd: project.path, kind: 'shell', title: 'Project terminal', createdAt: '2026-10-13T00:00:00Z', status: 'running', exitCode: null };
export const harnesses: HarnessSnapshot = { sessions: [session], compatibility: null, error: null, mcpStartup: [] };
export function Stage({ children, height = 430 }: { children: React.ReactNode; height?: number }) { return <div style={{ position: 'relative', display: 'flex', width: '100%', minWidth: 0, height }}>{children}</div>; }

import { useState,useSyncExternalStore } from 'react';
import { NotificationProvider } from '../../src/renderer/NotificationContext';
import { NotificationController } from '../../src/renderer/notifications';
import { NotificationStack } from '../../src/renderer/NotificationStack';
import type { NotificationOverlayBridge,NotificationTransport } from '../../src/shared/notifications';
function LocalNotices({controller}:{controller:NotificationController}){
 const notices=useSyncExternalStore(controller.subscribe,controller.snapshot);
 const [bridge]=useState<NotificationOverlayBridge>(()=>({command:command=>{if(command.type==='dismiss')controller.dismiss(command.id);if(command.type==='action')void controller.run(command.id,command.actionId);},onState:()=>()=>{},onFocus:()=>()=>{},onPointer:()=>()=>{}}));
 return <div style={{position:'fixed',zIndex:2000,top:16,left:'50%',transform:'translateX(-50%)',width:'min(620px, 100%)'}}><NotificationStack notifications={notices} visible maxHeight={480} bridge={bridge}/></div>;
}
export function Isolated({children,count=0,transport,showNotices=true}:{children:React.ReactNode;count?:number;transport?:NotificationTransport;showNotices?:boolean}){
 const [controller]=useState(()=>{const c=new NotificationController();for(let i=0;i<count;i++)c.push({source:'catalog',context:`${i}`,operation:`${i}`,level:'info',title:`Local notice ${i+1}`});return c;});
 return <NotificationProvider controller={controller} transport={transport}>{children}{showNotices&&<LocalNotices controller={controller}/>}</NotificationProvider>;
}
