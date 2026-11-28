import type { Meeting } from "../shared/types";

/** Where a synced event came from: the connected Google Calendar or a calendar link (iCal). */
export const calTag = (m: Pick<Meeting, "feedId"> | undefined) => (m?.feedId?.startsWith("google:") ? "Google Calendar" : "Calendar link");
