const $ = (id) => document.getElementById(id);
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  monitor:
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  box: '<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7 5.8l9 5"/>',
  settings:
    '<path d="m10 3-1 3-3 1-3-1-1 4 2 2-1 3 3 3 3-1 3 2 3-2 3 1 3-3-1-3 2-2-1-4-3 1-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  logout: '<path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 13h8M8 17h5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
}
document.querySelectorAll("[data-icon]").forEach((element) => {
  element.innerHTML = icon(element.dataset.icon);
});
const errorCopy = {
  INVALID_CREDENTIALS: "Проверьте логин и пароль.",
  UNAUTHORIZED: "Проверьте логин и пароль.",
  FORBIDDEN: "У вас нет доступа к этому действию.",
  LOGIN_IN_USE: "Этот логин уже занят.",
  INVALID_ACCOUNT:
    "Проверьте данные аккаунта. Пароль должен содержать минимум 12 символов.",
  INVALID_REQUEST: "Проверьте заполненные поля.",
  CSRF_REJECTED: "Обновите страницу и повторите действие.",
  RATE_LIMITED: "Слишком много попыток. Подождите немного.",
};
function humanError(error) {
  return error.status === 401
    ? "Проверьте логин и пароль."
    : errorCopy[error.code] ||
        (error.name === "TypeError"
          ? "Не удалось связаться с сервером. Проверьте подключение."
          : "Не удалось выполнить действие. Повторите попытку.");
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
  });
  const data =
    response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.code || String(response.status));
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}
