/**
 * test/edge.mjs —— 边界 / 故障注入测试（**不联网、不动真账号**）
 * 跑法：node test/edge.mjs
 *
 * 为什么有它：smoke.mjs 只验"外壳行为"，live.mjs 会真动账号。
 * 这一层专门喂**坏输入**和**假 python**：
 *   - config.json / DSH 配置里的脏值（true、数组、负数、小数、字符串数字、坏 JSON）
 *   - bvid / action / text 的各种畸形参数
 *   - 账本损坏、跨天、垃圾计数
 *   - 假 python 模拟：正常 / 噪声输出 / 静默退出 / 报错 JSON / 并发抢额度
 * 全部跑在临时 DSH_HOME 里，真家目录一个字节都不碰。
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

// 先隔离家目录，再 import 插件（plugin 的 where/ledger 都是调用时读 env，这里只是保险）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bi-edge-boot-'))
const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
const { apply, __testing } = plugin
const { HARD_MAX, HARD_PER_TARGET, HARD_DM_PER_DAY } = __testing

const BVID = 'BV1d8pU6xEZX'
const results = []
const t = async (label, fn) => {
  try { await fn(); results.push(['PASS', label]) } catch (e) { results.push(['FAIL', label, e?.message || String(e)]) }
}
const tmpHome = (tag) => mkdtempSync(join(tmpdir(), `bi-edge-${tag}-`))
const dayKeyOf = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const today = () => dayKeyOf()
const yesterday = () => dayKeyOf(new Date(Date.now() - 86400000))

/** 假 ctx：只提供 tools.register + logger */
function mount(home, config = {}) {
  process.env.DSH_HOME = home
  const tools = new Map()
  const ctx = { tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }
  apply(ctx, config)
  return {
    tools,
    touch: tools.get('bili_touch'),
    dyn: tools.get('bili_post_dynamic'),
    dm: tools.get('bili_send_dm'),
    trending: tools.get('bili_trending'),
    inbox: tools.get('bili_inbox'),
    favContent: tools.get('bili_fav_content'),
    status: tools.get('bili_touch_status'),
  }
}

function writeCfg(home, cfg) {
  // 大多数用例测的是别的逻辑，先把"公开发布类默认关"显式打开；专门测默认值的用例会自己覆盖
  if (typeof cfg === 'object' && cfg !== null) cfg = { allowWrite: true, allowShare: true, allowDynamic: true, ...cfg }
  const dir = join(home, 'bili-interact')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg, null, 2), 'utf8')
}

function seedState(home, days = {}, log = []) {
  const dir = join(home, 'bili-interact')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, days, log }), 'utf8')
}

/* ═══════════════ ① 配置与开关 ═══════════════ */
console.log('① 配置与开关')

await t('首次加载自动创建 config.json（默认关）', () => {
  const home = tmpHome('cfg1')
  mount(home)
  const f = join(home, 'bili-interact', 'config.json')
  assert.ok(existsSync(f), 'config.json 没被创建')
  const cfg = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(cfg.allowWrite, false)
  assert.equal(cfg.likePerDay, HARD_MAX.like)
  assert.ok(Object.keys(cfg).some((k) => k.startsWith('_说明')), '缺 _说明')
})

await t('坏 JSON → 当没有（不崩、保持默认关）', async () => {
  const home = tmpHome('cfg2')
  mount(home)
  writeCfg(home, '{ this is not json')
  const r = await mount(home).touch.execute({ action: 'like', bvid: BVID })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /默认是关的|关/)
})

await t('allowWrite: "true" 字符串 → 视为打开（宽容但不含糊）', async () => {
  const home = tmpHome('cfg3')
  mount(home)
  writeCfg(home, { allowWrite: 'true' })
  const r = await mount(home).touch.execute({ action: 'like', bvid: BVID })
  // 打开后会走到环境检查（这个 home 没有先辈环境）
  assert.equal(r.ok, false)
  assert.doesNotMatch(String(r.error), /默认是关的/)
  assert.match(String(r.error), /凭证|Python|环境/)
})

await t('allowWrite: "yes" → 不算打开', async () => {
  const home = tmpHome('cfg4')
  mount(home)
  writeCfg(home, { allowWrite: 'yes' })
  const r = await mount(home).touch.execute({ action: 'like', bvid: BVID })
  assert.match(String(r.error), /默认是关的/)
})

