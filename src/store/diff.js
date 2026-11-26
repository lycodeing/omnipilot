// data diff 语义：按 _run 分组，取最近两个 distinct run（按组内 _ts 最大值排序），
// cur=最近 run 行，prev=次近 run 行。`--against last` 即"与上一次 run 对比"。
// 旧实现把 prev 取成"所有非 lastRun 行"（多次 run 混在一起），本模块修正该语义。

export function diffByRun(rows) {
  const byRun = new Map();
  for (const r of rows ?? []) {
    const run = r?._run ?? null;
    if (!byRun.has(run)) byRun.set(run, []);
    byRun.get(run).push(r);
  }
  const runs = [...byRun.entries()].map(([run, rs]) => ({ run, rs, maxTs: Math.max(...rs.map((r) => r._ts ?? 0)) }));
  runs.sort((a, b) => b.maxTs - a.maxTs);
  const cur = runs[0] ?? { run: null, rs: [] };
  const prev = runs[1] ?? { run: null, rs: [] };
  return {
    lastRun: cur.run,
    previousRun: prev.run,
    currentRows: cur.rs.length,
    previousRows: prev.rs.length,
    current: cur.rs.slice(0, 5),
    previous: prev.rs.slice(-5),
  };
}
