const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {presentUserError}=require('../dist/messages/user-messages.js');

test('agent startup rejection returns controlled JSON without raw diagnostics',()=>{
  const source=fs.readFileSync('dist/desktop/main.js','utf8');
  const start=source.lastIndexOf('}).catch(error => {');
  const end=source.indexOf('\nelectron_1.app.on(',start);
  assert.ok(start>=0&&end>start);
  const handler=source.slice(start+'}).catch('.length,end).replace(/;\s*$/,'').slice(0,-1);
  const output=[],exits=[];
  const {safeAgentError}=require('../dist/server/agent-cli.js');
  const context={agentMode:true,console:{log(value){output.push(value)},error(){assert.fail('Raw diagnostic output')}},electron_1:{app:{exit(code){exits.push(code)}}},agent_cli_1:{safeAgentError}};
  const reject=vm.runInNewContext('('+handler+')',context);
  reject(new Error('PRIVATE_TOKEN_SENTINEL /private/path?token=secret'));
  assert.deepEqual(exits,[1]);
  assert.equal(output.length,1);
  assert.equal(JSON.parse(output[0]).ok,false);
  assert.ok(!/PRIVATE_TOKEN_SENTINEL|private\/path|token=secret/.test(output[0]));
});

test('actual download renderer translates saved remote errors and warnings without a GUI',()=>{
  const source=fs.readFileSync('dist/ui/renderer.js','utf8');
  const start=source.indexOf('function renderDownloads()');
  const end=source.indexOf('function transferStatusText(',start);
  assert.ok(start>=0&&end>start);
  const messages=[];
  const node=(tag,text='')=>({tag,textContent:text,dataset:{},children:[],append(...children){this.children.push(...children)},setAttribute(){}});
  const raw=['Staging anchor cleanup requires attention.','Published destination could not be verified.',"The previous download's partial file was unavailable during migration.",'Download failed.','Destination already exists; its contents were not verified.'];
  const jobs=raw.map((error,index)=>({id:'generated-'+index,name:'example-data.bin',destination:'/fictional/downloads/example-data.bin',status:'needs-attention',error,bytesReceived:0,totalBytes:128,addedAt:'2026-01-01T00:00:00Z'}));
  jobs.push({...jobs[0],id:'generated-complete',status:'completed',error:undefined,verification:'verified',stagingWarning:'The verified output is safe, but its staged copy could not be removed.'});
  const body=node('tbody');
  const context={presentUserError,state:{jobs,target:{mode:'remote'}},selectedJob:undefined,downloadSort:undefined,title(){},table(){return body},node,downloadType(){return'BIN'},compactDate(){return''},size:String,speedText(){return'Unlimited'},rowSelect(){},addRowContext(){},setCopyableMessage(_element,message){messages.push(message)}};
  vm.runInNewContext(source.slice(start,end)+'\nrenderDownloads();',context);
  assert.equal(body.children.length,6);
  for(const error of raw)assert.ok(!messages.some(message=>message.includes(error)),error);
  assert.ok(messages.some(message=>/download server/.test(message)));
  assert.ok(messages.every(message=>!/(?:anchor|artifact|inode|migration|published destination)/i.test(message)));
  assert.ok(messages.some(message=>/verified|complete/i.test(message)));
});

test('provider transfer text cannot become a raw end-user error',()=>{
  const source=fs.readFileSync('dist/ui/renderer.js','utf8');
  const start=source.indexOf('function transferStatusText('),end=source.indexOf('function renderTransfers()',start);
  const context={};vm.runInNewContext(source.slice(start,end)+'\nglobalThis.show=transferStatusText;',context);
  assert.equal(context.show('COMPLETED'),'Completed');
  assert.match(context.show('ERROR'),/Check the transfer on put.io/);
  assert.ok(!context.show('PRIVATE_TOKEN_SENTINEL /private/path').includes('PRIVATE_TOKEN_SENTINEL'));
});
