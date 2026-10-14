import type {TerminalBridge} from '../../src/renderer/TerminalPane';
import type {TerminalOutput,TerminalScreen,TerminalReplay} from '../../src/shared/terminal';
/** Synthetic input boundary only. Real TerminalOutputReader + xterm own rendering/order. */
export function terminalAdapter(id:string,truncated:boolean,onStatus:(status:'running'|'exited')=>void){
 let seq=0;const listeners=new Set<(event:TerminalOutput)=>void>();const calls:{method:string;params?:Record<string,unknown>}[]=[];
 const emit=(data:string)=>{const event:TerminalOutput={id,generation:'catalog',seq:++seq,data};for(const listener of listeners)listener(event);};
 const bridge:TerminalBridge={
  invoke:async(method,params)=>{calls.push({method,params});if(method==='terminalScreen'){const screen:TerminalScreen={id,generation:'catalog',seq,cols:80,rows:24,content:'Projector catalog terminal\r\nSynthetic saved output. No process is running.\r\n$ ',truncated};return screen;}if(method==='terminalReplay'){const replay:TerminalReplay={id,generation:'catalog',seq,events:[],gap:false};return replay;}if(method==='terminalResize')return {resized:true};if(method==='terminalStop'){onStatus('exited');return null;}if(method==='terminalRestart'){onStatus('running');return null;}if(method==='terminalInput'){emit(String(params?.data??''));return null;}throw new Error(`Unexpected catalog terminal command: ${method}`);},
  onTerminalOutput:callback=>{listeners.add(callback);return()=>listeners.delete(callback);},
  getPathForFile:file=>`/example/catalog-project/${file.name}`,
 };
 return {bridge,calls,emit};
}
