import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as weave from 'weave';
import { AgentActionSchema, SceneSchema, GearSchema, IntentSchema, compilePlan, planShots, recipes, type PlanVersion, type Overrides } from './domain';
export const plannerVersion='flowblock-planner-v1';
export const PlanningInputSchema=z.object({scene:SceneSchema,gear:GearSchema,intent:IntentSchema,prompt:z.string().max(4000).optional()}).strict();
export type PlanningInput=z.infer<typeof PlanningInputSchema>;
export type PlannerMessage={role:'system'|'user'|'assistant';content:string};
export type PlannerEvent={action:unknown;observation:unknown;elapsedMs:number};
export type PlanningResult={plans:PlanVersion[];source:'forge'|'library';message:string;traceId?:string;model?:string;events:PlannerEvent[];usage:{inputTokens:number;outputTokens:number};inputHash:string;plannerVersion:string;latencyMs:number};
export const systemPrompt=`You are FlowBlock's product-shot planning coordinator. Return exactly one JSON action per turn, no markdown. Never edit the scene, gear, or measurements. Use only the given recipes and typed parameters. Geometry validation is authoritative. Aim for up to three distinct feasible shots matching the brief. A static shot is not a substitute for requested movement without explaining the compromise. Use compile_candidate for each candidate, inspect its returned validation, and repair at most twice. Never call an invalid plan safe. When finished return only candidate IDs you have compiled and validated, plus a concise explanation. At most six actions are available. For physical suggestions use hypotheses, never infer operator distance from video. Available actions:\n${JSON.stringify(z.toJSONSchema(AgentActionSchema))}`;
let telemetryInit:Promise<unknown>|undefined;
export async function telemetry() {
 if(!process.env.WANDB_API_KEY||!process.env.WANDB_ENTITY||process.env.FLOWBLOCK_TRACE==='0')return false;
 try { telemetryInit??=weave.init(`${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT||'flowblock'}`);await telemetryInit;return true; }catch{return false;}
}
export type ChatResult={content:string;usage:{inputTokens:number;outputTokens:number}};
export async function chat(messages:PlannerMessage[],model:string,signal:AbortSignal):Promise<ChatResult> {
 const base=process.env.FLOWBLOCK_INFERENCE_URL || 'https://api.inference.wandb.ai/v1';
 const response=await fetch(`${base.replace(/\/$/,'')}/chat/completions`,{
  method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.WANDB_API_KEY}`,'OpenAI-Project':`${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT||'flowblock'}`},
  body:JSON.stringify({model,messages,max_tokens:1600,temperature:0.1,...(model.includes('gpt-oss')?{reasoning_effort:'low'}:{})}),
 });
 if(!response.ok)throw new Error(`Inference returned HTTP ${response.status}`);
 const data=await response.json();
 return {content:data.choices?.[0]?.message?.content||'',usage:{inputTokens:data.usage?.prompt_tokens||0,outputTokens:data.usage?.completion_tokens||0}};
}
export async function runPlanner(raw:PlanningInput,options:{model?:string;deadlineMs?:number;chat?:typeof chat;trace?:boolean}={}):Promise<PlanningResult> {
 const input=PlanningInputSchema.parse(raw);const started=Date.now();const inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const base={inputHash,plannerVersion,events:[] as PlannerEvent[],usage:{inputTokens:0,outputTokens:0},latencyMs:0};
 const fallback=(message:string):PlanningResult=>({...base,plans:planShots(input.scene,input.gear,input.intent).filter(p=>p.validation.valid).slice(0,3),source:'library',message,latencyMs:Date.now()-started});
 if(!process.env.WANDB_API_KEY&&!options.chat)return fallback('Using the local recipe library. Forge generation is not configured.');
 const model=options.model||process.env.FLOWBLOCK_MODEL||'openai/gpt-oss-20b';
 const traced=options.trace!==false&&await telemetry();
 const conversation=traced?weave.startConversation({agentName:'FlowBlock planner',agentVersion:plannerVersion,model,conversationId:randomUUID(),attributes:{inputHash}}):undefined;
 const turn=conversation?.startTurn({userMessage:input.prompt||input.intent.brief});
 const deadline=AbortSignal.timeout(options.deadlineMs||30000);
 const candidates=new Map<string,PlanVersion>();let repairs=0;let message='';
 const messages:PlannerMessage[]=[{role:'system',content:systemPrompt},{role:'user',content:JSON.stringify({...input,recipes:recipes.map(({id,family,name})=>({id,family,name}))})}];
 try {
  for(let i=0;i<6;i++){
   if(deadline.aborted)throw new Error('Planning deadline reached');
   const llm=turn?.startLLM({model,providerName:'coreweave'});let response:ChatResult;
   try{if(llm)llm.inputMessages=messages;response=await(options.chat||chat)(messages,model,deadline);llm?.output(response.content);llm?.record({usage:response.usage});}
   finally{llm?.end();}
   base.usage.inputTokens+=response.usage.inputTokens;base.usage.outputTokens+=response.usage.outputTokens;
   messages.push({role:'assistant',content:response.content});
   let action:z.infer<typeof AgentActionSchema>;
   try{action=AgentActionSchema.parse(JSON.parse(response.content));}
   catch{if(++repairs>2)throw new Error('Model returned invalid actions');messages.push({role:'user',content:'Invalid action. Return one JSON action matching the schema. Do not change scene facts.'});continue;}
   const tool=turn?.startTool({name:action.action,args:JSON.stringify(action)});let observation:unknown;
   try {
    switch(action.action){
     case 'list_recipes': observation=recipes;break;
     case 'compile_candidate': {
      const p=compilePlan(input.scene,input.gear,input.intent,action.recipeId,action.overrides);candidates.set(p.id,p);
      observation={candidateId:p.id,recipeId:p.recipeId,validation:p.validation,framing:p.framing,durationSeconds:p.durationSeconds};
      if(!p.validation.valid&&++repairs>2)throw new Error('Repair budget reached');break;
     }
     case 'validate_candidate': {const p=candidates.get(action.candidateId);observation=p?{candidateId:p.id,validation:p.validation}:{error:'Unknown candidate'};break;}
     case 'read_take_findings': observation={findings:[],message:'This request has no uploaded take.'};break;
     case 'propose_revision': observation={error:'Revisions require a saved take and evidence. Select a recipe for this planning request.'};break;
     case 'finish': {
      const plans=action.candidateIds.map(id=>candidates.get(id)).filter((p):p is PlanVersion=>!!p&&p.validation.valid).slice(0,3);
      if(action.candidateIds.some(id=>!candidates.get(id)?.validation.valid)){observation={error:'Finish referenced unknown or invalid candidates. Return validated candidate IDs only.'};break;}
      message=action.explanation;observation={accepted:plans.map(p=>p.id)};base.events.push({action,observation,elapsedMs:Date.now()-started});tool?.end({result:JSON.stringify(observation)});
      return {...base,plans,source:'forge',message,traceId:conversation?.conversationId,model,latencyMs:Date.now()-started};
     }
    }
    base.events.push({action,observation,elapsedMs:Date.now()-started});tool?.end({result:JSON.stringify(observation)});
   }catch(error){tool?.end({error:error instanceof Error?error:new Error('Tool failed')});throw error;}
   messages.push({role:'user',content:JSON.stringify({observation})});
  }
  const plans=[...candidates.values()].filter(p=>p.validation.valid).slice(0,3);
  if(plans.length)return {...base,plans,source:'forge',message:'The action limit was reached. These compiled options passed validation; review their tradeoffs before rehearsing.',traceId:conversation?.conversationId,model,latencyMs:Date.now()-started};
  return fallback('The planner did not find a validated candidate within its action budget. Showing local recipes.');
 }catch(error){console.warn('Planner failure:',error instanceof Error?error.message:'Unknown error');turn?.recordError(error instanceof Error?error:new Error('Planner failed'));return fallback('Forge generation could not finish. Your setup is preserved; these options come from the local recipe library.');}
 finally{turn?.end();conversation?.end();if(traced)await weave.flushOTel().catch(()=>{});}
}
export function recompilePlan(raw:unknown):PlanVersion {
 const source=z.object({scene:SceneSchema,gear:GearSchema,intent:IntentSchema,recipeId:z.enum(recipes.map(r=>r.id) as [typeof recipes[number]['id'],...typeof recipes[number]['id'][]]),overrides:z.record(z.string(),z.unknown()).optional()}).passthrough().parse(raw);
 return compilePlan(source.scene,source.gear,source.intent,source.recipeId,source.overrides as Overrides|undefined);
}
