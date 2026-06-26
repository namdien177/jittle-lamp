(function () {
  var saved = localStorage.getItem("jl-theme");
  var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = saved || "system";
  applyTheme(theme);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (getStoredTheme() === "system") applyTheme("system");
  });

  function getStoredTheme() { return localStorage.getItem("jl-theme") || "system"; }
  window.getStoredTheme = getStoredTheme;

  window.setTheme = function (t) {
    localStorage.setItem("jl-theme", t);
    applyTheme(t);
    document.querySelectorAll(".theme-option").forEach(function (el) {
      el.classList.toggle("selected", el.dataset.theme === t);
    });
  };

  function applyTheme(t) {
    var isDark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  }

  window.toggleTheme = function () {
    var current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "light" : "dark");
  };
})();
