/**
 * test/smoke.mjs —— 不装进 DSH 也能验的最小冒烟测试
 * 跑法：node test/smoke.mjs
 *
 * 只验证"插件外壳"的行为：注册了几个工具、开关与上限守卫是否生效、
 * 以及 status 能否读到先辈环境。**不**在这里做真实写操作（点赞会改用户账号，
 * 那一步走真实工具调用，见 README 的自测步骤）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject, __testing } from '../index.js'

// ⭐ 隔离家目录：测试会创建/改写 config.json，绝不能碰用户真实的那份
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bili-interact-smoke-'))

const { HARD_MAX } = __testing

/** 假的 ctx：只提供 tools.register + logger */
function makeCtx() {
  const tools = new Map()
  return {
    tools,
    ctx: {
      tools: { register: (t) => { tools.set(t.name, t) } },
      logger: { info: () => {} },
    },
  }
}

const results = []
const t = async (label, fn) => {
  try { await fn(); results.push(['PASS', label]) } catch (e) { results.push(['FAIL', label, e?.message || String(e)]) }
}

let pass = 0
let fail = 0

// ① 插件元信息
await t('导出 name / inject', () => {
  assert.equal(name, 'bili-interact')
  assert.deepEqual(inject, ['tools'])  // webServer 走子插件可选挂载（headless 没有 HTTP 服务）
})

// ② 允许写操作 = 默认关：注册工具 + 拒绝写
{
  const { tools, ctx } = makeCtx()
  apply(ctx, {}) // 空配置 = 全默认
  await t('注册了 5 个工具', () => {
    assert.ok(tools.has('bili_touch'), '缺 bili_touch')
    assert.ok(tools.has('bili_touch_status'), '缺 bili_touch_status')
    assert.ok(tools.has('bili_post_dynamic'), '缺 bili_post_dynamic')
    assert.ok(tools.has('bili_following_updates'), '缺 bili_following_updates')
    assert.ok(tools.has('bili_fav_folders'), '缺 bili_fav_folders')
  })
  await t('发动态：正文为空被拒', async () => {
    const r = await tools.get('bili_post_dynamic').execute({ text: '   ' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /正文/)
  })
  await t('发动态：开关关着 → 拒绝（不真的发）', async () => {
    const r = await tools.get('bili_post_dynamic').execute({ text: '测试' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /关/)
  })
  await t('默认 allowWrite=false → 点赞被拒', async () => {
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: 'BV1d8pU6xEZX' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /默认是关的/)
  })
  await t('bvid 格式校验', async () => {
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: 'not-a-bvid' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /bvid 格式不对/)
  })
  await t('action 白名单校验', async () => {
    const r = await tools.get('bili_touch').execute({ action: 'dance', bvid: 'BV1d8pU6xEZX' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /不支持的 action/)
  })
  await t('七个动作都在白名单里', async () => {
    const r = await tools.get('bili_touch').execute({ action: 'share', bvid: 'BV1d8pU6xEZX' })
    // share 是合法动作，这里只要求它不报"不支持的 action"（默认 allowWrite=false 会先被开关挡住）
    assert.doesNotMatch(String(r.error || ''), /不支持的 action/)
  })
  await t('status 读到先辈环境 + 默认值', async () => {
    const r = await tools.get('bili_touch_status').execute({})
    assert.equal(r.ok, true)
    assert.equal(r.allowWrite, false)
    assert.deepEqual(r.hardMax, HARD_MAX)
    assert.ok(r.base.python, '没解析出 python')
    assert.ok(r.base.credential, '没解析出凭证')
  })
}

// ③ 配置文件（本插件没有客户端设置页，用户直接改这个 JSON）
{
  const cfgDir = join(process.env.DSH_HOME, 'bili-interact')
  const cfgFile = join(cfgDir, 'config.json')
  const { tools, ctx } = makeCtx()
  apply(ctx, {})
  await t('首次加载自动创建 config.json（默认关）', () => {
    assert.ok(existsSync(cfgFile), `没创建：${cfgFile}`)
    const j = JSON.parse(readFileSync(cfgFile, 'utf8'))
    assert.equal(j.allowWrite, false)
  })
  writeFileSync(cfgFile, JSON.stringify({ allowWrite: true, likePerDay: 9999, favPerDay: 2, bogus: 1 }), 'utf8')
  await t('改 config.json 立即生效（不用重启），上限仍被夹回 20', async () => {
    const r = await tools.get('bili_touch_status').execute({})
    assert.equal(r.allowWrite, true)
    assert.equal(r.limits.like, HARD_MAX.like) // 9999 → 20
    assert.equal(r.limits.fav, 2)
    assert.equal(r.cfgFile, cfgFile)
  })
  writeFileSync(cfgFile, JSON.stringify({ allowWrite: true, likePerDay: 0 }), 'utf8')
  await t('额度=0 时点赞被拒（不真的动账号）', async () => {
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: 'BV1d8pU6xEZX' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /额度用完了|今日/)
  })
  writeFileSync(cfgFile, '{ 这不是 JSON', 'utf8')
  await t('config.json 写坏 → 回落默认，不抛异常', async () => {
    const r = await tools.get('bili_touch_status').execute({})
    assert.equal(r.ok, true)
    assert.equal(r.allowWrite, false)
    assert.equal(r.limits.like, HARD_MAX.like)
  })
  writeFileSync(cfgFile, JSON.stringify({ allowWrite: false }), 'utf8') // 还原，别影响后面的用例
}

// ④ DSH config 字段类型错乱时不炸（先辈 2026-10-14 事故的同款输入）
{
  const { tools, ctx } = makeCtx()
  apply(ctx, { allowWrite: 'yes', likePerDay: { nested: true }, sharePerDay: '3' })
  await t('type 错乱的 config 不炸且回落到默认', async () => {
    const r = await tools.get('bili_touch_status').execute({})
    assert.equal(r.ok, true)
    assert.equal(r.allowWrite, false) // 字符串 'yes' 不算 true
    assert.equal(r.limits.like, HARD_MAX.like)
  })
}

for (const r of results) {
  if (r[0] === 'PASS') { pass++; console.log(`✅ ${r[1]}`) }
  else { fail++; console.log(`❌ ${r[1]}\n   ${r[2]}`) }
}
console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
