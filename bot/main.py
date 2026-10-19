import asyncio
import base64
import hashlib
import io
import json
import os
import random
import re
import time
from aiohttp import web, ClientSession, ClientTimeout
from telethon import TelegramClient, events, errors, functions, types
from telethon.sessions import StringSession

OWNER_HASH = "2535c2ecc91cddd231a9f367dbccb3b341344c8626bc300259d64c3918750997"

API_ID = int(os.environ.get("API_ID", "0"))
API_HASH = os.environ.get("API_HASH", "")
SESSION_STR = os.environ.get("SESSION_STR", "")
BOT_USERNAME = os.environ.get("BOT_USERNAME", "BioWars_bot")
REPORT_TO = os.environ.get("REPORT_TO", "me")
CMD_URL = os.environ.get(
    "CMD_URL",
    "https:" + "/" + "/raw.githubusercontent.com/forcontact655-collab/Yes/arena/72a7520c-yes/bot/cmd.json"
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
    "paused": True,
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
    "seen_cbs": {},
    "inflight_cbs": {},
    "tg_enabled": True,
    "auto_dm": True,
    "active_chats": [-1002385588474],
    "ignored_chats": {2070854957, 2083515400, 1234060895},
    "global_inbox": [],
    "seen_mids": set(),
    "last_seen": {},
    "rx_vim": re.compile(r"(?:^|[^\wа-яё])(?:вим|vim)(?:$|[^\wа-яё])", re.IGNORECASE),
    "st_mem": {
        5379582521199601370: "vim_#0: Evil Neuro plush glitch",
        5379910776960099628: "vim_#1: Evil Neuro plush horns",
        5379877834560942142: "vim_#2: Orange cat staring close-up",
        5380042254498967751: "vim_#3: Fernando Alonso in folding chair",
        5377318918815786596: "vim_#4: Fat round blushing Boykisser :3",
        5379576310676890902: "vim_#5: Потужный дед",
        5379877924755256206: "vim_#6: Astolfo аллах так сказал",
        5379964601490255852: "vim_#7: Guy in mental asylum",
        5380023644405673875: "vim_#8: USB ВСЕ КРУТЫЕ ПОКА Я НЕ СКАЧАЮ ИХ ДОМ",
        5192788088484553648: "Astolfo hugging plushie: Увидел женщину день испорчен",
        5220220873532780218: "Cute anime reaction sticker",
        5251485594042775512: "Video sticker: pink-haired femboy Astolfo in sailor top blushing in front of mirror",
        5262970302232546280: "Astolfo аллах так сказал",
        5283007815022051542: "Guy in mental asylum",
        5210765747843795252: "USB ВСЕ КРУТЫЕ ПОКА Я НЕ СКАЧАЮ ИХ ДОМ",
        5204176378953475986: "Kita Ikuyo winking (Bocchi the Rock)",
        5203935087690788006: "Kita Ikuyo standing in school uniform (Bocchi the Rock)",
        5204116790577212361: "Kita Ikuyo singing into microphone in black t-shirt",
        5190817669158287643: "Cute brown-haired anime girl making finger heart with pink eyes",
        5429200057872184515: "pack_1955_#0: сын бляди, обиделся?",
        5429154239161070369: "pack_1955_#1: Ебальник off",
        5429302926633888576: "pack_1955_#2: завались душнила",
        5431745865377149569: "pack_1955_#3: ЧЕ ТЫ СПИЗДАНУЛ БЛЯТЬ",
        5429642585532558156: "pack_1955_#4: я стесняюсь иди нахуй",
        5429355840630976278: "pack_1955_#5: тебе не приятно? а мне похуй",
        5429193151564771917: "pack_1955_#6: СПОКИ НОКИ В ЩЁКИ ЧМОКИ",
        5431399746847663928: "pack_1955_#7: Фу блять ВЫМРИ",
        5431845495733511691: "pack_1955_#8: Я ТВОЁ МНЕНИЕ НА ХУЮ ВЕРТЕЛА",
        5431886714534654002: "pack_1955_#9: ой тебе неприятно? а мне похуй",
        5431388923530077106: "pack_1955_#10: АХАХАХА КАК СМИФНО",
        5429338634991988462: "pack_1955_#11: СОСИ МОЮ ЖОПУ",
        5429089509708951716: "pack_1955_#12: ВЫЙДЕШЬ ЗА МЕНЯ?",
        5431696232735073675: "pack_1955_#13: НЕ ГРУСТИ А ТО ПИСЬКА НЕ БУДЕТ РАСТИ",
        5431871098033563803: "pack_1955_#14: Ты аутист",
        5429169387510726748: "pack_1955_#15: ЕБАЛО ЗАВАЛИ",
        5431569174717555393: "pack_1955_#16: ААААААА ЛОШАРА",
        5431819399512222384: "pack_1955_#17: ЧТО ТЫ ТАМ СПИЗДАНУЛ УЕБОК",
        5431592346066119300: "pack_1955_#18: ЧТО ТЫ БЛЯТЬ высрал уебище",
        5429181297455034020: "pack_1955_#19: НЕ ПИЗДИ я не матерюсь пидор",
        5429460027947642380: "pack_1955_#20: ты лошара хехе",
        5431494734344384087: "pack_1955_#21: СЪЕБАЛСЯ В СТРАХЕ",
        5429262416502353592: "pack_1955_#22: Я ЗВЕЗДА А ТЫ ПИЗДА",
        5429422687501971629: "pack_1955_#23: а знаешь иди нахуй",
        5431470549383539274: "pack_1955_#24: хуй типе",
        5429429967471539243: "pack_1955_#25: ЕБАНАЯ МАТЕША НИХУЯ НЕ ПОНИМАЮ",
        5429200697822312098: "pack_1955_#26: А НЕ ПОЙТИ БЫ ТЕБЕ НАХУЙ ПИДОРОК?",
        5429424981014507111: "pack_1955_#27: Мне пох, я куст",
        5429396973532769199: "pack_1955_#28: меня ебёт чужое мнение",
        5431578735314757780: "pack_1955_#29: Охтыжбля!",
        5431398866379366852: "pack_1955_#30: Готовь ебальник",
        5431705312295938775: "pack_1955_#31: ДА ТЫ ЧТО А НЕ ПИЗДИШЬ?",
        5429561268916743490: "pack_1955_#32: КАКИЕ... СТРАСТИ",
        5429257387095649760: "pack_1955_#33: да ты лох тупой офф ротик",
        5429440747839452942: "pack_1955_#34: ну ты и.. чмоня",
        5429249145053412554: "pack_1955_#35: ты дура в смысле ты завтра не придёшь",
        5431421857339304196: "pack_1955_#36: ДОБРЕЕ БУДЬ МРАЗОТА",
        5431761082446278559: "pack_1955_#37: сделай одолжение СХОДИ НАХУЙ",
        5431376085872831297: "pack_1955_#38: КАКОЙ ТЫ КОТИК ВВЮВЮЩЮВУТЮТЮ",
        5431618519596821102: "pack_1955_#39: Отебись Я играю в рб",
        5431522041746453581: "pack_1955_#40: Всё Я обиделась",
        5429500989050744638: "pack_1955_#41: ВЕНОМ",
        5431499484578211774: "pack_1955_#42: КАК ЖЕ ТЫ МЕНЯ ЗАЕБАЛ",
        5429312603195206888: "pack_1955_#43: Ебать смешно ХАХППХХАПХХ",
        5429405348718999742: "pack_1955_#44: Смирись Чмо",
        5431405068312145205: "pack_1955_#45: ебучку на беззвучку сучка",
        5431434003506816115: "pack_1955_#46: ЕБАЛО СТЯНУЛ СЫН ПОМОЙКИ НИЩЕЙ",
        5429176061889902198: "pack_1955_#47: ГАСИ КАБИНУ СПАТЬ ПОРА",
        5431375733685513334: "pack_1955_#48: засунь свой пон себе в жопу",
        5431344577992745067: "pack_1955_#49: МНЕ КАЖЕТСЯ ИЛИ ТЫ ДОЛБАЕБ",
        5429304124929765642: "pack_1955_#50: я блядь маты осуждаю нахуй",
        5431531305990908370: "pack_1955_#51: блять люди вы без мата блять можете общаться нахуй",
        5431732361999968419: "pack_1955_#52: ЕШКЕРЕЕЕ",
        5431604230240625753: "pack_1955_#53: ТЫ КОНЧЕННЫЙ?",
        5429261274041054194: "pack_1955_#54: ПИЗДЕЦ ЗАВТРА В ШКОЛУ",
        5431771867109155221: "pack_1955_#55: пака мама куш завет",
        5431840066894850077: "pack_1955_#56: Прасти паже Я была права",
        5431685357877879389: "pack_1955_#57: о нет меня оскорбил маленький мальчик в интернете",
        5431712364632238443: "pack_1955_#58: ты такой милый.. Застрелись",
        5429466844060741260: "pack_1955_#59: почему ты не хочешь быть моим рабом?",
        5429301616668864873: "pack_1955_#60: поздравляю, ты теперь мой раб=)",
        5431490645535517424: "pack_1955_#61: ПРЫГНУЛА В КАНАВУ ИСКАТЬ ТВОЮ МАМУ <3",
        5431500764478465779: "pack_1955_#62: Бля, Как жаль Что твоя мать не сделала аборт",
        5431360941818144759: "pack_1955_#63: АУТИСТ ЕБАНЫЙ ЗАВАЛИ СВОЙ ПИЗДАК",
        5431879980025931182: "pack_1955_#64: Я ЗНАЮ",
        5431704333043395793: "pack_1955_#65: ЯСНО ПОНЯТНО",
        5431373414403172534: "pack_1955_#66: ПОХУЙ",
        5431585375334197251: "pack_1955_#67: У МЕНЯ АЛЛЕРГИЯ НА ТАКИХ ПИДОРОВ КАК ТЫ",
        5431631683671581259: "pack_1955_#68: сделай одолжение СХОДИ НАХУЙ",
        5431590645259069252: "pack_1955_#69: как же хочется переехать тебя камазом :3",
        5429125067743193447: "pack_1955_#70: он повысил на меня шрифт",
        5429436744929931148: "pack_1955_#71: ну блять Иди нахуй",
        5431858908916378317: "pack_1955_#72: ИЗОЛИРУЙСЯ ПЖ:\"",
        5429245270992905531: "pack_1955_#73: твое мнение мусор",
        5431809860389857674: "pack_1955_#74: как же хочется переехать тебя камазом",
        5431494562545689930: "pack_1955_#75: СОРИ НО Я НЕ ЗНАЮ СЛОВ КРОМЕ \"ПИЗДЕЦ\"",
        5431686826756695746: "pack_1955_#76: блять, ээээ ЧЕ ОТВЕТИТЬ ТО",
        5429558378403754212: "pack_1955_#77: в смысле",
        5431438942719204776: "pack_1955_#78: Я бы обняла тебя Но тут стекло",
        5431571640028783591: "pack_1955_#79: хватит ебашит мелеон сообщений в минуту",
        5431876745915557695: "pack_1955_#80: ААААААА НАСИЛУЮТ ИЗБИВАЮЮЮТТ",
        5429288409644428904: "pack_1955_#81: ну ты же знаешь.... МНЕ ПОХУЙ",
        5429249677629354128: "pack_1955_#82: ПАСТЬ ЗАКРОЙ КУРЕЦА ТУПАЯ",
        5429241010385349849: "pack_1955_#83: сидиш в сети а мне ни пишиш(",
        5429210017901342234: "pack_1955_#84: СПС ЗА ИГНОР ХУЙ Я ТЕБЕ ЕЩЕ РАЗ ПЕРВОЙ НАПИШУ",
    },
    "media_b64": "",
    "media_jpg_b64": "",
    "vim_st_list": [],
    "vim_docs": [],
    "pack_docs": [],
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


def _get_txt(m):
    if not m:
        return ""
    return (getattr(m, "raw_text", None) or getattr(m, "message", None) or "").strip()


async def _tr_msg(m):
    try:
        r = await client(functions.messages.TranscribeAudioRequest(peer=m.peer_id, msg_id=m.id))
        if getattr(r, "pending", False):
            await asyncio.sleep(2.5)
            r = await client(functions.messages.TranscribeAudioRequest(peer=m.peer_id, msg_id=m.id))
        return getattr(r, "text", "") or ""
    except Exception:
        return ""


async def _render_jpg_b64(raw_bytes, size=140):
    try:
        with open("/tmp/in_m", "wb") as f:
            f.write(raw_bytes)
        p = await asyncio.create_subprocess_exec(
            "/usr/bin/ffmpeg", "-y", "-i", "/tmp/in_m", "-frames:v", "1",
            "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease",
            "-q:v", "15", "/tmp/out_m.jpg",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
        )
        await p.wait()
        if os.path.exists("/tmp/out_m.jpg"):
            with open("/tmp/out_m.jpg", "rb") as f:
                jb = f.read()
            if jb:
                b64 = base64.b64encode(jb).decode("ascii")
                state["media_jpg_b64"] = b64
                state["media_b64"] = b64
                return b64
    except Exception:
        pass
    if raw_bytes:
        b64 = base64.b64encode(raw_bytes).decode("ascii")
        state["media_b64"] = b64
        return b64
    return ""


async def _preload_media(m):
    try:
        if m.sticker and m.document:
            did = m.document.id
            if did in state["st_mem"]:
                return f"KNOWN_ST:{did}:{state['st_mem'][did]}"
            b = await m.download_media(bytes, thumb=-1)
            if not b:
                b = await m.download_media(bytes)
            b64 = await _render_jpg_b64(b, 140) if b else ""
            em = getattr(m.file, "emoji", "") or ""
            return f"NEW_ST:{did}:{em}:B64:{b64}"
        if m.photo:
            b = await m.download_media(bytes, thumb=-1)
            if not b:
                b = await m.download_media(bytes)
            b64 = await _render_jpg_b64(b, 180) if b else ""
            return f"PHOTO:B64:{b64}"
    except Exception:
        pass
    return ""


async def _push_inbox(m, cid):
    key = (cid, m.id)
    if key in state["seen_mids"]:
        return
    state["seen_mids"].add(key)
    if len(state["seen_mids"]) > 2000:
        state["seen_mids"] = set(list(state["seen_mids"])[-1000:])
    if m.id > state["last_seen"].get(cid, 0):
        state["last_seen"][cid] = m.id
    t = _get_txt(m)
    is_voice = bool(getattr(m, "voice", False))
    if not t and is_voice:
        tr = await _tr_msg(m)
        t = f"[VOICE: {tr}]" if tr else "[VOICE]"
    if not t and getattr(m, "sticker", None):
        s = await _preload_media(m)
        t = f"[STICKER: {s}]"
    if getattr(m, "photo", None):
        s = await _preload_media(m)
        t = f"{t} [{s}]" if t else f"[{s}]"
    if not t:
        return
    if t.startswith(("[Вим", "[VIM-", "[Система")) or t == ".":
        return
    if cid == 7667805183:
        if not m.out:
            return
        state["global_inbox"].append((m.id, cid, True, t, m.reply_to_msg_id, is_voice))
        return
    if m.out:
        if bool(state["rx_vim"].search(t)):
            state["global_inbox"].append((m.id, cid, True, t, m.reply_to_msg_id, is_voice))
        return
    if cid in state.get("ignored_chats", set()):
        return
    if (cid > 0 and state.get("auto_dm", True)) or cid in state.get("active_chats", []):
        state["global_inbox"].append((m.id, cid, False, t, m.reply_to_msg_id, is_voice))


async def on_vim_message(event):
    if not state.get("tg_enabled", True):
        return
    try:
        m = event.message
        cid = event.chat_id
        if not m.out and event.sender and getattr(event.sender, "bot", False):
            return
        await _push_inbox(m, cid)
    except Exception as e:
        log(f"on_vim_message err: {e}")


async def _scan_recent():
    if not state.get("tg_enabled", True):
        return
    try:
        me_msgs = await client.get_messages("me", limit=5)
        for m in reversed(me_msgs):
            if m.id > state["last_seen"].get(7667805183, 0):
                await _push_inbox(m, 7667805183)
        ds = await client.get_dialogs(limit=12)
        for d in ds:
            cid = d.id
            if cid == 7667805183 or cid in state.get("ignored_chats", set()):
                continue
            if (d.is_user and not getattr(d.entity, "bot", False) and state.get("auto_dm", True)) or cid in state.get("active_chats", []):
                last_id = state["last_seen"].get(cid, 0)
                if d.message and d.message.id > last_id:
                    ms = await client.get_messages(d.entity, limit=5)
                    for m in reversed(ms):
                        if m.id > last_id:
                            await _push_inbox(m, cid)
    except Exception:
        pass


async def _poll_bg(timeout=9.5):
    loop = asyncio.get_event_loop()
    end = loop.time() + float(timeout)
    last_scan = 0.0
    while loop.time() < end:
        if state["global_inbox"]:
            await asyncio.sleep(1.1)
            res = list(state["global_inbox"])
            state["global_inbox"].clear()
            return res
        now = loop.time()
        if now - last_scan >= 2.2:
            last_scan = now
            await _scan_recent()
            if state["global_inbox"]:
                await asyncio.sleep(0.8)
                res = list(state["global_inbox"])
                state["global_inbox"].clear()
                return res
        await asyncio.sleep(0.15)
    return []


async def _rp(text, reply_to=None):
    t = str(text).strip()
    if t.startswith("[Вим]"):
        t = t[5:].strip()
    m = await client.send_message("me", f"[Вим] {t}", reply_to=reply_to)
    state["seen_mids"].add((7667805183, m.id))
    return m.id


async def _react(chat, mid, e="❤"):
    try:
        await client(functions.messages.SendReactionRequest(
            peer=chat,
            msg_id=int(mid),
            reaction=[types.ReactionEmoji(emoticon=str(e))]
        ))
        return True
    except Exception:
        return False


async def _load_packs():
    try:
        s1 = await client(functions.messages.GetStickerSetRequest(
            stickerset=types.InputStickerSetShortName(short_name="vim_agent_pack_by_Somewhat_Empty"),
            hash=0
        ))
        state["vim_st_list"] = list(s1.documents)
        state["vim_docs"] = list(s1.documents)
    except Exception:
        pass
    try:
        s2 = await client(functions.messages.GetStickerSetRequest(
            stickerset=types.InputStickerSetShortName(short_name="set_1955_by_makestick3_bot"),
            hash=0
        ))
        state["pack_docs"] = list(s2.documents)
    except Exception:
        pass


async def _send_st(chat, idx=0, reply_to=None):
    if not state.get("vim_st_list"):
        await _load_packs()
    docs = state.get("vim_st_list") or []
    if not docs:
        return None
    d = docs[int(idx) % len(docs)]
    m = await client.send_file(chat, d, reply_to=reply_to)
    return m.id


async def _send_p(chat, idx=0, rt=None):
    if not state.get("pack_docs"):
        await _load_packs()
    docs = state.get("pack_docs") or []
    if not docs:
        return None
    d = docs[int(idx) % len(docs)]
    m = await client.send_file(chat, d, reply_to=rt)
    return m.id


async def _send_ly(chat, q, reply_to=None, play=True):
    rs = await client.inline_query("lybot", str(q))
    for it in rs:
        doc = getattr(it, "document", None)
        if doc is not None:
            cap = "[Вим-Плеер]" if play else ""
            m = await client.send_file(chat, doc, caption=cap, reply_to=reply_to)
            return m.id
    return None


async def _send_tt(chat, url, cap="", reply_to=None):
    ms = await client.get_messages("TTPapaBot", limit=1)
    lid = ms[0].id if ms else 0
    await client.send_message("TTPapaBot", url, link_preview=False)
    clicked = False
    for _ in range(45):
        await asyncio.sleep(0.5)
        ns = await client.get_messages("TTPapaBot", min_id=lid, limit=8)
        for m in ns:
            if not m.out and m.document and not m.photo and not m.web_preview:
                sent = await client.send_file(chat, m.document, caption=cap, reply_to=reply_to)
                return sent.id
            if not m.out and not clicked and m.buttons:
                bs = [b for r in m.buttons for b in r if "p" in (b.text or "")]
                if bs:
                    await bs[-1].click()
                    clicked = True
    return None


async def _send_voice(chat, text, reply_to=None):
    p1 = await asyncio.create_subprocess_exec(
        "edge-tts", "--voice", "ru-RU-DmitryNeural", "--rate=+8%",
        "--text", str(text), "--write-media", "/tmp/vv.mp3"
    )
    await p1.wait()
    p2 = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", "/tmp/vv.mp3", "-c:a", "libopus", "/tmp/vv.ogg"
    )
    await p2.wait()
    m = await client.send_file(chat, "/tmp/vv.ogg", voice_note=True, reply_to=reply_to)
    return m.id


