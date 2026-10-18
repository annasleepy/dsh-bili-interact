/**
 * test/live.mjs —— 真账号上的一次性端到端自测（会真的点赞/取消点赞！）
 * 跑法：BILI_LIVE=1 node test/live.mjs
 *
 * 与 GUI 里调工具走的是**同一份 index.js + python/bili_write.py**，
 * 只是 ctx 由这里伪造。所以它能回答"工具链是不是真的通"，
 * 至于"宿主有没有把工具注册进会话"要重启后看工具清单。
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const BVID = process.env.BILI_TEST_BVID || 'BV1d8pU6xEZX' // 先辈那期视频，最安全的自测对象
if (process.env.BILI_LIVE !== '1') {
  console.log('跳过：要真的动账号请设 BILI_LIVE=1')
  process.exit(0)
}

const tools = new Map()
const ctx = { tools: { register: (t) => { tools.set(t.name, t) } }, logger: { info: () => {} } }
apply(ctx, { allowWrite: true })

const touch = tools.get('bili_touch')
const status = tools.get('bili_touch_status')
assert.ok(touch && status, '工具没注册')

const results = []
const step = async (label, fn) => {
  try { const v = await fn(); results.push(['PASS', label, v]); return v }
  catch (e) { results.push(['FAIL', label, e?.message || String(e)]) }
}

await step('status：读环境', async () => {
  const s = await status.execute({})
  assert.equal(s.ok, true)
  console.log(`  环境：python=${s.base.python}`)
  console.log(`  环境：credential=${s.base.credential}`)
  console.log(`  额度：like ${s.usedToday.like}/${s.limits.like}`)
  return s
})

const before = await status.execute({})
const usedBefore = before.usedToday.like
let likeSkipped = false
let favSkipped = false

const likeRes = await step('点赞（真写操作）', async () => {
  const r = await touch.execute({ action: 'like', bvid: BVID })
  console.log(`  返回：${JSON.stringify(r).slice(0, 300)}`)
  if (!r.ok && /同一个视频/.test(String(r.error))) {
    likeSkipped = true
    console.log('  ⚠️ 同一视频今日额度已满（护栏生效），跳过 like/unlike 真机写入')
    return { skipped: true }
  }
  assert.equal(r.ok, true, `点赞失败：${JSON.stringify(r)}`)
  return r
})

if (!likeSkipped) {
  await step('账本 +1', async () => {
    const s = await status.execute({})
    assert.equal(s.usedToday.like, usedBefore + 1, `账本没 +1（${s.usedToday.like} vs ${usedBefore}）`)
    return s.usedToday.like
  })

  await step('取消点赞（还原账号状态）', async () => {
    const r = await touch.execute({ action: 'unlike', bvid: BVID })
    console.log(`  返回：${JSON.stringify(r).slice(0, 300)}`)
    assert.equal(r.ok, true, `取消点赞失败：${JSON.stringify(r)}`)
    return r
  })
}

await step('收藏（真写操作，收进默认收藏夹）', async () => {
  const r = await touch.execute({ action: 'fav', bvid: BVID })
  console.log(`  返回：${JSON.stringify(r).slice(0, 400)}`)
  if (!r.ok && /同一个视频/.test(String(r.error))) {
    favSkipped = true
    console.log('  ⚠️ 同一视频今日额度已满（护栏生效），跳过 fav/unfav 真机写入')
    return { skipped: true }
  }
  assert.equal(r.ok, true, `收藏失败：${JSON.stringify(r)}`)
  return r
})

if (!favSkipped) {
  await step('取消收藏（还原）', async () => {
    const r = await touch.execute({ action: 'unfav', bvid: BVID })
    console.log(`  返回：${JSON.stringify(r).slice(0, 400)}`)
    assert.equal(r.ok, true, `取消收藏失败：${JSON.stringify(r)}`)
    return r
  })
}

let pass = 0
let fail = 0
for (const [st, label, extra] of results) {
  if (st === 'PASS') { pass++; console.log(`✅ ${label}`) }
  else { fail++; console.log(`❌ ${label}\n   ${extra}`) }
}
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
