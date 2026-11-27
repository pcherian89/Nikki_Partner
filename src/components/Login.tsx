import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import { Avatar } from "./Avatar";

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("POST", "/api/auth/login", { password: pw, ...(needCode ? { code } : {}) });
      onDone();
    } catch (e2) {
      if ((e2 as ApiError).code === "totp_required") setNeedCode(true);
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-screen">
      <Avatar size={96} glow />
      <h1 className="h2">Nikki</h1>
      <form className="login card" onSubmit={submit}>
        <label className="field">
          <span>Password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        {needCode && (
          <label className="field">
            <span>6-digit code (or a recovery code)</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus />
          </label>
        )}
        {err && <p className="error-text">{err}</p>}
        <button className="btn primary" disabled={busy || !pw}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
