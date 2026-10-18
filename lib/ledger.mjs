/**
 * lib/ledger.mjs —— 每日动作账本（代码级硬上限的唯一记分牌）
 * ============================================================================
 * 落盘：`~/.dsh/bili-interact/state.json`
 *   { "version": 1, "days": { "2026-10-18": { "like": 3 } },
 *     "log": [ { "at": "...", "action": "like", "target": "BV…", "ok": true } ] }
 *
 * ⭐ 这里有两条铁规矩（就是为了不变成刷量工具）：
 *   ① 计数按**本地日期**滚，跨天自动归零；
 *   ② 上限在 index.js 里被 HARD_MAX 再夹一次 —— 用户在设置里**只能调低，调不高**。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { dshHome } from './where.mjs'

const LOG_MAX = 200

export function ledgerFile() {
  return join(dshHome(), 'bili-interact', 'state.json')
}

function empty() {
  return { version: 1, days: {}, log: [] }
}

export function readLedger() {
  try {
    const file = ledgerFile()
    if (!existsSync(file)) return empty()
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object') return empty()
    if (!data.days || typeof data.days !== 'object') data.days = {}
    if (!Array.isArray(data.log)) data.log = []
    return data
  } catch {
    return empty() // 账本坏了就当今天没花过 —— 宁可多给一次，也不要让插件起不来
  }
}

function writeLedger(data) {
  try {
    const file = ledgerFile()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file) // 原子换 —— 别留半个 JSON
    return true
  } catch {
    return false // 写不进去也别抛：抛出去会杀掉调用方
  }
}

/** 本地日期键（YYYY-MM-DD）；用本地时区，跟用户看到的"今天"一致 */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function todayCounts(data = readLedger(), day = dayKey()) {
  const row = data.days?.[day]
  return row && typeof row === 'object' ? { ...row } : {}
}

export function usedToday(action, data = readLedger(), day = dayKey()) {
  const n = Number(todayCounts(data, day)[action] || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 今天（本地日期）记过账的条目 —— 给"同一对象每日上限"和审计列表用 */
export function todayEntries(data = readLedger(), day = dayKey()) {
  return (Array.isArray(data.log) ? data.log : []).filter((e) => {
    if (!e || typeof e.at !== 'string') return false
    const d = new Date(e.at)
    return Number.isFinite(d.getTime()) && dayKey(d) === day
  })
}

/** 记一笔成功动作：今天该动作 +1，并追加日志（日志只留最近 LOG_MAX 条） */
export function bump(action, target = '', extra = {}) {
  const data = readLedger()
  const day = dayKey()
  if (!data.days[day] || typeof data.days[day] !== 'object') data.days[day] = {}
  data.days[day][action] = Number(data.days[day][action] || 0) + 1
  data.log.push({ at: new Date().toISOString(), action, target: String(target || ''), ok: true, ...extra })
  if (data.log.length > LOG_MAX) data.log = data.log.slice(-LOG_MAX)
  // 只保留最近 14 天的计数，别让文件无限长
  const days = Object.keys(data.days).sort()
  while (days.length > 14) delete data.days[days.shift()]
  const ok = writeLedger(data)
  return { ok, used: data.days[day][action] }
}
