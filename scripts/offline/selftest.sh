#!/usr/bin/env bash
# Автоматические проверки после офлайн-обновления (подключается из install_app.sh и install_robot.sh).

ST_FAIL=0
ST_WARN=0
ST_FIXES=""

st_ok()   { echo "  [OK]   $1"; }
st_warn() { echo "  [WARN] $1"; ST_WARN=$((ST_WARN + 1)); [ -z "${2:-}" ] || ST_FIXES="${ST_FIXES}  • $1:\n      $2\n"; }
st_bad()  { echo "  [FAIL] $1"; ST_FAIL=$((ST_FAIL + 1)); [ -z "${2:-}" ] || ST_FIXES="${ST_FIXES}  • $1:\n      $2\n"; }

st_http() {
  curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo 000
}

st_container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

st_snapshot_counts() {
  docker exec -i lan-calendar node -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync("/app/data/calendar.db", { readOnly: true });
      for (const fn of ["lc_dec_pfn", "lc_dec_pph", "lc_dec_plg", "lc_dec_ppw"]) {
        db.function(fn, { deterministic: true }, (v) => v ?? "");
      }
      const tables = ["users","people","points","crews","tasks","task_visit_reports","equipment"];
      const out = tables.map((t) => {
        try { return t + "=" + db.prepare("SELECT count(*) c FROM " + t).get().c; }
        catch { return t + "=-1"; }
      });
      console.log(out.join(" "));
    } catch {}
  ' 2>/dev/null || true
}

st_report() {
  echo
  if [ "$ST_FAIL" -eq 0 ] && [ "$ST_WARN" -eq 0 ]; then
    echo "ИТОГ: всё в порядке, замечаний нет."
    return 0
  fi
  echo "ИТОГ: ошибок=$ST_FAIL, предупреждений=$ST_WARN"
  if [ -n "$ST_FIXES" ]; then
    echo "Что проверить:"
    printf '%b' "$ST_FIXES"
  fi
  [ "$ST_FAIL" -eq 0 ]
}

