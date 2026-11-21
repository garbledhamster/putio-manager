const fs = require('node:fs/promises');
const path = require('node:path');
const {createEngine} = require('../../dist/engine/engine');
const {startRemoteServer} = require('../../dist/server/server');
const {RemoteEngine} = require('../../dist/remote/client');
const credentials = {available:()=>false,encrypt:()=>{throw Error('unexpected')},decrypt:()=>{throw Error('unexpected')}};
async function start(dir,mode,gate,runtime) {
 const ledger = path.join(dir,'provider.json');
 const update = async fn => { const data=JSON.parse(await fs.readFile(ledger,'utf8'));fn(data);await fs.writeFile(ledger,JSON.stringify(data)); };
 const transport = async (input,init={}) => {
  const u=new URL(input),p=u.pathname;
  if(p==='/account/info')return Response.json({status:'OK'});
  if(p==='/files/1')return Response.json({status:'OK',file:{id:1,parent_id:20,name:'file.bin',file_type:'FILE',size:4}});
  if(p==='/files/20')return Response.json({status:'OK',file:{id:20,parent_id:0,name:'folder',file_type:'FOLDER',size:0}});
  if(p==='/files/list')return Response.json({status:'OK',files:[]});
  if(p==='/files/1/url')return Response.json({status:'OK',url:'http://fixture.test/bytes'});
  if(p==='/bytes'){await update(d=>d.downloads++);return new Response('data');}
  if(p==='/files/delete'){
   const id=String(init.body.get('file_ids'));await update(d=>{d.requests.push(id);if(!d.deleted.includes(id))d.deleted.push(id);});
   if(gate?.step===(id==='1'?'file':'folder') && gate.phase==='inflight'){process.send('boundary');await new Promise(()=>{});}
   return Response.json({status:'OK'});
  }
  throw Error('unexpected '+p);
 };
 if(gate?.phase==='outcome'){
  const rename=fs.rename;let held=false;
  fs.rename=async(from,to)=>{if(!held&&String(to).endsWith('engine.json')){const state=JSON.parse(await fs.readFile(from,'utf8'));if(Object.values(state.recovery||{}).some(r=>r.cleanup?.step===gate.step&&r.cleanup?.phase==='succeeded')){held=true;process.send('boundary');await new Promise(()=>{});}}return rename(from,to);};
 }
 const engine=await createEngine({stateDirectory:path.join(dir,'state'),credentials,token:'fixture',apiBase:'http://fixture.test/',transport,downloadRuntime:runtime,roots:[{id:'root',label:'Root',path:path.join(dir,'root')}]});
 let client=engine,server;const token='a'.repeat(43);if(mode==='remote'){server=await startRemoteServer(engine,{host:'127.0.0.1',port:0,clientToken:token});client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token});}
 return {engine,client,server,async reconnect(){await client.close();client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token});this.client=client;}};
}
if(process.argv[2]) (async()=>{const [dir,mode,step,phase]=process.argv.slice(2);const x=await start(dir,mode,{step,phase});await x.client.execute('selectDownloadRoot',['root']);await x.client.execute('downloadFile',['1',{deleteAfterDownload:true,deleteSourceFolders:step==='folder'}]);})().catch(e=>{process.send({error:e.message});process.exit(1);});
module.exports={start};
