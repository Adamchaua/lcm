import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrationCopyLimits } from '../../src/migration/copy-destination.js';

describe('migration copy bounds',()=>{
  it.each([0,-1,501,NaN,Infinity,1.5])('rejects unsupported record bounds %s',maxRecords=>{
    expect(()=>migrationCopyLimits({maxRecords,maxBytes:1024})).toThrow();
  });
  it('bounds bytes, leases and whole-operation attempts before any target access',()=>{
    for(const input of [{maxBytes:150994945},{leaseTtlMs:999},{leaseTtlMs:86400001},{maximumTransactionAttempts:11},{maximumTransactionAttempts:0}]){
      expect(()=>migrationCopyLimits({maxRecords:1,maxBytes:1024,...input})).toThrow();
    }
    expect(migrationCopyLimits({maxRecords:1,maxBytes:1024})).toEqual({maxRecords:1,maxBytes:1024,leaseTtlMs:300000,maximumTransactionAttempts:3});
  });
});

it('reads committed proof after response loss instead of repeating the mutation',async()=>{
  const { settleMigrationCopyOperation } = await import('../../src/migration/copy-destination.js');
  const { PostgreSqlCommitOutcomeUnknownError } = await import('../../src/storage/postgresql/errors.js');
  let durable=0; const events:string[]=[];
  const result=await settleMigrationCopyOperation({maximumTransactionAttempts:3,
    mutate:async()=>{durable++;events.push('commit');throw new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});},
    reconnect:async()=>{events.push('reconnect');},readback:async()=>{events.push('proof');return durable===1?'exact':null;}});
  expect(result).toBe('exact');expect(durable).toBe(1);expect(events).toEqual(['commit','reconnect','proof']);
});
it('requires proof even after acknowledged commit and leaves unavailable proof unresolved',async()=>{
  const { settleMigrationCopyOperation } = await import('../../src/migration/copy-destination.js');
  let durable=0;
  await expect(settleMigrationCopyOperation({maximumTransactionAttempts:2,mutate:async()=>{durable++;},reconnect:async()=>{},readback:async()=>{throw new Error('unavailable');}})).rejects.toThrow();
  expect(durable).toBe(1);
});

const state=vi.hoisted(()=>({run:false,completed:false,receipt:false,lease:false,fences:0,expires:false,owned:true,locked:true,
 failure:'' as string,closed:0,writerClosed:0,transactions:0,renew:false,runtimeIdentifier:'1',writes:[] as string[],queries:[] as string[]}));
