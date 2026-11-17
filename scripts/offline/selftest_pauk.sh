#!/usr/bin/env bash
# Автоматические проверки параллельной установки «Паук» (подключается из install_pauk.sh).

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

st_db_counts_file() {
  local db_host_path="$1"
  [ -f "$db_host_path" ] || return 0
  local db_dir db_name
  db_dir="$(cd "$(dirname "$db_host_path")" && pwd)"
  db_name="$(basename "$db_host_path")"
  docker run --rm -e DB_NAME="$db_name" -v "$db_dir:/db:ro" pauk:latest node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync("/db/" + process.env.DB_NAME, { readOnly: true });
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

st_pauk_counts() {
  docker exec -i pauk-app node --no-warnings -e '
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
    echo "ИТОГ: «Паук» развёрнут успешно, замечаний нет."
    return 0
  fi
  echo "ИТОГ: ошибок=$ST_FAIL, предупреждений=$ST_WARN"
  if [ -n "$ST_FIXES" ]; then
    echo "Что проверить:"
    printf '%b' "$ST_FIXES"
  fi
  [ "$ST_FAIL" -eq 0 ]
}

st_selftest_pauk() {
  local project="$1" https_port="$2" app_port="$3" baseline_counts="${4:-}" old_running="${5:-}"
  echo
  echo "Проверки параллельной копии «Паук» ($project):"

  local c
  for c in pauk-app pauk-caddy; do
    if st_container_running "$c"; then
      st_ok "контейнер $c запущен"
    else
      st_bad "контейнер $c не запущен ($(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo 'нет'))" \
        "sudo docker logs --tail 50 $c ; затем: cd $project/docker && sudo docker compose -p pauk -f docker-compose.pauk.yml up -d pauk-app pauk-caddy"
    fi
  done

  if [ -n "$old_running" ]; then
    for c in $old_running; do
      if st_container_running "$c"; then
        st_ok "старая система ($c) продолжает работать без перерыва"
      else
        st_warn "контейнер старой системы $c сейчас остановлен" "проверьте sudo docker ps -a"
      fi
    done
  fi

  local code
  code="$(st_http "http://127.0.0.1:${app_port}/login")"
  if [ "$code" = "200" ]; then
    st_ok "«Паук» отвечает локально на 127.0.0.1:${app_port} (код 200)"
  else
    st_bad "«Паук» не отвечает на 127.0.0.1:${app_port} (код $code)" "sudo docker logs --tail 80 pauk-app"
  fi

  code="$(st_http "https://127.0.0.1:${https_port}/login")"
  case "$code" in
    200|301|302|303|307|308) st_ok "отдельный HTTPS-порт ${https_port} через pauk-caddy работает (код $code)" ;;
    *) st_bad "pauk-caddy не ответил по HTTPS на 127.0.0.1:${https_port} (код $code)" "sudo docker logs --tail 50 pauk-caddy" ;;
  esac

  if [ -f "${HERE:-.}/CODE.sha256" ]; then
    local mism
    mism="$(docker exec -i pauk-app sh -c 'cd /app && sha256sum -c --quiet -' < "$HERE/CODE.sha256" 2>&1 | head -4 | tr '\n' ';' || true)"
    if [ -z "$mism" ]; then
      st_ok "в контейнере pauk-app работает актуальный код пакета ($(cat "$HERE/BUILD" 2>/dev/null))"
    else
      st_bad "в контейнере pauk-app не совпадает код: $mism" "перезапустите контейнер pauk-app"
    fi
  fi

  local db
  db="$(docker exec -i pauk-app node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/app/data/calendar.db");
    for (const fn of ["lc_dec_pfn", "lc_dec_pph", "lc_dec_plg", "lc_dec_ppw"]) {
      db.function(fn, { deterministic: true }, (v) => v ?? "");
    }
    const ok = db.prepare("PRAGMA integrity_check").get().integrity_check === "ok";
    console.log(ok ? "OK" : "BAD");
  ' 2>/dev/null || true)"
  case "$db" in
    OK*) st_ok "база данных «Паук» цела (integrity_check=ok)" ;;
    *) st_bad "проблема с базой данных «Паук»: ${db:-не удалось проверить}" "проверьте $project/data/calendar.db" ;;
  esac

  if [ -n "$baseline_counts" ]; then
    local after t b a lost=""
    after="$(st_pauk_counts)"
    for t in users people points crews tasks task_visit_reports equipment; do
      b="$(echo "$baseline_counts" | tr ' ' '\n' | sed -n "s/^$t=//p")"
      a="$(echo "$after" | tr ' ' '\n' | sed -n "s/^$t=//p")"
      if [ -n "$b" ] && [ -n "$a" ] && [ "$b" != "-1" ] && [ "$a" -lt "$b" ]; then
        lost="$lost $t: было $b, стало $a;"
      fi
    done
    if [ -z "$lost" ]; then
      st_ok "все записи из базы перенесены без потерь ($after)"
    else
      st_bad "в базе «Паук» меньше записей, чем в исходной:$lost" "проверьте копию в $project/backups/"
    fi
  fi

  if st_container_running pauk-robot; then
    local rob
    rob="$(docker exec -i pauk-app node --no-warnings -e '
      const fs = require("fs");
      const url = (process.env.YANDEX_ROBOT_URL || "http://pauk-robot:8100").replace(/\/+$/, "");
      let key = (process.env.YANDEX_ROBOT_API_KEY || "").trim();
      if (!key && fs.existsSync("/app/data/robot/.robot_api_key")) key = fs.readFileSync("/app/data/robot/.robot_api_key", "utf8").trim();
      const headers = key ? { "X-Robot-Key": key } : {};
      (async () => {
        try {
          const r = await fetch(url + "/status", { headers, signal: AbortSignal.timeout(15000) });
          console.log(r.ok ? "STATUS_OK" : "STATUS_BAD " + r.status);
        } catch (e) { console.log("STATUS_ERR " + e.message); }
      })();
    ' 2>/dev/null || true)"
    case "$rob" in
      *STATUS_OK*) st_ok "браузерный робот pauk-robot (Chromium) запущен и доступен из «Паук»" ;;
      *) st_warn "pauk-robot запущен, но ещё инициализируется ($rob)" "sudo docker logs --tail 40 pauk-robot" ;;
    esac
  fi

  return 0
}