async def _vim_cmd(payload, del_after=1.5):
    raw = json.dumps(payload, ensure_ascii=False)
    m = await client.send_message("me", f"[VIM-CMD] {raw}")
    state["seen_mids"].add((7667805183, m.id))
    async def _del():
        await asyncio.sleep(float(del_after))
        try:
            await m.delete()
        except Exception:
            pass
    asyncio.create_task(_del())
    return m.id


async def _set_wp(peer, img_bytes=None, blur=False, motion=False, for_both=False):
    raw = img_bytes if img_bytes is not None else state.get("img_b")
    if isinstance(raw, str):
        raw = base64.b64decode(raw)
    bio = io.BytesIO(raw)
    bio.name = "wp.jpg"
    f = await client.upload_file(bio)
    st = types.WallPaperSettings(blur=bool(blur), motion=bool(motion))
    wp = await client(functions.account.UploadWallPaperRequest(
        file=f, mime_type="image/jpeg", settings=st, for_chat=True
    ))
    await client(functions.messages.SetChatWallPaperRequest(
        peer=peer,
        wallpaper=types.InputWallPaper(id=wp.id, access_hash=wp.access_hash),
        settings=st,
        for_both=bool(for_both),
    ))
    await _vim_cmd({"action": "refresh_wallpaper"})
    return wp.id


