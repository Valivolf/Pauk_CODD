"""Сценарии Конструктора карт Яндекса — то же, что делает человек:

* создать карту: «Импорт» → файл с точками бригады → название → «Сохранить и продолжить» →
  «Ссылка на карту»;
* обновить карту ТОЧЕЧНО (если изменилось несколько точек): открыть её из «Списка карт», убрать
  удалённые точки, перекрасить/поправить описание у изменившихся (например, точка выполнена →
  зелёная), добавить новые через поиск по координатам («широта, долгота» → первая подсказка →
  первый найденный объект: точка встаёт ровно в эти координаты), заполнить подпись, описание и цвет,
  сохранить — ссылка остаётся той же;
* обновить карту ЦЕЛИКОМ (изменений много или точечно не вышло) = создать новую и удалить старую
  (ссылка меняется, приложение подставляет новую);
* удалить карту: «Список карт» → меню «…» у нужной карты → «Удалить».

Нужную карту ищем по её идентификатору — он лежит в атрибуте data-index="constructor:<хэш>"
строки списка и совпадает с хэшем в ссылке (um=constructor%3A<хэш>).

Селекторы взяты с живой страницы yandex.ru/map-constructor (кнопки имеют устойчивые классы
button_id_importBtn / button_id_saveBtn / button_id_mapListBtn,
поле файла — input.attach__control, строки списка — .map-selection-item). Если Яндекс поменяет вёрстку, ломается только этот файл, а при сбое
робот сохраняет снимок страницы (виден в окне календаря).
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Awaitable, Callable

from playwright.async_api import BrowserContext, Page

from pagewait import ACTION_TIMEOUT_MS, SAFETY_CAP, settle, watch

CONSTRUCTOR_URL = os.environ.get("ROBOT_CONSTRUCTOR_URL", "https://yandex.ru/map-constructor/")
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

_IMPORT_BTN = "button.button_id_importBtn"
_SAVE_BTN = "button.button_id_saveBtn"
_LOGIN_BTN = "button.button_id_loginBtn"
_LIST_BTN = "button.button_id_mapListBtn"
_FILE_INPUT = "input.attach__control"
_NAME_INPUT = 'input[placeholder="Название"]'
_MAP_ROW = ".map-selection-item"
# Точечное изменение карты (проверено на живой странице; префикс ymaps-2-1-79- зависит от версии API
# карт — поэтому в селекторах только «хвосты» имён классов):
_OBJECT_ITEM = ".geoObject-list-item"
_SEARCH_INPUT = '[class*="searchbox-input__input"]'      # «Адрес или объект»
_SUGGEST_ITEM = '[class*="search__suggest-item"]'         # подсказки под полем; первая — «широта, долгота — …»
_RESULT_TITLE = '[class*="islets_serp-item__title"]'      # найденные объекты; первый — самый точный
_BALLOON = ".balloon-setup"                               # окно точки: подпись, описание, цвет, «Готово»/«Удалить»
_BALLOON_SAVE = ".balloon-setup button.button_id_save-button"
_BALLOON_REMOVE = "button.button_id_remove-button"
_COLOR_BTN = ".balloon-setup__color-selector button.select__button"
_COLOR_ITEMS = ".popup_theme_colors .menu__item_theme_colors"
DEFAULT_COLOR_HEX = "1E98FF"                              # цвет новой точки по умолчанию («синий»)
# «Ссылка на карту» после сохранения: поле, в котором лежит адрес вида
# https://yandex.ru/maps/?um=constructor%3A<хэш>&source=constructorLink
_LINK_JS = r"""() => {
  const i = Array.from(document.querySelectorAll('input')).find(el => /\/maps\/\?um=constructor/.test(el.value));
  return i ? i.value : '';
}"""
_NAME_IMPORTED_JS = r"""() => {
  const i = document.querySelector('input[placeholder="Название"]');
  return !!(i && i.value.trim().length > 0 && /^Импорт/.test(i.value.trim()));
}"""
_CAPTCHA_MARKERS = ("showcaptcha", "captcha")
_CAPTCHA_TEXTS = ("Подтвердите, что запросы отправляли вы", "Вы не робот", "Are you not a robot")
_MAP_ID_RE = re.compile(r"um=constructor(?:%3A|:)([0-9a-fA-F]{16,})")


class RobotError(Exception):
    """code: not_logged_in | captcha | import_failed | map_missing | patch_failed | timeout | page_changed | unknown"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


