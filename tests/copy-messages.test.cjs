const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function loadUI(file, globals = {}) {
  const source = fs.readFileSync(`dist/ui/${file}.js`, 'utf8');
  const names = file === 'copy-message' ? 'setCopyableMessage,makeParagraphsCopyable' : 'canCheckRules,requestRuleCheck';
  const context = {...globals};
  vm.runInNewContext(source.replace(/export /g, '') + `\nglobalThis.result={${names}};`, context);
  return context.result;
}
function element(tag) {
  return {tag, children:[], attrs:{}, textContent:'', get childElementCount(){return this.children.length;}, replaceChildren(){this.children=[];}, append(...items){this.children.push(...items);}, setAttribute(k,v){this.attrs[k]=v;}, addEventListener(type,fn){this[type]=fn;}};
}
test('copy control writes only the complete displayed message and reports success or failure', async () => {
  const writes = []; let fail = false;
  const {setCopyableMessage} = loadUI('copy-message',{document:{createElement:element},navigator:{clipboard:{async writeText(s){if(fail) throw Error('denied'); writes.push(s);}}}});
  const box = element('div'), message = 'Copy paused: partial file retained.\nPlease retry.';
  setCopyableMessage(box,message);
  const [text,button,feedback]=box.children;
  assert.equal(text.textContent,message); assert.equal(button.attrs['aria-label'],'Copy message to clipboard'); assert.equal(feedback.attrs.role,'status');
  let stopped=false; await button.click({stopPropagation(){stopped=true;}});
  assert.equal(stopped,true);assert.deepEqual(writes,[message]);assert.equal(feedback.textContent,'Copied.');
  setCopyableMessage(box,message);assert.equal(box.children[1],button);assert.equal(feedback.textContent,'Copied.');
  fail=true;await button.click({stopPropagation(){}});assert.equal(feedback.textContent,'Could not copy.');assert.deepEqual(writes,[message]);
  setCopyableMessage(box,'New detail');assert.notEqual(box.children[1],button);assert.equal(box.children[0].textContent,'New detail');
  setCopyableMessage(box,'');assert.equal(box.children.length,0);
});
test('paused rule checks cannot be requested; resuming allows the request', () => {
  const {canCheckRules,requestRuleCheck}=loadUI('rule-check');let calls=0;
  assert.equal(canCheckRules(true,1,true),false);requestRuleCheck(true,()=>calls++);assert.equal(calls,0);
  assert.equal(canCheckRules(true,1,false),true);requestRuleCheck(false,()=>calls++);assert.equal(calls,1);
  assert.equal(canCheckRules(false,1,false),false);assert.equal(canCheckRules(true,0,false),false);
});
test('native message copy shows feedback and never copies unrelated content', async () => {
  const {showCopyableDialog}=require('../dist/desktop/copy-dialog.js');
  const seen=[],copies=[];let replies=[1,0];
  await showCopyableDialog('Transfer added to put.io.',async detail=>{seen.push(detail);return replies.shift();},text=>copies.push(text));
  assert.deepEqual(copies,['Transfer added to put.io.']);assert.deepEqual(seen,['','Copied.']);
  replies=[1,0];seen.length=0;
  await showCopyableDialog('Could not add the transfer.',async detail=>{seen.push(detail);return replies.shift();},()=>{throw Error('denied');});
  assert.deepEqual(seen,['','Could not copy.']);
});
test('rules toolbar disables paused checks and guarded handler dispatches only after resume', async () => {
  const source=fs.readFileSync('dist/ui/renderer.js','utf8');
  const toolbar=source.slice(source.indexOf('function renderToolbar()'),source.indexOf('function render()'));
  const state={hasToken:true,rules:[{id:'r'}],paused:true};let calls=0;
  const actions={items:[],replaceChildren(){this.items=[]},append(...items){this.items.push(...items)}};
  const context={state,current:'rules',navigation:{replaceChildren(){},append(){}},actions,selectedFile:null,selectedRule:null,
    tool:(id,label,image,handler,disabled)=>({id,label,handler,disabled}),
    api:{checkRules:async()=>{calls++;}},run:async op=>op(),
    canCheckRules:(has,count,paused)=>has&&count>0&&!paused,
    requestRuleCheck:(paused,fn)=>{if(!paused)fn();}};
  vm.runInNewContext(toolbar+'\nglobalThis.draw=renderToolbar;',context);
  context.draw();let check=actions.items.find(x=>x.id==='rules-check');assert.equal(check.disabled,true);assert.match(check.label,/paused/);check.handler();assert.equal(calls,0);
  state.paused=false;context.draw();check=actions.items.find(x=>x.id==='rules-check');assert.equal(check.disabled,false);check.handler();await Promise.resolve();assert.equal(calls,1);
});

test('rendered paragraphs preserve embedded form controls and copy only plain message text', async () => {
  const writes=[]; const {makeParagraphsCopyable}=loadUI('copy-message',{document:{createElement:element},navigator:{clipboard:{async writeText(text){writes.push(text)}}}});
  const plain=element('p');plain.textContent='Visible explanation';
  const field=element('p');field.textContent='Visible label';const input=element('input');input.value='private input';field.append(input);
  makeParagraphsCopyable({querySelectorAll(){return [plain,field]}});
  assert.equal(field.children[0],input);assert.equal(field.children.length,1);assert.equal(input.value,'private input');
  await plain.children[1].click({stopPropagation(){}});assert.deepEqual(writes,['Visible explanation']);
});
