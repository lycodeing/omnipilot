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
//
// 写路径攒批（性能）：locate 是全系统最高频调用，旧实现每次成功定位都 upsert →
// locate_cache 同键命中时 merged>0 触发整文件重写（O(N) 写/次）。改为 run 内先写内存
// pending Map，去抖（FLUSH_DEBOUNCE_MS）或攒满 FLUSH_BATCH 条时一次性 upsert；
// 读 hint 优先查 pending，保证 run 内一致性。flush 挂到返回函数上供 run 收尾 await。
const FLUSH_DEBOUNCE_MS = 1500;
const FLUSH_BATCH = 50;

export function createCachedLocate({ device, store, opts = {}, ctx = null }) {
  const pending = new Map();
  let flushTimer = null;

  async function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending.size || !store) return;
    const rows = [...pending.values()];
    pending.clear();
    try {
      await store.upsert('locate_cache', 'key', rows, {});
    } catch { /* 缓存写失败不阻断 */ }
  }

  function scheduleFlush() {
    if (pending.size >= FLUSH_BATCH) { void flush(); return; }
    if (flushTimer) return;
    // 不用 unref：保证进程退出前 flush 完成，缓存不丢
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_DEBOUNCE_MS);
  }

  const locateWithCache = async function locateWithCache(target) {
    let hintBounds = null;
    let hintIdentity = null;
    let cacheRow = null;
    const stepKey = ctx?.currentStepKey ?? null;
    const ordinal = ctx?.locateOrdinal ?? 0;
    const key = buildCacheKey({ ...(stepKey ?? {}), locateOrdinal: ordinal, target });

    if (!opts.freshLocate && store) {
      try {
        // run 内刚写过的键优先（尚未落盘）
        let found = pending.get(key) || null;
        if (!found) {
          const rows = await store.read('locate_cache');
          found = rows.find((r) => r.key === key) || null;
        }
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

    // 定位成功 → 记入 pending（命中 cache 时不重复写，避免无效 IO）
    if (res.ok && res.bounds && store && res.strategy !== 'cache') {
      try {
        const prev = pending.get(key) || cacheRow || {};
        const stepKey2 = ctx?.currentStepKey ?? null;
        const ord2 = ctx?.locateOrdinal ?? 0;
        pending.set(key, {
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
        });
        scheduleFlush();
      } catch { /* 缓存写失败不阻断 */ }
    }
    // 每次定位后 ordinal 递增：同一步骤内多次定位各占独立缓存槽
    if (ctx) ctx.locateOrdinal = ordinal + 1;
    return res;
  };

  locateWithCache.flush = flush;
  return locateWithCache;
}
