"""Ожидание загрузки страницы по СОСТОЯНИЮ, а не по времени.

Раньше робот в нескольких местах решал по часам («через 1,2 с кнопка «Войти» ещё видна — значит, не вошли», «20 секунд на открытие списка»), и на медленном
сервере или при задержке Яндекса это давало ложные ошибки (страница просто не успела прогрузиться). Теперь после каждого перехода и значимого действия робот ждёт,
пока страница действительно загрузилась: документ готов (readyState = complete) и сеть затихла (нет незавершённых запросов страницы, скриптов, стилей, данных) —
и лишь потом смотрит на кнопки. Верхний предел ожидания (SAFETY_CAP) — страховка от вечного зависания, а не расчёт времени: он большой.

Что не считается «страница ещё грузится»: счётчики и «маячки» (Метрика и т. п.), картинки и шрифты (плитки карты подгружаются бесконечно), долгие запросы,
висящие дольше LONG_POLL секунд (длинный опрос — страница ими не заблокирована)."""
from __future__ import annotations

import asyncio
import time

from playwright.async_api import Page

SAFETY_CAP = 180.0                 # секунд: предел ожидания одной загрузки (страховка), а не расчёт времени на операцию
ACTION_TIMEOUT_MS = 60000          # клик / ожидание элемента: ждём, пока он станет доступен (страница могла ещё грузиться)
LONG_POLL = 15.0                   # запрос дольше стольких секунд считаем длинным опросом и загрузку страницы им не задерживаем
_RELEVANT_TYPES = {"document", "script", "stylesheet", "xhr", "fetch"}
_NOISE = ("mc.yandex.", "/clck/", "an.yandex.", "yabs.yandex.", "adfox", "yandexadexchange", "favicon", "/watch/", "metrika")


class PageWatch:
    """Следит за запросами страницы: сколько их ещё не закончилось и когда последний раз что-то происходило."""

    def __init__(self, page: Page) -> None:
        self.pending: dict = {}
        self.last = time.monotonic()
        page.on("request", self._on_request)
        page.on("requestfinished", self._on_done)
        page.on("requestfailed", self._on_done)

    @staticmethod
    def _relevant(req) -> bool:
        try:
            if req.resource_type not in _RELEVANT_TYPES:
                return False
            url = req.url or ""
        except Exception:  # noqa: BLE001
            return False
        return not any(n in url for n in _NOISE)

    def _on_request(self, req) -> None:
        if self._relevant(req):
            self.pending[req] = time.monotonic()
            self.last = time.monotonic()

    def _on_done(self, req) -> None:
        if self.pending.pop(req, None) is not None:
            self.last = time.monotonic()

    def busy(self) -> int:
        now = time.monotonic()
        return sum(1 for t0 in self.pending.values() if now - t0 < LONG_POLL)

    def quiet_for(self) -> float:
        return time.monotonic() - self.last if not self.busy() else 0.0


def watch(page: Page) -> PageWatch:
    """Начать следить за страницей (вызывать сразу после создания, до перехода по адресу)."""
    w = getattr(page, "_lc_watch", None)
    if w is None:
        w = PageWatch(page)
        try:
            setattr(page, "_lc_watch", w)
        except Exception:  # noqa: BLE001
            pass
    return w


async def settle(page: Page, quiet: float = 0.8, cap: float = SAFETY_CAP) -> bool:
    """Дождаться, пока страница загрузилась: документ готов и сеть затихла не меньше чем на `quiet` секунд. True — дождались, False — вышли по страховке."""
    w = getattr(page, "_lc_watch", None)
    if w is None:
        try:
            await page.wait_for_load_state("networkidle", timeout=int(min(cap, 30) * 1000))
            return True
        except Exception:  # noqa: BLE001
            return False
    deadline = time.monotonic() + cap
    while True:
        try:
            ready = (await page.evaluate("document.readyState")) == "complete"
        except Exception:  # noqa: BLE001 — страница как раз переходит на другой адрес
            ready = False
        if ready and w.quiet_for() >= quiet:
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(0.2)
