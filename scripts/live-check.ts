/**
 * Checks Nikki against the REAL Claude API (the automated tests use scripted replies). Run it yourself:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run check:live
 *
 * It uses a throwaway database, makes about 7 model calls (a few cents), and prints only PASS/FAIL lines — never your
 * data or Nikki's replies. A FAIL means the real model did something the app's rules say it shouldn't, or that its
 * output couldn't be used.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first. (No key is stored by this script.)");
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nikki-live-"));
process.env.DATABASE_PATH = path.join(tmp, "nikki.db");

const { app } = await import("../server/index.js");
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
let n = 0;
let failed = 0;
const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", "x-workspace": "personal", "x-timezone": "Europe/London", "x-client-id": "live-check" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const chat = (text: string, kind = "chat") => api("POST", "/api/messages", { text, kind, clientRequestId: `live-${++n}-xxxxxxxx` });
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

try {
  let r = await chat("Add three tasks: call the bank, send the invoices and book flights to Dublin.");
  check("model call succeeds", r.status === 200, `HTTP ${r.status}: ${r.json?.error ?? ""}`);
  if (r.status !== 200) throw new Error("stopping: the first call to Claude failed, so the rest would only repeat the same error");
  let s = r.json.state;
  const titles = (s?.tasks ?? []).map((t: any) => t.title.toLowerCase());
  check("three tasks were created", ["bank", "invoice", "flight"].every((w) => titles.some((t: string) => t.includes(w))));
  check("no estimates were invented", (s?.tasks ?? []).every((t: any) => t.estimateMinutes === null));
  check("tasks are not scheduled (no plan, nothing on a block)", s?.plan === null);

  const bank = (s?.tasks ?? []).find((t: any) => t.title.toLowerCase().includes("bank"));
  r = await chat("Start working on calling the bank.");
  const receipts = r.json.state?.messages?.at(-1)?.meta?.receipts ?? [];
  check("'start' ran as a real action with an ok receipt", receipts.some((x: any) => x.ok) && r.json.state?.running?.taskId === bank?.id);
  await api("POST", `/api/tasks/${bank?.id}/timer`, { action: "stop" });

  r = await chat("Remind me tomorrow morning to follow up on the proposal.");
  s = r.json.state;
  check("a reminder was created for tomorrow, not a task", s?.reminders?.length === 1 && s.reminders[0].localDate === s.tomorrow.date && !s.tasks.some((t: any) => /follow up/i.test(t.title)));

  r = await chat("I'm considering starting another product.");
  s = r.json.state;
  check("an idea in discussion creates nothing", !s?.proposal && s?.projects?.length === 0 && s?.memory?.length === 0);

  r = await chat("I want to plan a project: launch a newsletter over the next six weeks, about five hours a week. Please propose milestones.");
  s = r.json.state;
  check("a project is proposed or clarified, never saved without confirmation", s?.projects?.length === 0 && (!!s?.proposal?.projectPlan || (s?.messages?.at(-1)?.meta?.questions?.length ?? 0) > 0));
  if (s?.proposal?.projectPlan) {
    const p = s.proposal.projectPlan;
    check("the proposed plan has milestones and is not flooding today", p.milestones.length >= 2 && p.tasks.length <= 12);
  }

  r = await chat("Weekly review", "weekly_review");
  check("weekly review returns text and the app's own counts", r.status === 200 && !!r.json.state?.messages?.at(-1)?.text && !!r.json.state?.messages?.at(-1)?.meta?.weekly);
} catch (e) {
  console.log(`FAIL  unexpected error: ${(e as Error).message}`);
  failed++;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll live checks passed.");
process.exit(failed ? 1 : 0);
