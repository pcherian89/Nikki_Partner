# Nikki — Planning, Timer and Chat Specification

Status: **approved baseline for Stages C and D**, with four refinements (marked **R1–R4**) and one correction to Stage B. Changes after approval only where testing shows a material issue.

Core idea: **tasks** say what needs doing; **scheduled blocks** say when you intend to work; **work sessions** record what you actually did. They stay separate and are connected by task id.

## Concepts

| Concept | Meaning | Where it lives |
|---|---|---|
| Task | What needs to be done. One overall status. | `tasks` |
| Assigned day | The day you intend to address it. No time. | `tasks.planned_date` |
| Priority | How important: High / Normal / Low. Affects ordering only (**R4**). | `tasks.priority` (new) |
| Optional | "If time allows" — set only by the user, independent of priority (**R4**). | `tasks.optional` (new) |
| Deadline | Date, with an optional time. Never a calendar event, never a block. | `tasks.deadline`, `tasks.deadline_time` (new) |
| Estimate | Total effort. **Unknown stays unknown** (NULL); never filled in with a default (**R3**). | `tasks.estimate_minutes` |
| Scheduled block | When you intend to work. Several per task. Versioned; never deleted. | `plans` + `plan_blocks` (+ `pinned`) |
| Fixed commitment | Meetings, calendar events, pinned blocks. Never moved automatically. | `meetings`, pinned blocks |
| Work session | Time actually worked: timer or reported by you. Several per task. | `work_sessions` |
| Block outcome | Your answer for a planned block. Separate from the task's status. | `block_outcomes` |
| Reminder | Something to remember. Takes no work time. Stage D. | `reminders` (Stage D) |

## One rule for chat and buttons

Both use the same command functions (`server/commands.ts`), so they share validation. The model only makes requests; the app executes them; the **receipt** ("✓ Done" / "✕ Not done: reason") is the record of what happened, not the model's wording. Failures are fed into the next turn so a false claim isn't repeated.

| | Applies to |
|---|---|
| **Runs immediately, with a receipt and Undo** | Creating tasks (any number). Priority, optional, deadline, or assigned day when the task has no scheduled blocks. Start, pause, finish. Time you report, when it doesn't conflict. |
| **Preview first, runs on Confirm** | Anything that adds, moves or removes a scheduled block (including moving a task off a day where it has blocks). Deleting. "Move all unfinished". Planning and replanning. Time reports that overlap something. |
| **Always needs confirmation (unchanged)** | Saved personal context. Confirmed plans. |
| **Clarification** | One short question, only when the answer changes the result. |

## Flows

### 1. Task capture
- A task needs only a title. Day defaults to the list it is added from; priority Normal; no deadline; no estimate.
- Today, Tomorrow and each Week day have a one-line "+ Add task". Everything keeps its form.
- Chat: "Add the insurance tender to today" and "Add five tasks for tomorrow" create immediately with one Undo. A count with no titles gets one question: "What are they?". "Remind me…" is offered as a task for that day until Stage D.
- Retries never duplicate: request id plus title de-duplication.

### 2. Priority, optional and deadline (R4)
- Priority High / Normal / Low changes **ordering only**. Low never means ignorable or deferrable.
- "If time allows" is a separate, explicit flag. The planner schedules such tasks last. It is never inferred from priority.
- A deadline always counts. A task with a deadline is scheduled, or flagged "at risk", before any priority or optional consideration, whatever its priority.
- "Prepare the presentation, high priority, due today at 5 PM" creates one task: assigned today, High, deadline 5 PM, **no block**. Nikki may recommend a block; that stays optional.
- **At risk**: remaining effort doesn't fit between now and the deadline after fixed commitments (computed for deadlines today and tomorrow). **No estimate**: shown as "Due 5 PM · no estimate", never as at risk. **Overdue**: stays visible at the top until you decide.
- Only you change a deadline. If "4 PM" has already passed today, Nikki asks "tomorrow at 4 PM?".

### 3. Starting work, scheduled or not
- Every open task for today has one primary action: Start (Resume when paused). Starting never creates or alters a block.
- Tasks for other days: Start offers "Work on it today".

### 4. Timer start, pause, resume, switch
- One timer at a time. Starting another shows a choice: **Pause it and start X** / **Finish it and start X** / Cancel. The server refuses a silent overlap with a clear error carrying that choice; chat asks the same question.
- Pause ends the session; Resume starts a new session on the same task (shown as "3 sessions · 45 min"). Paused time is never counted.
- **Current focus** appears only while a timer is actually running.