Step = Callable[[str], None]
Shot = Callable[[Page], Awaitable[None]]
Snap = Callable[[Page, str], Awaitable[None]]   # отладка: снимок экрана после шага (только если задание с debug)


def map_id_from_url(url: str) -> str:
    """Идентификатор карты из ссылки «…?um=constructor%3A<хэш>…» (пусто, если это другая ссылка)."""
    m = _MAP_ID_RE.search(url or "")
    return m.group(1).lower() if m else ""


async def _visible(page: Page, selector: str) -> bool:
    try:
        return await page.locator(selector).first.is_visible()
    except Exception:  # noqa: BLE001
        return False


async def _dismiss_dialogs(page: Page) -> bool:
    """Закрывает окна, перекрывающие Конструктор: приветствие «Создайте собственную карту»
    (первый вход) и «Список карт» (открывается само, когда в аккаунте уже есть карты) —
    у обоих есть жёлтая кнопка «Создать карту», она же начинает новую пустую карту."""
    closed = False
    for _ in range(3):
        # Элементов с таким текстом в странице может быть несколько (часть скрыта) — берём видимый.
        btn = page.get_by_text("Создать карту", exact=True).filter(visible=True).first
        try:
            if not await btn.is_visible():
                break
            await btn.click(timeout=ACTION_TIMEOUT_MS)
            closed = True
            await settle(page, quiet=0.5, cap=60)
        except Exception:  # noqa: BLE001
            break
    return closed


async def _login_button_gone(page: Page, wait: float) -> bool:
    """Кнопка «Войти» в шапке Конструктора первые секунды висит и у вошедшего человека — пока страница узнаёт, кто вошёл (а на медленном сервере это
    долго). Сначала ждём, пока страница ЗАГРУЗИТСЯ, потом (ещё до `wait` секунд) — исчезновения кнопки; True — исчезла (вход есть).
    Ушли на страницу входа Яндекса — сразу False."""
    await settle(page, cap=SAFETY_CAP)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if "passport.yandex" in (page.url or ""):
            return False
        if not await _visible(page, _LOGIN_BTN):
            return True
        await asyncio.sleep(0.5)
    return not await _visible(page, _LOGIN_BTN)


async def page_problem(page: Page, patient: float = 0) -> RobotError | None:
    """Не показал ли Яндекс капчу и не просит ли войти. patient — сколько секунд ждать, не исчезнет ли кнопка «Войти» сама (страница ещё грузится)."""
    url = page.url or ""
    if any(m in url for m in _CAPTCHA_MARKERS):
        return RobotError("captcha", "Яндекс показал проверку «Вы не робот». Откройте «Яндекс-аккаунт для карт» и пройдите её в окне браузера робота.")
    try:
        body = await page.locator("body").inner_text(timeout=ACTION_TIMEOUT_MS)
    except Exception:  # noqa: BLE001
        body = ""
    if any(t in body for t in _CAPTCHA_TEXTS):
        return RobotError("captcha", "Яндекс показал проверку «Вы не робот». Откройте «Яндекс-аккаунт для карт» и пройдите её в окне браузера робота.")
    if "passport.yandex" in url:
        return RobotError("not_logged_in", "Робот не вошёл в Яндекс. Откройте «Яндекс-аккаунт для карт» и войдите.")
    if await _visible(page, _LOGIN_BTN):
        if patient and await _login_button_gone(page, patient):
            return None
        return RobotError("not_logged_in", "Робот не вошёл в Яндекс. Откройте «Яндекс-аккаунт для карт» и войдите.")
    return None


