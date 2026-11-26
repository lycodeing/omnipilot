// 安卓平台包：把散落各层的 Android 知识收敛为单一描述对象。
// 新增平台 = 新增一个平台包文件 + resolvePlatform 注册，引擎逻辑零改。

// facts 采集：getprop 键 → facts 字段名。单独常量便于派生 factsKeys 别名，避免两份表分叉。
const FACTS_PROPS = [
  { prop: 'ro.build.version.release', key: 'androidVersion' },
  { prop: 'ro.product.model', key: 'deviceModel' },
];

export const androidPlatform = {
  name: 'android',
  displayName: 'Android',
  l2PromptFile: 'prompts/system.android.md',
  // facts 采集：getprop 键 → facts 字段名
  factsProps: FACTS_PROPS,
  // facts 字段名清单（从 factsProps 派生，供按名取字段的消费方使用）
  factsKeys: FACTS_PROPS.map((f) => f.key),
  // lint 平台片段规则：顶层出现这些键判 error（平台拼装冲突）
  lintPlatformFragments: ['android:', 'ios:', 'web:', 'desktop:', 'tasks:'],
  grantablePermissions: [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_CONTACTS',
    'android.permission.CALL_PHONE',
    'android.permission.READ_SMS',
  ],
  systemDialogPackages: [
    'com.google.android.permissioncontroller',
    'com.android.permissioncontroller',
    'com.google.android.packageinstaller',
    'com.android.packageinstaller',
    'com.android.systemui',
  ],
  residentSystemPackages: ['com.android.systemui'],
  toolDescriptionExamples: {
    read: 'class=android.widget.TextView#index=1',
  },
};
