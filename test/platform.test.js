// 平台包测试（Task 22）：平台选择缝与安卓知识表形状
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlatform, listPlatforms } from '../src/platform/index.js';
import { androidPlatform } from '../src/platform/android.js';

test('resolvePlatform：缺省 android，未知平台报错', () => {
  assert.equal(resolvePlatform().name, 'android');
  assert.equal(resolvePlatform('android').name, 'android');
  assert.throws(() => resolvePlatform('ios'), /未知平台/);
});

test('androidPlatform：知识表完整', () => {
  assert.ok(androidPlatform.l2PromptFile.includes('system.android.md'));
  assert.ok(androidPlatform.factsProps.some((f) => f.prop === 'ro.build.version.release'));
  assert.ok(androidPlatform.grantablePermissions.includes('android.permission.CAMERA'));
  assert.ok(androidPlatform.systemDialogPackages.includes('com.android.permissioncontroller'));
  assert.ok(androidPlatform.lintPlatformFragments.includes('android:'));
});

test('listPlatforms：当前只有 android', () => {
  assert.deepEqual(listPlatforms(), ['android']);
});
