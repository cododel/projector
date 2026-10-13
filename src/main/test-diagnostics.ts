import { pathToFileURL } from 'node:url';
import type { App } from 'electron';
import { diagnostic, installProcessDiagnostics } from '../shared/test-diagnostics';
// Register the monitor while this first main import is evaluated, before other
// application modules can fail during initialization.
installProcessDiagnostics('main');
export function observeElectron(app: App): void {
  if (!process.env.PROJECTOR_TEST_DIAGNOSTICS) return;
  installProcessDiagnostics('main');
  app.on('web-contents-created',(_event, contents) => {
    const classify = (source = contents.getURL()) => {
      if (source.startsWith('projector://document')) return {role:'document',external:false};
      if (source.startsWith('projector://app') || (process.env.ELECTRON_RENDERER_URL && source.startsWith(process.env.ELECTRON_RENDERER_URL))) return {role:'shell',external:false};
      if (process.env.PROJECTOR_COMPOSER_TEST_DATA && source.startsWith(pathToFileURL(process.env.PROJECTOR_COMPOSER_TEST_DATA + '/').href)) return {role:'shell-fixture',external:false};
      if (source.startsWith('data:')) return {role:'overlay',external:false};
      return {role:'external-page',external:true};
    };
    contents.on('console-message',details=>{
      const {role,external} = classify(details.sourceId || details.frame?.url || contents.getURL());
      diagnostic(role,'console-'+details.level,details.message,details.level==='error'?'error':details.level==='warning'?'warning':'info',{external,pid:details.frame?.osProcessId || contents.getOSProcessId(),workerId:`contents:${contents.id}/frame:${details.frame?.routingId ?? 'unknown'}`,stack:`${details.sourceId}:${details.lineNumber}`});
    });
    contents.on('preload-error',(_event,path,error)=>diagnostic('preload','preload-error',error.message,'error',{stack:path+'\n'+error.stack}));
    contents.on('render-process-gone',(_event,details)=>{
      if (details.reason==='clean-exit') return;
      const {role,external} = classify();
      diagnostic(role,'renderer-exit',`${details.reason}: ${details.exitCode}`,'error',{external,workerId:contents.id});
    });
  });
}
