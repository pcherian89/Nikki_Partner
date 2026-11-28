# Phase 1, Stage 1A: connect Gmail and Calendar, read-only

Status (28 Nov 2026): built and tested on a development branch (`claude/nikki-phase-1a`) with a fake Google.
**Not deployed. No real Google account connected yet.** Production deploy waits for your approval.

## 1. Focused review (consolidated recommendation)

Perspectives used: executive assistant, chief of staff, security, Google platform, product/UX, cost.

- **Read first, act later.** 1A asks Google only for `gmail.readonly` and `calendar.readonly`. Drafts (1B) and
  sending (1D) ask for more only when those features exist and you approve.
- **Code before AI.** Look-ups ("show my latest emails", "what's on tomorrow?") are answered by the app itself:
  exact, instant, free, and no email text goes to an AI model. AI arrives in 1B for understanding and drafting.
- **One assistant, not new places to check.** Email answers appear in the existing chat; a simple Email tab appears
  only once Gmail is connected; Google events flow into Today/Tomorrow/Week like your iCal calendars.
- **Accounts and spaces.** Many accounts are supported from the start; each belongs to one space (Personal by
  default). Moving an account between spaces needs your password again. The confidential space can't hold accounts.
  Only personal `@gmail.com` accounts in Phase 1; organisation-managed accounts are refused by Google's own `hd` claim.
- **Each personal Google account needs its own small Google Cloud project** in Personal mode (Google's rule: a
  Personal-mode client works only for the account that created it). Setting one up takes about 5 minutes.
- **Recovery before credentials.** Nikki refuses to store a Google sign-in until a restore test has passed and an
  encrypted backup is on your Mac (see §4).

## 2. What Google's current documentation says (checked 28 Nov 2026)

| Topic | Finding | Effect on Nikki |
|---|---|---|
| Gmail MCP | `gmailmcp.googleapis.com/mcp/v1` (30 tools, incl. send/reply/forward with Google's own approval form) and `/mcp/v1self` (25 tools, no send/reply/forward). Streamable HTTP, OAuth bearer. | 1A uses `/mcp/v1self` and only 4 read tools. |
| Calendar MCP | `calendarmcp.googleapis.com/mcp/v1` (9 tools) and `/mcp/v1self` (8, no delete). | 1A uses 5 read tools. |
| Scopes | `gmail.readonly` is accepted by search_threads, get_thread, get_message, list_labels. `calendar.readonly` by list_events, get_event, search_events, list_calendars, suggest_time. | Smallest possible scopes. |
| Client | Must be marked "Use this client for an AI-powered agent". Personal-mode quick setup, no app verification. | Setup guide in operations.md §7. |
| Tokens | Access tokens last 1 hour; refresh tokens need `access_type=offline`. | Refresh token sealed; access tokens in memory only. |
| Approvals | Google asks for human approval via MCP "form elicitation" for actions such as sending. | 1A never triggers it. 1D will show Google's form. |
| Quota and price | Standard tier: 5,000 requests/day/project, free (since 24 Nov 2026). Paid Scaled tier is optional; billing from 1 Apr 2027 applies only if enrolled. | Nikki stops itself at 1,500/day per product. No paid tier. |
| AI Tools Addendum | AI agents must use Google's MCP servers; no keeping Google data after disconnecting; no model training on it; derived technical data (e.g. embeddings) at most 30 days. | MCP only; disconnect deletes Nikki's copies; no embeddings; chat email headers deleted after 30 days. |
| Schedule-send, attachment download | No MCP tool for either. | 1B/1D: "Save to Gmail, schedule it there"; attachments open in Gmail. |

**Open points (to confirm during the real-account test):** the Calendar MCP setup page still says "Developer
Preview" while Google's quota pages list it as generally available. If Google refuses Calendar for your account, the
existing iCal link keeps working and nothing else breaks. Personal-mode limits (one project per account, can't be
undone) come from earlier research and weren't on the pages re-read today.

## 3. What was built

- Google sign-in with PKCE, a single-use 10-minute state tied to your signed-in device, identity checks (right
  address, verified, personal, same account on reconnect, no duplicates) and granted-scope checks.
- Encrypted refresh token; reconnect and disconnect; one "sign in again" notification (deep link to Accounts).
- Read-only Gmail: search (plain words or Gmail syntax) and read a conversation as plain text, with Open in Gmail.
- Read-only Calendar: chosen calendars copied for the next month into Nikki's meetings, so plans work around them;
  cancelled/declined/free events skipped; all-day events shown in answers; repeating events expanded.
- iCal duplication handled: events Google already provides appear once; Nikki suggests unlinking the old link.
- Chat: email look-ups, schedule questions, "what can you access?" with source and freshness on every answer.
- Screens: Context → Accounts (add flow with safety checks, status, calendars, permissions, Google requests today),
  the Email tab (only when Gmail is connected), chat cards.
- Database v8, additive only (new tables `oauth_states`, `google_events`, `provider_calls`; new account columns).
  A pre-upgrade copy is taken automatically, as before.

## 4. Backup and recovery (§24)

- Railway volume backups: the Backups tab exists on the service; whether your plan includes them isn't confirmed.
- Nightly encrypted backups (02:30, 14 kept) are **on the same volume**, so they don't survive losing the volume.
  They include the sealed Google token, which is useless without the key.
- New: each backup is test-restored straight after it's made; connecting Google requires a passed restore test and
  a backup downloaded to your Mac in the last 7 days (no paid service).
- Key: only in Railway and your Apple Passwords. Without it no backup opens.
- Restore: `scripts/restore-backup.ts` (operations.md §2). The JSON export is your planning data only, not a full
  backup.
- Google tokens never need restoring: after a restore you reconnect in one minute.

## 5. Tests

| Kind | Status |
|---|---|
| Automated (171, incl. 15 new for 1A) | ✓ all pass |
| Mocked Google (fake OAuth + MCP, SSE and JSON replies) | ✓ connect, wrong account, managed account, expired, cancelled, reused state, refresh failure, reconnect, disconnect, read-only allowlist, chat answers, calendar conversion, iCal dedupe |
| Screens on phone, tablet, laptop (fake data) | ✓ screenshots |
| Real Google provider | ✗ not yet (needs your Google Cloud setup) |
| Real account (your Gmail) | ✗ not yet. Gmail features are not claimed to work until tested with your account |
| Real iPhone ("sign in again" notification) | ✗ not yet |
| Phase 0 leftover: reminder notification opens Today | ✗ still to test on your iPhone |

## 6. Costs

Stage 1A uses no AI credit: look-ups are answered in code. Google: free Standard tier. Railway: unchanged.

## 7. What's left for 1A

1. Your approval of the screens, then deploy to production (database v7 → v8, additive).
2. Google Cloud setup (operations.md §7), one step at a time.
3. Real-account tests: connect, latest emails, search by person and subject, open a conversation, today's and
   tomorrow's schedule, disconnect and reconnect, check nothing changed in Gmail.
