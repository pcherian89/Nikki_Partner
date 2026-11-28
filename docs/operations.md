# Running Nikki safely: setup, backups, rollback and recovery

Plain-language steps for the owner. Nothing here needs code. Updated with Phase 0 (27 Nov 2026).

## 1. One-time setup after Phase 0 goes live

Do these in order. Each takes a few minutes. Nothing here costs money.

### Step 1. Create the encryption key (on your Mac, not in chat)

Why: Nikki now encrypts its secrets (the push-notification signing key, two-step sign-in, and later your Google
tokens) and its nightly backups. The key that does this must live only on the server.

1. On your Mac, open **Terminal** (Spotlight → "Terminal").
2. Type `openssl rand -base64 32` and press Return. It prints one line of 44 characters ending in `=`.
3. Copy that line. Do not paste it anywhere except the next step (not in chat, email, Notes or GitHub).

### Step 2. Put the key into Railway

1. Open Railway → your Nikki project → the Nikki service → **Variables**.
2. **New Variable**: name `NIKKI_ENCRYPTION_KEY`, value: paste the line. Save.
3. Railway redeploys by itself. When it is done, open Nikki → **Context → Security and devices**. It should say
   "Encryption key: set (fingerprint xxxxxxxx)". The fingerprint is safe to share; the key is not.
4. Also keep a copy of the key in **Apple Passwords** (a new password entry called "Nikki encryption key"). Without
   it, encrypted backups can never be opened.

### Step 3. Turn on Railway's own volume backups

Why: Nikki's nightly backups sit on the same disk as the database. Railway's backups protect against losing the disk.

1. Railway → Nikki service → the **Volume** (`/data`) → **Backups**.
2. Turn on **Daily** and **Weekly** schedules. Railway charges these like ordinary volume storage; for Nikki's small
   database that is a few cents a month at most.

### Step 4. Sign in again on each device

The old sign-in cookie is no longer accepted (each device now has its own session you can sign out remotely). Open
Nikki on your iPhone, iPad and Mac once and sign in with your usual password.

### Step 5 (optional, recommended). Two-step sign-in

Context → Security and devices → **Turn on two-step sign-in**. On iPhone, tap **Add to Passwords**, then type the
6-digit code. Save the 8 recovery codes in Apple Passwords. From then on, sign-in asks for the password and the code.

### Step 6. Check notifications on your iPhone

On your iPhone, open Nikki from the Home Screen → **Context → Reminders & notifications → Turn on notifications**,
then **Send a test**. Only treat notifications as working after the test reaches your lock screen. Nikki only counts a
device as verified when the device confirms it showed the test. The test goes to the device only and never appears in
your inbox.

## 2. Backups

| Layer | What | Where | Kept |
| --- | --- | --- | --- |
| Pre-upgrade copy | Automatic copy before any database layout change | `/data/nikki.db.v6-before-v7-….bak` | last 5 |
| Nightly encrypted backup | Whole personal database, encrypted (AES-256-GCM) | `/data/backups/nikki-YYYY-MM-DD.db.enc` | 14 days |
| Railway volume backups | The whole volume | Railway | per Railway schedule |
| Your export | Planning data as a file | Context → Data → Export | as long as you keep it |

Nightly backups run at 02:30 India time and need the encryption key. **Back up now** and **download (encrypted)**
are in Context → Security and devices (download asks for your password again).

### Restoring an encrypted backup

On a computer with this repository and Node installed:

```bash
NIKKI_ENCRYPTION_KEY='the key from Apple Passwords' npx tsx scripts/restore-backup.ts nikki-2026-11-27.db.enc restored.db
```

Then in Railway: upload/replace using the steps in "Rolling back data" below (never overwrite `nikki.db` while running).

## 3. Rolling back

### Rolling back the code

Railway → **Deployments** → the last good deployment → **⋯ → Redeploy**. Phase 0 only **adds** tables, so older
code still runs on the upgraded database.

If you roll back to a version from **before Phase 0** after setting the encryption key, run this once in Railway →
service → **Console** so the older version can still send notifications:

```bash
npx tsx scripts/unseal-for-rollback.ts
```

You will also need to sign in again (older versions use the old cookie).

