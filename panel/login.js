const form = $("loginForm");
const submit = $("loginSubmit");
const password = form.elements.password;
$("showPassword").addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  $("showPassword").setAttribute(
    "aria-label",
    show ? "Скрыть пароль" : "Показать пароль",
  );
  $("showPassword").setAttribute("aria-pressed", String(show));
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  $("loginError").textContent = "";
  submit.disabled = true;
  submit.querySelector("span").textContent = "Входим…";
  try {
    await request("/api/v2/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: form.elements.login.value,
        password: password.value,
      }),
    });
    password.value = "";
    location.replace("/panel/");
  } catch (error) {
    $("loginError").textContent = humanError(error);
    password.focus();
    submit.disabled = false;
    submit.querySelector("span").textContent = "Войти";
  }
});
request("/api/v2/admin/session")
  .then(() => location.replace("/panel/"))
  .catch((error) => {
    if (error.status !== 401) $("loginError").textContent = humanError(error);
  });
