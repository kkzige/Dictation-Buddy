import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compareVersions,isNewerVersion} from '../version-utils.js';

test('新版本与旧版本的比较',()=>{
  assert.equal(compareVersions('0.3.2','0.3.1'),1);
  assert.equal(compareVersions('0.3.2','0.3.2'),0);
  assert.equal(compareVersions('0.3.2','0.4.0'),-1);
  assert.equal(isNewerVersion('0.3.10','0.3.9'),true);
  assert.equal(isNewerVersion('0.3.1','0.3.2'),false);
});
test('版本格式非法时不误判更新',()=>{
  assert.throws(()=>isNewerVersion('0.3.2-preview','0.3.1'));
});
