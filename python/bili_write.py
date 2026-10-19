#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bili_write.py —— dsh-bili-interact 的单次写操作执行器

一次调用只做一件事，结果以**一行 JSON** 打到 stdout（失败也一样，`ok:false`）。
JS 侧负责所有闸门（开关 / 每日上限 / 账本），这里只管"把一次动作发出去"。

凭证**只读** dsh-bili-scroll 家目录里那份（`~/.dsh/bili-duty/bili_credential.json`），
不复制、不落盘、不回显到任何输出里。

用法：
    python bili_write.py nav
    python bili_write.py like BV1d8pU6xEZX
    python bili_write.py unlike BV1d8pU6xEZX
"""
import asyncio
import json
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

try:  # Windows 控制台默认 cp936，会把中文打成乱码；JS 侧按 UTF-8 解析
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

DSH_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
BASE_DIR = DSH_HOME / "bili-duty"
CRED_FILE = Path(os.environ.get("BILI_CREDENTIAL") or (BASE_DIR / "bili_credential.json"))
# 关注动态的"上次检查"游标（只读工具自己维护，不进账本、不占额度）
FOLLOW_STATE = DSH_HOME / "bili-interact" / "following.json"

ACTION_LABEL = {
    "nav": "查看登录的是谁",
    "like": "点赞",
    "unlike": "取消点赞",
    "fav": "收藏",
    "unfav": "取消收藏",
    "share": "转发",
    "follow": "关注",
    "unfollow": "取关",
    "dynamic": "发动态",
    "dm": "发私信",
    "following_updates": "查看关注更新",
    "fav_folders": "查看收藏夹",
    "trending": "看趋势（热门/热搜/每周必看/排行榜）",
    "inbox": "看有没有人理我（未读/回复/@与点赞）",
    "fav_content": "看收藏夹里有什么",
}


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_credential():
    """从 dsh-bili-scroll 的凭证文件建一个 bilibili_api 的 Credential（只读）。"""
    if not CRED_FILE.exists():
        raise RuntimeError(
            f"找不到凭证文件：{CRED_FILE} —— 先安装 dsh-bili-scroll 并在它的设置页扫码登录"
        )
    data = json.loads(CRED_FILE.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise RuntimeError("凭证文件格式不对（应当是 JSON 对象）")
    if not data.get("sessdata"):
        raise RuntimeError("凭证里没有 sessdata —— 先辈插件那边没登录成功，重新扫码登录一次")
    from bilibili_api import Credential

    return Credential(
        sessdata=data.get("sessdata") or None,
        bili_jct=data.get("bili_jct") or None,
        buvid3=data.get("buvid3") or None,
        dedeuserid=data.get("dedeuserid") or None,
        ac_time_value=data.get("ac_time_value") or None,
    )


async def do_nav(cred) -> dict:
    from bilibili_api import user

    info = await user.get_self_info(credential=cred)
    info = info or {}
    return {
        "who": {
            "mid": info.get("mid"),
            "name": info.get("uname") or info.get("name"),
        }
    }


async def do_like(cred, bvid: str, undo: bool = False) -> dict:
    from bilibili_api import video

    if not bvid or not bvid.upper().startswith("BV"):
        raise RuntimeError(f"bvid 看起来不对：{bvid!r}（要 BV 开头的视频号）")
    v = video.Video(bvid=bvid, credential=cred)
    res = await v.like(status=not undo) or {}
    api_code = res.get("code") if isinstance(res, dict) else None
    relation = None
    try:
        relation = await v.get_relation()
    except Exception:  # noqa: BLE001 —— 关系接口挂了不影响"动作发出去了"这个事实
        relation = None
    return {
        "action": "unlike" if undo else "like",
        "bvid": bvid,
        "api_code": api_code,
        "relation": relation if isinstance(relation, dict) else None,
    }


async def _self_mid(cred) -> int:
    from bilibili_api import user

    info = await user.get_self_info(credential=cred) or {}
    mid = info.get("mid")
    if not mid:
        raise RuntimeError("拿不到自己的 UID（登录状态可能失效，回先辈插件重新扫码）")
    return int(mid)


async def _folder_list(cred, video_obj=None):
    """当前账号的收藏夹列表（传 video 时会带该视频在每个夹里的 fav_state）。"""
    from bilibili_api import favorite_list

    mid = await _self_mid(cred)
    data = await favorite_list.get_video_favorite_list(uid=mid, video=video_obj, credential=cred) or {}
    return data.get("list") or []


async def _resolve_folders(cred, video_obj, tokens, allow_create=False, max_create=0):
    """把收藏夹名 / ID 解析成收藏夹；不存在的按开关新建（受 max_create 限制）。"""
    from bilibili_api import favorite_list

    folders = await _folder_list(cred, video_obj)
    by_title = {str(f.get("title") or "").strip(): f for f in folders}
    by_id = {int(f.get("id")): f for f in folders if f.get("id") is not None}
    picked, created = [], []
    for tok in tokens:
        tok = str(tok).strip()
        if not tok:
            continue
        f = by_title.get(tok)
        if f is None and tok.isdigit():
            f = by_id.get(int(tok))
        if f is None:
            if not allow_create or len(created) >= max_create:
                raise RuntimeError(
                    f"收藏夹「{tok}」不存在，这次又不允许新建（现有：{', '.join(by_title) or '无'}）"
                )
            res = await favorite_list.create_video_favorite_list(
                title=tok, introduction="", private=False, credential=cred
            ) or {}
            # 这个接口直接返回收藏夹对象（`{"id": ...}`），不是 `{"data": {...}}`
            data = res.get("data") if isinstance(res, dict) else None
            fid = (data.get("id") if isinstance(data, dict) else None) or (res.get("id") if isinstance(res, dict) else None)
            if not fid:
                raise RuntimeError(f"新建收藏夹「{tok}」失败：{res}")
            f = {"id": int(fid), "title": tok}
            created.append({"id": int(fid), "title": tok})
            by_title[tok] = f
            by_id[int(fid)] = f
        fid = int(f.get("id"))
        if fid not in [int(x.get("id")) for x in picked]:
            picked.append(f)
    return picked, created


async def do_fav(cred, bvid: str, undo: bool = False, folders=None, allow_create: bool = True, max_create: int = 2) -> dict:
    """收藏 / 取消收藏。

    一个视频可以同时进多个收藏夹（B站 原生支持，比如「动画」+「工具」两个标签）：
      - `folders` 给了就按名字/ID 投进这些夹（不存在的按开关新建）
      - 没给就投默认夹
      - undo 时：给了 folders 只从这些夹移出；没给就从**所有**含有它的夹里移出
    """
    from bilibili_api import video

    v = video.Video(bvid=bvid, credential=cred)
    tokens = [str(x) for x in (folders or []) if str(x).strip()]
    created = []
    if undo:
        if tokens:
            picked, _ = await _resolve_folders(cred, v, tokens, allow_create=False)
            # 只对「确实在这个夹里」的夹调删除：否则 B站 会返回成功但什么也没删，
            # 模型会以为收拾干净了（2026-10-18 真机踩到）。
            ids = [int(f.get("id")) for f in picked if f.get("fav_state") in (1, True)]
            if not ids:
                return {
                    "action": "unfav",
                    "bvid": bvid,
                    "favFolders": [],
                    "createdFolders": [],
                    "already": True,
                    "note": "这个视频本来就不在指定的收藏夹里，没有可取消的收藏",
                }
        else:
            allf = await _folder_list(cred, v)
            ids = [int(f.get("id")) for f in allf if f.get("fav_state") in (1, True)]
            if not ids:
                return {
                    "action": "unfav",
                    "bvid": bvid,
                    "favFolders": [],
                    "createdFolders": [],
                    "already": True,
                    "note": "这个视频不在任何收藏夹里，没有可取消的收藏",
                }
        res = await v.set_favorite(add_media_ids=[], del_media_ids=ids)
    else:
        if tokens:
            picked, created = await _resolve_folders(
                cred, v, tokens, allow_create=allow_create, max_create=max(0, max_create)
            )
            ids = [int(f.get("id")) for f in picked]
        else:
            allf = await _folder_list(cred, v)
            if not allf:
                raise RuntimeError("账号里一个收藏夹都没有 —— 先在 B站 建一个默认收藏夹")
            default = next((f for f in allf if "默认" in str(f.get("title") or "")), allf[0])
            ids = [int(default.get("id"))]
        res = await v.set_favorite(add_media_ids=ids, del_media_ids=[])
    return {
        "action": "unfav" if undo else "fav",
        "bvid": bvid,
        "favFolders": ids,
        "createdFolders": created,
        "api_code": res.get("code") if isinstance(res, dict) else None,
    }


async def do_fav_folders(cred) -> dict:
    """只读：列出账号里的视频收藏夹（名字 + ID + 条数）。"""
    folders = await _folder_list(cred)
    return {
        "folders": [
            {"id": f.get("id"), "title": f.get("title"), "mediaCount": f.get("media_count")}
            for f in folders
        ]
    }


async def _find_video_dynamic(cred, bvid: str, mid: int, max_pages: int = 4):
    """在 UP 主最近的动态里找这条视频对应的官方动态（转发要用它的 dynamic_id）。"""
    from bilibili_api import user

    u = user.User(uid=int(mid), credential=cred)
    offset = ""
    for _ in range(max_pages):
        ds = await u.get_dynamics_new(offset=offset) or {}
        for it in ds.get("items") or []:
            md = (it.get("modules") or {}).get("module_dynamic") or {}
            arch = (md.get("major") or {}).get("archive") or {}
            if str(arch.get("bvid") or "").upper() == bvid.upper():
                return it.get("id_str")
        offset = ds.get("offset")
        if not offset:
            break
    return None


async def do_share(cred, bvid: str, text: str = "转发动态") -> dict:
    """转发 = 发一条引用该视频的转发动态（**不是** share 计数接口）。**不可撤销**。"""
    from bilibili_api import dynamic, video

    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info() or {}
    mid = (info.get("owner") or {}).get("mid")
    if not mid:
        raise RuntimeError("拿不到视频作者 UID")
    dyn_id = await _find_video_dynamic(cred, bvid, mid)
    if not dyn_id:
        raise RuntimeError("找不到这条视频对应的动态（视频太旧或作者已删），无法用转发动态的方式分享")
    res = await dynamic.Dynamic(dynamic_id=int(dyn_id), credential=cred).repost(text) or {}
    return {
        "action": "share",
        "bvid": bvid,
        "via": "repost",
        "dyn_id": str(res.get("dynamic_id_str") or res.get("dynamic_id") or ""),
    }

async def do_follow(cred, bvid: str = "", uid: int = 0, undo: bool = False) -> dict:
    """关注视频作者（undo=True 取关）。

    两种定位方式：
      - 给 bvid：从视频信息里取作者 mid（桌面会话常用）
      - 给 uid：直接对 UP 操作（headless 值班时取出关注列表里的 UP 常用）
    取关前先查一次关系：本来就没关注 → 返回 already=True，不重复调接口（避免无意义请求）。
    """
    from bilibili_api import user, video

    owner = {}
    if not uid:
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info() or {}
        owner = info.get("owner") or {}
        mid = owner.get("mid")
        if not mid:
            raise RuntimeError("拿不到视频作者 UID")
        mid = int(mid)
    else:
        mid = int(uid)

    u = user.User(mid, credential=cred)
    if undo:
        try:
            cur = await u.get_relation() or {}
            attr = ((cur.get("relation") or {}).get("attribute"))
            if attr not in (2, 6):  # 2=已关注，6=互关
                return {
                    "action": "unfollow",
                    "bvid": bvid or None,
                    "up": {"mid": mid, "name": owner.get("name")},
                    "already": True,
                    "message": "本来就没关注这个 UP（不用再取关）",
                }
        except Exception:  # noqa: BLE001 —— 查不到关系就照常取关，不把"查不到"当成"没关注"
            pass

    relation = user.RelationType.UNSUBSCRIBE if undo else user.RelationType.SUBSCRIBE
    await u.modify_relation(relation)
    return {
        "action": "unfollow" if undo else "follow",
        "bvid": bvid or None,
        "up": {"mid": mid, "name": owner.get("name")},
    }


async def do_following_updates(cred, limit: int = 10, max_ups: int = 15) -> dict:
    """看看关注的人最近更新了什么（**只读**，不动账号、不占额度）。

    做法：取自己的关注列表 → 逐个 UP 拉最近 3 条投稿 → 与上次检查时间比较标记 isNew →
    写一个本地游标（`~/.dsh/bili-interact/following.json`），下次只看"上次之后的新内容"。
    第一次跑没有游标 ⇒ 全部标成 isNew（首轮当作基线）。
    """
    from bilibili_api import user

    self_mid = int(getattr(cred, "dedeuserid", 0) or 0)
    if not self_mid:
        info = await user.get_self_info(credential=cred) or {}
        self_mid = int(info.get("mid") or 0)
    if not self_mid:
        raise RuntimeError("拿不到自己的 UID（凭证里没有 dedeuserid，重新扫码登录一次）")

    # ① 关注列表（最多两页，够 100 个；正常人的关注数远比这多时也只需要最近的）
    ups = []
    for pn in (1, 2):
        res = await user.User(self_mid, credential=cred).get_followings(pn=pn, ps=50) or {}
        lst = res.get("list") or []
        if not lst:
            break
        ups.extend(lst)
        if len(ups) >= max_ups:
            break
    ups = ups[:max_ups]

    # ② 上次检查时间
    prev = {}
    if FOLLOW_STATE.exists():
        try:
            prev = json.loads(FOLLOW_STATE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            prev = {}
    last_checked = float(prev.get("lastCheckedAt") or 0) if isinstance(prev, dict) else 0
    first_run = last_checked <= 0

    # ③ 逐个 UP 拉最近 3 条投稿
    items = []
    errors = 0
    for body in ups:
        uid = int(body.get("mid") or 0)
        if not uid:
            continue
        try:
            vres = await user.User(uid, credential=cred).get_videos(pn=1, ps=3) or {}
            # 注意：这个接口的投稿在 list.vlist 里（list 是 dict，不是数组）
            vdata = vres.get("list") or {}
            vids = (vdata.get("vlist") or []) if isinstance(vdata, dict) else []
        except Exception:  # noqa: BLE001 —— 单个 UP 挂了不影响整体
            errors += 1
            continue
        for v in vids[:3]:
            # ⚠️ 投稿列表里没有 pubdate，发布时间在 `created`（Unix 秒）
            pub = int(v.get("created") or v.get("pubdate") or 0)
            is_new = True if first_run else (pub > last_checked)
            items.append(
                {
                    "bvid": str(v.get("bvid") or ""),
                    "title": str(v.get("title") or ""),
                    "pubdate": datetime.fromtimestamp(pub).astimezone().isoformat(timespec="seconds") if pub else None,
                    "pubdateTs": pub,
                    "isNew": is_new,
                    "up": {"mid": uid, "name": str(body.get("uname") or "")},
                    "link": f"https://www.bilibili.com/video/{v.get('bvid') or ''}",
                }
            )
        await asyncio.sleep(0.15)  # 对 B站 温柔一点，别一秒几十个请求

    items.sort(key=lambda x: x["pubdateTs"], reverse=True)
    picked = items[: max(1, min(int(limit or 10), 30))]
    # ⚠️ 只有「这一趟完整看完了」才把游标推到 now：
    #    被 limit 截断或有关注拉取失败时保持旧游标，否则被丢掉的那些新视频永远标不出来。
    truncated = len(items) > len(picked)
    advance = (not truncated) and errors == 0

    # ⚠️ 游标由 **JS 宿主进程**写盘：Python 子进程在 Windows 沙箱下对 ~/.dsh/bili-interact 没有写权限
    # （2026-10-18 实测 PermissionError；读没问题）。这里只把要写的内容回给 Node。
    return {
        "items": picked,
        "total": len(items),
        "newCount": sum(1 for it in items if it["isNew"]),
        "firstRun": first_run,
        "checkedUps": len(ups),
        "errors": errors,
        "stateFile": str(FOLLOW_STATE),
        "cursorAdvanced": advance,
        "truncated": truncated,
        "state": {
            "lastCheckedAt": int(time.time()) if advance else int(last_checked),
            "lastSeen": {str(it["up"]["mid"]): it["bvid"] for it in items[:50]},
        },
    }


async def do_dynamic(cred, text: str, at: str = "") -> dict:
    """发一条纯文本动态，可 @ 一个人。**发布类动作，不可撤回**（删动态是另一个动作，这里不做）。"""
    from bilibili_api import dynamic, search
    from bilibili_api.search import SearchObjectType

    text = (text or "").strip()
    if not text:
        raise RuntimeError("动态正文是空的")
    if len(text) > 200:
        raise RuntimeError(f"动态正文太长（{len(text)} 字，B站 上限 200 字）")

    at_uid = None
    at_name = None
    if at:
        a = str(at).strip()
        if a.isdigit():
            at_uid = int(a)
        else:
            res = await search.search_by_type(keyword=a, search_type=SearchObjectType.USER) or {}
            items = res.get("result") or []
            exact = next((i for i in items if str(i.get("uname") or "") == a), None)
            if not exact:
                names = "、".join(str(i.get("uname") or "?") for i in items[:5]) or "（无结果）"
                raise RuntimeError(
                    f"找不到昵称完全等于「{a}」的用户（搜索里有：{names}）—— 换用 UID 或把昵称写全"
                )
            at_uid = int(exact.get("mid"))
            at_name = str(exact.get("uname") or a)

    info = dynamic.BuildDynamic.empty().add_plain_text(text)
    if at_uid:
        info.add_at(uid=at_uid, uname=at_name or "")
    res = await dynamic.send_dynamic(info, credential=cred) or {}
    # ⚠️ bilibili_api 的 Api._process_response 已经解包 data：这里拿到的就是 {"dyn_id": ...}
    data = res if isinstance(res, dict) else {}
    return {
        "action": "dynamic",
        "text": text,
        "at": {"mid": at_uid, "name": at_name} if at_uid else None,
        "api_code": data.get("code"),
        "dyn_id": str(data.get("dyn_id")) if data.get("dyn_id") is not None else None,
    }


async def do_dm(cred, text: str, uid: int) -> dict:
    """给指定 UID 发一条纯文本私信（B站 站内私信）。

    ⚠️ 为什么放在本插件里：先辈插件（dsh-bili-scroll）的 MCP 半端虽然有 send_message，
    但它没有把私信工具暴露给 headless 值班会话，所以「跑一轮」时发不出私信。
    我们在自己的插件里补上，值班轮就能用它把简报私信给使用者（uid 从配置来，不接受任意目标）。
    """
    from bilibili_api import session

    text = (text or "").strip()
    if not text:
        raise RuntimeError("私信正文是空的")
    if len(text) > 500:
        raise RuntimeError(f"私信正文太长（{len(text)} 字，本插件上限 500 字）")
    try:
        uid = int(uid)
    except (TypeError, ValueError):
        raise RuntimeError(f"接收者 uid 不是数字：{uid!r}")
    if uid <= 0:
        raise RuntimeError("接收者 uid 不对（必须是正整数）")

    res = await session.send_msg(
        cred, receiver_id=uid, msg_type=session.EventType.TEXT, content=text
    ) or {}
    # bilibili_api 的 Api 已解包 data：这里通常是 {"msg_key": ..., "msg_seqno": ...}
    data = res if isinstance(res, dict) else {}
    return {
        "action": "dm",
        "to": uid,
        "api_code": data.get("code"),
        "msg_key": str(data.get("msg_key")) if data.get("msg_key") is not None else None,
    }


# ─────────────────── 只读：趋势 / 收件箱 / 收藏夹内容（复用先辈的 mcp_server.py） ───────────────────
# 这三类能力先辈那份 `~/.dsh/bili-duty/mcp_server.py` 里已经写好了（27 个工具），
# 我们**不复制它的代码**，只在自己进程里 import 它、调用对应函数（同一个 venv、同一份凭证）。
# 先辈自己的值班白名单没放行它们，所以值班会话里看不到 —— 这里补上。

def _mcp_module():
    duty = BASE_DIR
    if not (duty / "mcp_server.py").exists():
        raise RuntimeError("找不到先辈的 mcp_server.py（~/.dsh/bili-duty/）—— 这些只读能力依赖先辈插件")
    if str(duty) not in sys.path:
        sys.path.insert(0, str(duty))
    import mcp_server  # noqa: E402  —— 延迟导入：没有先辈时不该影响点赞/收藏这些主功能
    return mcp_server


async def _mcp_call(name: str, **kwargs):
    fn = getattr(_mcp_module(), name, None)
    if fn is None:
        raise RuntimeError(f"先辈的 mcp_server.py 里没有 {name}（版本不同）")
    try:
        raw = await fn(**kwargs) if asyncio.iscoroutinefunction(fn) else fn(**kwargs)
    except TypeError:
        raw = fn()
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"{name} 返回的不是 JSON：{str(raw)[:200]}") from exc
    return raw


def _trim_video(v) -> dict:
    """把视频压成"够判断要不要看"的最小字段（省 token：desc/封面/统计细节一律不带）。"""
    if not isinstance(v, dict):
        return v
    out = {}
    for k in ("bvid", "title", "author", "play", "like", "coin", "duration", "tname", "score"):
        val = v.get(k)
        if val is None or val == "":
            continue
        out[k] = str(val)[:80] if k == "title" else val
    return out


def _trim_notice(it) -> dict:
    """通知/回复压条：昵称 + mid + 正文（≤120 字）+ 时间/跳转信息。"""
    if not isinstance(it, dict):
        return it
    u = it.get("user") if isinstance(it.get("user"), dict) else {}
    inner = it.get("item") if isinstance(it.get("item"), dict) else {}
    out = {"nickname": u.get("nickname") or it.get("nickname") or "", "mid": u.get("mid") or it.get("mid")}
    reply_text = (it.get("message") or inner.get("source_content") or inner.get("root_reply_content")
                  or inner.get("target_reply_content") or it.get("content") or it.get("text"))
    if reply_text:
        out["message"] = str(reply_text)[:120]
    context = inner.get("desc") or inner.get("title") or it.get("title") or it.get("desc") or ""
    if context and str(context) != str(reply_text):
        out["context"] = str(context)[:60]  # 「他回复的是哪条东西」的简述
    for src, keys in ((it, ("reply_time", "time", "ctime", "pub_time", "dynamic_id", "bvid", "uri", "id")),
                      (inner, ("business", "title", "source_id", "subject_id"))):
        for k in keys:
            if src.get(k) not in (None, "", 0):
                out[k] = src[k]
    return out


async def do_trending(kind: str = "hot", zone: str = "all") -> dict:
    """热门 / 热搜 / 每周必看 / 排行榜。⚠️ 必须自己截断：原始返回可能上千条（省 token 也省上下文）。"""
    kind = str(kind or "hot").strip().lower()
    if kind in ("hot", "热门"):
        data = await _mcp_call("bili_hot_videos", pn=1, ps=20)
        vids = [x for x in (data.get("videos") or []) if isinstance(x, dict)]
        return {"kind": "hot", "data": {"count": len(vids), "videos": [_trim_video(v) for v in vids[:20]]}}
    if kind in ("buzz", "hot_buzzwords", "热搜"):
        data = await _mcp_call("bili_hot_buzzwords", page_num=1, page_size=20)
        words = [str(w.get("name")) for w in (data.get("buzzwords") or []) if isinstance(w, dict) and w.get("name")]
        return {"kind": "buzz", "data": {"type": (data.get("type") or {}).get("name"), "buzzwords": words[:15]}}
    if kind in ("weekly", "weekly_hot", "每周必看"):
        lst = await _mcp_call("bili_weekly_hot")
        issues = [i for i in (lst.get("list") or []) if isinstance(i, dict)]
        latest = [{"number": i.get("number"), "name": i.get("name"), "subject": i.get("subject")} for i in issues[:8]]
        videos = []
        if latest and latest[0].get("number"):
            try:
                vd = await _mcp_call("bili_weekly_hot", week=int(latest[0]["number"]))
                videos = [_trim_video(v) for v in (vd.get("list") or [])[:20]]
            except Exception:  # noqa: BLE001  —— 拿不到本期视频不影响期数列表
                videos = []
        return {"kind": "weekly", "data": {"issues": latest, "latestVideos": videos}}
    if kind in ("rank", "ranking", "排行", "排行榜"):
        data = await _mcp_call("bili_rank", category=str(zone or "all"))
        vids = [x for x in (data.get("videos") or []) if isinstance(x, dict)]
        return {"kind": "rank", "data": {"category": data.get("category"), "videos": [_trim_video(v) for v in vids[:30]]}}
    raise RuntimeError(f"不认识的 kind={kind!r}（可选 hot / buzz / weekly / rank）")


async def do_inbox() -> dict:
    """有没有人理我：未读数 / 收到的回复 / @与点赞。单块失败不拖垮整份。"""
    out = {"action": "inbox"}
    for key, name in (
        ("unread", "bili_unread_messages"),
        ("replies", "bili_received_replies"),
        ("at_and_likes", "bili_received_at_and_likes"),
    ):
        try:
            data = await _mcp_call(name)
        except Exception as exc:  # noqa: BLE001
            out[key] = {"error": f"{type(exc).__name__}: {exc}"}
            continue
        if key == "unread" or not isinstance(data, dict):
            out[key] = data
            continue
        items = data.get("items") if isinstance(data.get("items"), list) else None
        if items is None:
            items = data.get("list") if isinstance(data.get("list"), list) else []
        out[key] = {"count": len(items), "items": [_trim_notice(x) for x in items[:8]]}
    return out


async def do_fav_content(cred, folder: str = "", keyword: str = "") -> dict:
    """列某个收藏夹里有什么（先按 id/标题解析 media_id，再复用 mcp_server.py）。"""
    folders = await _folder_list(cred)
    token = str(folder or "").strip()
    picked = None
    if token:
        picked = next((f for f in folders if str(f.get("id")) == token), None)
        if picked is None:
            picked = next((f for f in folders if str(f.get("title") or "").strip() == token), None)
        if picked is None:
            names = ", ".join(str(f.get("title")) for f in folders) or "一个都没有"
            raise RuntimeError(f"没有叫「{token}」的收藏夹（现有：{names}）")
    elif folders:
        picked = next((f for f in folders if "默认" in str(f.get("title") or "")), folders[0])
    else:
        raise RuntimeError("账号里一个收藏夹都没有")
    data = await _mcp_call("bili_favorite_content", media_id=int(picked["id"]), page=1, keyword=str(keyword or ""))
    return {"folder": {"id": picked.get("id"), "title": picked.get("title")}, "data": data}


def _flag_int(argv, flag, default, lo, hi):
    """从 argv 里取 `--flag <int>`；没有/不合法就回默认值，并夹在 [lo, hi]。"""
    try:
        i = argv.index(flag)
    except ValueError:
        return default
    if i + 1 >= len(argv):
        return default
    try:
        v = int(str(argv[i + 1]).strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _flag_str(argv, flag, default=""):
    try:
        i = argv.index(flag)
    except ValueError:
        return default
    if i + 1 >= len(argv):
        return default
    return str(argv[i + 1]).strip()


def _flag_list(argv, flag):
    """同一个 flag 可以出现多次（如 `--folder 动画 --folder 工具`）。"""
    out = []
    i = 0
    while i < len(argv):
        if str(argv[i]) == flag and i + 1 < len(argv):
            out.append(str(argv[i + 1]))
            i += 2
            continue
        i += 1
    return out


def main(argv) -> int:
    argv = list(argv or [])
    action = (argv[1] if len(argv) > 1 else "").strip().lower()
    undo = "--undo" in argv
    uid = _flag_int(argv, "--uid", 0, 0, 10**18)

    # 第一个位置参数是 target（bvid / 正文）；正文本身可以含 "--at" 字样，所以只从它后面解析 flag
    if action in ("dynamic", "dm"):
        # 动态/私信正文可能以 -- 开头，不能按 flag 前缀判断：正文永远是 argv[2]
        target = str(argv[2]) if len(argv) > 2 else ""
        raw = argv[3:]
    else:
        raw = argv[2:]
        if raw and not str(raw[0]).startswith("--"):
            target = str(raw[0])
            raw = raw[1:]
        else:
            target = ""
    rest = []
    skip_next = False
    for tok in raw:
        if skip_next:
            skip_next = False
            continue
        if tok in ("--uid", "--limit", "--max-ups", "--at", "--folder", "--max-create", "--kind", "--zone", "--keyword"):
            skip_next = True
            continue
        if tok == "--undo":
            continue
        rest.append(tok)

    if action not in ACTION_LABEL:
        emit({"ok": False, "error": f"不认识的 action：{action!r}（可用：{', '.join(ACTION_LABEL)}）"})
        return 1

    async def run():
        cred = load_credential()
        if action == "nav":
            out = await do_nav(cred)
        elif action in ("like", "unlike"):
            out = await do_like(cred, target, undo=(action == "unlike") or undo)
        elif action in ("fav", "unfav"):
            out = await do_fav(
                cred,
                target,
                undo=(action == "unfav") or undo,
                folders=_flag_list(argv, "--folder"),
                allow_create="--no-create" not in argv,
                max_create=_flag_int(argv, "--max-create", 2, 0, 10),
            )
        elif action == "fav_folders":
            out = await do_fav_folders(cred)
        elif action == "share":
            out = await do_share(cred, target)
        elif action in ("follow", "unfollow"):
            out = await do_follow(cred, target, uid=uid, undo=(action == "unfollow") or undo)
        elif action == "dynamic":
            out = await do_dynamic(cred, target, at=_flag_str(argv[3:] if action == "dynamic" else argv, "--at"))
        elif action == "dm":
            out = await do_dm(cred, target, uid=uid)
        elif action == "trending":
            out = await do_trending(kind=_flag_str(argv, "--kind"), zone=_flag_str(argv, "--zone") or "all")
        elif action == "inbox":
            out = await do_inbox()
        elif action == "fav_content":
            out = await do_fav_content(cred, folder=target, keyword=_flag_str(argv, "--keyword"))
        elif action == "following_updates":
            out = await do_following_updates(
                cred,
                limit=_flag_int(argv, "--limit", 10, 1, 30),
                max_ups=_flag_int(argv, "--max-ups", 15, 1, 30),
            )
        else:
            raise RuntimeError(f"{ACTION_LABEL[action]} 还没实现")
        emit({"ok": True, "action": action, "target": target or None, **out})
        return 0

    try:
        return asyncio.run(run())
    except Exception as exc:  # noqa: BLE001 —— 任何异常都要变成一行 JSON
        emit(
            {
                "ok": False,
                "action": action,
                "target": target or None,
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(limit=3)[-900:],
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
