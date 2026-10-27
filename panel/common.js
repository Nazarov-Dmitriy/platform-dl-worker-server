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
    '<path d="M19.00,12.00L18.94,12.91L20.69,14.33L20.31,15.44L18.06,15.50L17.55,16.26L16.95,16.95L16.26,17.55L16.50,19.79L15.44,20.31L13.81,18.76L12.91,18.94L12.00,19.00L11.09,18.94L9.67,20.69L8.56,20.31L8.50,18.06L7.74,17.55L7.05,16.95L6.45,16.26L4.21,16.50L3.69,15.44L5.24,13.81L5.06,12.91L5.00,12.00L5.06,11.09L3.31,9.67L3.69,8.56L5.94,8.50L6.45,7.74L7.05,7.05L7.74,6.45L7.50,4.21L8.56,3.69L10.19,5.24L11.09,5.06L12.00,5.00L12.91,5.06L14.33,3.31L15.44,3.69L15.50,5.94L16.26,6.45L16.95,7.05L17.55,7.74L19.79,7.50L20.31,8.56L18.76,10.19L18.94,11.09Z"/><circle cx="12" cy="12" r="3"/>',
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
  SITE_BUSY: "У сайта есть незавершённые задания. Завершите или отмените их перед удалением.",
  DEVICE_BUSY:
    "Устройство выполняет задание. Дождитесь завершения и повторите удаление.",
  REVISION_CONFLICT:
    "Запись изменилась. Обновите список и повторите действие.",
  PRECONDITION_REQUIRED: "Обновите список и повторите действие.",
  NOT_FOUND: "Объект уже удалён или недоступен. Обновите список.",
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

// Download inside the already opened HTTPS page, with a visible fetch error.
// This endpoint is public; no account/session credential is sent with the request.
document.querySelectorAll('a[download="device-ca.crt"]').forEach((link) => {
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    if (link.getAttribute("aria-busy") === "true") return;
    link.setAttribute("aria-busy", "true");
    let status = document.getElementById("certificateDownloadStatus");
    if (!status) {
      status = document.createElement("p");
      status.id = "certificateDownloadStatus";
      status.className = "download-status";
      status.setAttribute("role", "status");
      document.body.append(status);
    }
    status.hidden = false;
    status.textContent = "Получаем сертификат…";
    try {
      const response = await fetch("/device-ca.crt", {
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Certificate unavailable");
      const certificate = await response.text();
      if (
        !certificate.startsWith("-----BEGIN CERTIFICATE-----") ||
        certificate.includes("PRIVATE KEY") ||
        certificate.length > 65536
      ) {
        throw new Error("Invalid public certificate");
      }
      const url = URL.createObjectURL(
        new Blob([certificate], { type: "application/x-x509-ca-cert" }),
      );
      const download = document.createElement("a");
      download.href = url;
      download.download = "device-ca.crt";
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status.textContent = "Сертификат подготовлен к скачиванию.";
    } catch {
      status.textContent =
        "Не удалось получить сертификат. Проверьте подключение и повторите скачивание.";
    } finally {
      link.removeAttribute("aria-busy");
    }
  });
});
