import { useState } from "react";
import { getThemeChoice, setThemeChoice, type ThemeChoice } from "../theme";

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "auto", label: "Auto" },
];

/** Light, dark, or follow the phone. Saved on this device. */
export function AppearanceCard() {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice());
  return (
    <section className="card" aria-label="Appearance">
      <h2 className="h3">Appearance</h2>
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={choice === o.value}
            className={choice === o.value ? "active" : ""}
            onClick={() => {
              setChoice(o.value);
              setThemeChoice(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="muted small">Auto follows your phone’s light or dark setting. Saved on this device.</p>
    </section>
  );
}

/** One-tap switch in the top bar. */
export function ThemeQuickToggle() {
  const [, force] = useState(0);
  const light = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light";
  return (
    <button
      className="theme-quick"
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      title={light ? "Dark mode" : "Light mode"}
      onClick={() => {
        setThemeChoice(light ? "dark" : "light");
        force((n) => n + 1);
      }}
    >
      {light ? "☾" : "☀"}
    </button>
  );
}
