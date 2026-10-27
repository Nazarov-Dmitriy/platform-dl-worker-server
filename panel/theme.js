(() => {
  const key = "worker.theme";
  const choices = ["light", "dark"];
  let preference = "light";
  try {
    const saved = localStorage.getItem(key);
    if (choices.includes(saved)) preference = saved;
    else if (saved === "system") {
      // Keep the former appearance once; future changes are chosen explicitly.
      preference = matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    localStorage.setItem(key, preference);
  } catch {}
  function apply() {
    document.documentElement.dataset.theme = preference;
    document.documentElement.dataset.themePreference = preference;
    document.querySelectorAll("[data-theme-control]").forEach((select) => {
      select.value = preference;
    });
  }
  apply();
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.querySelectorAll("[data-theme-control]").forEach((select) =>
      select.addEventListener("change", () => {
        preference = choices.includes(select.value) ? select.value : "light";
        try {
          localStorage.setItem(key, preference);
        } catch {}
        apply();
      }),
    );
  });
})();
