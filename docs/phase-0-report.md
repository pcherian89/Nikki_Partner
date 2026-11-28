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
| Phase 0 budget | $5.00 a month for all of Nikki's AI; $0.25 a day for background agents (both editable in Context → AI usage → Manage budget) |
| Phase 0 added AI use | None by default: the example agent is code-only and disabled |

Spend shown in Nikki is Nikki's own measurement from token counts and list prices, not Anthropic's invoice. Nikki never
buys credit or enables auto top-up.

## QA

- `npm test`: 156 of 156 pass (120 existing, unchanged; 26 Phase 0; 10 added in the pre-deployment review).
- `npm run typecheck` and `npm run build` pass.
- Screens checked on phone (390px), tablet (820px) and laptop (1440px) with no layout overflow and no CSP console errors.

### Not yet verified

- **Real iPhone push** (including badge and deep links): only verified once the owner's test reaches the lock screen.
- Behaviour on the live Railway deployment: this branch has not been deployed.

## Known limitations

- Calendar links are checked before each fetch, but DNS rebinding between check and connect is not fully prevented.
- Passkeys are deferred; two-step sign-in uses TOTP.
- Sign-in rate limits are held in memory and reset on redeploy.
- Failed AI calls are recorded at $0 and counted as "not measured" calls.
- Haiku 5.5's cache-read price is not published; Nikki assumes 0.1× the input price.
- "Today" and "this month" follow the time zone Nikki has on record for you (India time by default).
- The planning export still includes calendar feed links (unchanged from before; treat exports as private).

## Pre-deployment review (28 Nov 2026)

A review of Phase 0 from the owner's side (daily use on phone, tablet and laptop) and from engineering, security, QA
and operations. Identity, dark theme and green accents are unchanged; nothing was removed.

### Findings and what was done

| # | Finding | Severity | Done |
| --- | --- | --- | --- |
| 1 | Every approval button said "Approve exactly this" whatever it did | High (clarity) | Each kind of item names its action: **Create task**, **Add reminder**, **Show it**. Future kinds (Save draft, Send email, Add event) declare their own label. The exact-parameter check behind the button is unchanged |
| 2 | Inbox cards repeated the title in the detail, gave no reason and no consequence | High | Cards show: what (task, reminder) and which agent suggested it, the item, when (e.g. "Saturday, 28 November · 9:00 AM", India time), **Why**, and **what happens** ("It only reminds you: nothing is paid, booked or sent") |
| 3 | Approvals, notifications and history were mixed in one list | Medium | Three tabs with counts: **To review**, **Updates** (filter by category, grouped repeats, mark all read), **History** |
| 4 | Only Approve / Reject | Medium | **Edit** (changes the item; any earlier approval is void and the new version must be confirmed), **Later** (in 3 hours / tomorrow 9 AM; never past expiry), **Dismiss**; approved-and-scheduled items can be cancelled |
| 5 | Risk of double confirmation | Medium | Verified in code and by a test: requests you make in chat use the existing Confirm/Undo and never reach the inbox. The inbox is for agents' suggestions and (later) anything leaving Nikki |
| 6 | "Send a test" in the inbox put test items into the real inbox | High | Removed from the server and the screen. The device push test stays under Reminders & notifications and writes nothing to the inbox |
| 7 | A sign-in alert on every sign-in | Medium | Alerts only for a browser not seen in 90 days, at most one per device per day; the first-ever sign-in makes none. Kept as a high-priority security item |
| 8 | $2.95 "spent" on the AI Usage screen | High (trust) | Explained below: sample data in the screenshot copy only |
| 9 | AI usage screen was technical | Medium | Overview first (Today, This month, Left this month, a bar, status); breakdown under **Where it went**; settings under **Manage budget**. States the date measurement started and points to the Claude Console for the actual bill and remaining credit |
| 10 | $1.00 daily agent limit was 20% of the month | Medium | Lowered to **$0.25** a day (agents only). A Sonnet morning briefing costs about $0.05 and sorting 40 emails on Haiku about $0.01, so a normal day fits; a runaway agent can use at most 5% of the month in a day |
| 11 | No warning in chat near the limit | Medium | A banner above the chat from 90%, and a choice for when the month is used up: planning chat **keeps working (counted)** or **pauses until next month** |
| 12 | Haiku 5.5 long prompts under-priced | Low | Over 100K prompt tokens the whole call is priced at $0.50 / $2.50 |
| 13 | "Safety switch" hid what it does | High | Renamed **Agent controls**: on/stopped, agents switched on, running now, waiting for approval, scheduled, AI available; one red **Stop all agents and actions**; "What Stop does" explains every case |
| 14 | Stop only took effect between runs | High | A running agent now stops before its next model call or tool call |
| 15 | Items approved before a stop could run on resume | High | Approving is refused while stopped. On resume, anything approved that became due goes back to "To review" and you're told once. Future scheduled items keep their time and still face the normal approval expiry |
| 16 | Security settings were a long flat list | Low | A short status list, with signed-in devices, two-step sign-in, backups and activity log in sections that open on tap |
| 17 | Lock-screen settings were split from notifications | Low | Moved into Reminders & notifications ("What reaches your lock screen") |