await t('上限脏值：true/数组被忽略，字符串数字认，负数夹 0，小数向下取整', async () => {
  const home = tmpHome('cfg5')
  mount(home)
  writeCfg(home, { likePerDay: true, favPerDay: [10], sharePerDay: '3.9', followPerDay: -5, dynamicPerDay: 9 })
  const s = await mount(home).status.execute({})
  assert.equal(s.limits.like, HARD_MAX.like, 'true 不该被 Number(true)=1 吃掉')
  assert.equal(s.limits.fav, HARD_MAX.fav, '数组参数不该被 Number(["10"])=10 吃掉')
  assert.equal(s.limits.share, 3, '字符串小数 3.9 → 向下取整 3')
  assert.equal(s.limits.follow, 0)
  assert.equal(s.limits.dynamic, HARD_MAX.dynamic, '发动态硬上限是 2，配多少都夹到 2')
})

await t('上限超大值夹到硬上限', async () => {
  const home = tmpHome('cfg6')
  mount(home)
  writeCfg(home, { likePerDay: 1e9, favPerDay: 999, sharePerDay: 999, followPerDay: 999, dynamicPerDay: 999 })
  const s = await mount(home).status.execute({})
  assert.deepEqual(s.limits, { ...HARD_MAX, dm: 5, folder: 2, total: 25, perTarget: 2 })
})

await t('DSH 配置脏值不炸：allowWrite:"yes" / likePerDay:{nested} / sharePerDay:"3"', async () => {
  const home = tmpHome('cfg7')
  writeCfg(home, { allowWrite: false }) // 文件显式关，别让 DSH 配置的 allowWrite 影响
  const m = mount(home, { allowWrite: 'yes', likePerDay: { nested: true }, sharePerDay: '3' })
  const s = await m.status.execute({})
  assert.equal(s.allowWrite, false)
  assert.equal(s.limits.like, HARD_MAX.like)
  assert.equal(s.limits.share, 3)
})

/* ═══════════════ ② 参数与闸门 ═══════════════ */
console.log('② 参数与闸门')
{
  const home = tmpHome('args')
  mount(home) // 默认关：合法参数一律止步于开关；非法参数在开关前被拒
  const m = mount(home)

  await t('bvid 小写前缀被容忍并归一', async () => {
    const r = await m.touch.execute({ action: 'like', bvid: 'bv1d8pU6xEZX' })
    assert.equal(r.ok, false)
    assert.doesNotMatch(String(r.error), /bvid 格式不对/, '小写 bv 不该被判格式错')
  })

  await t('bvid 全大写也合法（大小写不影响校验，只影响调用）', async () => {
    const r = await m.touch.execute({ action: 'like', bvid: 'BV1D8PU6XEZX' })
    assert.doesNotMatch(String(r.error), /bvid 格式不对/)
  })

  await t('bvid 长度/内容校验', async () => {
    for (const bad of ['BV123', 'BV1d8pU6xEZ', 'BV1d8pU6xEZXx', 'not-a-bvid', 'BV!@#$%^&*()']) {
      const r = await m.touch.execute({ action: 'like', bvid: bad })
      assert.equal(r.ok, false, `应拒绝：${bad}`)
      assert.match(String(r.error), /bvid 格式不对/, `应报格式错：${bad} → ${r.error}`)
    }
  })

  await t('action 白名单：空/未知/大写都被拒，且列出全部 7 个动作', async () => {
    for (const bad of ['', 'dance', 'LIKE']) {
      const r = await m.touch.execute({ action: bad, bvid: BVID })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /不支持的 action/)
    }
    const r = await m.touch.execute({ action: 'dance', bvid: BVID })
    for (const a of ['like', 'unlike', 'fav', 'unfav', 'share', 'follow', 'unfollow']) {
      assert.ok(String(r.error).includes(a), `提示里缺 ${a}`)
    }
    assert.ok(!String(r.error).includes('coin'), '提示里不该再有 coin')
  })

  await t('非字符串参数被明确拒绝（不会 String 成 [object Object]）', async () => {
    const a = await m.touch.execute({ action: 123, bvid: BVID })
    assert.match(String(a.error), /action 必须是字符串/)
    const b = await m.touch.execute({ action: 'like', bvid: 123 })
    assert.match(String(b.error), /bvid 必须是字符串/)
    const c = await m.dyn.execute({ text: { a: 1 } })
    assert.match(String(c.error), /text 必须是字符串/)
    const d = await m.dyn.execute({ text: 'hi', at: 123 })
    assert.match(String(d.error), /at 必须是字符串/)
  })

  await t('发动态正文边界：空 / 空白 / 200 字通过闸门 / 201 字被拒', async () => {
    assert.match(String((await m.dyn.execute({ text: '' })).error), /正文/)
    assert.match(String((await m.dyn.execute({ text: '   ' })).error), /正文/)
    const ok200 = await m.dyn.execute({ text: '字'.repeat(200) })
    assert.doesNotMatch(String(ok200.error), /太长/, '200 字不该被判太长')
    assert.match(String((await m.dyn.execute({ text: '字'.repeat(201) })).error), /太长/)
  })

  await t('status 结构稳定：6 个额度键 + hardMax 与代码一致', async () => {
    const s = await m.status.execute({})
    assert.equal(s.ok, true)
    assert.deepEqual(Object.keys(s.usedToday).sort(), ['dm', 'dynamic', 'fav', 'follow', 'like', 'share'])
    // dynamic 默认 1（硬上限 2）；dm 默认 5（硬上限 10）；其余额度默认即硬上限
    assert.deepEqual(s.limits, { ...HARD_MAX, dynamic: 1, dm: 5, folder: 2, total: 25, perTarget: 2 })
    assert.deepEqual(s.hardMax, HARD_MAX)
    assert.equal(s.ready, false)
    assert.match(String(s.reason), /凭证/)
  })
}

