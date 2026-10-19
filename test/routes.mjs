// 直接验证 /api/bili-interact 路由与 handler（不依赖宿主/配对）
import { apply } from '../index.js'

const routes = []
const tools = []
const effects = []
const ctx = {
  tools: { register: (t) => { tools.push(t); return t } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  effect: (fn) => { const d = fn(); effects.push(d); return d },
  logger: { info: () => {} },
  get(name) { return this[name] },
}

apply(ctx, {})

const route = routes.find((r) => r.path === '/api/bili-interact')
if (!route) { console.error('FAIL: route 未注册'); process.exit(1) }

const call = (method, path, body) => new Promise((resolve) => {
  const chunks = []
  const req = { method, url: path, on: (ev, cb) => {
    if (ev === 'data') { if (body !== undefined) cb(Buffer.from(JSON.stringify(body))); }
    if (ev === 'end') cb()
    if (ev === 'error') { /* noop */ }
  } }
  const res = {
    statusCode: 0, headers: {}, body: '',
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}) },
    end(data) { this.body = String(data || ''); resolve(this) },
  }
  route.handler(req, res)
})

const s = await call('GET', '/api/bili-interact/status')
const sj = JSON.parse(s.body)
console.log('status:', s.statusCode, 'ok=', sj.ok, 'ready=', sj.ready, 'allowWrite=', sj.switches?.allowWrite, 'caps.like=', sj.caps?.like, 'actions=', sj.todayActions?.length)

const c = await call('GET', '/api/bili-interact/config')
const cj = JSON.parse(c.body)
console.log('config:', c.statusCode, 'keys=', Object.keys(cj.config || {}).length, 'allowWrite=', cj.config?.allowWrite)

const p = await call('POST', '/api/bili-interact/config', { roundGapMinutes: 30 })
const pj = JSON.parse(p.body)
console.log('post config:', p.statusCode, 'ok=', pj.ok, 'roundGap=', pj.config?.roundGapMinutes)

const bad = await call('GET', '/api/bili-interact/nope')
console.log('unknown:', bad.statusCode, bad.body.slice(0, 60))
process.exit(0)
