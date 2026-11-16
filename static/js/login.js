const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');
const submitBtn = document.getElementById('loginSubmit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Входим…';
  const username = form.elements.username.value;
  const password = form.elements.password.value;
  try {
    // Deliberately NOT Api.post() — that helper redirects to /login on any
    // 401, which is correct for "your session expired" on every other
    // page, but wrong here: a login attempt's own 401 ("неверный пароль")
    // would trigger that same redirect, reloading this very page and
    // wiping the username the user just typed before they even saw why it
    // failed.
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = (payload && payload.detail) || res.statusText;
      throw new Error(typeof detail === 'string' ? detail : 'Не удалось войти');
    }
    // Fetch-based submission doesn't reliably trigger the browser's own
    // "save password?" prompt everywhere — Chrome/Edge respond well to the
    // Credential Management API below; Firefox/Safari instead lean on
    // their own form-detection heuristics, helped by loginForm's action/
    // method/autocomplete attributes in login.html (present even though JS
    // intercepts the actual submit).
    if (window.PasswordCredential) {
      try { await navigator.credentials.store(new PasswordCredential({ id: username, password, name: username })); }
      catch (e) { /* not fatal — saving the password is a nice-to-have */ }
    }
    // Проверяем, что браузер действительно сохранил cookie сессии: иначе вход
    // «успешен», а страница сразу возвращает обратно на экран входа без
    // объяснений (так бывало, когда cookie была помечена Secure, а сайт открыт
    // по обычному http://).
    const check = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (check.status === 401) {
      throw new Error('Вход выполнен, но браузер не сохранил сессию (cookie). Откройте сайт по тому адресу, который указан у администратора, или проверьте, что cookie не заблокированы.');
    }
    window.location.href = '/';
  } catch (err) {
    errorBox.textContent = err.message || 'Не удалось войти';
    errorBox.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Войти';
    // Логин остаётся как есть — неверным обычно оказывается пароль, не
    // номер учётки; перепечатывать логин заново не нужно, только пароль.
    form.elements.password.value = '';
    form.elements.password.focus();
  }
});
