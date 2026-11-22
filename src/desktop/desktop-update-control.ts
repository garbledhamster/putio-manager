import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateUpdateDirectory} from './update-transfer';
import {updateAction, type UpdateAction} from './update-cli';
const nonce=/^control-[0-9a-f-]{36}$/;
/** Same-user single-instance handoff. Only a private nonce crosses Electron's process event. */
export async function createUpdateRequest(userData:string,action:UpdateAction):Promise<string>{
  const directory=await privateUpdateDirectory(userData,'control-');
  // mkdtemp's short suffix is replaced by a full unpredictable request ID.
  const destination=path.join(path.dirname(directory),'control-'+randomUUID());await fs.rename(directory,destination);
  await fs.writeFile(path.join(destination,'request.json'),JSON.stringify({schema:1,action})+'\n',{mode:0o600,flag:'wx'});return path.basename(destination);
}
async function requestDirectory(userData:string,id:unknown):Promise<string>{
  if(typeof id!=='string'||!nonce.test(id))throw Error('update-failed');
  const profile=await fs.realpath(path.resolve(userData));
  const directory=path.join(profile,'desktop-updates',id),info=await fs.lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(directory)!==directory||(process.platform!=='win32'&&(info.mode&0o077)!==0))throw Error('update-failed');return directory;
}
export async function consumeUpdateRequest(userData:string,id:unknown):Promise<UpdateAction>{
  const directory=await requestDirectory(userData,id),file=path.join(directory,'request.json'),info=await fs.lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024||Date.now()-info.mtimeMs>120000)throw Error('update-failed');
  const input=JSON.parse(await fs.readFile(file,'utf8'));if(input.schema!==1||Object.keys(input).some(k=>!['schema','action'].includes(k)))throw Error('update-failed');
  const action=updateAction([input.action]);await fs.rename(file,path.join(directory,'consumed.json'));return action;
}
export async function replyUpdateRequest(userData:string,id:unknown,value:unknown):Promise<void>{
  const directory=await requestDirectory(userData,id);const data=JSON.stringify(value)+'\n';if(data.length>8192)throw Error('update-failed');
  await fs.writeFile(path.join(directory,'response.tmp'),data,{mode:0o600,flag:'wx'});await fs.rename(path.join(directory,'response.tmp'),path.join(directory,'response.json'));
}
export async function waitUpdateResponse(userData:string,id:string):Promise<unknown>{
  const directory=await requestDirectory(userData,id),deadline=Date.now()+60000;
  try{while(Date.now()<deadline){const file=path.join(directory,'response.json'),info=await fs.lstat(file).catch(()=>undefined);if(info){if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw Error('update-failed');return JSON.parse(await fs.readFile(file,'utf8'))}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('app-busy')}
  finally{await removeUpdateRequest(userData,id)}
}
export async function removeUpdateRequest(userData:string,id:string):Promise<void>{
  const directory=await requestDirectory(userData,id).catch(()=>undefined);if(!directory)return;
  for(const name of['request.json','consumed.json','response.json','response.tmp'])await fs.unlink(path.join(directory,name)).catch(()=>{});await fs.rmdir(directory).catch(()=>{});
}