### 5. Forgotten or inaccurate time, and cross-device timers (R2)
- **The server is the source of truth.** A running timer is its stored start time plus the server's clock; every client reads it on load and when it becomes visible, and shows server-time-corrected elapsed time.
- **A timer found running after a long absence, or started on another device**, is shown with its state — "Running on *X* since 9:05 AM (started on another device)" — with **[Still working] [Stop and set time…]**. A timer counts as "uncertain" when: it was started on another device and this device has not seen it before; this device last saw the app 3+ hours ago while it ran; elapsed exceeds twice the estimate (2 hours if no estimate); or it runs past the end of the working window or midnight.
- Uncertain elapsed time is **never treated as verified**. Stopping an uncertain timer saves the session as "Needs a check", prefilled with the elapsed time: **Keep / set minutes / discard**. Until confirmed it is shown separately ("+3h 10m to check") and excluded from totals and remaining effort. Nothing is silently dropped.
- At most one prompt per threshold, only while the app is open, never a push. "Still working" snoozes it for 2 hours.
- Forgot to start: "Add time worked" on a task (duration, or from–to), or tell Nikki. Labelled **Reported**. Overlaps and duplicates are checked and asked about once.
- Finish without time: allowed; no time is invented; the row shows "Done · no time recorded".
- Any session can be edited or deleted later.

### 6. Nikki chat commands

| You say | Does | Confirms? |
|---|---|---|
| What should I work on next? | Answers from the app's own ranking (overdue/at risk, then priority, then scheduled time) | No |
| Plan my day | Plan proposal (flow 7) | Preview |
| I have ten tasks today | Creates them if titles are given; otherwise asks "What are they?" | Undo |
| This is my top priority | Sets High; asks which if two match | Undo |
| Move the report to later today | Shows real free slots | Preview |
| Start working on the tender | Starts; asks pause/finish if another is running | None |
| Pause the timer | Pauses; says so if none is running | None |
| I finished the presentation | Finishes, stops the timer, invents no time, offers "add time?" | Undo |
| I forgot to start the timer | Asks once for task and time | Asks |
| I worked on the report 10 to 11 / about 40 minutes | Records a **Reported** session after checks | Undo, or Preview if it overlaps |
| What haven't I completed? | Lists today's unfinished and carryovers | No |
| Move unfinished tasks to tomorrow | Lists them for you to confirm | Preview |
| What deadlines this week? | Lists from the app's data | No |
| The report must be submitted by 4 PM | Sets the deadline (asks if that time has passed) | Undo |
| Move the proposal review to Friday | Assigns the day | Undo, or Preview if it has blocks |

