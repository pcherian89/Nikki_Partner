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

Context → **Send a test through the inbox**. Only mark notifications as working after the test reaches your lock
screen. Nikki itself only counts a device as verified when the device confirms it showed the test.

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

- **Context → Safety switch → Stop all agents and actions**: everything automatic stops at once; planning and chat
  still work. Resume each part separately.
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
