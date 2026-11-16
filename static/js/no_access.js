// Страница «Нет доступа»: роли не доступен ни один раздел — можно только выйти.
document.getElementById('noAccessLogout').onclick = async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* выход всё равно продолжается */ }
  window.location.href = '/login';
};