async def is_logged_in(ctx: BrowserContext) -> tuple[bool, str]:
    """Настоящая проверка: открывает Конструктор и смотрит, нет ли кнопки «Войти»."""
    page = await ctx.new_page()
    watch(page)
    try:
        await page.goto(CONSTRUCTOR_URL, wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
        await settle(page)                                       # ждём загрузки страницы, а не отсчитываем секунды
        deadline = time.monotonic() + SAFETY_CAP
        while time.monotonic() < deadline:
            if await _visible(page, _IMPORT_BTN):
                # Без входа Конструктор тоже рисуется (кнопка «Импорт» есть), но сверху видна кнопка «Войти». У вошедшего она тоже висит
                # первые секунды, пока страница не узнает, кто вошёл, — поэтому ждём загрузки и исчезновения кнопки, а не решаем сразу.
                problem = await page_problem(page, patient=20)
                return (problem is None), (problem.message if problem else "")
            problem = await page_problem(page, patient=10)
            if problem:
                return False, problem.message
            await asyncio.sleep(0.5)
        return False, "Конструктор карт так и не загрузился (страница не отвечает)"
    finally:
        await page.close()


_WHY_KEYS = ("intercepts pointer events", "not visible", "not enabled", "not stable", "detached", "outside of the viewport", "strict mode violation", "did not receive")


def _why(exc: Exception) -> str:
    """Первая строка ошибки Playwright («Locator.click: Timeout 60000ms exceeded») не говорит, КАКОЙ элемент не нажался и почему; это есть ниже, в «Call log»:
    что ждали («waiting for locator(…)») и чему мешало (перекрыт окном — «<div …> intercepts pointer events», не виден, не доступен). Достаём эти две строки."""
    lines = [line.strip().lstrip("-").strip() for line in str(exc).splitlines()[1:] if line.strip()]
    target = next((ln for ln in lines if ln.startswith("waiting for")), "")
    reason = next((ln for ln in reversed(lines) if any(k in ln for k in _WHY_KEYS)), "")
    out = ""
    if target:
        out += f" — ждали: {target[:150]}"
    if reason:
        out += f"; мешало: {reason[:170]}"
    return out


async def _with_page(ctx: BrowserContext, shot: Shot, fn):
    """Свежая вкладка на одно действие; любой сбой — понятная ошибка + снимок страницы."""
    page = await ctx.new_page()
    watch(page)
    page.set_default_timeout(ACTION_TIMEOUT_MS)
    try:
        try:
            return await fn(page)
        except RobotError:
            await shot(page)
            raise
        except Exception as exc:  # noqa: BLE001 — любой сбой Playwright = понятная ошибка + снимок
            await shot(page)
            problem = await page_problem(page, patient=10)
            if problem:
                raise problem
            kind = "timeout" if "Timeout" in type(exc).__name__ else "page_changed"
            raise RobotError(kind, f"Не удалось выполнить шаг в Конструкторе ({type(exc).__name__}). Возможно, Яндекс изменил страницу: {str(exc).splitlines()[0][:200]}{_why(exc)}")
    finally:
        await page.close()


async def _open_constructor(page: Page, step: Step) -> None:
    """Открывает Конструктор и ждёт, пока страница готова (или капча / нужен вход)."""
    step("Открываю Конструктор карт…")
    await page.goto(CONSTRUCTOR_URL, wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
    await settle(page)                                           # ждём, пока страница загрузится (по состоянию, не по времени)
    deadline = time.monotonic() + SAFETY_CAP
    while True:
        if await _visible(page, _IMPORT_BTN):
            break
        problem = await page_problem(page, patient=10)
        if problem:
            raise problem
        await _dismiss_dialogs(page)
        if time.monotonic() > deadline:
            raise RobotError("timeout", "Конструктор карт так и не загрузился (страница не отвечает)")
        await asyncio.sleep(0.5)
    # Без входа кнопка «Импорт» тоже есть — проверяем «Войти» сразу, а не после загрузки файла. Но терпеливо: у вошедшего она висит, пока страница не загрузилась.
    await settle(page)
    problem = await page_problem(page, patient=20)
    if problem:
        raise problem


async def _import_file(page: Page, filename: str, content: bytes) -> None:
    """«Импорт» → файл. Кнопка «Импорт» есть только у пустой карты."""
    for attempt in range(3):
        try:
            await page.locator(_IMPORT_BTN).click(timeout=ACTION_TIMEOUT_MS)
            await page.wait_for_selector(_FILE_INPUT, state="attached", timeout=ACTION_TIMEOUT_MS)
            break
        except Exception:  # noqa: BLE001 — «Импорт» перекрыт окном: закрыть и повторить
            if attempt == 2:
                raise
            await _dismiss_dialogs(page)
            await page.keyboard.press("Escape")
            await settle(page, quiet=0.5, cap=60)
    await page.locator(_FILE_INPUT).set_input_files(files=[{"name": filename, "mimeType": XLSX_MIME, "buffer": content}])


async def _save_and_get_link(page: Page, name: str) -> str:
    """Название → «Сохранить и продолжить» → ссылка. У УЖЕ существующей карты ссылка видна сразу, а само
    сохранение (запросы на сервер Яндекса) ещё идёт — закрыть вкладку в этот момент значит потерять правки
    (проверено на живом Конструкторе). Поэтому ждём, пока все запросы сохранения закончатся."""
    pending: set = set()

    def on_request(req) -> None:
        if req.method != "GET":
            pending.add(req)

    def on_done(req) -> None:
        pending.discard(req)

    page.on("request", on_request)
    page.on("requestfinished", on_done)
    page.on("requestfailed", on_done)
    try:
        name_input = page.locator(_NAME_INPUT).first
        await name_input.fill(name)
        await name_input.press("Tab")
        await page.locator(_SAVE_BTN).click()
        deadline = time.monotonic() + SAFETY_CAP
        while True:
            url = await page.evaluate(_LINK_JS)
            if url:
                break
            if await _visible(page, _LOGIN_BTN) and not await _login_button_gone(page, 5):
                raise RobotError("not_logged_in", "Яндекс попросил войти при сохранении карты. Войдите в «Яндекс-аккаунт для карт».")
            problem = await page_problem(page, patient=5)
            if problem:
                raise problem
            if time.monotonic() > deadline:
                raise RobotError("timeout", "Карта так и не сохранилась — ссылка не появилась")
            await asyncio.sleep(0.7)
        if not re.match(r"^https://yandex\.[a-z]+/maps/", url):
            raise RobotError("page_changed", f"Ссылка на карту выглядит необычно: {url[:80]}")
        # Дождаться окончания запросов сохранения (по состоянию: пока они есть — ждём) и затишья сети — серверу Яндекса нужно дописать.
        wait_until = time.monotonic() + SAFETY_CAP
        while pending and time.monotonic() < wait_until:
            await asyncio.sleep(0.3)
        await settle(page, quiet=2.0, cap=60)
        return url
    finally:
        page.remove_listener("request", on_request)
        page.remove_listener("requestfinished", on_done)
        page.remove_listener("requestfailed", on_done)


# ---------------------------------------------------------------- создать

async def create_map(ctx: BrowserContext, *, name: str, filename: str, content: bytes, step: Step, shot: Shot) -> str:
    async def run(page: Page) -> str:
        await _open_constructor(page, step)
        # Окна поверх страницы (приветствие, «Список карт») закрываем до нажатия «Импорт».
        await _dismiss_dialogs(page)
        step("Загружаю точки в Конструктор…")
        await _import_file(page, filename, content)
        # Импорт закончился, когда в поле «Название» появилось «Импорт из …».
        deadline = time.monotonic() + SAFETY_CAP
        while True:
            try:
                if await page.evaluate(_NAME_IMPORTED_JS):
                    break
            except Exception:  # noqa: BLE001
                pass
            problem = await page_problem(page, patient=5)
            if problem:
                raise problem
            if time.monotonic() > deadline:
                raise RobotError("import_failed", "Конструктор так и не принял файл с точками (формат файла или страница изменились)")
            await asyncio.sleep(0.7)
        step("Называю карту и сохраняю…")
        url = await _save_and_get_link(page, name)
        step("Готово — ссылка получена")
        return url

    return await _with_page(ctx, shot, run)


# ---------------------------------------------------------------- список карт

async def _open_list(page: Page) -> None:
    """«Список карт» открыт и в нём есть строки (если в аккаунте есть карты)."""
    rows = page.locator(_MAP_ROW)
    await settle(page)
    started = time.monotonic()
    deadline = started + SAFETY_CAP
    clicked = False
    while time.monotonic() < deadline:
        try:
            if await rows.first.is_visible():
                return
        except Exception:  # noqa: BLE001
            pass
        # Список сам открывается при загрузке, если карты есть; если страница загрузилась, а списка нет — открываем кнопкой.
        if not clicked and time.monotonic() - started > 3:
            try:
                await page.locator(_LIST_BTN).first.click(timeout=ACTION_TIMEOUT_MS)
                clicked = True
                await settle(page, quiet=0.5, cap=60)
            except Exception:  # noqa: BLE001
                pass
        await asyncio.sleep(0.4)


async def _find_map_row(page: Page, map_id: str):
    """Строка списка нужной карты или None (если такой карты в аккаунте нет)."""
    await _open_list(page)
    row = page.locator(f'{_MAP_ROW}[data-index="constructor:{map_id}"]')
    for _ in range(6):
        if await row.count():
            return row.first
        # Список может подгружаться порциями — докрутить вниз и посмотреть ещё раз.
        await page.evaluate(
            """() => { const rows = document.querySelectorAll('.map-selection-item'); const last = rows[rows.length - 1];
              if (!last) return; let p = last.parentElement;
              while (p && p.scrollHeight <= p.clientHeight + 2) p = p.parentElement;
              if (p) p.scrollTop = p.scrollHeight; }"""
        )
        await settle(page, quiet=0.6, cap=60)
    return None


# ---------------------------------------------------------------- точечное обновление

async def _object_count(page: Page) -> int:
    return await page.locator(_OBJECT_ITEM).count()


async def _open_map_in_editor(page: Page, map_id: str, step: Step) -> None:
    await _open_constructor(page, step)
    step("Ищу карту в списке…")
    row = await _find_map_row(page, map_id)
    if row is None:
        raise RobotError("map_missing", "Этой карты нет в аккаунте Яндекса (удалена вручную?) — будет создана новая.")
    await row.scroll_into_view_if_needed()
    await row.click()
    # Открылась в редакторе: окно «Списка карт» закрылось.
    deadline = time.monotonic() + SAFETY_CAP
    while time.monotonic() < deadline:
        if not await _visible(page, _MAP_ROW):
            break
        await asyncio.sleep(0.4)
    await settle(page)


async def _wait_count_change(page: Page, before: int, *, up: bool, timeout: float = 90) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        now = await _object_count(page)
        if (now > before) if up else (now < before):
            return now
        await asyncio.sleep(0.25)
    return await _object_count(page)


async def _find_object(page: Page, caption: str, desc: str) -> int:
    """Номер объекта в списке слева по подписи (там он выглядит «(ПОДПИСЬ) описание») и началу описания; -1 — нет."""
    caption = (caption or "").strip()
    texts = [t.strip() for t in await page.locator(_OBJECT_ITEM).all_inner_texts()]
    prefix = f"({caption})" if caption else ""
    candidates = [i for i, t in enumerate(texts) if not prefix or t.startswith(prefix)]
    if not candidates:
        return -1
    key = (desc or "").strip()[:25].lower()
    return next((i for i in candidates if key and key in texts[i].lower()), candidates[0])


async def _remove_object(page: Page, point: dict) -> bool:
    """Убирает с карты точку по подписи."""
    idx = await _find_object(page, point.get("caption") or "", point.get("desc") or "")
    if idx < 0:
        return False
    before = await _object_count(page)
    await page.locator(_OBJECT_ITEM).nth(idx).locator(".geoObject-list-item__title").first.click(timeout=ACTION_TIMEOUT_MS)
    await page.locator(f"{_BALLOON_REMOVE}:visible").first.click(timeout=ACTION_TIMEOUT_MS)
    return (await _wait_count_change(page, before, up=False)) < before


async def _change_object(page: Page, change: dict) -> bool:
    """Меняет описание и/или цвет уже стоящей на карте точки: клик по ней в списке → правка → «Готово»."""
    idx = await _find_object(page, change.get("caption") or "", change.get("old_desc") or "")
    if idx < 0:
        return False
    await page.locator(_OBJECT_ITEM).nth(idx).locator(".geoObject-list-item__title").first.click(timeout=ACTION_TIMEOUT_MS)
    balloon = page.locator(_BALLOON).filter(visible=True).first
    await balloon.wait_for(state="visible", timeout=ACTION_TIMEOUT_MS)
    if change.get("desc") is not None:
        await balloon.locator("textarea").first.fill(change["desc"])
    if change.get("color"):
        await _set_color(page, change["color"])
    await page.locator(_BALLOON_SAVE).filter(visible=True).first.click(timeout=ACTION_TIMEOUT_MS)
    await settle(page, quiet=0.5, cap=60)
    return True


async def _set_color(page: Page, hex_color: str) -> None:
    await page.locator(_COLOR_BTN).filter(visible=True).first.click(timeout=ACTION_TIMEOUT_MS)
    idx = await page.evaluate(
        """(hex) => { const want = 'rgb(' + parseInt(hex.slice(0, 2), 16) + ', ' + parseInt(hex.slice(2, 4), 16) + ', ' + parseInt(hex.slice(4, 6), 16) + ')';
          const items = Array.from(document.querySelectorAll('.popup_theme_colors .menu__item_theme_colors'));
          return items.findIndex(e => getComputedStyle(e).backgroundColor === want); }""",
        hex_color.lstrip("#"),
    )
    if idx < 0:
        raise RobotError("page_changed", f"В палитре цветов нет нужного цвета ({hex_color})")
    await page.locator(_COLOR_ITEMS).nth(idx).click(timeout=ACTION_TIMEOUT_MS)


async def _add_point(page: Page, point: dict) -> None:
    """Добавляет точку через поиск по координатам — ровно так же, как делает диспетчер вручную."""
    lat = str(point["lat"]).strip().replace(",", ".")
    lon = str(point["lon"]).strip().replace(",", ".")
    before = await _object_count(page)
    box = page.locator(_SEARCH_INPUT).first
    await box.click(timeout=ACTION_TIMEOUT_MS)
    await box.press("Control+a")
    await box.press("Backspace")
    await box.press_sequentially(f"{lat}, {lon}", delay=15)
    suggestion = page.locator(_SUGGEST_ITEM).filter(visible=True).first
    await suggestion.wait_for(state="visible", timeout=ACTION_TIMEOUT_MS)
    # Список подсказок обновляется с задержкой: сразу после набора в нём ещё подсказка ПРЕДЫДУЩЕЙ точки (так падала вторая и следующие точки в одном задании —
    # проверено на живом Конструкторе). Ждём, пока первая подсказка станет относиться именно к этим координатам.
    deadline = time.monotonic() + 45
    while True:
        text = (await suggestion.inner_text()).replace("\u00a0", " ")
        if lat[:6] in text and lon[:6] in text:
            break
        if time.monotonic() > deadline:
            raise RobotError("patch_failed", f"Первая подсказка поиска не похожа на координаты ({lat}, {lon}): «{text[:60]}»")
        await asyncio.sleep(0.3)
    await suggestion.click()
    found = page.locator(_RESULT_TITLE).filter(visible=True).first
    await found.wait_for(state="visible", timeout=ACTION_TIMEOUT_MS)
    await found.click()
    balloon = page.locator(_BALLOON).filter(visible=True).first
    await balloon.wait_for(state="visible", timeout=ACTION_TIMEOUT_MS)
    await balloon.locator("input").first.fill(point.get("caption") or "")
    await balloon.locator("textarea").first.fill(point.get("desc") or "")
    color = (point.get("color") or DEFAULT_COLOR_HEX).lstrip("#").upper()
    if color != DEFAULT_COLOR_HEX:
        await _set_color(page, color)
    await page.locator(_BALLOON_SAVE).filter(visible=True).first.click(timeout=ACTION_TIMEOUT_MS)
    if (await _wait_count_change(page, before, up=True)) <= before:
        raise RobotError("patch_failed", f"Точка ({lat}, {lon}) не появилась на карте")
    await settle(page, quiet=0.5, cap=60)


async def patch_map(
    ctx: BrowserContext, *, map_id: str, name: str, add: list[dict], remove: list[dict], change: list[dict],
    expected_total: int | None, step: Step, shot: Shot, snap: Snap | None = None,
) -> str:
    """Меняет карту точечно, ссылка остаётся прежней. Любой сбой — до сохранения, поэтому карта
    остаётся как была, а приложение повторит правку позже (карта не пересоздаётся и не удаляется)."""
    async def mark(page: Page, label: str) -> None:
        if snap is not None:
            await snap(page, label)

    async def run(page: Page) -> str:
        await _open_map_in_editor(page, map_id, step)
        await mark(page, "1-opened")
        for i, point in enumerate(remove, 1):
            step(f"Убираю точки ({i} из {len(remove)})…")
            if not await _remove_object(page, point):
                raise RobotError("patch_failed", f"На карте не нашлась точка «{point.get('caption', '')}» для удаления")
            await mark(page, f"2-removed-{i}")
        for i, item in enumerate(change, 1):
            step(f"Меняю точки ({i} из {len(change)})…")
            if not await _change_object(page, item):
                raise RobotError("patch_failed", f"На карте не нашлась точка «{item.get('caption', '')}» для изменения")
            await mark(page, f"3-changed-{i}")
        for i, point in enumerate(add, 1):
            step(f"Добавляю точки ({i} из {len(add)})…")
            await _add_point(page, point)
            await mark(page, f"4-added-{i}")
        total = await _object_count(page)
        if expected_total is not None and total != expected_total:
            raise RobotError("patch_failed", f"После правок на карте {total} точек, а должно быть {expected_total}")
        step("Сохраняю карту…")
        await mark(page, "5-before-save")
        url = await _save_and_get_link(page, name)
        await mark(page, "6-after-save")
        if map_id_from_url(url) != map_id:
            raise RobotError("page_changed", "После сохранения ссылка карты изменилась — это неожиданно, проверьте карту в Конструкторе.")
        # Проверка: карта сохранилась — открыть её заново в новой вкладке и сверить число точек.
        step("Проверяю, что карта сохранилась…")
        check = await page.context.new_page()
        watch(check)
        check.set_default_timeout(ACTION_TIMEOUT_MS)
        try:
            await _open_map_in_editor(check, map_id, lambda _msg: None)
            saved_total = await _object_count(check)
            saved_texts = [t.strip().lower() for t in await check.locator(_OBJECT_ITEM).all_inner_texts()]
        finally:
            await check.close()
        if expected_total is not None and saved_total != expected_total:
            raise RobotError("patch_failed", f"После сохранения на карте {saved_total} точек, а должно быть {expected_total} — правки не сохранились")
        # Число точек одинаково и когда всё сохранилось, и когда ничего (−1 +1), поэтому сверяем и содержимое.
        for item in [*add, *change]:
            caption = (item.get("caption") or "").strip().lower()
            key = (item.get("desc") or "").strip()[:25].lower()
            prefix = f"({caption})" if caption else ""
            if not any(t.startswith(prefix) and key in t for t in saved_texts):
                raise RobotError("patch_failed", f"После сохранения на карте нет точки «{item.get('caption', '')}» с новым описанием — правки не сохранились")
        step("Готово — карта обновлена")
        return url

    return await _with_page(ctx, shot, run)


# ---------------------------------------------------------------- прочитать (ничего не меняет)

async def read_map(ctx: BrowserContext, *, map_id: str, step: Step, shot: Shot) -> list[str]:
    """Тексты точек карты так, как их показывает список слева («(ПОДПИСЬ) описание»). Карту не меняет и не сохраняет. Нужно приложению, когда оно не знает,
    что лежит на карте (ссылку вставили вручную): по текстам оно считает, что убрать, что поменять и что добавить, — и правит ЭТУ ЖЕ карту, а не создаёт новую."""
    async def run(page: Page) -> list[str]:
        await _open_map_in_editor(page, map_id, step)
        step("Читаю точки на карте…")
        texts = [" ".join(t.split()) for t in await page.locator(_OBJECT_ITEM).all_inner_texts()]
        step(f"Готово — на карте точек: {len(texts)}")
        return texts

    return await _with_page(ctx, shot, run)


# ---------------------------------------------------------------- удалить

async def delete_map(ctx: BrowserContext, *, map_id: str, step: Step, shot: Shot) -> bool:
    """True — карта удалена, False — её и так не было (удалена вручную)."""
    async def run(page: Page) -> bool:
        await _open_constructor(page, step)
        step("Ищу карту в списке…")
        row = await _find_map_row(page, map_id)
        if row is None:
            return False
        await row.scroll_into_view_if_needed()
        step("Удаляю карту…")
        await row.locator("button:visible").first.click(timeout=ACTION_TIMEOUT_MS)
        await page.locator(".menu__item:visible", has_text="Удалить").first.click(timeout=ACTION_TIMEOUT_MS)
        await settle(page, quiet=0.8, cap=60)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if not await page.locator(f'{_MAP_ROW}[data-index="constructor:{map_id}"]').count():
                step("Готово — карта удалена")
                return True
            await asyncio.sleep(0.5)
        raise RobotError("page_changed", "Карта осталась в списке после удаления (Яндекс изменил страницу?)")

    return await _with_page(ctx, shot, run)
