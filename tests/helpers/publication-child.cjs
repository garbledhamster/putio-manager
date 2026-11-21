const fs = require('node:fs/promises');
const path = require('node:path');
const {createEngine}=require('../../dist/engine/engine');
const {startRemoteServer}=require('../../dist/server/server');
const {RemoteEngine}=require('../../dist/remote/client');
const credentials={available:()=>false,encrypt:()=>{throw Error('unexpected')},decrypt:()=>{throw Error('unexpected')}};
const transport=async input=> {const p=new URL(input).pathname; if(p==='/account/info') return Response.json({status:'OK'}); if(p==='/files/1') return Response.json({status:'OK',file:{id:1,parent_id:0,name:'file.bin',file_type:'FILE',size:4}}); if(p==='/files/1/url') return Response.json({status:'OK',url:'http://fixture.test/bytes'}); if(p==='/bytes') return new Response('data'); throw Error('unexpected '+p);};
const options=dir=>({stateDirectory:path.join(dir,'state'),credentials,token:'fixture',apiBase:'http://fixture.test/',transport,roots:[{id:'root',label:'Root',path:path.join(dir,'root')}]});
async function start(dir,mode) {const engine=await createEngine(options(dir)); let client=engine,server; if(mode==='remote'){const token='a'.repeat(43); server=await startRemoteServer(engine,{host:'127.0.0.1',port:0,clientToken:token}); client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token});} return {engine,client,server};}
if (process.argv[2]) (async()=>{ const [dir,mode,gate]=process.argv.slice(2); if(gate==='after-save') { const original=fs.unlink; fs.unlink=async(...args)=>{ if(String(args[0]).endsWith('.download')) { process.send('saved'); await new Promise(()=>{}); } return original(...args); }; } else { const original=fs.link; fs.link=async(...args)=>{await original(...args); process.send('published'); await new Promise(()=>{});}; } const {client}=await start(dir,mode); await client.execute('selectDownloadRoot',['root']); await client.execute('downloadFile',['1']); })().catch(e=>{process.send({error:e.message});process.exit(1)});
module.exports={start};
