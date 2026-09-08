import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'unknown',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (buffer: Buffer) => ({result:buffer.toString(),shouldReEncrypt:false})
  }, clipboard:{}, shell:{}
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { initDurableStore, writeDurableNow, flushDurable, resetDurableForTests } = await import('../src/main/durable.js');
const { startBridge, shutdownBridge, resetBridgeForTests, setBrowserOpener } = await import('../src/main/bridge.js');
const { spawn, restoreSwarm, snapshotSwarm, onSwarmPersistNow, onRetiredWorkersPersistNow } = await import('../src/main/agents.js');
const { BRIDGE_PROTOCOL, APP_VERSION } = await import('../src/main/version.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const owner = {tabId:7,documentId:'test-document'};
const id = '11111111-2222-4333-8444-555555555555';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let dir = '';
let port = 0;
let barriers = 0;

function request(method:string, route:string, body?:unknown, options:{auth?:boolean;origin?:string;protocol?:number} = {}) {
  return new Promise<{status:number;body:any}>((resolve,reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({hostname:'127.0.0.1',port,path:route,method,headers:{
      origin:options.origin ?? origin,
      ...(options.auth === false ? {} : {authorization:'Bearer isolated-task-box-token'}),
      'x-extension-version':APP_VERSION,
      'x-extension-protocol':String(options.protocol ?? BRIDGE_PROTOCOL),
      ...(data ? {'content-type':'application/json','content-length':Buffer.byteLength(data)} : {})
    }}, res => {
      let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);
      res.on('end',()=>resolve({status:res.statusCode || 0,body:raw ? JSON.parse(raw) : null}));
    });
    req.on('error',reject);req.end(data);
  });
}
const statusPath = (requestId=id, doc=owner.documentId) => `/task-box/clear/status?${new URLSearchParams({requestId,tabId:String(owner.tabId),documentId:doc})}`;

beforeEach(async () => {
  expect(process.env.CLF_BRIDGE_PORTS).toBe('0');
  dir=await makeTempDir('task-box-bridge-');
  initConfigPath(dir);initSecretsPath(dir);initSessionStore(dir);initDurableStore(dir);
  await saveConfig(defaultConfig());
  await setSecret('bridgeToken','isolated-task-box-token');
  resetBridgeForTests();restoreSwarm(null);barriers=0;
  setBrowserOpener(async () => {}); // Even simulated worker bootstrap never opens a real browser.
  onSwarmPersistNow(async snapshot=>{barriers++;await writeDurableNow('swarm',snapshot);});
  onRetiredWorkersPersistNow(snapshot=>writeDurableNow('retired-workers',snapshot));
  port=(await startBridge())!;
  expect(port).toBeGreaterThan(0);
  expect([8765,8766,8767,8768,8769]).not.toContain(port);
});

afterEach(async () => {
  await shutdownBridge();
  await flushDurable();resetBridgeForTests();restoreSwarm(null);
  onSwarmPersistNow(null);onRetiredWorkersPersistNow(null);
  resetDurableForTests();resetSecretsCacheForTests();resetSessionStoreForTests();
  await removeTempDir(dir);
});

