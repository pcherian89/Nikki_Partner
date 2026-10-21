import webpush from "web-push";
import type { NotificationStatus, Reminder } from "../shared/types.js";
import { clockIso, DB, getSetting, setSetting } from "./db.js";
import { UserFacingError } from "./errors.js";
import type { Deliver } from "./reminders.js";

/**
 * Web Push: notifications to devices that opted in, even when Nikki is closed. Free (the browser vendor's push
 * service carries it) and needs no account. It is NOT assumed to work: a device only counts as "verified" after it
 * has actually received a test and told the server so (the service worker acknowledges every push it shows).
 */

type Sender = (sub: webpush.PushSubscription, payload: string, opts: webpush.RequestOptions) => Promise<{ statusCode: number }>;
let sender: Sender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);

/** For tests: replace the network call. */
export function setPushSender(fn: Sender | null) {
  sender = fn ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
}

function keys(db: DB): { publicKey: string; privateKey: string } {
  const get = (k: string) => (db.prepare("SELECT value FROM secrets WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  let publicKey = get("vapid_public");
  let privateKey = get("vapid_private");
  if (!publicKey || !privateKey) {
    const k = webpush.generateVAPIDKeys();
    publicKey = k.publicKey;
    privateKey = k.privateKey;
    db.prepare("INSERT OR REPLACE INTO secrets (key, value) VALUES ('vapid_public', ?), ('vapid_private', ?)").run(publicKey, privateKey);
  }
  return { publicKey, privateKey };
}

export const vapidPublicKey = (db: DB) => keys(db).publicKey;

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function subscribe(db: DB, sub: BrowserSubscription, clientId: string | null) {
  if (!/^https:\/\//.test(sub.endpoint)) throw new UserFacingError("That isn't a valid push address.", 400, "invalid");
  db.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, client_id, created_at, failures) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, client_id = excluded.client_id, failures = 0",
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, clientId, clockIso());
}

export function unsubscribe(db: DB, endpoint: string) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function pushStatus(db: DB, clientId: string | null): NotificationStatus {
  const subs = (db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN client_id = ? THEN 1 ELSE 0 END) AS mine FROM push_subscriptions").get(clientId ?? "") as { n: number; mine: number | null });
  const lastTestAt = getSetting(db, "push_last_test_at");
  const lastAckAt = getSetting(db, "push_last_ack_at");
  return {
    pushAvailable: true,
    subscriptions: subs.n,
    thisDevice: (subs.mine ?? 0) > 0,
    verified: !!lastTestAt && !!lastAckAt && lastAckAt >= lastTestAt,
    lastTestAt,
    lastAckAt,
  };
}

/** Sends to every subscribed device. Returns how many the push service accepted. Dead subscriptions are removed. */
export async function sendPush(db: DB, payload: Record<string, unknown>, urgency: "high" | "normal" = "high"): Promise<number> {
  const k = keys(db);
  const subs = db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as { endpoint: string; p256dh: string; auth: string }[];
  let accepted = 0;
  const details = { vapidDetails: { subject: process.env.VAPID_SUBJECT || "mailto:nikki@example.com", publicKey: k.publicKey, privateKey: k.privateKey } };
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency, ...details });
      accepted++;
      db.prepare("UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?").run(clockIso(), s.endpoint);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
      else {
        db.prepare("UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?").run(s.endpoint);
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND failures >= 5").run(s.endpoint);
      }
    }
  }
  return accepted;
}

/** Used by the reminder loop: a push for a due reminder. Records "push" only if at least one device accepted it. */
export const deliverByPush =
  (db: DB): Deliver =>
  async (r: Reminder) => {
    const n = await sendPush(db, { kind: "reminder", id: r.id, title: "Reminder", body: r.title, tag: r.id });
    return n > 0 ? ["push"] : [];
  };

/** Sends a test notification. It counts as verified only when the device acknowledges it. */
export async function sendTest(db: DB) {
  const n = await sendPush(db, { kind: "test", id: "test", title: "Nikki", body: "Notifications are working.", tag: "nikki-test" }, "normal");
  setSetting(db, "push_last_test_at", clockIso());
  if (!n) throw new UserFacingError("No device is set up for notifications yet (or the push service refused the send). Turn notifications on first.", 409, "no_subscription");
  return n;
}

/** The service worker calls this when it has shown a notification. */
export function ackPush(db: DB) {
  setSetting(db, "push_last_ack_at", clockIso());
}
