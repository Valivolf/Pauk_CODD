"""Сценарии Яндекс Форм под отдельным аккаунтом (профиль «forms» браузера робота) — то же, что делает человек:

* проверить вход: открыть список форм (forms.yandex.ru/admin) — без входа Яндекс перекидывает на страницу входа;
* выгрузить таблицу ответов: страница «Ответы» формы → кнопка «XLSX с доп.полями» → формат XLSX → «Скачать».
  Файл с ответами приходит как обычная загрузка браузера; робот отдаёт его байты приложению, а оно разбирает строки так же,
  как таблицу, загруженную вручную (отчёты по комплексам, фото).

Селекторы — по ВИДИМЫМ подписям кнопок (так они описаны в справке Яндекс Форм), а не по классам: подписи меняются реже вёрстки.
Если Яндекс поменяет страницу, ломается только этот файл, а при сбое робот сохраняет снимок страницы (виден в окне календаря).
Файлы-вложения ответов (фото) открываются только создателю формы — поэтому для форм нужен свой вход в аккаунт создателя.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path
from typing import Callable, Optional

from playwright.async_api import BrowserContext, Download, Page

from pagewait import ACTION_TIMEOUT_MS, SAFETY_CAP, settle, watch

FORMS_HOME = os.environ.get("ROBOT_FORMS_URL", "https://forms.yandex.ru/admin/")
FORMS_BUSINESS_HOME = os.environ.get("ROBOT_FORMS_BUSINESS_URL", "https://forms.yandex.ru/cloud/admin/")    # «Формы для бизнеса» — там формы организации


CAPTCHA_TEXT = ("Яндекс показывает проверку «Вы не робот» (запросы с сервера он считает автоматическими). Пройдите её один раз в браузере робота: "
                "«Настройки → Яндекс Формы: вход и автозагрузка» → «Проверить скачивание» → «Пройти проверку в браузере робота»")


def is_captcha(url: str) -> bool:
    return "showcaptcha" in (url or "").lower()


class FormsError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def needs_login(url: str) -> bool:
    """Яндекс перекинул на страницу входа (или на проверку «Вы не робот»)."""
    u = (url or "").lower()
    return "passport." in u or "/auth" in u.split("?")[0] or "showcaptcha" in u


async def _settle(page: Page, seconds: float = SAFETY_CAP) -> None:
    """Дождаться, пока страница действительно загрузилась (документ готов и сеть затихла) — по состоянию, а не по времени; seconds — лишь страховка от зависания."""
    await settle(page, quiet=1.0, cap=seconds)


async def _wait_found(find, seconds: float = 90.0):
    """Ждёт, пока `find()` (async) что-нибудь найдёт: кнопки на странице Яндекса появляются, когда она дорисована; None — не появилось за seconds уже загруженной страницы."""
    deadline = time.monotonic() + seconds
    while True:
        found = await find()
        if found is not None or time.monotonic() >= deadline:
            return found
        await asyncio.sleep(0.4)


async def is_logged_in(ctx: BrowserContext) -> tuple[bool, str]:
    page = await ctx.new_page()
    watch(page)
    try:
        for home in (FORMS_BUSINESS_HOME, FORMS_HOME):        # сначала формы организации (как у большинства), потом личные
            await page.goto(home, wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
            await _settle(page)
            if is_captcha(page.url):
                return False, CAPTCHA_TEXT
            if not needs_login(page.url):
                return True, ""
        return False, "Вход в Яндекс для Форм не выполнен"
    except Exception as exc:  # noqa: BLE001
        return False, f"Не удалось открыть Яндекс Формы ({type(exc).__name__}): проверьте, что с сервера открыт forms.yandex.ru"
    finally:
        await page.close()


async def _first_visible(locator, limit: int = 8):
    """Первый видимый элемент из найденных (на странице бывают скрытые копии кнопок)."""
    try:
        count = min(await locator.count(), limit)
    except Exception:  # noqa: BLE001
        return None
    for i in range(count):
        item = locator.nth(i)
        try:
            if await item.is_visible():
                return item
        except Exception:  # noqa: BLE001
            continue
    return None


async def _last_visible(locator, limit: int = 12):
    """Последний видимый элемент: окно «Параметры файла» добавляется в конец страницы, и его кнопка «Скачать» идёт после кнопки «Скачать» вверху."""
    try:
        count = min(await locator.count(), limit)
    except Exception:  # noqa: BLE001
        return None
    for i in range(count - 1, -1, -1):
        item = locator.nth(i)
        try:
            if await item.is_visible():
                return item
        except Exception:  # noqa: BLE001
            continue
    return None


async def _export_button(page: Page):
    """Кнопка, открывающая выгрузку. Настоящая страница «Ответы» (проверено в браузере владельца): кнопка «Скачать» справа над таблицей; в прежней
    вёрстке она называлась «XLSX с доп.полями»."""
    for locator in (
        page.get_by_role("button", name=re.compile(r"^\s*скачать\s*$", re.I)),
        page.get_by_role("button", name=re.compile(r"(xlsx|csv|json).*(доп|поля)|доп.*поля", re.I)),
        page.get_by_text(re.compile(r"XLSX\s*с\s*доп", re.I)),
        page.get_by_role("button", name=re.compile(r"скачать|выгрузить|экспорт", re.I)),
    ):
        found = await _first_visible(locator)
        if found is not None:
            return found
    return None


async def export_answers(ctx: BrowserContext, url: str, *, shot_path: Optional[Path] = None, step: Callable[[str], None] = lambda s: None) -> bytes:
    """Скачивает таблицу ответов формы (.xlsx). url — страница «Ответы» формы (адрес из браузера)."""
    page = await ctx.new_page()
    watch(page)
    page.set_default_timeout(ACTION_TIMEOUT_MS)
    loop = asyncio.get_running_loop()
    got: "asyncio.Future[Download]" = loop.create_future()
    page.on("download", lambda d: got.done() or got.set_result(d))

    async def snapshot() -> None:
        if shot_path is None:
            return
        try:
            shot_path.parent.mkdir(parents=True, exist_ok=True)
            shot_path.write_bytes(await page.screenshot(type="jpeg", quality=70, timeout=ACTION_TIMEOUT_MS))
        except Exception:  # noqa: BLE001
            pass

    async def wait_download(seconds: float) -> Optional[Download]:
        try:
            return await asyncio.wait_for(asyncio.shield(got), timeout=seconds)
        except asyncio.TimeoutError:
            return None

    try:
        step("Открываю страницу ответов формы…")
        await page.goto(url, wait_until="domcontentloaded", timeout=ACTION_TIMEOUT_MS)
        await _settle(page)
        if is_captcha(page.url):
            await snapshot()
            raise FormsError("captcha", CAPTCHA_TEXT)
        if needs_login(page.url):
            await snapshot()
            raise FormsError("not_logged_in", "Вход в Яндекс для Форм не выполнен (или нужна проверка «Вы не робот») — «Настройки → Яндекс Формы: вход и автозагрузка»")
        step("Ищу кнопку выгрузки ответов…")
        btn = await _wait_found(lambda: _export_button(page))                   # страница загружена, но кнопка дорисовывается — ждём её появления
        if btn is None:
            await snapshot()
            raise FormsError("page_changed", "На странице ответов нет кнопки выгрузки «XLSX с доп.полями». Проверьте адрес страницы (вкладка «Ответы» формы) "
                                              "и что аккаунт — создатель формы; если страница другая — Яндекс мог изменить вёрстку")
        step("Выбираю формат XLSX…")
        await btn.click()
        await _settle(page, 60)
        d = await wait_download(1.0)                                      # у части вёрсток кнопка скачивает сразу
        if d is None:
            for locator in (
                page.get_by_role("option", name=re.compile(r"^\s*xlsx\s*$", re.I)),
                page.get_by_role("menuitem", name=re.compile(r"^\s*xlsx\s*$", re.I)),
                page.get_by_role("radio", name=re.compile(r"xlsx", re.I)),
                page.get_by_text(re.compile(r"^\s*XLSX\s*$")),
            ):
                opt = await _first_visible(locator)
                if opt is not None:
                    try:
                        await opt.click(timeout=ACTION_TIMEOUT_MS)
                    except Exception:  # noqa: BLE001 — формат по умолчанию и так XLSX
                        pass
                    break
            await _settle(page, 60)
            d = await wait_download(1.0)
        if d is None:
            step("Скачиваю…")
            async def find_down():
                found = await _last_visible(page.get_by_role("button", name=re.compile(r"^\s*скачать\s*$", re.I)))
                return found if found is not None else await _last_visible(page.get_by_text(re.compile(r"^\s*Скачать\s*$")))

            down = await _wait_found(find_down, 60.0)                       # окно «Параметры файла» открывается не мгновенно
            if down is None:
                await snapshot()
                raise FormsError("page_changed", "После выбора формата не нашлась кнопка «Скачать» — Яндекс мог изменить вёрстку страницы ответов")
            await down.click()
            d = await wait_download(SAFETY_CAP)                             # Яндекс собирает файл столько, сколько нужно (большие формы — долго)
        if d is None:
            await snapshot()
            raise FormsError("timeout", "Яндекс так и не отдал файл с ответами (форма очень большая или ответы в архиве — повторите позже)")
        path = await d.path()
        data = Path(path).read_bytes() if path else b""
        if not data.startswith(b"PK"):
            await snapshot()
            raise FormsError("bad_file", "Яндекс отдал не таблицу Excel (.xlsx) — проверьте формат выгрузки в форме")
        return data
    except FormsError:
        raise
    except Exception as exc:  # noqa: BLE001
        await snapshot()
        kind = "timeout" if "Timeout" in type(exc).__name__ else "page_changed"
        raise FormsError(kind, f"Не удалось выгрузить ответы формы ({type(exc).__name__}): {str(exc).splitlines()[0][:200] if str(exc) else ''}")
    finally:
        try:
            await page.close()
        except Exception:  # noqa: BLE001
            pass


def now() -> float:
    return time.time()
