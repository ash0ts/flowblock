import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { get, set, del } from 'idb-keyval';
import type { PlanVersion } from '@/domain/contracts';
import type { TakeAnalysis } from '@/domain/take-analysis';

export type ProductAnnotation = { timeSeconds:number; box:{x:number;y:number;width:number;height:number} };
export type SavedAttempt = {
  id:string; name:string; createdAt:string; plan:PlanVersion; takeId:string|null;
  duration:number; ratio:number; uploadComplete?:boolean; analysis:TakeAnalysis|null; seed:ProductAnnotation|null;
  corrections:ProductAnnotation[]; expectedStart:number; expectedEnd:number; revised:boolean;
};
const storage:StateStorage={
  getItem:async(name)=>{try{return await get<string>(name)??null;}catch{return null;}},
  setItem:async(name,value)=>{try{await set(name,value);}catch{if(typeof window!=='undefined')window.dispatchEvent(new Event('flowblock-storage-error'));}},
  removeItem:async(name)=>{await del(name);},
};
type TakeHistory={attempts:SavedAttempt[];save:(attempt:SavedAttempt)=>void;remove:(id:string)=>void};
export const useTakeHistory=create<TakeHistory>()(persist((setState)=>({
  attempts:[],
  save:(attempt)=>setState((state)=>({attempts:[...state.attempts.filter((item)=>item.id!==attempt.id),attempt].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-12)})),
  remove:(id)=>setState((state)=>({attempts:state.attempts.filter((item)=>item.id!==id)})),
}),{name:'flowblock-takes-v1',storage:createJSONStorage(()=>storage),skipHydration:true}));
