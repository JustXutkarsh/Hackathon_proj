const local = location.pathname === '/local' || location.pathname === '/local/';
document.querySelectorAll('.brand').forEach(a => a.href = local ? '/local' : '/');
if (local) {
  document.querySelector('.practice').insertAdjacentHTML('beforeend', '<a href="/">Shared plans</a>');
  await import('./app.js');
} else {
  await import('./shared.bundle.js');
}