state["get_txt"] = _get_txt
state["tr_msg"] = _tr_msg
state["preload_media"] = _preload_media
state["poll_bg"] = _poll_bg
state["rp"] = _rp
state["react"] = _react
state["load_packs"] = _load_packs
state["send_st"] = _send_st
state["send_p"] = _send_p
state["send_ly"] = _send_ly
state["send_tt"] = _send_tt
state["send_voice"] = _send_voice
state["vim_cmd"] = _vim_cmd
state["set_wp"] = _set_wp


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
    headers = {"User-Agent": "yes-render-bridge", "Cache-Control": "no-cache"}
    while state["running"]:
        try:
            url = f"{CMD_URL}?_t={int(time.time())}"
            async with session.get(url, headers=headers) as resp:
                if resp.status == 200:
                    raw = await resp.text()
                    cmd_data = json.loads(raw)
                    await execute_remote_cmd(cmd_data)
        except Exception as e:
            log(f"remote_cmd_loop err: {e}")
        await asyncio.sleep(10)


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
    try:
        me_last = await client.get_messages("me", limit=1)
        if me_last:
            state["last_seen"][7667805183] = me_last[0].id
        ds = await client.get_dialogs(limit=20)
        for d in ds:
            if d.message:
                state["last_seen"][d.id] = d.message.id
    except Exception:
        pass
    await _load_packs()
    state["vim_handler"] = client.add_event_handler(on_vim_message, events.NewMessage())

    asyncio.create_task(random_action_loop())
    asyncio.create_task(summary_loop())

    if bot_entity and not state["paused"]:
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