// Every statement the mocked runtime serves, whether through a bare runtime or a
// transaction executor. Writes are recorded on whichever cluster the runtime reaches.
const runtimeQuery=async(config:{text:string})=>{
 state.queries.push(config.text);
 if(config.text.includes('pg_control_system()'))return {rows:[{system_identifier:state.runtimeIdentifier}]};
 if(/^(INSERT|UPDATE)/u.test(config.text))state.writes.push(config.text);
 return {rows:state.locked?[{locked:1}]:[]};
};
vi.mock('../../src/storage/postgresql/runtime.js',()=>({PostgreSqlRuntime:class{
 constructor(){if(state.failure.includes('runtime-construction'))throw new Error('runtime construction');}
 async query(config:{text:string}){return runtimeQuery(config);}
 async transaction<T>(operation:(executor:unknown)=>Promise<T>){
  const saved={run:state.run,completed:state.completed,receipt:state.receipt};state.transactions++;
  const executor={transactionScope:'active',query:runtimeQuery,savepoint:async(fn:(value:unknown)=>unknown)=>fn(executor)};
  try{return await operation(executor);}catch(error){Object.assign(state,saved);throw error;}
 }
 async close(){state.closed++;if(state.failure.includes('runtime-close'))throw new Error('runtime close');}
}}));
vi.mock('../../src/storage/postgresql/coordination.js',()=>({PostgreSqlWorkCoordinator:class{
 constructor(readonly executor:{query:(config:{text:string})=>Promise<unknown>}){}
 async acquireLease(){await this.executor.query({text:'INSERT INTO lcm.fenced_leases'});state.lease=state.owned;return state.owned?{fencingToken:1n}:null;}
 async renewLease(){await this.executor.query({text:'UPDATE lcm.fenced_leases SET renewed'});state.renew=true;return state.owned?{fencingToken:1n}:null;}
 async assertLeaseFence(){state.fences++;if(state.expires&&state.fences%2===0)throw new Error('expired');}
 async releaseLease(){await this.executor.query({text:'UPDATE lcm.fenced_leases SET released'});state.lease=false;if(state.failure==='release')throw new Error('release');}
}}));
vi.mock('../../src/storage/postgresql/portable-destination.js',async importOriginal=>({
 assertPostgreSqlSystemIdentifier:(await importOriginal<typeof import('../../src/storage/postgresql/portable-destination.js')>()).assertPostgreSqlSystemIdentifier,
 createPostgreSqlPortableDestination:async()=>({preflight:async()=>{if(state.failure.includes('preflight'))throw new Error('preflight');return {};},close:async()=>{state.writerClosed++;if(state.failure.includes('writer-close'))throw new Error('writer close');}}),
 admitPortableDestinationInTransaction:async()=>{state.run=true;},
 readPortableRunInTransaction:async()=>state.run?{state:state.completed?'completed':'active'}:null,
 readPortableBatchReceiptInTransaction:async()=>state.receipt?{checkpoint:{nextOrdinal:1},batchSha256:'a'.repeat(64)}:null,
 applyPortableBatchInTransaction:async()=>{state.receipt=true;return {nextOrdinal:1};},
 verifyPortableDestinationComplete:async()=>({complete:true}),
 completePortableDestinationInTransaction:async()=>{state.completed=true;},
 readPortableCompletedRunInTransaction:async()=>state.completed,
}));
beforeEach(()=>{Object.assign(state,{run:false,completed:false,receipt:false,lease:false,fences:0,expires:false,owned:true,locked:true,failure:'',closed:0,writerClosed:0,transactions:0,renew:false,runtimeIdentifier:'1',writes:[],queries:[]});});
async function destination(expectedSystemIdentifier?:string){
 const api=await import('../../src/migration/copy-destination.js');
 return api.openMigrationCopyDestination({expectedSystemIdentifier,settings:{} as never,expectedOwner:'owner',expectedIdentity:{id:'project',machineId:'machine'},generationId:'generation',runId:'run',source:{describe:()=>({manifestSha256:'b'.repeat(64)})} as never,
  ownerProcessId:'owner',leaseTtlMs:1000,maximumTransactionAttempts:3,withSourceAuthority:async operation=>operation(async()=>{})});
}
it('uses the fenced transaction for admission, data and completion and closes only its lease',async()=>{
 const target=await destination();
 await target.admit(false);expect(state.run).toBe(true);
 expect(await target.readBatch({} as never)).toBeNull();
 expect(await target.applyBatch({} as never)).toMatchObject({checkpoint:{nextOrdinal:1}});
 const proof=await target.verify();expect(await target.readCompleted(proof)).toBe(false);
 await target.complete(proof);expect(await target.readCompleted(proof)).toBe(true);
 expect(state.completed).toBe(true);expect(state.renew).toBe(true);expect(state.fences).toBe(6);
 await target.admit(true);await target.close();expect(state.lease).toBe(false);expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});
it('rolls admission back when the ending fence expires',async()=>{
 state.expires=true;const target=await destination();
 try{await expect(target.admit(false)).rejects.toThrow('expired');expect(state.run).toBe(false);}finally{await target.close();}
});
it('refuses a competing owner before admission',async()=>{
 state.owned=false;const target=await destination();
 try{await expect(target.admit(false)).rejects.toThrow('another worker');expect(state.run).toBe(false);}finally{await target.close();}
});
it('requires a serialized matching run on resume',async()=>{
 const target=await destination();
 try{await expect(target.admit(true)).rejects.toThrow('missing');state.locked=false;await expect(target.admit(true)).rejects.toThrow('serialization');}finally{await target.close();}
});
it.each(['release','runtime-close','writer-close'])('attempts all cleanup when %s fails',async failure=>{
 const target=await destination();await target.admit(false);state.failure=failure;
 await expect(target.close()).rejects.toThrow();expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});
it('closes both owners after preflight refusal',async()=>{
 state.failure='preflight';await expect(destination()).rejects.toThrow('preflight');expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});