st_selftest_app() {
  local project="$1" since="$2" before="${3:-}" backup="${4:-}"
  echo
  echo "Проверки приложения:"
  local c
  for c in lan-calendar codd-bot lan-calendar-caddy; do
    if st_container_running "$c"; then
      st_ok "контейнер $c запущен"
    else
      st_bad "контейнер $c не запущен ($(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo 'нет'))" \
        "sudo docker logs --tail 50 $c ; затем: cd $project/docker && sudo docker compose up -d lan-calendar codd-bot"
    fi
  done

  local code
  code="$(st_http http://127.0.0.1:3000/login)"
  if [ "$code" = "200" ]; then
    st_ok "приложение отвечает на 127.0.0.1:3000 (код 200)"
  else
    st_bad "приложение не отвечает на 127.0.0.1:3000 (код $code)" "sudo docker logs --tail 80 lan-calendar"
  fi

  code="$(st_http https://127.0.0.1/login)"
  case "$code" in
    200|301|302|303|307|308) st_ok "HTTPS через Caddy работает (код $code)" ;;
    *) st_warn "Caddy не ответил по HTTPS на 127.0.0.1 (код $code)" "sudo docker logs --tail 50 lan-calendar-caddy" ;;
  esac

  if [ -f "${HERE:-.}/CODE.sha256" ]; then
    local mism
    mism="$(docker exec -i lan-calendar sh -c 'cd /app && sha256sum -c --quiet -' < "$HERE/CODE.sha256" 2>&1 | head -4 | tr '\n' ';' || true)"
    if [ -z "$mism" ]; then
      st_ok "в контейнере работает код этого пакета (сборка $(cat "$HERE/BUILD" 2>/dev/null))"
    else
      st_bad "в контейнере не совпадает код: $mism" "cd $project/docker && sudo docker compose up -d --force-recreate --no-build lan-calendar codd-bot"
    fi
  fi

  local db
  db="$(docker exec -i lan-calendar node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/app/data/calendar.db");
    for (const fn of ["lc_dec_pfn", "lc_dec_pph", "lc_dec_plg", "lc_dec_ppw"]) {
      db.function(fn, { deterministic: true }, (v) => v ?? "");
    }
    const problems = [];
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") problems.push("целостность базы нарушена");
    console.log(problems.length ? problems.join("; ") : "OK");
  ' 2>/dev/null || true)"
  case "$db" in
    OK*) st_ok "база данных в порядке (integrity_check=ok)" ;;
    *) st_bad "база данных: ${db:-не удалось проверить}" "откатите версию и проверьте $backup" ;;
  esac

  if [ -n "$before" ]; then
    local after t b a lost=""
    after="$(st_snapshot_counts)"
    for t in users people points crews tasks task_visit_reports equipment; do
      b="$(echo "$before" | tr ' ' '\n' | sed -n "s/^$t=//p")"
      a="$(echo "$after" | tr ' ' '\n' | sed -n "s/^$t=//p")"
      if [ -n "$b" ] && [ -n "$a" ] && [ "$b" != "-1" ] && [ "$a" -lt "$b" ]; then
        lost="$lost $t: было $b, стало $a;"
      fi
    done
    if [ -z "$lost" ]; then st_ok "данные на месте (число записей не уменьшилось)"
    else st_bad "после обновления записей стало меньше:$lost" "проверьте резервную копию $backup"; fi
  fi

  code="$(st_http http://127.0.0.1:3000/api/equipment/meta)"
  if [ "$code" = "401" ]; then st_ok "склад закрыт без входа (код 401)"
  else st_bad "раздел склада не закрыт без входа (код $code)" "проверить auth middleware"; fi

  code="$(st_http 'http://127.0.0.1:3000/api/bot/equipment/held?vk_id=1')"
  if [ "$code" = "401" ]; then st_ok "API бота закрыт без ключа (код 401)"
  else st_bad "API бота не закрыт без ключа (код $code)" "проверить auth middleware"; fi

  if [ -n "$backup" ]; then
    if [ -s "$backup" ]; then st_ok "копия базы перед обновлением создана ($backup)"
    else st_bad "копия базы перед обновлением не создана" "sudo cp $project/data/calendar.db $project/backups/manual.db"; fi
  fi
  return 0
}

st_selftest_robot() {
  local project="$1"
  echo
  echo "Проверки робота карт:"
  if st_container_running yandex-robot; then st_ok "контейнер yandex-robot запущен"
  else st_bad "контейнер yandex-robot не запущен" "sudo docker logs --tail 50 yandex-robot"; fi
  if ! st_container_running lan-calendar; then
    st_bad "приложение (lan-calendar) не запущено" "сначала запустите lan-calendar"
    return
  fi
  local out
  out="$(docker exec -i lan-calendar node -e '
    const fs = require("fs");
    const url = (process.env.YANDEX_ROBOT_URL || "http://yandex-robot:8100").replace(/\/+$/, "");
    let key = (process.env.YANDEX_ROBOT_API_KEY || "").trim();
    if (!key && fs.existsSync("/app/data/robot/.robot_api_key")) key = fs.readFileSync("/app/data/robot/.robot_api_key", "utf8").trim();
    const headers = key ? { "X-Robot-Key": key } : {};
    (async () => {
      try {
        const r = await fetch(url + "/status", { headers, signal: AbortSignal.timeout(30000) });
        if (!r.ok) { console.log("STATUS_BAD " + r.status); return; }
        const j = await r.json();
        console.log("STATUS_OK " + (j.chrome || ""));
      } catch (e) { console.log("STATUS_ERR " + e.message); }
    })();
  ' 2>&1 || true)"
  case "$out" in
    *STATUS_OK*) st_ok "приложение видит робота Яндекса" ;;
    *STATUS_BAD\ 401*) st_bad "ключ робота не совпал с ключом приложения" "перезапустить yandex-robot" ;;
    *STATUS_BAD*) st_bad "робот ответил ошибкой: $out" "sudo docker logs --tail 80 yandex-robot" ;;
    *) st_bad "приложение не достучалось до робота ($out)" "sudo docker logs --tail 50 yandex-robot" ;;
  esac
  return 0
}