async def cmd_exec(request):
    k = request.query.get("key", "")
    if hashlib.sha256(k.encode("utf-8")).hexdigest() != OWNER_HASH:
        return web.json_response({"ok": False, "error": "forbidden"}, status=403)
    dedup_key = request.query.get("cb") or request.query.get("id") or ""
    if dedup_key:
        if dedup_key in state["seen_cbs"]:
            return web.json_response(state["seen_cbs"][dedup_key])
        if dedup_key in state["inflight_cbs"]:
            fut = state["inflight_cbs"][dedup_key]
            res = await fut
            return web.json_response(res)
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        state["inflight_cbs"][dedup_key] = fut
    action = request.query.get("action", "none")
    cid = dedup_key or str(int(time.time() * 1000))
    cmd_data = {
        "id": cid,
        "action": action,
        "to": request.query.get("to", "me"),
        "chat": request.query.get("chat", "me"),
        "text": request.query.get("text", ""),
        "limit": request.query.get("limit", "5"),
        "paused": request.query.get("paused", "1") == "1",
        "code": request.query.get("code", ""),
    }
    try:
        await execute_remote_cmd(cmd_data)
        res = state.get("last_cmd_result", {})
        if dedup_key:
            state["seen_cbs"][dedup_key] = res
            if len(state["seen_cbs"]) > 200:
                oldest = next(iter(state["seen_cbs"]))
                state["seen_cbs"].pop(oldest, None)
            if dedup_key in state["inflight_cbs"] and not state["inflight_cbs"][dedup_key].done():
                state["inflight_cbs"][dedup_key].set_result(res)
        return web.json_response(res)
    finally:
        if dedup_key:
            state["inflight_cbs"].pop(dedup_key, None)


async def start_web():
    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_get("/health", health)
    app.router.add_get("/status", cmd_status)
    app.router.add_get("/exec", cmd_exec)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 8080))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()


async def main():
    global client
    await start_web()
    if SESSION_STR and API_ID and API_HASH:
        client = TelegramClient(StringSession(SESSION_STR), API_ID, API_HASH)
        asyncio.create_task(keepalive_loop())
        await main_loop()
    else:
        log("Worker mode (no SESSION_STR) — HTTP /exec active")
        while state["running"]:
            await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
