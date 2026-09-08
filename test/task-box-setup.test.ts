import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {describe,it,expect} from 'vitest';

const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const start=source.indexOf('async function taskBoxSetup(');
const end=source.indexOf('\nchrome.runtime.onMessage.addListener',start);
const setupSource=source.slice(start,end)+'\nglobalThis.setup=taskBoxSetup;';
const setupUrl='chrome-extension://test-companion/task-box-setup.html';
const sender={id:'test-companion',url:setupUrl,frameId:0};
function harness(seed:Record<string,any>={},capable=true){
  const data=structuredClone(seed);let writes=0;let calls=0;
  const ctx:any={taskBox:{protocol:1},console,chrome:{runtime:{id:'test-companion',getURL:()=>setupUrl},storage:{local:{
    get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,structuredClone(data[k])])),
    set:async(values:Record<string,any>)=>{writes++;Object.assign(data,structuredClone(values));}
  }}},call:async(route:string)=>{calls++;expect(route).toBe('/task-box/capabilities');return {ok:capable,data:{protocol:1,supported:capable,atMostOnce:true,durableReceipts:true}};}};
  vm.runInNewContext(setupSource,ctx);
  return {data,setup:ctx.setup,writes:()=>writes,calls:()=>calls};
}
describe('TASK BOX explicit extension-origin cutover',()=>{
  it('refuses a ChatGPT page or another extension before reading capability or writing state',async()=>{
    const h=harness();
    for(const s of [{...sender,url:'https://chatgpt.com/'},{...sender,id:'other'},{...sender,frameId:1}]){
      expect((await h.setup({type:'clf-task-box-setup:enable',oldExtensionDisabled:true,previousOutcomeReviewed:true},s)).ok).toBe(false);
    }
    expect(h.calls()).toBe(0);expect(h.writes()).toBe(0);
  });
  it('requires capability plus both human acknowledgements; never resets lifecycle',async()=>{
    const h=harness({taskBoxCreationGlobal:{state:'present',generation:4}});
    expect((await h.setup({type:'clf-task-box-setup:enable'},sender)).ok).toBe(false);
    expect(h.writes()).toBe(0);
    expect((await h.setup({type:'clf-task-box-setup:enable',oldExtensionDisabled:true,previousOutcomeReviewed:true},sender)).ok).toBe(true);
    expect(h.data.taskBoxCreationGlobal).toEqual({state:'present',generation:4});
    expect(h.data.taskBoxIntegrationEnabled).toBe(true);
    expect(h.data.taskBoxCutoverReceipt).toMatchObject({legacyOperationReplayed:false,legacyOperationDeclaredComplete:false,oldExtensionDisabled:'human-attested'});
    const old=harness({},false);
    expect((await old.setup({type:'clf-task-box-setup:enable',oldExtensionDisabled:true,previousOutcomeReviewed:true},sender)).ok).toBe(false);
    expect(old.writes()).toBe(0);
  });
  it('cannot release a pending operation through setup or report it as ready',async()=>{
    const seed={taskBoxCreationGlobal:{state:'deleting',generation:0,requestId:'uncertain'}};
    const h=harness(seed);
    for(const type of ['clf-task-box-setup:status','clf-task-box-setup:enable']){
      expect(await h.setup({type,oldExtensionDisabled:true,previousOutcomeReviewed:true},sender)).toMatchObject({ok:false,error:'TASK_BOX_LIFECYCLE_BLOCKED'});
    }
    expect(h.data).toEqual(seed);expect(h.writes()).toBe(0);
  });
});
