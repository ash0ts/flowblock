import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
vi.mock('@/auth',()=>({auth:vi.fn()}));
import { handleApi } from '../src/server/api';
import { defaultGear, defaultIntent, defaultScene, planShots } from '../src/domain';
const dsn=process.env.FLOWBLOCK_TEST_DATABASE_URL||process.env.DATABASE_URL;
const suite=dsn?describe:describe.skip;
const owner='local-developer',plan=planShots(defaultScene,defaultGear,defaultIntent).find(p=>p.validation.valid)!;
const input={scene:defaultScene,gear:defaultGear,intent:defaultIntent,prompt:'API transaction fixture'};
const annotation={seed:{timeSeconds:2,box:{x:.4,y:.3,width:.2,height:.4}},expectedVisible:{startSeconds:0,endSeconds:5}};
const request=(route:string,body:unknown,key?:string)=>new Request(`http://localhost:3037/api/${route}`,{method:'POST',headers:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});

suite('API transactions against disposable PostgreSQL schema',()=>{
 let admin:Pool,pool:Pool,schema:string,directory:string;
 const globalDb=globalThis as unknown as {flowblockPool?:Pool};
 beforeAll(async()=>{
  admin=new Pool({connectionString:dsn});schema=`api_test_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:dsn,options:`-csearch_path=${schema}`,max:8});globalDb.flowblockPool=pool;
  await pool.query(await readFile('migrations/001_initial.sql','utf8'));
  directory=await mkdtemp(path.join(tmpdir(),'flowblock-api-db-'));
  vi.stubEnv('DATABASE_URL',dsn!);vi.stubEnv('FLOWBLOCK_LOCAL_MODE','1');vi.stubEnv('FLOWBLOCK_STORAGE_DIR',directory);vi.stubEnv('S3_BUCKET','');vi.stubEnv('WANDB_API_KEY','');
 });
 beforeEach(async()=>{await pool.query('TRUNCATE jobs,takes,usage_events,plan_versions,worker_health CASCADE');await pool.query("INSERT INTO worker_health(worker_id,device,model,ready) VALUES('test-health','cpu','health-fixture-only',true)");});
 afterAll(async()=>{delete globalDb.flowblockPool;await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();});
 async function take(takeOwner=owner,status='uploaded'){
  const id=randomUUID(),key=`owners/${takeOwner}/takes/${id}/original`;
  await pool.query('INSERT INTO takes(id,owner_id,object_key,file_name,size_bytes,mime_type,status,plan) VALUES($1,$2,$3,\'fixture.mp4\',10,\'video/mp4\',$4,$5)',[id,takeOwner,key,status,plan]);return {id,key};
 }
 it('atomically deduplicates concurrent planning and consumes quota once',async()=>{
  const responses=await Promise.all([handleApi(request('plans',input,'same-plan')),handleApi(request('plans',input,'same-plan'))]);
  expect(responses.every(r=>[200,202].includes(r.status))).toBe(true);
  const payloads=await Promise.all(responses.map(r=>r.json()));expect(payloads[0].jobId).toBe(payloads[1].jobId);
  expect(Number((await pool.query('SELECT count(*) FROM jobs')).rows[0].count)).toBe(1);
  expect(Number((await pool.query('SELECT count(*) FROM usage_events')).rows[0].count)).toBe(1);
  const changed=await handleApi(request('plans',{...input,prompt:'different'},'same-plan'));expect(changed.status).toBe(409);
 });
 it('rejects a reused analysis key when input or take changes',async()=>{
  const first=await take(),second=await take();
  const concurrent=await Promise.all([handleApi(request(`takes/${first.id}/analyze`,annotation,'analysis-key')),handleApi(request(`takes/${first.id}/analyze`,annotation,'analysis-key'))]);
  expect(concurrent.map(r=>r.status).sort()).toEqual([200,202]);
  expect((await pool.query('SELECT payload FROM jobs')).rows[0].payload.targetTimeBasis).toBe('normalized-phase');
  expect((await handleApi(request(`takes/${first.id}/analyze`,{...annotation,seed:{...annotation.seed,timeSeconds:3}},'analysis-key'))).status).toBe(409);
  expect((await handleApi(request(`takes/${second.id}/analyze`,annotation,'analysis-key'))).status).toBe(409);
  await pool.query('UPDATE worker_health SET ready=false');
  expect((await handleApi(request(`takes/${first.id}/analyze`,annotation,'analysis-key'))).status).toBe(200);
  expect((await handleApi(request(`takes/${first.id}/analyze`,annotation,'new-key'))).status).toBe(503);
  expect(Number((await pool.query('SELECT count(*) FROM jobs')).rows[0].count)).toBe(1);
  expect(Number((await pool.query('SELECT count(*) FROM usage_events')).rows[0].count)).toBe(1);
 });
 it('denies another owner media and take operations',async()=>{
  const other=await take('someone-else');
  expect((await handleApi(new Request(`http://localhost:3037/api/takes/${other.id}/media`))).status).toBe(404);
  expect((await handleApi(request(`takes/${other.id}/analyze`,annotation))).status).toBe(404);
  expect((await handleApi(new Request(`http://localhost:3037/api/takes/${other.id}`,{method:'DELETE'}))).status).toBe(404);
 });
 it('rejects a parent version on a new project before reaching the foreign key',async()=>{
  const response=await handleApi(request('projects',{name:'New project',plan,expectedVersionId:randomUUID()}));
  expect(response.status).toBe(400);
  expect(Number((await pool.query('SELECT count(*) FROM projects')).rows[0].count)).toBe(0);
 });
 it('serializes concurrent uploads and keeps only one accepted body',async()=>{
  const row=await take(owner,'uploading');
  const responses=await Promise.all(['abcdefghij','0123456789'].map(body=>handleApi(new Request(`http://localhost:3037/api/takes/${row.id}/upload`,{method:'PUT',body}))));
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
  const bytes=await readFile(path.join(directory,row.key),'utf8');expect(['abcdefghij','0123456789']).toContain(bytes);
  expect(await readdir(path.dirname(path.join(directory,row.key)))).toEqual(['original']);
 });
 it('does not publish an upload when deletion occurs during streaming',async()=>{
  const row=await take(owner,'uploading');let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const stream=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(new TextEncoder().encode('abcde'));await gate;controller.enqueue(new TextEncoder().encode('fghij'));controller.close();}});
  const pending=handleApi(new Request(`http://localhost:3037/api/takes/${row.id}/upload`,{method:'PUT',body:stream,duplex:'half'} as RequestInit));
  await vi.waitFor(async()=>expect(await readdir(path.dirname(path.join(directory,row.key)))).toHaveLength(1),{interval:10,timeout:2000});
  await pool.query("INSERT INTO jobs(id,owner_id,kind,payload,result) VALUES($1,$2,'analysis',$3,$4)",[randomUUID(),owner,{takeId:row.id,privateAnnotation:'test-data'},{privateTestValue:'scrub-me'}]);
  expect((await handleApi(new Request(`http://localhost:3037/api/takes/${row.id}`,{method:'DELETE'}))).status).toBe(200);release();
  expect((await pending).status).toBe(410);
  await expect(readFile(path.join(directory,row.key))).rejects.toThrow();
  const saved=(await pool.query('SELECT file_name,plan,training_consent FROM takes WHERE id=$1',[row.id])).rows[0];
  expect(saved).toEqual({file_name:'deleted',plan:{},training_consent:false});
  const job=(await pool.query('SELECT payload,result,error,status FROM jobs')).rows[0];
  expect(job).toEqual({payload:{takeId:row.id,deleted:true},result:null,error:null,status:'cancelled'});
 });
});
