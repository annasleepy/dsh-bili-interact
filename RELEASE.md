# 发布清单：dsh-bili-interact v0.0.5

> 更新时间：2026-10-18 22:4x　状态：插件代码已稳定（smoke 14/14、edge 50/50、live 6/6），等三样东西：GitHub 仓库、npm 发布、视频。

## 0. 已经准备好的

| 文件 | 说明 |
| --- | --- |
| `index.js` / `lib/` / `python/` | 主插件：5 个工具（`bili_touch`、`bili_following_updates`、`bili_fav_folders`、`bili_post_dynamic`、`bili_touch_status`）|
| `cordis.patch.yml` | bundle patch（纯 `- insert:`，不覆盖别家）|
| `README.md`（12.6 KB）| 功能表、配置、安全设计、已知限制、测试命令 |
| `LICENSE` | MIT |
| `ISSUE-to-upstream.md` | 给先辈仓库 `github.com/c1overzz/dsh-bili-scroll` 的 issue 草稿 |
| `issue-url.txt` | 预填 URL（8,752 字符，可能超服务器限制，正文仍以 md 为准）|
| `VIDEO-SCRIPT.md` | 2 分 40 秒录屏脚本 + 标题/简介草稿 |
| `test/smoke.mjs` `test/edge.mjs` `test/live.mjs` | 14 + 50 + 6 用例 |

npm 包名 `dsh-bili-interact` 已查：**registry 404，名字可用**。

## 1. GitHub 仓库（需要你的账号）

```bash
cd C:/Users/LENOVO/Documents/deepseek-harness/default-workspace/projects/dsh-bili-interact
git init
git add -A
git commit -m "dsh-bili-interact v0.0.5: 给 dsh-bili-scroll 补上点赞/收藏/关注/转发/发动态"
# 在 GitHub 网页新建空仓库 dsh-bili-interact（不要勾 README）
git remote add origin <你的仓库地址>
git push -u origin main
```

- 仓库 Topics 建议：`dsh-plugin` `bilibili` `dsh-bili-scroll`
- About 写：`Dsh 插件：给 dsh-bili-scroll 补上写操作（默认关 + 代码级硬上限）`
- README 顶部加一行：「先装 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，本插件是它的伴随插件」——把先辈的下载和 star 挂在前面。

## 2. npm 发布（账号你自己注册）

```bash
npm login                       # 用你注册的 npmjs 账号
cd C:/Users/LENOVO/Documents/deepseek-harness/default-workspace/projects/dsh-bili-interact
npx --yes npm-publish-check .   # 可选：先干跑
npm publish --access public
npm view dsh-bili-interact version   # 应返回 0.0.5
```

发布前确认三件事：
1. `package.json` 的 `files` 已包含 `index.js/cordis.patch.yml/lib/python/README.md/LICENSE`（不含 test，减小体积；要带测试就加 `test`）。
2. `peerDependencies` 里 `dsh-bili-scroll >=0.1.0 <0.3.0` 会随 `npm i` 自动装（npm ≥7 默认装 peer），这是「硬依赖先辈」的落点。
3. `engines.node >=22`（DSH 运行时是 v24）。

## 3. README 截图（3 张，需要真实界面）

| # | 画面 | 用途 |
| --- | --- | --- |
| 1 | 设置 → 插件 → `dsh-bili-interact` 卡片（显示版本、来源 file:）| 证明可装 |
| 2 | 大肥鱼点完赞 + 收藏到「AI 工具」后的 `bili_touch` 返回（状态行 + usedToday 剩余额度）| 证明能动手 |
| 3 | 值班报告 `~/.dsh/bili-duty/out/<日期>.md` 里「已点赞 / 已收藏」那几行 | 证明值班也接上了 |

## 4. 视频

照 `VIDEO-SCRIPT.md` 录；录完先发 B站，再把 BV 号写进 README 和 npm 首页。

## 5. 上游 issue（先辈仓库）

`ISSUE-to-upstream.md` 正文复制进 `https://github.com/c1overzz/dsh-bili-scroll/issues/new`。
本机没有 GitHub 凭据（无 `gh` / `GITHUB_TOKEN` / `gh` 配置 / `git-credentials`），只能你点 Create。

## 6. 发布后回填

- [ ] README 加 `npm i dsh-bili-interact` / GitHub 链接 / 视频链接
- [ ] 在本插件 README 顶部把先辈仓库链接放第一行
- [ ] `memory/dsh-bili-interact.md` 记「已发布 v0.0.5、npm 包名、仓库地址」
- [ ] RECAP 记一条「已发布」
