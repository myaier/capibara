import { t } from "../shared/text";
import {useCallback,useEffect,useRef,useState} from "react";
import { useRpc } from "./fleet-client";
import {getPreferences,updatePreferences,type PreferencesSnapshot,type PreferencesUpdate,type ViewPreferences} from "../shared/preferences";
export function useViewPreferences(viewKey:string){
  const read=useRpc(getPreferences),write=useRpc(updatePreferences);
  const [snapshotKey,setSnapshotKey]=useState(viewKey);
  const [snapshot,setSnapshot]=useState<PreferencesSnapshot|null>(null),[error,setError]=useState<string|null>(null);
  const state=useRef<PreferencesSnapshot|null>(null),queue=useRef<Promise<unknown>>(Promise.resolve()),alive=useRef(true),generation=useRef(0);
  useEffect(()=>{alive.current=true;const current=++generation.current;state.current=null;setSnapshotKey(viewKey);setSnapshot(null);void read({viewKey}).then(next=>{if(alive.current&&current===generation.current){state.current=next;setSnapshot(next);setError(next.error);}}).catch(e=>{if(alive.current&&current===generation.current)setError(String(e.message??e));});return()=>{alive.current=false;};},[viewKey,read]);
  const mutate=useCallback((patch:Omit<PreferencesUpdate,"viewKey"|"expectedRevision">)=>{
    const current=generation.current;
    const request=queue.current.catch(()=>{}).then(async()=>{let base=state.current??await read({viewKey});for(let attempt=0;attempt<3;attempt++){const result=await write({viewKey,expectedRevision:base.revision,...patch});base=result;if(current!==generation.current)return result;state.current=result;if(alive.current){setSnapshot(result);setError(result.error);}if(result.status==="updated")return result;}throw new Error(t("secondaryUseViewPreferences.thisViewWasChangedOnAnother"));});
    queue.current=request;return request.catch(error=>{if(alive.current)setError(error.message??String(error));throw error;});
  },[read,write,viewKey]);
  const saveView=useCallback((view:ViewPreferences)=>mutate({view}),[mutate]);
  return {snapshot:snapshotKey===viewKey?snapshot:null,error,ready:snapshotKey===viewKey&&!!snapshot,mutate,saveView};
}
