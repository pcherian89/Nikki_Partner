# Implementation checklist

| Stage | Item | Status |
|---|---|---|
| C | Stage C claims verified against code and commits | Done (pushed commits `98ec883`, `4a846b6`) |
| C | Pinned blocks (stated or hand-edited times) protected in replans | Done + tested |
| C | Keep going past a block: conflicts shown, safe choices | Done + tested |
| C | No invented estimates; unestimated blocks labelled provisional | Done + tested |
| C | Proposal shows Not scheduled / At risk from app facts | Done (browser-checked at the end) |
| C | End-of-day review: time to check, user-controlled carryovers, deadlines | Done + tested |
| C | Completion never invents sessions | Done + tested |
| C | Timer persistence across restart and devices | Done + tested |
| C | Chat/UI share business rules (deadline/day validation) | Done + tested |
| C | Real Claude test | Cannot run here (no API key). `npm run check:live` provided |
| D | Reminders: in-app (verified), closed-app push (built, NOT verified on a real device) | Done; push unverified |
| E | Projects: milestones, linked tasks, proposals, progress from real states, project reminders | Done + tested (API + browser) |
| F | Strategic guidance + memory | |
| — | Integrated scenario, browser, release | |
