# Phase 0 report (27 Nov 2026)

Phase 0 adds the safety foundations that every later connector (Gmail, Calendar, Drive and others) will rely on. It
connects **no** outside accounts. Existing planning, chat, tasks, reminders, calendar feeds, design and data are
unchanged.

- Architecture and module map: [architecture.md](architecture.md)
- Setup, backups, rollback and recovery for the owner: [operations.md](operations.md)

## What changed

| Area | Before | After Phase 0 |
| --- | --- | --- |
| Sign-in | One shared cookie | A session per device, signed out remotely; rate limits and lockout; optional two-step sign-in (TOTP + 8 recovery codes); password re-check for sensitive steps |
| Web security | Basic | Strict security headers and CSP, same-origin check on every change, SSRF guard on calendar links |
| Secrets | Plain text in the database | Sealed with AES-256-GCM using a key held only in Railway (`NIKKI_ENCRYPTION_KEY`), rotatable |
| Approvals | None | Inbox with proposals bound to the exact parameters; editing clears approval; important actions need the password again and expire after 1 hour; no carry-over to another day |
| Background work | Reminder timer only | Persistent job runner with leases, IST schedules, retries with backoff, catch-up after restarts |
| Outcome safety | n/a | Actions interrupted mid-run become **uncertain** and wait for the user; never retried blindly |
| AI spend | Not tracked | Every AI call metered; $5/month budget (configurable); alerts at 50/75/90/100%; agent AI pauses when the budget or credit runs out. The planner keeps its model (Opus 5.5) |
| Notifications | Push for reminders | Notification centre with history, bell and app badge, per-category settings, quiet hours (22:00 to 07:00 India time), private previews, Declarative Web Push |
| Agents | None | One engine: profiles, code collectors, optional AI with a permission gateway. Agents start disabled; only the user can widen their permissions |
| Spaces | None | Personal, Revivo, Avagama, Consulting, Other, Government (confidential, off, never sent to AI) |
| Emergency | None | One switch stops all agents and actions; planning and chat keep working |
| Backups | Railway only | Encrypted nightly backup (02:30 India time, 14 kept), pre-upgrade copy, encrypted download after a password check |
| Audit | None | Append-only activity log (ids only, no message content) |

Database: schema v7, **additive only** (new tables, nothing removed or rewritten). A copy is taken before the upgrade.

## Security

- No credential ever passes through chat. The only secret Phase 0 needs is the encryption key, created on the owner's
  Mac and pasted straight into Railway Variables (see operations.md, Steps 1 and 2).
- Without the key, Nikki still runs, but refuses to store account tokens and skips encrypted backups, and says so in
  Context → Security and devices.
- Permissions are enforced in code by the tool gateway, never by AI instructions. AI-made or system-made agent profiles
  start disabled.
- Data sent to AI is wrapped as untrusted data so instructions inside it are treated as content.

## Reliability

- Jobs and actions survive restarts: leases expire, missed runs catch up once (or are skipped if more than 30 minutes
  late, where that is safer), and graceful shutdown on redeploy.
- Each action executes at most once (conditional claim). Idempotency keys stop duplicate requests from Nikki; they do
  not guarantee an outside provider will never repeat an effect, so unknown outcomes are marked uncertain.

## AI spend

| Figure | Value |
| --- | --- |
| Measured baseline (last 30 days, Claude Console) | $1.09; 283,313 input and 18,957 output tokens; Opus 5.5 |
| Credit remaining at review | $0.64 (top-up needed before agents use AI) |
| Phase 0 budget | $5.00 a month, $1.00 a day for agents (both editable in Context) |
| Phase 0 added AI use | None by default: the example agent is code-only and disabled |

Spend shown in Nikki is Nikki's own measurement from token counts and list prices, not Anthropic's invoice. Nikki never
buys credit or enables auto top-up.

## QA

- `npm test`: 146 of 146 pass (120 existing, unchanged, plus 26 new for sign-in, vault, approvals, jobs, budget,
  notifications, spaces, agents and backups).
- `npm run typecheck` and `npm run build` pass.
- Screens checked on phone (390px), tablet (820px) and laptop (1440px) with no layout overflow and no CSP console errors.

### Not yet verified

- **Real iPhone push** (including badge and deep links): only verified once the owner's test reaches the lock screen.
- Behaviour on the live Railway deployment: this branch has not been deployed.

## Known limitations

- Calendar links are checked before each fetch, but DNS rebinding between check and connect is not fully prevented.
- Passkeys are deferred; two-step sign-in uses TOTP.
- Sign-in rate limits are held in memory and reset on redeploy.
- Failed AI calls are recorded at $0.
- The planning export still includes calendar feed links (unchanged from before; treat exports as private).

## Next steps

1. Owner review of the screens and this report.
2. Owner steps in operations.md (encryption key, Railway volume backups, sign in again, optional two-step sign-in,
   iPhone notification test).
3. Deploy after approval; confirm on the live address.
4. Phase 1 (Google, read-only first) only after separate approval.
