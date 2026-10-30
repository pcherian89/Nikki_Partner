export type ThemeChoice = "dark" | "light" | "auto";
const KEY = "nikki.theme";

export function getThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "auto" ? v : "dark";
  } catch {
    return "dark";
  }
}

const resolve = (c: ThemeChoice) => (c === "auto" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : c);

export function applyTheme(c: ThemeChoice) {
  const t = resolve(c);
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#F2F5EC" : "#0B0F0C");
}

export function setThemeChoice(c: ThemeChoice) {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* storage unavailable: the choice lasts until the page closes */
  }
  applyTheme(c);
}

/** In Auto, follow the phone when it switches between light and dark. */
export function watchSystemTheme() {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const on = () => getThemeChoice() === "auto" && applyTheme("auto");
  mq.addEventListener?.("change", on);
  return () => mq.removeEventListener?.("change", on);
}