/* ═══════════════ ③ 额度与账本 ═══════════════ */
console.log('③ 额度与账本')

await t('likePerDay=0 → 直接额度拒绝（不启动 python）', async () => {
  const home = tmpHome('q0')
  mount(home)
  writeCfg(home, { allowWrite: true, likePerDay: 0 })
  const r = await mount(home).touch.execute({ action: 'like', bvid: BVID })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /额度用完了（0\/0）/)
})

await t('今天已用满 → 拒绝；撤销类动作不占额度', async () => {
  const home = tmpHome('q1a')
  mount(home)
  writeCfg(home, { allowWrite: true })
  seedState(home, { [today()]: { like: HARD_MAX.like } })
  const m = mount(home)
  const like = await m.touch.execute({ action: 'like', bvid: BVID })
  assert.match(String(like.error), /额度用完了/)
  const unlike = await m.touch.execute({ action: 'unlike', bvid: BVID })
  assert.match(String(unlike.error), /凭证|Python|环境/, '撤销类动作不该被点赞额度挡住')
})

await t('跨天自动归零：昨天用满不影响今天', async () => {
  const home = tmpHome('q2')
  mount(home)
  seedState(home, { [yesterday()]: { like: HARD_MAX.like } })
  const s = await mount(home).status.execute({})
  assert.equal(s.usedToday.like, 0)
  assert.equal(s.today, today())
})

await t('账本损坏 / 计数是垃圾 → 当 0，不崩', async () => {
  const home = tmpHome('q3')
  mount(home)
  seedState(home, { [today()]: { like: 'abc', fav: -5, share: null } })
  const s = await mount(home).status.execute({})
  assert.equal(s.usedToday.like, 0)
  assert.equal(s.usedToday.fav, 0)
  assert.equal(s.usedToday.share, 0)
  // 整个文件坏掉
  mkdirSync(join(home, 'bili-interact'), { recursive: true })
  writeFileSync(join(home, 'bili-interact', 'state.json'), 'not json at all', 'utf8')
  const s2 = await mount(home).status.execute({})
  assert.equal(s2.usedToday.like, 0)
})

await t('发动态额度用满 → 拒绝', async () => {
  const home = tmpHome('q4')
  mount(home)
  writeCfg(home, { allowWrite: true, dynamicPerDay: 1 })
  seedState(home, { [today()]: { dynamic: 1 } })
  const r = await mount(home).dyn.execute({ text: '测试' })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /额度用完了/)
})

await t('ledger：日志只留 200 条、计数只留 14 天', async () => {
  const home = tmpHome('ledger')
  process.env.DSH_HOME = home
  const ledger = await import(pathToFileURL(join(ROOT, 'lib', 'ledger.mjs')).href)
  for (let i = 0; i < 205; i++) ledger.bump('like', `BV${i}`)
  const data = JSON.parse(readFileSync(join(home, 'bili-interact', 'state.json'), 'utf8'))
  assert.equal(data.log.length, 200, `日志条数 ${data.log.length}`)
  assert.equal(ledger.usedToday('like'), 205)
  // 塞 20 天旧数据，再 bump 一次，应只剩 14 天
  const days = {}
  for (let i = 0; i < 20; i++) days[dayKeyOf(new Date(Date.now() - i * 86400000))] = { like: 1 }
  writeFileSync(join(home, 'bili-interact', 'state.json'), JSON.stringify({ version: 1, days, log: [] }), 'utf8')
  ledger.bump('like', 'x')
  const d2 = JSON.parse(readFileSync(join(home, 'bili-interact', 'state.json'), 'utf8'))
  assert.ok(Object.keys(d2.days).length <= 14, `天数 ${Object.keys(d2.days).length}`)
})

/* ═══════════════ ④ 故障注入（假 python） ═══════════════ */
console.log('④ 故障注入（假 python）')