describe('authenticated direct TASK BOX Clear (no GUI/native host)',()=>{
  it('connects shipped page + coordinator + HTTP bridge + official reset, including a lost POST reply',async()=>{
    spawn({workers:[{task:'isolated full-stack worker'}],caller:{conversationId:'isolated-prime'}});
    const data:Record<string,any>={taskBoxIntegrationEnabled:true,taskBoxCreationGlobal:{state:'present',generation:0}};
    const local={get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,structuredClone(data[k])])),
      set:async(values:Record<string,any>)=>{Object.assign(data,structuredClone(values));}};
    const wire:string[]=[];
    const context:any={URL,URLSearchParams,console};
    for(const file of ['task-box-compatibility.js','task-box-coordinator.js','task-box-background.js']){
      vm.runInNewContext(await fs.readFile(path.join(process.cwd(),'extension',file),'utf8'),context);
    }
    const api=context.CLFTaskBoxBackground.registerTaskBox({chrome:{storage:{local},runtime:{getManifest:()=>({version:APP_VERSION})}},
      call:async(route:string,init:any={})=>{
        wire.push(route);
        const response=await request(init.method || 'GET',route,init.body ? JSON.parse(init.body) : undefined);
        if(route==='/task-box/clear') return {ok:false,error:'simulated_lost_reply'};
        return {ok:response.status===200,status:response.status,data:response.body};
      }});
    const row=(key:string)=>`<div id="${key}"><a href="/g/${key}"><span class="_NCija_content">TASK BOX</span></a><button aria-label="Pin project">pin</button><button aria-label="Open project options for TASK BOX" aria-haspopup="menu">options</button></div>`;
    const dom=new JSDOM(`<nav>${row('old-project')}<button id="new" aria-label="New project">New project</button></nav><div id="portal"></div>`,
      {url:'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555',runScripts:'outside-only'});
    const win:any=dom.window;win.__CLF_TASK_BOX_TEST__=true;
    win.chrome={storage:{local,onChanged:{addListener:()=>{},removeListener:()=>{}}},runtime:{id:'test',getManifest:()=>({version:APP_VERSION}),
      sendMessage:(message:any)=>api.handle(message,{tab:{id:owner.tabId},documentId:owner.documentId,frameId:0,url:win.location.href},()=>true)}};
    for(const file of ['task-box-compatibility.js','task-box-core.js','task-box.js']) win.eval(await fs.readFile(path.join(process.cwd(),'extension',file),'utf8'));
    let deletes=0,saves=0;
    try {
      expect((await win.CLFTaskBox.start()).enabled).toBe(true);
      const doc=win.document;doc.getElementById('old-project').insertAdjacentHTML('beforeend','<span id="ordinary-chat">Manually filed ordinary chat</span>');
      const hooks=win.CLFTaskBoxTestHooks;hooks.ensureSidebarBoxClearButton();
      const captured=hooks.taskBoxSidebarContext();
      const button=doc.querySelector('[data-cos-box-clear-sidebar]');
      const menu=doc.createElement('div');menu.setAttribute('role','menu');
      menu.innerHTML='<button role="menuitem">Share project</button><div role="separator"></div><button id="delete" role="menuitem">Delete project</button>';
      menu.querySelector('#delete').addEventListener('click',()=>{
        menu.remove();const dialog=doc.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<button>Delete from Chat and Work</button>';
        dialog.querySelector('button').addEventListener('click',()=>{expect(snapshotSwarm()).toBeNull();deletes++;doc.getElementById('old-project').remove();dialog.remove();});
        doc.body.append(dialog);
      });doc.body.append(menu);
      doc.getElementById('new').addEventListener('click',()=>{
        const dialog=doc.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<input aria-label="Project name"><button>Save</button>';
        dialog.querySelector('button').addEventListener('click',()=>{expect(dialog.querySelector('input').value).toBe('TASK BOX');saves++;doc.querySelector('nav').insertAdjacentHTML('afterbegin',row('new-project'));dialog.remove();});
        doc.body.append(dialog);
      });
      await hooks.clearTaskBoxFromContext(button,captured,menu,{testBypass:true});
      expect(wire.filter(route=>route==='/task-box/clear')).toHaveLength(1);
      expect(wire.filter(route=>route.startsWith('/task-box/clear/status?'))).toHaveLength(1);
      expect(deletes).toBe(1);expect(saves).toBe(1);
      expect(doc.getElementById('ordinary-chat')).toBeNull();expect(doc.getElementById('new-project')).not.toBeNull();
      expect(data.taskBoxCreationGlobal).toEqual({state:'present',generation:1});
      expect(data.lastBoxClearOperation).toMatchObject({stage:'completed',clearCompleted:true,recreateCompleted:true});
    } finally {win.__CLF_TASK_BOX_RUNTIME__?.stop();win.close();}
  });
  it('capability and missing-request status never mutate the official swarm or create a receipt',async()=>{
    const cap=await request('GET','/task-box/capabilities');
    expect(cap.body).toEqual({protocol:1,supported:true,atMostOnce:true,durableReceipts:true});
    expect((await request('GET',statusPath())).body).toMatchObject({ok:false,status:'unknown_request',requestId:id});
    expect(barriers).toBe(0);
    await expect(fs.stat(path.join(dir,'state','task-box-clear.json'))).rejects.toMatchObject({code:'ENOENT'});
  });

  it('uses the real official reset and durability path, and old receipt cannot clear a later swarm',async()=>{
    spawn({workers:[{task:'first isolated worker'}],caller:{conversationId:'test-prime'}});
    expect(snapshotSwarm()).not.toBeNull();
    const first=await request('POST','/task-box/clear',{owner,requestId:id});
    expect(first).toEqual({status:200,body:{protocol:1,ok:true,status:'completed',requestId:id}});
    expect(snapshotSwarm()).toBeNull();expect(barriers).toBeGreaterThan(0);
    const saved=JSON.parse(await fs.readFile(path.join(dir,'state','task-box-clear.json'),'utf8'));
    expect(saved.busy).toBeNull();expect(saved.receipts[id]).toMatchObject({protocol:1,owner,state:'completed'});
    spawn({workers:[{task:'second isolated worker'}],caller:{conversationId:'test-prime'}});
    const count=barriers;
    expect((await request('POST','/task-box/clear',{owner,requestId:id})).body.status).toBe('completed');
    expect((await request('GET',statusPath())).body.status).toBe('completed');
    expect(snapshotSwarm()).not.toBeNull();expect(barriers).toBe(count);
  });

  it('pending state after a simulated restart never repeats Clear or upgrades status',async()=>{
    await writeDurableNow('task-box-clear',{version:1,busy:{state:'pending',requestId:id,owner},receipts:{}});
    resetBridgeForTests();
    expect((await request('GET',statusPath())).body).toMatchObject({status:'incomplete'});
    expect((await request('POST','/task-box/clear',{owner,requestId:id})).body).toMatchObject({status:'incomplete'});
    expect((await request('POST','/task-box/clear',{owner,requestId:otherId})).body).toMatchObject({status:'busy'});
    expect(barriers).toBe(0);
  });

  it('requires authentication, extension origin, compatible protocol and the precise method',async()=>{
    expect((await request('POST','/task-box/clear',{owner,requestId:id},{auth:false})).status).toBe(401);
    expect((await request('POST','/task-box/clear',{owner,requestId:id},{origin:'https://chatgpt.com'})).status).toBe(403);
    expect((await request('POST','/task-box/clear',{owner,requestId:id},{protocol:-1})).status).toBe(426);
    expect((await request('GET','/task-box/clear')).status).toBe(405);
    expect((await request('POST',statusPath(),{})).status).toBe(405);
    expect(barriers).toBe(0);
  });

  it('rejects forged owner, malformed request and extra command fields without executing',async()=>{
    for (const body of [null,[],{owner,requestId:'bad'},{owner:{...owner,tabId:-1},requestId:id},
      {owner:{...owner,documentId:''},requestId:id},{owner,requestId:id,command:'anything'}]) {
      expect((await request('POST','/task-box/clear',body)).status).toBe(400);
    }
    expect((await request('GET',statusPath()+'&requestId='+otherId)).status).toBe(400);
    expect(barriers).toBe(0);
  });

  it('completed receipt is exact-owner scoped and corrupt persistent state is never absence',async()=>{
    await request('POST','/task-box/clear',{owner,requestId:id});
    expect((await request('GET',statusPath(id,'wrong-document'))).body.status).toBe('owner_mismatch');
    const before=barriers;
    await fs.writeFile(path.join(dir,'state','task-box-clear.json'),'{broken','utf8');
    expect((await request('POST','/task-box/clear',{owner,requestId:otherId})).status).toBe(500);
    await fs.writeFile(path.join(dir,'state','task-box-clear.json'),'null','utf8');
    expect((await request('POST','/task-box/clear',{owner,requestId:otherId})).status).toBe(500);
    expect(barriers).toBe(before);
  });
});
