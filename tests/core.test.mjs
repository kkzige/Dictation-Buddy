import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  parseEntries, normalizeDb, deduplicateWords, arrangeWords, buildSteps,
  pinPrompt, collectWords, graphemes, prepareBankEntries
} from '../core.js';

test('中文逐行导入、去编号、去重但不错误拆词', () => {
  assert.deepEqual(parseEntries('1. 崎岖\n2、 拥抱\n崎岖\n  3. 坚韧', 'zh-CN').map(x => x.text), ['崎岖','拥抱','坚韧']);
});
test('英文词组保留内部空格', () => {
  assert.deepEqual(parseEntries('take care of\nlook after', 'en-US').map(x => x.text), ['take care of', 'look after']);
});
test('分隔符输入', () => {
  assert.deepEqual(parseEntries('苹果、香蕉，西瓜', 'zh-CN','punct').map(x => x.text), ['苹果','香蕉','西瓜']);
});
test('仅允许汉字下标被标记', () => {
  const d = normalizeDb({banks:[{id:'b',lang:'zh-CN',title:'x',items:[{id:'w',text:'a海！',marks:[0,1,1,2,99]}]}]});
  assert.deepEqual(d.banks[0].items[0].marks,[1]);
});
test('混合词库组合保留每词语言', () => {
  const db = normalizeDb({banks:[
    {id:'a',title:'中文',lang:'zh-CN',items:[{id:'a1',text:'崎岖',marks:[0]}]},
    {id:'b',title:'英语',lang:'en-US',items:[{id:'b1',text:'happen',marks:[]}]}
  ],groups:[{id:'g',title:'复习',refs:[{bankId:'a',itemId:'a1'},{bankId:'b',itemId:'b1'}]}]});
  assert.deepEqual(collectWords(db,{type:'group',id:'g'}).map(x=>x.lang), ['zh-CN','en-US']);
});
test('重复词合并标记', () => {
  const w = [{lang:'zh-CN',text:'崎岖',marks:[0]}, {lang:'zh-CN',text:'崎岖',marks:[1]}];
  assert.deepEqual(deduplicateWords(w)[0].marks,[0,1]);
});
test('每词重复3遍并在最后播拼音提示', () => {
  const words=[{text:'崎岖',lang:'zh-CN',marks:[1]}, {text:'forest',lang:'en-US',marks:[]}];
  const steps=buildSteps(words,{repetitions:3,repeatGap:1,wordGap:4});
  assert.equal(steps.filter(x=>x.type==='say'&&x.phase==='word').length,6);
  assert.equal(steps.filter(x=>x.phase==='pinyin').length,1);
  assert.match(pinPrompt(words[0]),/第2个字/);
  assert.deepEqual(steps.filter(x=>x.type==='say'&&x.phase==='word').map(x=>x.lang), ['zh-CN','zh-CN','zh-CN','en-US','en-US','en-US']);
});
test('随机模式为真正重排', () => {
  const words=[{lang:'en-US',text:'a',marks:[]},{lang:'en-US',text:'b',marks:[]},{lang:'en-US',text:'c',marks:[]}];
  assert.deepEqual(arrangeWords(words,{skipDuplicates:true,order:'random'},()=>0).map(x=>x.text), ['b','c','a']);
});
test('标记按 Unicode 字符计算', () => {
  assert.equal(graphemes('𠮷祥').length,2);
});

test('向已有词库批量添加：跳过重复并保留原 ID 和拼音标记', () => {
  const original=[{id:'old-1',text:'苹果',marks:[0]}];
  const additions=[
    {id:'new-1',text:' 苹果 ',marks:[1]},
    {id:'new-2',text:'香蕉',marks:[0,1]},
    {id:'new-3',text:'香蕉',marks:[1]},
    {id:'new-4',text:'葡萄',marks:[0]},
  ];
  const {items,skipped}=prepareBankEntries(additions,'zh-CN',original);
  assert.equal(skipped,2);
  assert.deepEqual(items.map(w=>w.text),['香蕉','葡萄']);
  assert.deepEqual(items[0].marks,[0,1]);
  assert.deepEqual(original,[{id:'old-1',text:'苹果',marks:[0]}]);
});

test('中文宽度兼容去重、英语大小写去重，英语自动保留词组', () => {
  const existing=[{id:'1',text:'ABC',marks:[]}];
  const {items,skipped}=prepareBankEntries([{id:'2',text:'ａｂｃ',marks:[0]},{id:'3',text:'look after',marks:[1]}],'en-US',existing);
  assert.equal(skipped,1);
  assert.deepEqual(items.map(i=>i.text),['look after']);
  assert.deepEqual(items[0].marks,[]);
  assert.deepEqual(parseEntries('苹果 香蕉 葡萄','zh-CN','auto').map(x=>x.text),['苹果','香蕉','葡萄']);
  assert.deepEqual(parseEntries('look after\nget up','en-US','auto').map(x=>x.text),['look after','get up']);
});
