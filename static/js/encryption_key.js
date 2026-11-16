// «Настройки → 🔑 Ключ шифрования…» (только администратор): состояние шифрования ФИО, телефонов персонала, логинов и паролей комплексов,
// показ ключа для резервной копии и установка ключа другого сервера (после восстановления его копии базы). Бэкенд — app/api/routes_encryption.py.
// modal, $, esc, Api, btn*, fieldCls, labelCls — из ui.js.
async function openEncryptionKey() {
  let data;
  try { data = await Api.get('/api/encryption'); }
  catch (e) { alert('Не удалось получить состояние шифрования: ' + e.message); return; }

  const FIELD_NAMES = { 'people.full_name': 'ФИО персонала', 'people.phone': 'Телефоны персонала', 'points.login': 'Логины комплексов', 'points.password': 'Пароли комплексов' };
  const paint = (d) => {
    const rows = d.fields.map((f) => {
      const bad = f.plain || f.unreadable || !f.converted;
      return `<tr><td class="py-1 pr-3">${esc(FIELD_NAMES[f.field] || f.field)}</td>
        <td class="py-1 pr-3 text-emerald-300">${f.encrypted}</td>
        <td class="py-1 pr-3 ${f.plain ? 'text-rose-300' : 'text-slate-400'}">${f.plain}</td>
        <td class="py-1 ${f.unreadable ? 'text-rose-300' : 'text-slate-400'}">${f.unreadable}</td>
        ${bad ? '<td class="py-1 pl-3 text-rose-300">⚠</td>' : '<td class="py-1 pl-3 text-emerald-300">✓</td>'}</tr>`;
    }).join('');
    $('#encBody').innerHTML = `
      <div class="rounded-xl border ${d.ok && !d.failures ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-rose-500/30 bg-rose-500/10'} p-3 text-sm">
        ${d.ok && !d.failures ? '✅ Всё зашифровано и читается нашим ключом.' : '⚠ Есть значения, которые не зашифрованы или не читаются этим ключом — см. таблицу.'}
        ${d.failures ? `<div class="text-xs mt-1">Сбоев расшифровки с запуска: ${d.failures}. Чаще всего — в базу восстановлена копия с другого сервера: поставьте его ключ ниже.</div>` : ''}
      </div>
      <table class="text-xs w-full"><thead class="text-slate-400"><tr><th class="text-left font-normal">Поле</th><th class="text-left font-normal">Зашифровано</th><th class="text-left font-normal">Открытым текстом</th><th class="text-left font-normal">Не читается</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="text-xs text-slate-400">Ключ: ${esc(d.key_source)} · отпечаток <b class="text-slate-200">${esc(d.fingerprint)}</b> (на сервере и в запасной копии должен совпадать).</div>
      <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 space-y-1">
        <div><b>Сохраните ключ отдельно от сервера</b> (в менеджере паролей, на флешке). Он не входит в копию базы: если сервер потеряется, а ключа не будет, зашифрованные ФИО, телефоны, логины и пароли восстановить нельзя.</div>
        <div>Копия базы («Копия») без ключа не читается — это и есть защита: пересланный файл базы не раскрывает логины и пароли.</div>
      </div>
      <label class="${labelCls}">Пароль администратора (нужен, чтобы показать или поменять ключ)<input id="encPw" type="password" autocomplete="current-password" class="${fieldCls}"></label>
      <label class="${labelCls}">Ключ другого сервера (только для «Установить»)<input id="encNewKey" type="text" autocomplete="off" spellcheck="false" class="${fieldCls}" placeholder="43 знака" ${d.key_in_env ? 'disabled' : ''}></label>
      <div class="flex flex-wrap gap-2">
        <button type="button" id="encShow" class="${btnGhost}">Показать ключ</button>
        <button type="button" id="encApply" class="${btnGhost}" ${d.key_in_env ? 'disabled title="Ключ задан переменной FIELD_ENCRYPTION_KEY в .env — меняется там"' : ''}>Установить ключ другого сервера</button>
      </div>
      <div id="encOut" class="text-xs text-slate-300" style="white-space:pre-wrap;word-break:break-all"></div>`;
    $('#encShow').onclick = showKey;
    $('#encApply').onclick = applyKey;
  };

  const showKey = async () => {
    const password = $('#encPw').value;
    const out = $('#encOut');
    if (!password) { out.textContent = '⚠ Введите пароль администратора.'; return; }
    try {
      const r = await Api.post('/api/encryption/key/show', { password });
      out.innerHTML = `<div class="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-2">
        <div>Ключ шифрования (отпечаток ${esc(r.fingerprint)}):</div>
        <div id="encKeyText" class="font-mono text-sm text-slate-100 select-all">${esc(r.key)}</div>
        <div class="flex gap-2"><button type="button" id="encCopy" class="${btnGhost}">Скопировать</button>
          <button type="button" id="encSave" class="${btnGhost}">Сохранить в файл</button></div></div>`;
      $('#encCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.key); $('#encCopy').textContent = 'Скопировано ✓'; } catch { selectText($('#encKeyText')); } };
      $('#encSave').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([r.key + '\n'], { type: 'text/plain' }));
        a.download = `lan-calendar-field-key-${r.fingerprint}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
    } catch (e) { out.textContent = '⚠ ' + e.message; }
  };
  const selectText = (el) => { const range = document.createRange(); range.selectNodeContents(el); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); };

  const applyKey = async () => {
    const key = $('#encNewKey').value.trim(), password = $('#encPw').value;
    if (!key || !password) { $('#encOut').textContent = '⚠ Введите ключ и пароль администратора.'; return; }
    try { paint(await Api.post('/api/encryption/key/apply', { key, password })); $('#encOut').textContent = '✓ Ключ установлен. Прежний сохранён в папке данных (.field_key.old-…).'; }
    catch (e) { $('#encOut').textContent = '⚠ ' + e.message; }
  };

  modal(`<h2 class="font-display text-lg font-bold mb-1">🔑 Ключ шифрования</h2>
    <p class="text-xs text-slate-400 mb-3">ФИО и телефоны персонала, логины и пароли комплексов хранятся в базе только в зашифрованном виде (AES-256) и расшифровываются сервером при показе — тем ролям, которым это положено.</p>
    <div id="encBody" class="space-y-3"></div>
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`, { wide: true });
  paint(data);
}
