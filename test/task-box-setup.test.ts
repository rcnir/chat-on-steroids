import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {describe,it,expect,vi} from 'vitest';
// @ts-expect-error Production patcher modules are intentionally plain ESM without a declaration sidecar.
import {composeBackground} from '../patcher/task-box/extension-adapter.mjs';

const repo=process.cwd();
const official=execFileSync('git',['show','v2.0.6:extension/background.js'],{cwd:repo,encoding:'utf8'});
const source=composeBackground(official,{appVersion:'2.0.6',featureVersion:'task-box-test',protocol:1});
const start=source.indexOf('async function taskBoxSetup(');
const end=source.indexOf('\nchrome.runtime.onMessage.addListener',start);
const setupSource=source.slice(start,end)+'\nglobalThis.setup=taskBoxSetup;';
const setupUrl='chrome-extension://test-companion/task-box-setup.html';
const sender={id:'test-companion',url:setupUrl,frameId:0};
const setupHtml=readFileSync(new URL('../patcher/task-box/extension/task-box-setup.html',import.meta.url),'utf8');
const setupJs=readFileSync(new URL('../patcher/task-box/extension/task-box-setup.js',import.meta.url),'utf8');
function harness(seed:Record<string,any>={},capable=true,receiptCompleted=true){
  const data=structuredClone(seed);let writes=0;let calls=0;let recoveries=0;let recoveryChecks=0;let cleanupRecoveries=0;let cleanupRecoveryChecks=0;
  const taskBox:any={protocol:1};
  taskBox.manualDeletionRecoveryStatus=async(requestId:string,generation:number)=>{
    recoveryChecks++;
    const current=data.taskBoxCreationGlobal;
    if(current?.state!=='deleting'||current?.kind!=='clear'||current?.clearCompleted!==true||
        current.requestId!==requestId||current.generation!==generation){
      return {ok:false,error:'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE'};
    }
    if(!receiptCompleted) return {ok:false,error:'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE'};
    return {ok:true,recoveryRequired:true,requestId,generation};
  };
  taskBox.recoverManualDeletion=async(requestId:string,generation:number)=>{
    const verified=await taskBox.manualDeletionRecoveryStatus(requestId,generation);
    if(!verified.ok) return verified;
    recoveries++;
    const current=data.taskBoxCreationGlobal;
    if(current?.state!=='deleting'||current?.kind!=='clear'||current?.clearCompleted!==true||
        current.requestId!==requestId||current.generation!==generation){
      return {ok:false,error:'TASK_BOX_MANUAL_RECOVERY_NOT_AVAILABLE'};
    }
    data.taskBoxCreationGlobal={state:'open',generation:generation+1};
    return {ok:true,recovered:true,state:'open',generation:generation+1};
  };
  taskBox.cleanupRecoveryStatus=async(requestId:string,generation:number)=>{
    cleanupRecoveryChecks++;
    const current=data.taskBoxCreationGlobal;
    if(current?.state!=='reserved'||current?.mode!=='cleanup'||current.requestId!==requestId||current.generation!==generation){
      return {ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_NOT_AVAILABLE'};
    }
    return {ok:true,recoveryRequired:true,requestId,generation};
  };
  taskBox.recoverCleanupReservation=async(requestId:string,generation:number)=>{
    const verified=await taskBox.cleanupRecoveryStatus(requestId,generation);
    if(!verified.ok) return verified;
    cleanupRecoveries++;
    data.taskBoxCreationGlobal={state:'present',generation};
    return {ok:true,recovered:true,state:'present',generation,repairTabClosed:true};
  };
  const ctx:any={taskBox,TASK_BOX_CONTRACT:{protocol:1},console,URLSearchParams,chrome:{runtime:{id:'test-companion',getURL:()=>setupUrl},storage:{local:{
    get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,structuredClone(data[k])])),
    set:async(values:Record<string,any>)=>{writes++;Object.assign(data,structuredClone(values));}
  }}},call:async(route:string)=>{
    calls++;
    if(route==='/task-box/capabilities') return {ok:capable,data:{protocol:1,supported:capable,atMostOnce:true,durableReceipts:true}};
    throw new Error(`unexpected ${route}`);
  }};
  vm.runInNewContext(setupSource,ctx);
  return {data,setup:ctx.setup,writes:()=>writes,calls:()=>calls,recoveries:()=>recoveries,recoveryChecks:()=>recoveryChecks,
    cleanupRecoveries:()=>cleanupRecoveries,cleanupRecoveryChecks:()=>cleanupRecoveryChecks};
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

  it('offers only exact completed-Clear manual-deletion recovery and requires explicit human attestation',async()=>{
    const seed={taskBoxIntegrationEnabled:true,taskBoxCreationGlobal:{
      state:'deleting',generation:14,kind:'clear',requestId:'11111111-2222-4333-8444-555555555551',
      owner:{tabId:17,documentId:'document-17'},clearCompleted:true
    }};
    const h=harness(seed);
    expect(await h.setup({type:'clf-task-box-setup:status'},sender)).toMatchObject({
      ok:true,enabled:true,recoveryRequired:true,recoveryRequestId:seed.taskBoxCreationGlobal.requestId,recoveryGeneration:14
    });
    expect((await h.setup({type:'clf-task-box-setup:recover-manual-delete',requestId:seed.taskBoxCreationGlobal.requestId,generation:14,
      previousOutcomeReviewed:true},sender)).ok).toBe(false);
    expect(h.recoveries()).toBe(0);
    const recovered=await h.setup({type:'clf-task-box-setup:recover-manual-delete',
      requestId:seed.taskBoxCreationGlobal.requestId,generation:14,
      previousOutcomeReviewed:true,manualProjectDeletionConfirmed:true},sender);
    expect(recovered).toMatchObject({ok:true,recovered:true,state:'open',generation:15});
    expect(h.recoveries()).toBe(1);
    expect(h.data.taskBoxCreationGlobal).toEqual({state:'open',generation:15});

    const unconfirmed=harness(seed,true,false);
    expect(await unconfirmed.setup({type:'clf-task-box-setup:status'},sender)).toMatchObject({
      ok:false,error:'TASK_BOX_LIFECYCLE_BLOCKED'
    });
    expect(unconfirmed.recoveries()).toBe(0);
  });

  it('binds the setup recovery action to the exact status request and generation',async()=>{
    const seed={taskBoxIntegrationEnabled:true,taskBoxCreationGlobal:{
      state:'deleting',generation:14,kind:'clear',requestId:'11111111-2222-4333-8444-555555555551',
      owner:{tabId:17,documentId:'document-17'},clearCompleted:true
    }};
    for(const message of [
      {requestId:'33333333-4444-4555-8666-777777777771',generation:14},
      {requestId:seed.taskBoxCreationGlobal.requestId,generation:13},
      {requestId:seed.taskBoxCreationGlobal.requestId,generation:14,manualProjectDeletionConfirmed:false}
    ]){
      const h=harness(seed);
      const result=await h.setup({type:'clf-task-box-setup:recover-manual-delete',previousOutcomeReviewed:true,
        manualProjectDeletionConfirmed:true,...message},sender);
      expect(result.ok).toBe(false);
      expect(h.recoveries()).toBe(0);
      expect(h.data).toEqual(seed);
    }
  });

  it('offers orphaned cleanup recovery only for the exact reserved cleanup and requires both acknowledgements',async()=>{
    const requestId='11111111-2222-4333-8444-555555555551';
    const seed={taskBoxIntegrationEnabled:true,taskBoxCreationGlobal:{
      state:'reserved',generation:15,mode:'cleanup',requestId,owner:{tabId:17,documentId:'document-17'}
    }};
    const h=harness(seed);
    expect(await h.setup({type:'clf-task-box-setup:status'},sender)).toMatchObject({
      ok:true,enabled:true,cleanupRecoveryRequired:true,cleanupRecoveryRequestId:requestId,cleanupRecoveryGeneration:15
    });
    expect(h.cleanupRecoveryChecks()).toBe(1);
    for(const message of [
      {requestId,generation:15,previousOutcomeReviewed:false,inactiveRepairTabApproved:true},
      {requestId,generation:15,previousOutcomeReviewed:true,inactiveRepairTabApproved:false},
      {requestId:'33333333-4444-4555-8666-777777777771',generation:15,previousOutcomeReviewed:true,inactiveRepairTabApproved:true},
      {requestId,generation:14,previousOutcomeReviewed:true,inactiveRepairTabApproved:true}
    ]){
      expect(await h.setup({type:'clf-task-box-setup:recover-cleanup',...message},sender))
        .toMatchObject({ok:false,error:'TASK_BOX_CLEANUP_RECOVERY_CONFIRMATION_REQUIRED'});
      expect(h.cleanupRecoveries()).toBe(0);
    }
    expect(await h.setup({
      type:'clf-task-box-setup:recover-cleanup',requestId,generation:15,
      previousOutcomeReviewed:true,inactiveRepairTabApproved:true
    },sender)).toMatchObject({ok:true,recovered:true,state:'present',generation:15});
    expect(h.cleanupRecoveries()).toBe(1);
    expect(h.data.taskBoxCreationGlobal).toEqual({state:'present',generation:15});
  });

  it('shows a dedicated recovery confirmation and sends the exact status binding only after both acknowledgements',async()=>{
    const requestId='11111111-2222-4333-8444-555555555551';
    const sendMessage=vi.fn(async(message:any)=>{
      if(message.type==='clf-task-box-setup:status') return {
        ok:true,available:true,enabled:true,recoveryRequired:true,recoveryRequestId:requestId,recoveryGeneration:14
      };
      if(message.type==='clf-task-box-setup:recover-manual-delete') return {ok:true,recovered:true,state:'open',generation:15};
      throw new Error(`unexpected ${message.type}`);
    });
    const dom=new JSDOM(setupHtml,{url:setupUrl,runScripts:'outside-only'});
    Object.assign(dom.window,{chrome:{runtime:{sendMessage}}});
    dom.window.eval(setupJs);
    const document=dom.window.document;
    await vi.waitFor(()=>expect((document.getElementById('recovery') as HTMLElement).hidden).toBe(false));
    expect((document.getElementById('cutover') as HTMLElement).hidden).toBe(true);
    const button=document.getElementById('recover') as HTMLButtonElement;
    const reviewed=document.getElementById('recoveryReviewed') as HTMLInputElement;
    const deleted=document.getElementById('manualDeleted') as HTMLInputElement;
    expect(button.disabled).toBe(true);
    reviewed.click(); expect(button.disabled).toBe(true);
    deleted.click(); expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(()=>expect(sendMessage.mock.calls.some(([message])=>message.type==='clf-task-box-setup:recover-manual-delete')).toBe(true));
    const recoveryCall=sendMessage.mock.calls.find(([message])=>message.type==='clf-task-box-setup:recover-manual-delete')?.[0];
    expect(recoveryCall).toEqual({
      type:'clf-task-box-setup:recover-manual-delete',requestId,generation:14,
      previousOutcomeReviewed:true,manualProjectDeletionConfirmed:true
    });
    await vi.waitFor(()=>expect(sendMessage.mock.calls.filter(([message])=>message.type==='clf-task-box-setup:status')).toHaveLength(2));
    await vi.waitFor(()=>expect(button.disabled).toBe(false));
    dom.window.close();
  });

  it('shows cleanup recovery separately and sends its exact request only after both acknowledgements',async()=>{
    const requestId='11111111-2222-4333-8444-555555555551';
    let recovered=false;
    const sendMessage=vi.fn(async(message:any)=>{
      if(message.type==='clf-task-box-setup:status') return recovered
        ? {ok:true,available:true,enabled:true}
        : {ok:true,available:true,enabled:true,cleanupRecoveryRequired:true,cleanupRecoveryRequestId:requestId,cleanupRecoveryGeneration:15};
      if(message.type==='clf-task-box-setup:recover-cleanup') {
        recovered=true;
        return {ok:true,recovered:true,state:'present',generation:15,repairTabClosed:true};
      }
      throw new Error(`unexpected ${message.type}`);
    });
    const dom=new JSDOM(setupHtml,{url:setupUrl,runScripts:'outside-only'});
    Object.assign(dom.window,{chrome:{runtime:{sendMessage}}});
    dom.window.eval(setupJs);
    const document=dom.window.document;
    await vi.waitFor(()=>expect((document.getElementById('cleanupRecovery') as HTMLElement).hidden).toBe(false));
    expect((document.getElementById('cutover') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('recovery') as HTMLElement).hidden).toBe(true);
    const button=document.getElementById('recoverCleanup') as HTMLButtonElement;
    const reviewed=document.getElementById('cleanupReviewed') as HTMLInputElement;
    const approved=document.getElementById('inactiveRepairApproved') as HTMLInputElement;
    expect(button.disabled).toBe(true);
    reviewed.click(); expect(button.disabled).toBe(true);
    approved.click(); expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(()=>expect(sendMessage.mock.calls.some(([message])=>message.type==='clf-task-box-setup:recover-cleanup')).toBe(true));
    const recoveryCall=sendMessage.mock.calls.find(([message])=>message.type==='clf-task-box-setup:recover-cleanup')?.[0];
    expect(recoveryCall).toEqual({
      type:'clf-task-box-setup:recover-cleanup',requestId,generation:15,
      previousOutcomeReviewed:true,inactiveRepairTabApproved:true
    });
    await vi.waitFor(()=>expect(sendMessage.mock.calls.filter(([message])=>message.type==='clf-task-box-setup:status')).toHaveLength(2));
    await vi.waitFor(()=>expect((document.getElementById('cleanupRecovery') as HTMLElement).hidden).toBe(true));
    dom.window.close();
  });
});
