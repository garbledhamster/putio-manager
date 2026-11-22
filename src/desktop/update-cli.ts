import type {DesktopUpdateStatus} from './update-types';
import {updateErrorCode,updateErrorMessage} from './update-errors';
import {stableVersion} from './update-release';
export type UpdateAction='status'|'check'|'install'|'cancel';
export interface UpdateControl {status():DesktopUpdateStatus;check():Promise<DesktopUpdateStatus>;install():Promise<DesktopUpdateStatus>;cancel():Promise<DesktopUpdateStatus>}
const actions:readonly string[]=['status','check','install','cancel'];
export function updateAction(args:readonly string[]):UpdateAction{if(args.length!==1||!actions.includes(args[0]))throw Error('update-failed');return args[0] as UpdateAction}
/** Explicitly select public fields. Never print an engine, adapter or request object. */
export function publicUpdateStatus(value:DesktopUpdateStatus):DesktopUpdateStatus{
  const copy:Record<DesktopUpdateStatus['phase'],string>={idle:'Check GitHub for a newer desktop version.',checking:'Checking the published GitHub release.',current:'This desktop version is up to date.',available:'A newer desktop version is available.',downloading:'Downloading the desktop update.',verifying:'Verifying the downloaded update.',ready:'The verified update is ready.',preparing:'Saving current work before the desktop restarts.',installing:'Installing the verified update and restarting the desktop.',updated:'The desktop update is installed.',cancelled:'The update operation was cancelled.',failed:'The app could not finish this update operation.',unavailable:'This copy cannot install updates automatically.'};
  if(!value||value.schema!==1||value.source!=='github'||!['windows','macos','linux','unsupported'].includes(value.platform)||!stableVersion(value.currentVersion)||typeof value.phase!=='string'||!Object.hasOwn(copy,value.phase)||!['automatic','unavailable'].includes(value.capability))throw Error('update-failed');
  const output:DesktopUpdateStatus={schema:1,source:'github',platform:value.platform,currentVersion:value.currentVersion,capability:value.capability,phase:value.phase,message:copy[value.phase],restartRequired:value.restartRequired===true};
  if(stableVersion(value.availableVersion))output.availableVersion=value.availableVersion;
  if(typeof value.progressPercent==='number'&&Number.isFinite(value.progressPercent))output.progressPercent=Math.min(100,Math.max(0,value.progressPercent));
  if(value.errorCode){const code=updateErrorCode({updateCode:value.errorCode});Object.assign(output,{errorCode:code,...updateErrorMessage(code)});}
  else if(value.phase==='available')output.nextAction=value.capability==='automatic'?'Select Update and restart when you are ready.':"Install the updating edition from the project's GitHub release page.";
  return output;
}
export async function performUpdateAction(service:UpdateControl,action:UpdateAction,acceptInstall=false):Promise<{ok:boolean;accepted?:boolean;value:DesktopUpdateStatus}>{
  if(action==='install'&&acceptInstall){void service.install().catch(()=>{});const value=publicUpdateStatus(service.status());const accepted=!['failed','unavailable'].includes(value.phase);return{ok:accepted,accepted,value}}
  const value=action==='status'?service.status():await service[action]();return{ok:action==='status'||value.phase!=='failed'&&value.phase!=='unavailable',value:publicUpdateStatus(value)};
}
export function updateCliFailure(error:unknown){const code=updateErrorCode(error);return{ok:false,error:{code,...updateErrorMessage(code)}}}
