/**
 * lib/where.mjs —— 找 dsh-bili-scroll 的家底（家目录 / python / 凭证 / 我们的脚本）
 * ============================================================================
 * ⭐ 本插件**不复制**先辈插件的东西，只按它的公开约定去用：
 *   `~/.dsh/bili-duty/`  它的家目录（可用 DSH_HOME 覆盖）
 *   `config.json`        里 `pythonPath` 指向它建好的 venv python
 *   `.venv/Scripts/python.exe`  Windows 默认位置（没配 pythonPath 时兜底）
 *   `bili_credential.json`     扫码登录后的凭证（我们只读）
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件的根目录（python/bili_write.py 就在它下面） */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** dsh-bili-scroll 的家目录 */
export function baseDir() {
  return join(dshHome(), 'bili-duty')
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 找 python：优先用先辈插件 config.json 里那个（它自己建好、依赖齐），
 * 再退到它默认 venv 位置，最后才是 PATH 上的 python。
 */
export function resolvePython() {
  const base = baseDir()
  const cfg = readJsonSafe(join(base, 'config.json')) || {}
  const candidates = []
  if (typeof cfg.pythonPath === 'string' && cfg.pythonPath.trim()) candidates.push(cfg.pythonPath.trim())
  candidates.push(join(base, '.venv', 'Scripts', 'python.exe'))
  candidates.push(join(base, '.venv', 'bin', 'python3'))
  for (const c of candidates) {
    if (c === 'python') continue
    if (existsSync(c)) return { python: c, source: 'venv', exists: true }
  }
  // PATH 上的 python 没有先辈装好的依赖，不能算"就绪"——只能当兜底候选
  return { python: 'python', source: 'fallback', exists: false }
}

/** 找凭证文件 */
export function resolveCredential() {
  const file = join(baseDir(), 'bili_credential.json')
  return { file, exists: existsSync(file) }
}

/** 我们自己的执行器脚本 */
export function writeScript() {
  return join(PLUGIN_DIR, 'python', 'bili_write.py')
}

/**
 * 整体体检：给工具和设置页用的一句话现状。
 * @returns {{ready:boolean, reason?:string, python:string, pythonSource:string, credential:string, script:string}}
 */
export function health() {
  const { python, source, exists } = resolvePython()
  const cred = resolveCredential()
  const script = writeScript()
  const out = {
    ready: false,
    python,
    pythonSource: source,
    pythonExists: exists,
    credential: cred.file,
    credentialExists: cred.exists,
    script,
    scriptExists: existsSync(script),
    baseDir: baseDir(),
  }
  if (!cred.exists) {
    out.reason = `没找到先辈插件的登录凭证：${cred.file} —— 先装 dsh-bili-scroll 并在它的设置页扫码登录`
    return out
  }
  if (exists === false) {
    out.reason = `没找到先辈插件的 Python 环境：${python} —— 先在 dsh-bili-scroll 设置页点一次「装依赖」`
    return out
  }
  if (!out.scriptExists) {
    out.reason = `插件文件不完整：${script} 不存在（重装一次本插件）`
    return out
  }
  out.ready = true
  return out
}