it('retries readback without repeating the mutation after a transient failure',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 let writes=0,reads=0,reconnections=0;
 expect(await settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{writes++;},readback:async()=>{if(++reads===1)throw new Error('unavailable');return 'exact';},reconnect:async()=>{reconnections++;}})).toBe('exact');
 expect({writes,reads,reconnections}).toEqual({writes:1,reads:2,reconnections:1});
});
it('reports the current readback failure instead of a stale retried-mutation error',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlStorageOperationError}=await import('../../src/storage/postgresql/errors.js');
 const stale=new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},'40001',true);
 const fresh=new Error('fresh readback failure');
 let attempt=0;
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:2,
  mutate:async()=>{attempt++;if(attempt===1)throw stale;},
  readback:async()=>{throw fresh;},
  reconnect:async()=>{}})).rejects.toBe(fresh);
});
it('reports the current readback failure instead of a stale ambiguous-commit error',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
 const stale=new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});
 const fresh=new Error('fresh readback failure');
 let attempt=0,reads=0;
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:2,
  mutate:async()=>{attempt++;if(attempt===1)throw stale;},
  readback:async()=>{reads++;if(attempt===1)return null;throw fresh;},
  reconnect:async()=>{}})).rejects.toBe(fresh);
 expect(reads).toBe(3);
});
it('retries whole transactions only for the two supported serialization states',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlStorageOperationError}=await import('../../src/storage/postgresql/errors.js');
 let attempt=0;
 expect(await settleMigrationCopyOperation({maximumTransactionAttempts:4,mutate:async()=>{
  if(++attempt<3)throw new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},attempt===1?'40001':'40P01',true);
 },readback:async()=>true,reconnect:async()=>{throw new Error('unexpected reconnect');}})).toBe(true);
 expect(attempt).toBe(3);
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{throw new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'},'53300',true);},readback:async()=>true,reconnect:async()=>{}})).rejects.toMatchObject({sqlState:'53300'});
});
it('retains uncertainty when serialized absence consumes the remaining budget',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
 const original=new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:2,mutate:async()=>{throw original;},readback:async()=>null,reconnect:async()=>{}})).rejects.toBe(original);
});
it('proves a committed mutation even when the whole budget is spent on one attempt',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 let writes=0,reads=0;
 expect(await settleMigrationCopyOperation({maximumTransactionAttempts:1,mutate:async()=>{writes++;},readback:async()=>{reads++;return 'exact';},reconnect:async()=>{}})).toBe('exact');
 expect({writes,reads}).toEqual({writes:1,reads:1});
});
it('bounds readback retries instead of looping when proof never arrives',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 let writes=0,reads=0,reconnections=0;
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{writes++;},readback:async()=>{reads++;throw new Error('unavailable');},reconnect:async()=>{reconnections++;}})).rejects.toThrow('unavailable');
 expect({writes,reads,reconnections}).toEqual({writes:1,reads:3,reconnections:3});
});
it('reacquires an expired own lease before retrying work',async()=>{
 const target=await destination();await target.admit(false);state.owned=false;
 try{await expect(target.applyBatch({} as never)).rejects.toThrow('another worker');expect(state.receipt).toBe(false);}finally{await target.close();}
});

it.each(['runtime-construction','runtime-construction writer-close'])('releases the writer if %s fails',async failure=>{
 state.failure=failure;await expect(destination()).rejects.toThrow('runtime construction');expect(state.writerClosed).toBe(1);
});

it('preserves uncertain commit when rebuilding the readback connection fails',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');
 const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
 const unknown=new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'test'});
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{throw unknown;},
  readback:async()=>null,reconnect:async()=>{throw new Error('connection unavailable');}})).rejects.toBe(unknown);
});

it('preserves proof failure when reconnect also fails',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');const primary=new Error('proof unavailable');
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{},readback:async()=>{throw primary;},reconnect:async()=>{throw new Error('reconnect');}})).rejects.toBe(primary);
});
it('refuses storage failure without a retryable SQLSTATE',async()=>{
 const {settleMigrationCopyOperation}=await import('../../src/migration/copy-destination.js');const {PostgreSqlStorageOperationError}=await import('../../src/storage/postgresql/errors.js');
 const error=new PostgreSqlStorageOperationError('STORAGE_OPERATION_FAILED',{domain:'factory',operation:'test'});
 await expect(settleMigrationCopyOperation({maximumTransactionAttempts:3,mutate:async()=>{throw error;},readback:async()=>null,reconnect:async()=>{}})).rejects.toBe(error);
});
it('uses a fresh runtime for unknown admission and proves its durable run',async()=>{
 const {PostgreSqlRuntime}=await import('../../src/storage/postgresql/runtime.js');const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
 const transaction=PostgreSqlRuntime.prototype.transaction;
 const spy=vi.spyOn(PostgreSqlRuntime.prototype,'transaction').mockImplementationOnce(async function(...args){await transaction.apply(this,args);throw new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'admit'});});
 const target=await destination();try{await target.admit(false);expect(state.run).toBe(true);expect(state.closed).toBe(1);}finally{spy.mockRestore();await target.close();}
 expect(state.closed).toBe(2);
});
it('does not acknowledge completion when the exact completed readback is absent',async()=>{
 const api=await import('../../src/storage/postgresql/portable-destination.js');const target=await destination();await target.admit(false);
 const spy=vi.spyOn(api,'readPortableCompletedRunInTransaction').mockResolvedValue(false);
 try{await expect(target.complete(await target.verify())).rejects.toThrow('authoritative');}finally{spy.mockRestore();await target.close();}
});
it('preserves preflight failure when both cleanup operations fail',async()=>{
 state.failure='preflight runtime-close writer-close';await expect(destination()).rejects.toThrow('preflight');expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
});

