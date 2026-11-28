// 模型交互 transcript 落盘：每次 LLM 请求/响应追加一行 JSON 到 <runDir>/transcript.jsonl。
// run 结束后文件保留，供排查 prompt/response/token 用量/耗时；写入失败由调用方吞掉，不阻断主流程。

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 创建 transcript 写入器。首行写一条 meta 说明覆盖范围（session.prompt 路径暂未捕获）。
 * @param {string} runDir - run 目录路径（不存在时自动创建）
 * @returns {(entry: object) => void} transcriptWriter(entry)：每条记录序列化为一行 JSON 追加
 */
export function createTranscriptWriter(runDir) {
  const filePath = join(runDir, 'transcript.jsonl');
  mkdirSync(runDir, { recursive: true });
  // 头部 meta：声明本文件的捕获边界，避免排查时误以为覆盖了全部模型交互
  appendFileSync(filePath, JSON.stringify({
    type: 'meta',
    note: '本文件仅记录 createChatClient 路径的模型交互（VLM定位/doctor/cmdAsk）。agent 主循环(session.prompt)的交互暂未捕获。',
  }) + '\n');
  return (entry) => {
    appendFileSync(filePath, JSON.stringify(entry) + '\n');
  };
}