/** Runtime-local presentation memory; bounded and isolated by the borrowed host SDK. */
const hosts=new WeakMap<object,Map<string,{scroll:number;expanded:Set<string>;filter:string}>>();
export function readingMemory(host:object,key:string){let cache=hosts.get(host);if(!cache){cache=new Map();hosts.set(host,cache);}let state=cache.get(key);if(!state){state={scroll:0,expanded:new Set(),filter:"all"};cache.set(key,state);}else{cache.delete(key);cache.set(key,state);}while(cache.size>80)cache.delete(cache.keys().next().value!);return state;}
