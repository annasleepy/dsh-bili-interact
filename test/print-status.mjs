/** 只打印 bili_touch_status 的完整返回（排查用）：node test/print-status.mjs */
import { apply } from '../index.js'

const tools = new Map()
apply(
  { tools: { register: (t) => tools.set(t.name, t) }, logger: { info: () => {} } },
  { allowWrite: true },
)
const s = await tools.get('bili_touch_status').execute({})
console.log(JSON.stringify(s, null, 2))