### The $2.95 on the earlier screenshots

It was **sample data**, not spending. To show the AI Usage screen, three usage records were written into a separate
practice database in the review workspace (never the live one). One of them used the token counts from the Claude
Console (283,313 in, 18,957 out) priced at list rates with no caching: 283,313 × $4/M + 18,957 × $20/M = $1.51. The
other two added $1.44. Your real figures: the Console's $1.09 for 30 days is lower than $1.51 because part of the
input was served from Anthropic's cache at a tenth of the price.

Checked: model ids and prices (Opus 5.5 $4 / $20 per million, cache read $0.20, cache write $5; Sonnet 5.5 $2 / $10;
Haiku 5.5 $0.10 / $0.50, $0.50 / $2.50 over 100K); `input_tokens` excludes cached tokens, which are priced
separately; costs are US dollars; each call is recorded once (failed calls at $0 and marked "not measured"; no retries
of model calls); months and days follow India time. Production starts at $0.00: nothing is back-filled and no sample
records exist outside the test and screenshot databases. The screen says "Measured by Nikki since <date>".

| Figure | Where it comes from | Shown in Nikki as |
| --- | --- | --- |
| Actual spend and remaining credit | Claude Console (Usage, Billing) | A pointer to the Console. Nikki does not hold an admin key, so it cannot read these |
| Nikki-measured spend | Token counts on each API response × list price | Today, This month, Left this month |
| Estimates | Reservations made before an agent call (worst case) | Not shown as spend; released after the call |
| Limits | Your settings | $5.00 / month, $0.25 / day for agents |

### Security assessment

| Area | Result |
| --- | --- |
| Sessions and cookies | Random token per device, only its hash stored; HttpOnly, SameSite=Strict, Secure on HTTPS; 30-day sliding expiry; remote sign-out; tested |
| Sign-in protection | Rate limits and lockout; optional two-step sign-in; password re-check for sensitive steps; new-device alerts deduplicated |
| Encryption | AES-256-GCM, key only in Railway; rotation supported; losing the key makes encrypted backups unreadable, so a copy in Apple Passwords is required |
| Credential readiness | No outside account connected; tokens are refused without the key |
| Spaces and permissions | Enforced on the server by the tool gateway; AI-made agent settings start off; Government space off and never sent to AI |
| Approval integrity | Bound to a hash of the exact item; edit voids it; expiry (1 hour for consequential, 24 hours otherwise); no approving while stopped; resume asks again |
| Emergency stop, jobs | Persistent across restarts; leases stop double runs; interrupted outside actions become "uncertain", never retried |
| Budget | Agents reserve the worst case before calling and stop before exceeding the month or day |
| Prompt injection | Stored and outside data reaches AI wrapped as untrusted data; tools are an allow-list checked in code |
| Logging | Activity log stores ids and kinds, not content; append-only |
| Backup and restore | Encrypted nightly, 14 kept, copy before every schema upgrade; restore steps in operations.md |
| Migrations | Additive only (two new nullable columns this review); older code still runs on the upgraded database |
| Test isolation | Tests use throwaway temporary databases; screenshots used a separate practice database; the test-notification route is gone. Fixtures cannot reach production |
| External actions | None exist in Phase 0. The three action kinds (task, reminder, in-app note) stay inside Nikki |

### Test results (28 Nov 2026)

`npm test` 156 of 156 pass; `npm run typecheck` and `npm run build` pass. New tests cover: wording on inbox items;
edit voids an approval; "Later" hides an item until its time and never past expiry; no approving while stopped and no
running on resume; stop inside a running agent; cost maths including cache and Haiku long prompts; budget defaults,
start date and no back-fill; only agents can create inbox items; the test-notification route is gone; sign-in alerts.
Screens rechecked on phone, tablet and laptop: no console errors, no horizontal overflow.

**Verified:** everything above, on a local copy. **Not verified until you test:** iPhone push (lock screen, badge,
tapping through), behaviour on the live Railway service, and Railway volume backups.

### Readiness

Ready for your review of the screens. After your approval, deploy by following the checklist in operations.md
section 6. Phase 1 needs its own approval.

## Next steps

1. Owner review of the screens and this report.
2. Owner steps in operations.md (encryption key, Railway volume backups, sign in again, optional two-step sign-in,
   iPhone notification test).
3. Deploy after approval; confirm on the live address.
4. Phase 1 (Google, read-only first) only after separate approval.
