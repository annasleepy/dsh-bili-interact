/**
 * dsh-bili-interact —— 浏览器半端（设置里的一页：bili 互动）
 * ============================================================================
 * ⚠️ client bundle 不是 ESM，是自注册脚本（和先辈插件 dsh-bili-scroll 同一套约定）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 *   · id 必须等于 package.json 的 name
 *   · 进「设置」= slots.inject('settings.section') + slots.register({ name:'settings.section', id, order, label })
 *   · 数据走本插件自己的宿主路由 /api/bili-interact/{status,config}（见 index.js）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-interact',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-interact'
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = (p) => fetch(API + p, { credentials: 'same-origin' }).then(asJson)
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(asJson)

    const CSS = `
[data-bi-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 10px;max-width:660px;}
[data-bi-sec]{display:flex;flex-direction:column;gap:8px;}
[data-bi-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bi-row]{display:flex;align-items:center;gap:10px;}
[data-bi-grow]{flex:1;min-width:0;}
[data-bi-label]{font-size:13px;}
[data-bi-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bi-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-bi-sw][data-on]{background:#3b82f6;}
[data-bi-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bi-sw][data-on] i{left:19px;}
[data-bi-sw][disabled]{opacity:.45;cursor:default;}
[data-bi-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-bi-num]{width:74px;text-align:center;padding:5px 7px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-bi-num]:focus{outline:none;border-color:#3b82f6;}
[data-bi-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bi-msg][data-warn]{color:#f59e0b;}
[data-bi-msg][data-good]{color:#22c55e;}
[data-bi-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;}
[data-bi-badge]{font-size:11px;padding:2px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bi-table]{width:100%;border-collapse:collapse;font-size:12px;}
[data-bi-table] td{padding:4px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));}
[data-bi-table] td:last-child{text-align:right;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bi-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-bi-row': '' },
        h('div', { 'data-bi-grow': '' },
          h('div', { 'data-bi-label': '' }, label),
          note ? h('div', { 'data-bi-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    /** 数字项：本地草稿 + 失焦/回车提交（页面轮询不会打断输入） */
    function NumRow({ label, note, value, onSave, disabled }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      const [editing, setEditing] = React.useState(false)
      React.useEffect(() => { if (!editing) setDraft(String(value ?? '')) }, [value, editing])
      const commit = () => {
        setEditing(false)
        const n = Number(draft)
        if (Number.isFinite(n) && n !== Number(value)) onSave(n)
      }
      return h('div', { 'data-bi-row': '' },
        h('div', { 'data-bi-grow': '' },
          h('div', { 'data-bi-label': '' }, label),
          note ? h('div', { 'data-bi-note': '' }, note) : null),
        h('input', {
          'data-bi-num': '',
          type: 'number',
          value: draft,
          disabled: Boolean(disabled),
          onFocus: () => setEditing(true),
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur() } },
        }))
    }

    function Section({ title, children }) {
      return h('div', { 'data-bi-sec': '' }, h('div', { 'data-bi-h': '' }, title), ...children)
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [cfg, setCfg] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')

      const flash = (text, t) => { setMsg(text); setTone(t || '') }

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d && d.ok) setSt(d)
          } catch (e) { /* 宿主重载时会短暂 404，忽略 */ }
        }
        tick()
        const t = setInterval(tick, 8000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      React.useEffect(() => {
        let alive = true
        jget('/config').then((d) => { if (alive && d && d.ok) setCfg(d.config) }).catch(() => {})
        return () => { alive = false }
      }, [])

      const save = async (patch, label) => {
        try {
          const r = await jpost('/config', patch)
          if (r && r.ok) { setCfg(r.config); flash('已保存' + (label ? '：' + label : ''), 'good') } else flash('保存失败：' + (r && r.error || '未知错误'), 'warn')
        } catch (e) {
          flash('保存失败：' + e.message, 'warn')
        }
      }

      if (!cfg) {
        return h('div', { 'data-bi-page': '' },
          h('div', { 'data-bi-kv': '' }, st ? (st.ready ? '就绪' : '未就绪：' + (st.reason || '')) : '加载中…'),
          h('div', { 'data-bi-kv': '' }, '配置文件：' + (st ? st.cfgFile : '…')))
      }

      const on = Boolean(cfg.allowWrite)
      const sw = (k) => Boolean(cfg[k])
      const cap = st && st.caps ? st.caps : {}
      const round = st && st.round ? st.round : {}
      const used = st && st.usedToday ? st.usedToday : {}
      const hard = st && st.hardMax ? st.hardMax : {}
      const hardRound = st && st.hardRound ? st.hardRound : {}
      const totalUsed = st ? st.totalUsed : 0

      return h('div', { 'data-bi-page': '' },
        /* ── 总开关 ── */
        h(Section, { title: '写操作' }, [
          h(ToggleRow, {
            key: 'main',
            label: '允许写操作（总开关）',
            note: '关着时：点赞/收藏/关注/转发/发动态全部拒绝；撤销类（取消赞/取消收藏/取关）仍然可用。',
            on,
            onChange: (v) => save({ allowWrite: v }, v ? '打开写操作' : '关闭写操作'),
          }),
          on ? h('div', { 'data-bi-sub': '', key: 'sub' },
            h(ToggleRow, { label: '点赞', on: sw('allowLike'), onChange: (v) => save({ allowLike: v }) }),
            h(ToggleRow, { label: '收藏', on: sw('allowFav'), onChange: (v) => save({ allowFav: v }) }),
            h(ToggleRow, { label: '关注', on: sw('allowFollow'), onChange: (v) => save({ allowFollow: v }) }),
            h(ToggleRow, {
              label: '转发（不可撤回）', note: '转发会发布到你的动态，删不掉。默认关。',
              on: sw('allowShare'), onChange: (v) => save({ allowShare: v }),
            }),
            h(ToggleRow, {
              label: '发动态（不可撤回）', note: '发布到你的主页，删不掉。默认关。',
              on: sw('allowDynamic'), onChange: (v) => save({ allowDynamic: v }),
            }),
          ) : null,
        ]),
        /* ── 行为 ── */
        h(Section, { title: '行为' }, [
          h(ToggleRow, {
            key: 'pref', label: '优先看关注 UP 的更新',
            note: '只影响大肥鱼刷视频时的顺序，不影响只读工具。',
            on: sw('preferFollowing'), onChange: (v) => save({ preferFollowing: v }),
          }),
          h(ToggleRow, {
            key: 'create', label: '收藏时允许自动新建收藏夹',
            note: '没有合适分类时自动建（每天有上限）；关掉后只能用已有收藏夹。',
            on: sw('allowFavFolderCreate'), onChange: (v) => save({ allowFavFolderCreate: v }),
          }),
        ]),
        /* ── 每日上限 ── */
        h(Section, { title: '每日上限（只能调低，硬上限写死在代码里）' }, [
          h(NumRow, { key: 'l', label: '点赞', note: '硬上限 ' + (hard.like ?? 20), value: cfg.likePerDay, onSave: (n) => save({ likePerDay: n }) }),
          h(NumRow, { key: 'f', label: '收藏', note: '硬上限 ' + (hard.fav ?? 20), value: cfg.favPerDay, onSave: (n) => save({ favPerDay: n }) }),
          h(NumRow, { key: 'f2', label: '新建收藏夹', note: '硬上限 ' + (st?.hardFolderPerDay ?? 3), value: cfg.favFolderPerDay, onSave: (n) => save({ favFolderPerDay: n }) }),
          h(NumRow, { key: 's', label: '转发', note: '硬上限 ' + (hard.share ?? 3), value: cfg.sharePerDay, onSave: (n) => save({ sharePerDay: n }) }),
          h(NumRow, { key: 'fo', label: '关注', note: '硬上限 ' + (hard.follow ?? 10), value: cfg.followPerDay, onSave: (n) => save({ followPerDay: n }) }),
          h(NumRow, { key: 'd', label: '发动态', note: '硬上限 ' + (hard.dynamic ?? 2), value: cfg.dynamicPerDay, onSave: (n) => save({ dynamicPerDay: n }) }),
          h(NumRow, { key: 'dm', label: '私信简报', note: '硬上限 ' + (st?.hardDmPerDay ?? 10), value: cfg.dmPerDay, onSave: (n) => save({ dmPerDay: n }) }),
          h(NumRow, { key: 't', label: '每日总次数（所有动作合计）', note: '硬上限 ' + (st?.hardTotal ?? 30), value: cfg.totalPerDay, onSave: (n) => save({ totalPerDay: n }) }),
          h(NumRow, { key: 'pt', label: '同一个视频/UP 每天最多', note: '硬上限 ' + (st?.hardPerTarget ?? 5), value: cfg.perTargetPerDay, onSave: (n) => save({ perTargetPerDay: n }) }),
        ]),
        /* ── 每轮上限 ── */
        h(Section, { title: '每轮上限（防沉迷）' }, [
          h('div', { 'data-bi-note': '' }, '一轮 = 两次写操作间隔不超过下面的分钟数；间隔超过就算新的一轮。'),
          h(NumRow, { key: 'rl', label: '点赞', value: cfg.likePerRound, note: '硬上限 ' + (hardRound.like ?? 5), onSave: (n) => save({ likePerRound: n }) }),
          h(NumRow, { key: 'rf', label: '收藏', value: cfg.favPerRound, note: '硬上限 ' + (hardRound.fav ?? 5), onSave: (n) => save({ favPerRound: n }) }),
          h(NumRow, { key: 'rs', label: '转发', value: cfg.sharePerRound, note: '硬上限 ' + (hardRound.share ?? 1), onSave: (n) => save({ sharePerRound: n }) }),
          h(NumRow, { key: 'rfo', label: '关注', value: cfg.followPerRound, note: '硬上限 ' + (hardRound.follow ?? 2), onSave: (n) => save({ followPerRound: n }) }),
          h(NumRow, { key: 'gap', label: '轮与轮的间隔（分钟）', note: '10–120', value: cfg.roundGapMinutes, onSave: (n) => save({ roundGapMinutes: n }) }),
        ]),
        /* ── 今日用量 ── */
        h(Section, { title: '今天的用量' }, [
          h('table', { 'data-bi-table': '' },
            h('tbody', {},
              h('tr', {}, h('td', {}, '点赞'), h('td', {}, (used.like ?? 0) + ' / ' + (cap.like ?? 0))),
              h('tr', {}, h('td', {}, '收藏'), h('td', {}, (used.fav ?? 0) + ' / ' + (cap.fav ?? 0))),
              h('tr', {}, h('td', {}, '转发'), h('td', {}, (used.share ?? 0) + ' / ' + (cap.share ?? 0))),
              h('tr', {}, h('td', {}, '关注'), h('td', {}, (used.follow ?? 0) + ' / ' + (cap.follow ?? 0))),
              h('tr', {}, h('td', {}, '发动态'), h('td', {}, (used.dynamic ?? 0) + ' / ' + (cap.dynamic ?? 0))),
              h('tr', {}, h('td', {}, '私信简报'), h('td', {}, (used.dm ?? 0) + ' / ' + (cap.dm ?? 0))),
              h('tr', {}, h('td', {}, '合计'), h('td', {}, totalUsed + ' / ' + (cap.total ?? 0))),
            )),
          st && st.todayActions && st.todayActions.length
            ? h('div', { 'data-bi-kv': '' }, '最近：' + st.todayActions.slice(-5).reverse().map((a) => a.action + ' ' + (a.target || '')).join('　'))
            : h('div', { 'data-bi-kv': '' }, '今天还没动过手。'),
        ]),
        /* ── 运行状态 ── */
        h(Section, { title: '运行状态' }, [
          h('div', { 'data-bi-kv': '' }, st ? ((st.ready ? '✓ 依赖就绪' : '✗ 未就绪：' + (st.reason || '')) + '　·　写操作 ' + (st.switches && st.switches.allowWrite ? '已开' : '已关')) : '加载中…'),
          h('div', { 'data-bi-kv': '' }, 'python：' + (st && st.base ? st.base.python : '…')),
          h('div', { 'data-bi-kv': '' }, '私信收件人 UID：' + (st && st.dmUid != null ? st.dmUid : '…')),
          h('div', { 'data-bi-kv': '' }, '配置文件：' + (st && st.cfgFile ? st.cfgFile : '…')),
        ]),
        msg ? h('div', { 'data-bi-msg': '', 'data-good': tone === 'good' ? '' : undefined, 'data-warn': tone === 'warn' ? '' : undefined }, msg) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-interact')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-interact: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-interact', order: 31, label: 'bili 互动' },
          () => h(Panel),
        ))
      },
    }
  },
})
