/** Iterative display forest. Missing parents and cycles remain visible once. */
export interface SubtaskNode<T> { item:T; children:SubtaskNode<T>[]; broken:boolean }
export function subtaskForest<T>(items: readonly T[], idOf:(item:T)=>string, parentOf:(item:T)=>string|null|undefined):SubtaskNode<T>[] {
  const map=new Map<string,SubtaskNode<T>>();for(const item of items)map.set(idOf(item),{item,children:[],broken:false});
  const parents=new Map<string,string|null>();for(const [id,node]of map){const parent=parentOf(node.item);parents.set(id,parent&&map.has(parent)?parent:null);}
  const visited=new Set<string>();
  for(const id of map.keys()){if(visited.has(id))continue;let cursor:string|null=id;const chain:string[]=[];const local=new Set<string>();while(cursor&&!visited.has(cursor)){if(local.has(cursor)){parents.set(cursor,null);map.get(cursor)!.broken=true;break;}local.add(cursor);chain.push(cursor);cursor=parents.get(cursor)??null;}for(const key of chain)visited.add(key);}
  const roots:SubtaskNode<T>[]=[];for(const[id,node]of map){const parent=parents.get(id);if(parent)map.get(parent)!.children.push(node);else roots.push(node);}return roots;
}
export function flattenSubtasks<T>(roots:SubtaskNode<T>[],collapsed:ReadonlySet<string>,idOf:(item:T)=>string){const rows:Array<{item:T;depth:number;children:number;broken:boolean}>=[];const stack=roots.slice().reverse().map(node=>({node,depth:0}));while(stack.length){const{node,depth}=stack.pop()!;rows.push({item:node.item,depth,children:node.children.length,broken:node.broken});if(!collapsed.has(idOf(node.item)))for(let i=node.children.length-1;i>=0;i--)stack.push({node:node.children[i],depth:depth+1});}return rows;}
