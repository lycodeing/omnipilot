// 带跨执行坐标缓存的定位（§1.5 / §5.0.5）。
//
// 背景（2026-10-27 真机验证发现）：契约把缓存职责赋予"locate 工具"，但实际最高频的定位发生在
// tap/long_press/input/swipe 等动作工具里——它们原先直接调 device.locate()，完全绕过缓存层。
// 结果：175 次定位里只有 5 次命中 cache（3%），缓存形同虚设。
// 修法：把"读 hint → 定位 → 命中回写"抽成本函数，所有定位入口统一复用。
//
// 键方案（§2.1 评审 C1 重设计）：旧键 `${pageId}:${target}` 因单 Activity 架构（首页/热榜/发现全叫
// MainActivity）失去区分度。新键用"用例步骤身份"：caseId::stepIndex::locateOrdinal::target。
//
// 职责边界（尊重契约 §1.5）：本层只做 store 读写与 hint 传参；identity 校验（R2）在 device.locate 内。

// 键构造（纯函数，可单测）
export function buildCacheKey({ caseId, stepIndex, locateOrdinal, target }) {
  return `${caseId ?? 'unknown'}::${stepIndex ?? -1}::${locateOrdinal ?? 0}::${target ?? ''}`;
}

// 尺寸失效判定：缓存行记录的分辨率与当前设备不一致 → 坐标必然失效，判 miss
function sizeMatches(cacheRow, size) {
  const a = cacheRow?.screenSize;
  if (!a || !size) return true; // 任一侧缺失则不以此判定（交给 R2 兜底）
  return Number(a.w) === Number(size.w) && Number(a.h) === Number(size.h);
}

// deps: { device, store, opts }；ctx 提供 { currentStepKey, locateOrdinal }
// opts.freshLocate=true 时不读 hint（强制重新识别）
export function createCachedLocate({ device, store, opts = {}, ctx = null }) {
  return async function locateWithCache(target) {
    let hintBounds = null;
    let hintIdentity = null;
    let cacheRow = null;
    const stepKey = ctx?.currentStepKey ?? null;
    const ordinal = ctx?.locateOrdinal ?? 0;
    const key = buildCacheKey({ ...(stepKey ?? {}), locateOrdinal: ordinal, target });

    if (!opts.freshLocate && store) {
      try {
        const rows = await store.read('locate_cache');
        const found = rows.find((r) => r.key === key) || null;
        const size = await device.screenSize().catch(() => null);
        // 三重安全网之第二层：分辨率不符 → 判 miss（防跨设备误用）
        cacheRow = found && sizeMatches(found, size) ? found : null;
        if (cacheRow) {
          hintBounds = cacheRow.bounds || null;
          hintIdentity = cacheRow.identity || null;
        }
      } catch { /* 缓存缺失不阻断 */ }
    }

    const res = await device.locate(target, { hintBounds, hintIdentity });

    // 定位成功 → upsert 坐标缓存（命中 cache 时不重复写，避免无效 IO）
    if (res.ok && res.bounds && store && res.strategy !== 'cache') {
      try {
        const prev = cacheRow || {};
        const stepKey2 = ctx?.currentStepKey ?? null;
        const ord2 = ctx?.locateOrdinal ?? 0;
        await store.upsert('locate_cache', 'key', [{
          key: buildCacheKey({ ...(stepKey2 ?? {}), locateOrdinal: ord2, target }),
          caseId: stepKey2?.caseId ?? 'unknown',
          stepIndex: stepKey2?.stepIndex ?? -1,
          locateOrdinal: ord2,
          target: String(target ?? ''),
          bounds: res.bounds,
          identity: res.identity,
          screenSize: await device.screenSize().catch(() => null),
          hits: (prev.hits || 0) + 1,
          lastHitAt: Date.now(),
        }], {});
      } catch { /* 缓存写失败不阻断 */ }
    }
    // 每次定位后 ordinal 递增：同一步骤内多次定位各占独立缓存槽
    if (ctx) ctx.locateOrdinal = ordinal + 1;
    return res;
  };
}
