import {isUnreadCompletion,knownCompletionAt,timestamp,type AgentRecord} from "./model";
import type {TelemetryEvent} from "./telemetry";
export interface DecisionSignal{kind:"unread"|"permission"|"quiet"|"repeated_failure";agentId:string;title:string;since:string|null;count:number}
/** Evidence-bound hints, not inferred stuck/completed/test verdicts. */
export function decisionSignals(agents:readonly AgentRecord[],events:readonly TelemetryEvent[],now=Date.now()):DecisionSignal[]{
 const signals:DecisionSignal[]=[],failuresByAgent=new Map<string,TelemetryEvent[]>();
 for(const event of events)if(event.type==="turn_failed"&&(timestamp(event.at)??0)>=now-86400000){const list=failuresByAgent.get(event.agentId);if(list)list.push(event);else failuresByAgent.set(event.agentId,[event]);}
 for(const agent of agents){if(agent.archivedAt)continue;
  if(isUnreadCompletion(agent)){const since=knownCompletionAt(agent);if((timestamp(since)??now)<=now-15*60000)signals.push({kind:"unread",agentId:agent.id,title:agent.title,since,count:1});}
  if(agent.status==="waiting"){const since=agent.attentionReason==="permission"?agent.attentionTimestamp??agent.activeTurnStartedAt:null;signals.push({kind:"permission",agentId:agent.id,title:agent.title,since,count:agent.pendingPermissionCount});}
  if(agent.status==="running"&&(timestamp(agent.lastActivityAt)??now)<=now-30*60000)signals.push({kind:"quiet",agentId:agent.id,title:agent.title,since:agent.lastActivityAt,count:1});
  const failures=failuresByAgent.get(agent.id)??[];if(failures.length>=2)signals.push({kind:"repeated_failure",agentId:agent.id,title:agent.title,since:failures.at(-1)?.at??null,count:failures.length});
 }
 return signals.sort((a,b)=>(a.kind==="permission"?-1:1)-(b.kind==="permission"?-1:1)||(timestamp(a.since)??now)-(timestamp(b.since)??now));
}
