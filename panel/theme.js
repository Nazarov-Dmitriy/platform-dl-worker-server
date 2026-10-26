(() => {
  const key = "worker.theme";
  const media = matchMedia("(prefers-color-scheme: dark)");
  const choices = ["light", "dark", "system"];
  let preference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (choices.includes(saved)) preference = saved;
  } catch {}
  function apply() {
    document.documentElement.dataset.theme =
      preference === "system" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.themePreference = preference;
    document.querySelectorAll("[data-theme-control]").forEach((select) => {
      select.value = preference;
    });
  }
  apply();
  media.addEventListener("change", () => {
    if (preference === "system") apply();
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.querySelectorAll("[data-theme-control]").forEach((select) =>
      select.addEventListener("change", () => {
        preference = choices.includes(select.value) ? select.value : "system";
        try {
          localStorage.setItem(key, preference);
        } catch {}
        apply();
      }),
    );
  });
})();