const PY_EXE = process.env.BILI_TEST_PYTHON
  || join(homedir(), '.dsh', 'bili-duty', '.venv', 'Scripts', 'python.exe')
const hasPython = existsSync(PY_EXE)

if (!hasPython) {
  results.push(['SKIP', `④ 找不到 python（${PY_EXE}），故障注入段跳过`])
} else {
  const STUB = `import json, os, sys, time
mode = os.environ.get("BILI_STUB_MODE", "ok")
time.sleep(0.2)
if mode == "silent":
    sys.exit(0)
if mode == "noise":
    print("some python warning noise")
    print("another line")
if mode == "failjson":
    print(json.dumps({"ok": False, "error": "接口返回 -412"}, ensure_ascii=False))
    sys.exit(3)
print(json.dumps({"ok": True, "action": (sys.argv[1] if len(sys.argv) > 1 else None),
                  "api_code": 0, "who": {"mid": 1, "name": "stub"},
                  "state": {"lastCheckedAt": 123, "lastSeen": {"354813103": "BV1d8pU6xEZX"}},
                  "argv": sys.argv[1:]}, ensure_ascii=False))
`
  function makeStubPlugin() {
    const dir = mkdtempSync(join(tmpdir(), 'bi-edge-plugin-'))
    for (const f of ['index.js', 'package.json', 'cordis.patch.yml', 'lib', 'python']) {
      cpSync(join(ROOT, f), join(dir, f), { recursive: true })
    }
    writeFileSync(join(dir, 'python', 'bili_write.py'), STUB, 'utf8')
    return dir
  }
  function stubHome(tag) {
    const home = tmpHome(tag)
    mkdirSync(join(home, 'bili-duty'), { recursive: true })
    writeFileSync(join(home, 'bili-duty', 'bili_credential.json'), JSON.stringify({ sessdata: 'stub' }), 'utf8')
    writeFileSync(join(home, 'bili-duty', 'config.json'), JSON.stringify({ pythonPath: PY_EXE }), 'utf8')
    writeCfg(home, { allowWrite: true, likePerDay: 3, dynamicPerDay: 2 })
    return home
  }

  const stubPlugin = await import(pathToFileURL(join(makeStubPlugin(), 'index.js')).href)

  /** 只读工具用：装一次、只取四个只读/状态工具 */
  function roMount(home) {
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    return {
      trending: tools.get('bili_trending'),
      inbox: tools.get('bili_inbox'),
      favContent: tools.get('bili_fav_content'),
      status: tools.get('bili_touch_status'),
    }
  }

  await t('正常路径：假 python 返回 ok → 工具 ok、账本 +1、remaining 正确', async () => {
    const home = stubHome('stub1')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: BVID })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.usedToday, 1)
    assert.equal(r.remaining, 2)
    assert.equal(r.detail.who.name, 'stub')
  })

  await t('假 python 先打噪声行，仍能从最后一行取到 JSON', async () => {
    process.env.BILI_STUB_MODE = 'noise'
    const home = stubHome('stub2')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: BVID })
    delete process.env.BILI_STUB_MODE
    assert.equal(r.ok, true, JSON.stringify(r))
  })

  await t('假 python 一个字都不吐 → 明确报"没吐出可解析的结果"', async () => {
    process.env.BILI_STUB_MODE = 'silent'
    const home = stubHome('stub3')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: BVID })
    delete process.env.BILI_STUB_MODE
    assert.equal(r.ok, false)
    assert.match(String(r.error), /可解析/)
  })

  await t('假 python 返回 ok:false + 非零退出码 → 原样带回错误，且**不记账**', async () => {
    process.env.BILI_STUB_MODE = 'failjson'
    const home = stubHome('stub4')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: BVID })
    delete process.env.BILI_STUB_MODE
    assert.equal(r.ok, false)
    assert.match(String(r.error), /-412/)
    const s = await tools.get('bili_touch_status').execute({})
    assert.equal(s.usedToday.like, 0, '失败的动作不该记账')
  })

  await t('⭐ 并发抢额度：两个调用同时看到"还剩 1 次"，只能成功一个', async () => {
    const home = stubHome('stub5')
    writeCfg(home, { allowWrite: true, likePerDay: 1 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const [a, b] = await Promise.all([
      touch.execute({ action: 'like', bvid: BVID }),
      touch.execute({ action: 'like', bvid: BVID }),
    ])
    const oks = [a, b].filter((r) => r.ok === true).length
    assert.equal(oks, 1, `并发下成功了 ${oks} 次（应该 1 次）：${JSON.stringify([a.ok, b.ok])}`)
    const s = await tools.get('bili_touch_status').execute({})
    assert.equal(s.usedToday.like, 1, `账本应该只有 1 笔，实际 ${s.usedToday.like}`)
  })

  await t('⭐ 并发发动态：同样只成功一条', async () => {
    const home = stubHome('stub6')
    writeCfg(home, { allowWrite: true, dynamicPerDay: 1 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const dyn = tools.get('bili_post_dynamic')
    const [a, b] = await Promise.all([
      dyn.execute({ text: '并发测试一' }),
      dyn.execute({ text: '并发测试二' }),
    ])
    assert.equal([a, b].filter((r) => r.ok === true).length, 1, JSON.stringify([a.ok, b.ok]))
    const s = await tools.get('bili_touch_status').execute({})
    assert.equal(s.usedToday.dynamic, 1)
  })

  await t('⭐ bvid 大小写原样透传给 python（B站 API 区分大小写，转大写会 -400/-404）', async () => {
    const home = stubHome('stub8')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'like', bvid: 'BV1d8pU6xEZX' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.detail.argv[1], 'BV1d8pU6xEZX', `传给 python 的 bvid 被改了：${r.detail.argv[1]}`)
    // 小写前缀 bv 仍会被规整成 BV，但后 10 位一个字符都不许动
    const r2 = await tools.get('bili_touch').execute({ action: 'like', bvid: 'bv1d8pU6xEZX' })
    assert.equal(r2.detail.argv[1], 'BV1d8pU6xEZX', `小写前缀归一后尾段被改了：${r2.detail.argv[1]}`)
  })

  await t('⭐ 发私信：只发给配置里的 dmUid，走 python dm 动作并单独记账（不占总互动额度）', async () => {
    const home = stubHome('stub-dm1')
    writeCfg(home, { allowWrite: true, dmUid: 472463484 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_send_dm').execute({ text: '简报：今天看了 3 条' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.to, 472463484)
    assert.equal(r.usedToday, 1)
    const s = await tools.get('bili_touch_status').execute({})
    assert.equal(s.usedToday.dm, 1)
    assert.equal(s.totalUsed, 0, '私信不该占用公开互动的总次数')
    assert.equal(s.dmLimitToday > 0, true)
  })

  await t('发私信：额度 0 → 直接拒绝（不 spawn python）', async () => {
    const home = stubHome('stub-dm2')
    writeCfg(home, { allowWrite: true, dmPerDay: 0 })
    process.env.DSH_HOME = home
    const tools = new Map()
    const r0 = await (async () => {
      stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
      return tools.get('bili_send_dm').execute({ text: 'x' })
    })()
    assert.equal(r0.ok, false)
    assert.match(String(r0.error), /额度|上限/)
  })

  await t('发私信：dmUid=0 → 拒绝并提示改配置', async () => {
    const home = stubHome('stub-dm3')
    writeCfg(home, { allowWrite: true, dmUid: 0 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_send_dm').execute({ text: 'x' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /dmUid|收件人/)
  })

  await t('发私信：text 非字符串直接拒绝', async () => {
    const home = stubHome('stub-dm4')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_send_dm').execute({ text: { evil: 1 } })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /字符串/)
  })

  await t('⭐ 只读工具（trending / inbox）：allowWrite=false 也照跑，不占额度', async () => {
    const home = stubHome('stub-ro1')
    writeCfg(home, { allowWrite: false })
    const m = roMount(home)
    const r1 = await m.trending.execute({ kind: 'rank', zone: 'technology' })
    assert.equal(r1.ok, true)
    const r2 = await m.inbox.execute({})
    assert.equal(r2.ok, true)
    const s = await m.status.execute({})
    assert.equal(s.totalUsed, 0, '只读工具不该记账')
  })

  await t('只读工具：kind 非法 / zone 与 folder 以 -- 开头 → 直接拒绝', async () => {
    const home = stubHome('stub-ro2')
    const m = roMount(home)
    assert.equal((await m.trending.execute({ kind: 'xxx' })).ok, false)
    assert.equal((await m.trending.execute({ kind: 'rank', zone: '--x' })).ok, false)
    assert.equal((await m.favContent.execute({ folder: '--undo' })).ok, false)
  })

  await t('bili_fav_content：folder 作为第一个位置参数传给 python', async () => {
    const home = stubHome('stub-ro3')
    const m = roMount(home)
    const r = await m.favContent.execute({ folder: 'AI 工具', keyword: 'deepseek' })
    assert.equal(r.ok, true)
    assert.equal(r.action, 'fav_content', '假 python 的 action 回显 = argv[1]，说明位置参数没丢')
  })

  await t('⭐ 同一视频每日上限：默认 2 次，第 3 次被拒（防被内容诱导后反复动手）', async () => {
    const home = stubHome('stub9')
    writeCfg(home, { allowWrite: true, likePerDay: 5 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const a = await touch.execute({ action: 'like', bvid: BVID })
    const b = await touch.execute({ action: 'like', bvid: BVID })
    const c = await touch.execute({ action: 'like', bvid: BVID })
    assert.equal(a.ok, true, JSON.stringify(a))
    assert.equal(b.ok, true, JSON.stringify(b))
    assert.equal(c.ok, false, '同一视频第 3 次应该被拒')
    assert.match(String(c.error), /同一个视频/)
    // 换一个视频仍然可以（额度没被误伤）
    const d = await touch.execute({ action: 'like', bvid: 'BV1D8PU6XEZY' })
    assert.equal(d.ok, true, JSON.stringify(d))
  })

  await t('⭐ 同一视频上限按对象合计：like + fav 共用 2 次预算', async () => {
    const home = stubHome('stub9b')
    writeCfg(home, { allowWrite: true, likePerDay: 5, favPerDay: 5 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const a = await touch.execute({ action: 'like', bvid: BVID })
    const b = await touch.execute({ action: 'fav', bvid: BVID, folders: ['默认'] })
    const c = await touch.execute({ action: 'share', bvid: BVID })
    assert.equal(a.ok, true, JSON.stringify(a))
    assert.equal(b.ok, true, JSON.stringify(b))
    assert.equal(c.ok, false, '同一视频的 like+fav 已用掉 2 次，第三次换动作也该被拒')
    assert.match(String(c.error), /同一个视频/)
  })

  await t('⭐ 总开关关着时，撤销类仍然放行（不然自己点的赞撤不回来）', async () => {
    const home = stubHome('stub9c')
    writeCfg(home, { allowWrite: false })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const like = await touch.execute({ action: 'like', bvid: BVID })
    assert.equal(like.ok, false, '总开关关着，点赞应被拒')
    assert.match(String(like.error), /默认是关的/)
    const undo = await touch.execute({ action: 'unlike', bvid: BVID })
    assert.equal(undo.ok, true, `撤销类不该被总开关挡住：${JSON.stringify(undo)}`)
  })

  await t('收藏夹名字以 -- 开头 → 直接拒绝（防撞内部参数）', async () => {
    const home = stubHome('stub9d')
    writeCfg(home, { allowWrite: true })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'fav', bvid: BVID, folders: ['--undo'] })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /不能以 -- 开头/)
  })

  await t('⭐ 全局每日总上限：totalPerDay=2 时第三个写动作被拒', async () => {
    const home = stubHome('stub10')
    writeCfg(home, { allowWrite: true, totalPerDay: 2 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const a = await touch.execute({ action: 'like', bvid: BVID })
    const b = await touch.execute({ action: 'fav', bvid: 'BV1D8PU6XEZY' })
    const c = await touch.execute({ action: 'share', bvid: 'BV1D8PU6XEZZ' })
    assert.equal(a.ok, true, JSON.stringify(a))
    assert.equal(b.ok, true, JSON.stringify(b))
    assert.equal(c.ok, false, '总量到顶后应该被拒')
    assert.match(String(c.error), /总次数到顶/)
    // 撤销类动作不受总量限制（不然用户想撤回都不行）
    const u = await touch.execute({ action: 'unlike', bvid: BVID })
    assert.ok(u.error === undefined || !/总次数到顶/.test(String(u.error)), JSON.stringify(u))
  })

  await t('status 带 todayActions 审计列表（用户能看见今天动了哪几条）', async () => {
    const home = stubHome('stub11')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    await tools.get('bili_touch').execute({ action: 'like', bvid: BVID })
    const s = await tools.get('bili_touch_status').execute({})
    assert.equal(s.totalUsed, 1)
    assert.equal(Array.isArray(s.todayActions), true)
    assert.equal(s.todayActions.length, 1)
    assert.equal(s.todayActions[0].action, 'like')
    assert.equal(s.todayActions[0].target, BVID)
    assert.match(String(s.injectionNote), /素材/)
  })

  await t('改 config.json 立刻生效（不重启、不重载）', async () => {
    const home = stubHome('stub7')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const first = await tools.get('bili_touch').execute({ action: 'like', bvid: BVID })
    assert.equal(first.ok, true)
    writeCfg(home, { allowWrite: false })
    const second = await tools.get('bili_touch').execute({ action: 'like', bvid: BVID })
    assert.equal(second.ok, false)
    assert.match(String(second.error), /默认是关的/)
  })

  await t('⭐ bili_following_updates：只读，allowWrite=false 也照跑；limit/maxUps 传参正确', async () => {
    const home = stubHome('stub-follow')
    writeCfg(home, { allowWrite: false }) // 只读工具不该被写开关挡住
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const up = tools.get('bili_following_updates')
    assert.ok(up, '缺 bili_following_updates')
    const r = await up.execute({ limit: 3, maxUps: 5 })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.detail.argv.slice(0, 1), ['following_updates'])
    assert.ok(r.detail.argv.includes('--limit') && r.detail.argv.includes('3'), JSON.stringify(r.detail.argv))
    assert.ok(r.detail.argv.includes('--max-ups') && r.detail.argv.includes('5'), JSON.stringify(r.detail.argv))
  })

  await t('⭐ bili_following_updates：把 python 给的游标交给宿主写盘（python 没写权限）', async () => {
    const home = stubHome('stub-follow2')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_following_updates').execute({})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.stateSaved, true, '游标该由宿主写成功')
    const f = join(home, 'bili-interact', 'following.json')
    assert.ok(existsSync(f), `游标文件没写出来：${f}`)
    const saved = JSON.parse(readFileSync(f, 'utf8'))
    assert.equal(saved.lastCheckedAt, 123)
    assert.equal(saved.lastSeen['354813103'], 'BV1d8pU6xEZX')
  })

  await t('⭐ 取关：可以只给 uid（不必给 bvid），argv 带 --uid', async () => {
    const home = stubHome('stub-unfollow')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'unfollow', uid: 354813103 })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.detail.argv, ['unfollow', '--uid', '354813103'])
    assert.equal(r.uid, 354813103)
    assert.equal(r.bvid, undefined)
  })

  await t('关注/取关：既没 bvid 也没 uid → 明确报错', async () => {
    const home = stubHome('stub-nouid')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'unfollow' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /bvid 格式不对/)
  })

  await t('uid 脏值被拒：0 / 小数 / 字符串 / 负数', async () => {
    const home = stubHome('stub-baduid')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    for (const bad of [0, 1.5, '123', -5]) {
      const r = await touch.execute({ action: 'follow', uid: bad })
      assert.equal(r.ok, false, `应拒绝 uid=${bad}`)
      assert.match(String(r.error), /uid 必须是正整数/, `uid=${bad} → ${r.error}`)
    }
  })
  await t('分动作开关：allowLike=false → 点赞被拒；unlike 仍可用（撤销不受开关限制）', async () => {
    const home = stubHome('stub-flag-like')
    writeCfg(home, { allowLike: false })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const a = await touch.execute({ action: 'like', bvid: BVID })
    assert.equal(a.ok, false, JSON.stringify(a))
    assert.match(String(a.error), /allowLike/)
    const b = await touch.execute({ action: 'unlike', bvid: BVID })
    assert.equal(b.ok, true, JSON.stringify(b))
  })

  await t('公开发布默认关：allowShare 不打开 → 转发被拒；打开后通过', async () => {
    const home = stubHome('stub-flag-share')
    writeCfg(home, { allowShare: false })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const a = await touch.execute({ action: 'share', bvid: BVID })
    assert.equal(a.ok, false, JSON.stringify(a))
    assert.match(String(a.error), /allowShare/)
    writeCfg(home, { allowShare: true, sharePerDay: 3 })
    const b = await touch.execute({ action: 'share', bvid: BVID })
    assert.equal(b.ok, true, JSON.stringify(b))
  })

  await t('发动态默认关：allowDynamic=false → 被拒；打开后通过', async () => {
    const home = stubHome('stub-flag-dyn')
    writeCfg(home, { allowDynamic: false })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const dyn = tools.get('bili_post_dynamic')
    const a = await dyn.execute({ text: '一句话' })
    assert.equal(a.ok, false, JSON.stringify(a))
    assert.match(String(a.error), /allowDynamic/)
    writeCfg(home, { allowDynamic: true })
    const b = await dyn.execute({ text: '一句话' })
    assert.equal(b.ok, true, JSON.stringify(b))
  })

  await t('⭐ 每轮配额：likePerRound=1 时，同一轮第二次点赞被拒', async () => {
    const home = stubHome('stub-round')
    writeCfg(home, { likePerRound: 1, likePerDay: 10 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    const a = await touch.execute({ action: 'like', bvid: BVID })
    assert.equal(a.ok, true, JSON.stringify(a))
    const b = await touch.execute({ action: 'like', bvid: 'BV1D8PU6XEZY' })
    assert.equal(b.ok, false, JSON.stringify(b))
    assert.match(String(b.error), /这一轮/)
  })

  await t('轮次空窗 roundGapMinutes 脏值夹到 [10, 120]', async () => {
    const home = stubHome('stub-gap')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    writeCfg(home, { roundGapMinutes: 1 })
    assert.equal((await tools.get('bili_touch_status').execute({})).roundGapMinutes, 10)
    writeCfg(home, { roundGapMinutes: 999 })
    assert.equal((await tools.get('bili_touch_status').execute({})).roundGapMinutes, 120)
  })

  await t('收藏夹：folders 透传（--folder 多次 + --max-create）', async () => {
    const home = stubHome('stub-folders')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'fav', bvid: BVID, folders: ['AI 工具', '动画'] })
    assert.equal(r.ok, true, JSON.stringify(r))
    const argv = r.detail.argv
    assert.equal(argv.filter((x) => x === '--folder').length, 2)
    assert.ok(argv.includes('AI 工具') && argv.includes('动画'))
    assert.ok(argv.includes('--max-create'))
    assert.ok(!argv.includes('--no-create'))
  })

  await t('收藏夹：favFolderPerDay=0（或开关关）→ 传 --no-create', async () => {
    const home = stubHome('stub-folders2')
    writeCfg(home, { favFolderPerDay: 0 })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const r = await tools.get('bili_touch').execute({ action: 'fav', bvid: BVID, folders: ['新分类'] })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(r.detail.argv.includes('--no-create'))
    writeCfg(home, { allowFavFolderCreate: false })
    const r2 = await tools.get('bili_touch').execute({ action: 'fav', bvid: BVID, folders: ['另一个'] })
    assert.ok(r2.detail.argv.includes('--no-create'))
  })

  await t('收藏夹参数校验：>3 个 / 用于 like / 非字符串数组 → 拒绝', async () => {
    const home = stubHome('stub-folders3')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const touch = tools.get('bili_touch')
    assert.match(String((await touch.execute({ action: 'fav', bvid: BVID, folders: ['a', 'b', 'c', 'd'] })).error), /最多投 3 个/)
    assert.match(String((await touch.execute({ action: 'like', bvid: BVID, folders: ['a'] })).error), /只能用于 fav/)
    assert.match(String((await touch.execute({ action: 'fav', bvid: BVID, folders: [1, 2] })).error), /字符串数组/)
  })

  await t('⭐ bili_fav_folders：只读工具，allowWrite=false 也照跑', async () => {
    const home = stubHome('stub-favfolders')
    writeCfg(home, { allowWrite: false })
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const tool = tools.get('bili_fav_folders')
    assert.ok(tool, '缺 bili_fav_folders')
    const r = await tool.execute({})
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual(r.detail.argv, ['fav_folders'])
    assert.ok(Array.isArray(r.folders))
  })

  await t('status 带开关/每轮用量/收藏夹额度字段', async () => {
    const home = stubHome('stub-status2')
    process.env.DSH_HOME = home
    const tools = new Map()
    stubPlugin.apply({ tools: { register: (x) => tools.set(x.name, x) }, logger: { info: () => {} } }, {})
    const s = await tools.get('bili_touch_status').execute({})
    assert.equal(typeof s.switches.allowLike, 'boolean')
    assert.equal(typeof s.switches.allowShare, 'boolean')
    assert.equal(typeof s.usedThisRound.like, 'number')
    assert.equal(s.limitsRound.like, 3)
    assert.equal(s.hardRound.like, 5)
    assert.equal(s.hardFolderPerDay, 3)
    assert.equal(typeof s.folderUsedToday, 'number')
  })

  await t('真实 python 参数层：不认识的 action 也吐一行 JSON（不是崩栈）', async () => {
    const { spawnSync } = await import('node:child_process')
    const script = join(ROOT, 'python', 'bili_write.py')
    const cands = [
      join(homedir(), '.dsh', 'bili-duty', '.venv', 'Scripts', 'python.exe'),
      join(homedir(), '.dsh', 'bili-duty', '.venv', 'bin', 'python3'),
    ]
    const python = cands.find((x) => existsSync(x))
    if (!python) {
      results.push(['SKIP', '真实 python 参数层（本机没找到先辈 venv，跳过）'])
      return
    }
    const r = spawnSync(python, [script, 'bogus_action'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const lines = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    const last = lines[lines.length - 1] || ''
    const parsed = JSON.parse(last)
    assert.equal(parsed.ok, false)
    assert.match(String(parsed.error), /不认识的 action/)
    assert.equal(r.status, 1)
  })

}

/* ═══════════════ 汇总 ═══════════════ */
const pass = results.filter(([s]) => s === 'PASS').length
const fail = results.filter(([s]) => s === 'FAIL').length
const skip = results.filter(([s]) => s === 'SKIP').length
for (const [s, label, msg] of results) {
  if (s === 'PASS') console.log(`  ✅ ${label}`)
  else if (s === 'SKIP') console.log(`  ⏭️  ${label}`)
  else console.log(`  ❌ ${label}\n     ${msg}`)
}
console.log(`\n${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`)
process.exit(fail ? 1 : 0)