### Rolling back data

1. Railway Console: `ls -l /data /data/backups`.
2. Copy the one you want to a new name, never over the live file:
   `cp /data/nikki.db.v6-before-v7-….bak /data/nikki-restored.db`
3. Variables: `DATABASE_PATH=/data/nikki-restored.db`. Nikki restarts on the copy. To undo, set it back to
   `/data/nikki.db`.

## 4. Emergency switches

- **Context → Agent controls → Stop all agents and actions**: everything automatic stops at once, including an agent
  that is part-way through; planning, tasks, reminders and chat still work. **Resume** turns it back on. Anything you
  approved that became due while stopped is not run: it comes back to Inbox → To review for you to confirm again.
  Something already done outside Nikki can't be undone by this switch.
- **Signed-in devices → Sign out everywhere else**: if a device is lost.
- Lost every two-step device and recovery code: Railway Variables → `NIKKI_DISABLE_2FA=1`, sign in with your
  password, turn two-step sign-in off, then delete the variable.
- API credit runs out: Nikki pauses agent AI and tells you. Add credit in the Claude Console (Billing), then
  **Resume AI**. Nikki never buys credit or enables auto top-up.

## 5. Changing the encryption key (once a year, or if it may have leaked)

1. Create a new key (Step 1).
2. Railway Variables: set `NIKKI_ENCRYPTION_KEY_PREVIOUS` = the old key, `NIKKI_ENCRYPTION_KEY` = the new key.
3. After the redeploy, Nikki re-encrypts stored secrets with the new key on start.
4. Keep the old key while you still have backups made with it (14 days), then delete `NIKKI_ENCRYPTION_KEY_PREVIOUS`.

## 6. Deploying Phase 0 to production (only after your approval)

### How to see which branch Railway deploys

Railway → your Nikki project → the Nikki service → **Settings** → **Source**. It shows the GitHub repository and the
**branch** it deploys (and whether automatic deploys are on). The **Deployments** tab also shows the branch and commit
for each deployment. Phase 0's pull request targets `claude/loving-ptolemy-xty07b`; if Source shows a different
branch, tell Claude before anything is merged.

### Checklist

1. **Production branch.** Confirm it in Settings → Source (above).
2. **Database and volume.** Settings → Variables: `DATABASE_PATH` should point into the volume (normally
   `/data/nikki.db`). The service's **Volume** tab should show a volume mounted at `/data`.
3. **Backup and rollback ready.** Volume → Backups → **Back up now**, and note the current deployment in Deployments
   (that is the one to redeploy if needed).
4. **Encryption key.** Create it on your Mac and add `NIKKI_ENCRYPTION_KEY` (section 1, Steps 1 and 2). Save a copy
   in Apple Passwords.
5. **Secrets present.** Variables should list `APP_PASSWORD`, `ANTHROPIC_API_KEY` and `NIKKI_ENCRYPTION_KEY`. Check
   the names only; never paste the values anywhere.
6. **Migration safety.** Phase 0 only adds tables and columns. Nikki copies the database to
   `/data/nikki.db.v6-before-v7-….bak` before upgrading.
7. **Merge only after your approval.** You approve; then the pull request is marked ready and merged into the
   production branch. Railway deploys automatically.
8. **Health check.** Open `https://<your Nikki address>/api/health`. It should say `"ok":true`. Deployments should show
   the new deployment as Active with no crash logs.
9. **Your data.** Sign in, then check Today, Everything, your tasks, reminders and calendar feeds are as before.
   Context → AI usage should show $0.00 "Measured by Nikki since <today>", and Inbox should be empty.
10. **Sign-in and sessions.** Sign in on iPhone, iPad and Mac. Context → Security and devices → Signed-in devices should
    list each. Optionally turn on two-step sign-in.
11. **iPhone test.** Section 1, Step 6. Tell Claude whether the test reached your lock screen.

### If something goes wrong

1. Deployments → the previous good deployment → **⋯ → Redeploy** (section 3). The database keeps working with the
   older code.
2. If data looks wrong, restore from the pre-upgrade copy or a Railway volume backup (section 3, Rolling back data).
3. Context → Agent controls → **Stop** at any time; it does not affect planning or your data.