### 7. Planning a day, including missing estimates (R3)
- **The app computes the facts**: today's tasks with priority and deadline; remaining effort (estimate minus verified recorded time); free gaps from now to the end of the window after fixed commitments; pinned blocks.
- **Missing estimates never block planning.** The rest of the day is planned regardless. For a task with no estimate Nikki may: ask for an essential one when it matters (a deadline or High priority) — one question with quick replies (30 min / 1 h / 2 h / Not sure); offer a **provisional duration**, clearly labelled "provisional 30 min" and stored only in the proposed block, not on the task; or leave it unscheduled. Estimates stay NULL in stored data unless you set one.
- Workload line: "10 tasks · 7h 30m estimated (2 without estimate) · 5h 10m available". Unknown estimates are counted separately, never as a made-up number.
- The proposal has four parts: **Fixed**, **Suggested work**, **Not scheduled** (stays on today's list, with the reason), **At risk** (how short).
- Ordering: urgency first, then priority, then preferences, with "if time allows" tasks last. All tasks can be started in any order.
- Never schedules past a deadline without a warning, never drops a task, never extends your hours. If it can't all fit, it says so and offers: move the lowest-priority tasks that have no deadline, extend the day (your decision), or keep as is.
- Demo mode follows the same rules.

### 8. Replanning and overruns
- Replan keeps everything that started or was recorded. A priority change runs immediately with Undo; the schedule change is a preview with conflicts and the nearest free alternatives. Fixed items and deadlines are untouched.
- **Block ended while the timer runs:** "Planned time ended: [Keep going] [Finish] [Pause]". Keep going changes nothing unless a later flexible block would collide; then a preview shows what shifts and what no longer fits. Meetings and pinned blocks never move.
- **Block ended with no timer:** "Not finished: Done / Move…". Nothing is assumed.
- **Finished early:** with 20+ minutes left and unscheduled tasks, one quiet line: "25 min free: start X?".
- Blocks you set by stating a time are **pinned**; blocks Nikki proposes are flexible.

### 9. Today, Tomorrow, Week (R1)
**Today has three primary parts, in this order:**
1. **Current focus** — only while a timer is running.
2. **Today's tasks** — every task assigned to today, scheduled or not.
3. **Upcoming commitments** — meetings and pinned blocks, with start–end ranges, plus important deadlines.

Everything else is **contextual or compact**, never a competing section:
- **Needs a check** — one compact line that appears only when something needs checking; expands inline.
- **From earlier (carryovers)** — one collapsed line under the task list header ("3 from earlier ›"). Never auto-assigned.
- **Earlier today** — collapsed, with its count.
- **Timeline** — a List | Timeline toggle on the task list; the day bar sits inside the timeline.
- **Workload** — one muted summary line under the date.
- **Reminders** — a one-line strip, only when reminders exist (Stage D).
- At most one contextual banner is visible at a time. No redesign of the existing visual style.

Rows: checkbox, title, High marker, time range if scheduled, "Due" chip, remaining effort, one primary Start/Pause; everything else under ⋯. Sort: overdue and at risk, then High, then scheduled time. Nothing disappears when its time passes.
**Tomorrow** uses the same list and shows assigned tasks before any plan exists, with "Arrange tomorrow". **Week** shows the same tasks, deadlines and commitments; totals come from one server-computed day summary shared by Today, Tomorrow and Week.

### 10. End of day
One concise review, each piece of work asked about once:
1. Done today, with recorded time.
2. Needs a check (uncertain timer time): Confirm / Correct.
3. Planned sessions not recorded, grouped by task: with timer time → "Worked 40 of 90 min [Confirm] [Correct]"; without → "Did as planned / Partly… / Didn't do"; for tasks you finished → "Same as planned / Keep recorded / Set time".
4. Unfinished tasks: Tomorrow / Pick a day / Someday / Keep on today / Delete. Nothing moves on its own.
5. Deadlines: missed and approaching.
Unconfirmed work is never marked completed or skipped automatically.

### 11. Errors and edge cases
All-or-nothing actions with the reason shown; retried chat messages never duplicate; all times in the profile timezone; deleting a task keeps its sessions in history; Undo from the toast and the chat receipt.

## Correction to Stage B
Finishing a task does **not** mark earlier planned blocks done. They stay "Not recorded" until you answer. Only blocks that start after the completion time become "Not needed", because they cannot have happened.

## Data changes (migration v3, additive, copy taken first)
`tasks.priority` (default Normal), `tasks.optional` (default 0), `tasks.deadline_time`; `work_sessions.verified` (default 1) and a `reported` source; `plan_blocks.pinned`. The "started on another device" marker is kept in `settings`. No other tables. Estimates are never written unless the user sets them.

## Scope
Stage C: command layer, task-first Today and Tomorrow, priority and deadlines, flexible scheduling, timers, history accuracy, replanning. Stage D: reminders and in-app reminder behaviour. **Not in scope:** device notifications, recurring items, web push.

## Roadmap and status

| Stage | Content | Status |
|---|---|---|
| A, B | Architecture, history and data-safety foundation | Done |
| C | Task-first day, timers, pinned blocks, overrun conflicts, shared chat/UI command layer, end-of-day review | Done and tested |
| D | Reminders: in-app (verified); closed-app web push (built, **not verified on a real device**) | Done; push unverified |
| E | Long-term projects: Project → Milestones → ordinary tasks; proposal-confirmed; progress from real states | Done and tested |
| F | Strategic guidance in the same chat; confirmed-only structured memory; weekly review from app-counted facts | Done and tested with scripted replies; real-model behaviour unverified |

## How the later stages work (as built)

**Reminders.** Separate from tasks, deadlines, blocks and commitments. One-time, linked to a task or standalone, optionally counting down from a task deadline or project target date (they follow it if it moves). Stored as absolute instants with the user's timezone; the server fires them every 20 seconds with a compare-and-set so each fires once. When due they show on Today until done or snoozed. Closed-app delivery uses opt-in Web Push; a device counts as *verified* only after its own service worker acknowledges a test push.

**Projects.** `projects`, `milestones`, plus `tasks.project_id/milestone_id`. Nikki proposes (never saves) a plan; the user confirms with the same Confirm as a day plan. Tasks start unassigned, so a project never floods Today; next actions are the first three open tasks of the earliest open milestone. Progress is counted (tasks, milestones, recorded time), never estimated. Milestones complete only when the user says so. Pause, resume, complete and archive are quick actions with Undo.

**Strategic guidance and memory.** No separate mode: the same chat, with the app's records (projects, recorded time, deadlines) and a small structured memory (`memory_items`: focus, priority, commitment, goal, constraint, decision, paused, idea; each *confirmed / tentative / assumption / recommendation / approved / outdated*). Memory is changed directly by the user or by Nikki only after the user confirms; tentative items expire for review after 30 days and are then not given to the model; at most 80 items; outdated items are never used. Only a bounded, relevance-filtered slice is sent to the model. Discussing an idea never creates anything.

**Weekly review.** Optional, from the Today menu. The app counts the last seven days (done, unfinished, recorded time, per-project movement, neglected projects, upcoming deadlines, decisions) and lists what it can't see (finished tasks with no time, days without recorded time, unchecked time, missing estimates). Nikki interprets those counts; the counts are shown alongside her words. Demo mode produces a plain factual summary without a model.