describe('runtime checkouts are bound to the recorded cluster (#1508)',()=>{
 const wrongCluster=()=>{state.runtimeIdentifier='2';};
 it('keeps the lease, data and readback transactions working on the matching cluster',async()=>{
  const target=await destination('1');
  await target.admit(false);await target.applyBatch({} as never);await target.admit(true);
  expect(state.run).toBe(true);expect(state.receipt).toBe(true);expect(state.renew).toBe(true);
  const identifierReads=state.queries.filter(text=>text.includes('pg_control_system()')).length;
  expect(identifierReads).toBeGreaterThan(0);
  await target.close();expect(state.lease).toBe(false);
  expect(state.writes).toEqual(expect.arrayContaining(['INSERT INTO lcm.fenced_leases','UPDATE lcm.fenced_leases SET renewed','UPDATE lcm.fenced_leases SET released']));
 });
 it('checks the cluster before the first statement of every lease transaction',async()=>{
  const target=await destination('1');await target.admit(false);
  const firstQuery=state.queries.findIndex(text=>text.includes('pg_control_system()'));
  const firstWrite=state.queries.findIndex(text=>/^(INSERT|UPDATE)/u.test(text));
  expect(firstQuery).toBeGreaterThanOrEqual(0);expect(firstQuery).toBeLessThan(firstWrite);
  await target.close();
 });
 it('gives a mismatching runtime no lease write on acquire',async()=>{
  wrongCluster();const target=await destination('1');
  try{await expect(target.admit(false)).rejects.toMatchObject({code:'destination-conflict'});}finally{await expect(target.close()).resolves.toBeUndefined();}
  expect(state.writes).toEqual([]);expect(state.run).toBe(false);expect(state.lease).toBe(false);
 });
 it('gives a mismatching runtime no lease write on renew',async()=>{
  const target=await destination('1');await target.admit(false);state.writes=[];wrongCluster();
  try{await expect(target.applyBatch({} as never)).rejects.toMatchObject({code:'destination-conflict'});}finally{await expect(target.close()).rejects.toMatchObject({code:'destination-conflict'});}
  expect(state.writes).toEqual([]);expect(state.receipt).toBe(false);
 });
 it('gives a runtime rebuilt after an ambiguous commit no write and refuses its readback',async()=>{
  const {PostgreSqlRuntime}=await import('../../src/storage/postgresql/runtime.js');const {PostgreSqlCommitOutcomeUnknownError}=await import('../../src/storage/postgresql/errors.js');
  const transaction=PostgreSqlRuntime.prototype.transaction;
  const target=await destination('1');await target.admit(false);state.writes=[];
  const spy=vi.spyOn(PostgreSqlRuntime.prototype,'transaction').mockImplementationOnce(async function(...args){await transaction.apply(this,args);wrongCluster();throw new PostgreSqlCommitOutcomeUnknownError({domain:'factory',operation:'apply'});});
  try{
   await expect(target.applyBatch({} as never)).rejects.toBeInstanceOf(PostgreSqlCommitOutcomeUnknownError);
   expect(state.closed).toBeGreaterThan(0);
   await expect(target.readBatch({} as never)).rejects.toMatchObject({code:'destination-conflict'});
   await expect(target.admit(true)).rejects.toMatchObject({code:'destination-conflict'});
  }finally{spy.mockRestore();await target.close().catch(()=>undefined);}
  expect(state.writes.filter(text=>!text.includes('renewed'))).toEqual([]);
 });
 it('gives a mismatching runtime no release write on close and still closes both owners',async()=>{
  const target=await destination('1');await target.admit(false);state.writes=[];wrongCluster();
  await expect(target.close()).rejects.toMatchObject({code:'destination-conflict'});
  expect(state.writes).toEqual([]);expect(state.lease).toBe(true);expect(state.closed).toBe(1);expect(state.writerClosed).toBe(1);
 });
 it('refuses a readback on a mismatching cluster before the lease serialization lock, even without a lease row',async()=>{
  const target=await destination('1');wrongCluster();state.locked=false;
  try{
   await expect(target.admit(true)).rejects.toMatchObject({code:'destination-conflict'});
   await expect(target.readCompleted({} as never)).rejects.toMatchObject({code:'destination-conflict'});
  }finally{state.runtimeIdentifier='1';await target.close();}
  expect(state.queries.some(text=>text.includes('FOR UPDATE'))).toBe(false);
 });
 it('leaves the runtime unchecked when no cluster is expected',async()=>{
  wrongCluster();const target=await destination();
  await target.admit(false);await target.close();
  expect(state.queries.some(text=>text.includes('pg_control_system()'))).toBe(false);
 });
});
