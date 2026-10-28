// 解析报告 HTML 中的 ask-dump / ask-image 数据标签（契约 §1 / §4.1）
const DUMP_TYPE = 'ask-dump'
const IMAGE_TYPE = 'ask-image'
const DEFAULT_GROUP = 'default'

function emptyMeta() {
  return {
    sdkVersion: '',
    groupName: '',
    groupDescription: '',
    deviceType: '',
    device: null,
    modelBriefs: [],
    durationMs: null,
    status: '',
  }
}

function safeParse(text) {
  try {
    if (!text || !text.trim()) return null
    // C 写入时对 `</` 做了 `<\/` 转义，JSON.parse 原生支持 `\/`，解析即还原
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isStr(v) {
  return typeof v === 'string'
}

// single-html 模式的截图是 MB 级 base64 data URL：一次性转 Blob + objectURL。
// 收益：浏览器对 blob 解码结果可缓存复用（换图预热/交叉淡入不再重复同步解码），
// 且 JS 层不再长期持有 base64 大字符串。非 data URL（assets 模式相对路径）直通。
function toDisplayUrl(src) {
  if (!isStr(src) || !src.startsWith('data:')) return src
  const comma = src.indexOf(',')
  if (comma < 0) return src
  const meta = src.slice(5, comma) // 如 image/png;base64
  if (!/;\s*base64$/i.test(meta)) return src
  if (
    typeof atob !== 'function' ||
    typeof Blob !== 'function' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return src // 环境不支持（如老 Node 测试环境）→ 保持原值
  }
  try {
    const bin = atob(src.slice(comma + 1))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: meta.split(';')[0] || 'image/png' }))
  } catch {
    return src // base64 损坏等 → 保持原值
  }
}

// 同 data-group-id 去重保最新；ask-image 收进 screenshots；assets 模式相对路径直通
// 返回 { meta, executions, screenshots, assertions, networkTimeline, rollbacks }
// （后三项为契约 §4.1 形状之外的增加项，供 AssertionCard/NetworkLane 取数，见最终报告偏差说明）
export function parseReportDocument(doc = document) {
  const meta = emptyMeta()
  const executions = []
  const screenshots = {}
  const assertions = []
  const networkTimeline = []
  const rollbacks = []
  const latestByGroup = new Map()

  let dumpTags = []
  try {
    dumpTags = Array.from(doc.querySelectorAll(`script[type="${DUMP_TYPE}"]`))
  } catch {
    dumpTags = []
  }
  for (const tag of dumpTags) {
    const dump = safeParse(tag.textContent)
    if (!dump || typeof dump !== 'object') continue
    const groupId = tag.getAttribute('data-group-id') || DEFAULT_GROUP
    latestByGroup.set(groupId, dump) // 后出现覆盖先出现 → 保最新
  }

  for (const dump of latestByGroup.values()) {
    if (Array.isArray(dump.executions)) {
      for (const exec of dump.executions) {
        if (exec && typeof exec === 'object') executions.push(exec)
      }
    }
    if (isStr(dump.sdkVersion)) meta.sdkVersion = dump.sdkVersion
    if (isStr(dump.groupName)) meta.groupName = dump.groupName
    if (isStr(dump.groupDescription)) meta.groupDescription = dump.groupDescription
    if (isStr(dump.deviceType)) meta.deviceType = dump.deviceType
    if (dump.device && typeof dump.device === 'object' && !Array.isArray(dump.device)) meta.device = dump.device
    if (Array.isArray(dump.modelBriefs)) meta.modelBriefs = dump.modelBriefs
    if (Number.isFinite(dump.durationMs)) meta.durationMs = dump.durationMs
    if (isStr(dump.status)) meta.status = dump.status
    if (dump.screenshots && typeof dump.screenshots === 'object' && !Array.isArray(dump.screenshots)) {
      for (const [id, src] of Object.entries(dump.screenshots)) {
        // single-html 为 "" 占位（真图在 ask-image 标签）；assets 模式为相对路径
        if (id && isStr(src) && src) screenshots[id] = toDisplayUrl(src)
      }
    }
    if (Array.isArray(dump.assertions)) assertions.push(...dump.assertions)
    if (Array.isArray(dump.networkTimeline)) networkTimeline.push(...dump.networkTimeline)
    if (Array.isArray(dump.rollbacks)) rollbacks.push(...dump.rollbacks)
  }

  let imageTags = []
  try {
    imageTags = Array.from(doc.querySelectorAll(`script[type="${IMAGE_TYPE}"]`))
  } catch {
    imageTags = []
  }
  for (const tag of imageTags) {
    const id = tag.getAttribute('data-id')
    const src = (tag.textContent || '').trim()
    if (id && src) screenshots[id] = toDisplayUrl(src) // ask-image 为权威数据源，覆盖占位
  }

  return { meta, executions, screenshots, assertions, networkTimeline, rollbacks }
}
