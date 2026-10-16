import assert from 'node:assert/strict';
import test from 'node:test';
import {subtaskForest,flattenSubtasks} from '../shared/subtask-tree';

test('normal roots do not hide a separate cyclic native subtree',()=>{
 const items=[{id:'root',parent:null},{id:'a',parent:'b'},{id:'b',parent:'a'},{id:'orphan',parent:'missing'}];
 const rows=flattenSubtasks(subtaskForest(items,item=>item.id,item=>item.parent),new Set(),item=>item.id);
 assert.deepEqual(new Set(rows.map(row=>row.item.id)),new Set(['root','a','b','orphan']));
 assert.equal(rows.length,4);assert.equal(rows.filter(row=>row.broken).length,1);
});
test('deep subtask chains are iterative and collapse without losing siblings',()=>{
 const items=Array.from({length:5000},(_,index)=>({id:String(index),parent:index?String(index-1):null}));
 items.push({id:'sibling',parent:null});
 const tree=subtaskForest(items,item=>item.id,item=>item.parent);
 assert.equal(flattenSubtasks(tree,new Set(),item=>item.id).length,5001);
 assert.deepEqual(flattenSubtasks(tree,new Set(['0']),item=>item.id).map(row=>row.item.id),['0','sibling']);
});
