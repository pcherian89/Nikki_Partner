import { FormEvent, useState } from "react";
import { api } from "../api";
import { Avatar } from "./Avatar";

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("POST", "/api/auth/login", { password: pw });
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-screen">
      <Avatar size={96} glow />
      <h1 className="h2">Nikki Partner</h1>
      <form className="login card" onSubmit={submit}>
        <label className="field">
          <span>Password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        {err && <p className="error-text">{err}</p>}
        <button className="btn primary" disabled={busy || !pw}>
          {busy ? "Checking…" : "Open"}
        </button>
      </form>
    </div>
  );
}
