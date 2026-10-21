import type { Milestone, Project, ProjectDraft, ProjectProgress, ProjectStatus, ProjectView, Task } from "../shared/types.js";
import { clockIso, createTask, DB, getTask, listTasks, newId, updateTask } from "./db.js";
import { UserFacingError } from "./errors.js";
import { isValidDate } from "./time.js";

/**
 * Long-term goals. Project → Milestones → Tasks → Work sessions, where tasks are the ordinary Nikki tasks (they just
 * point at a project and optionally a milestone). A project never puts tasks on Today by itself: tasks stay unassigned
 * until the user (or an approved suggestion) gives them a day. Progress is counted from real states, never estimated.
 */

interface ProjectRow {
  id: string;
  title: string;
  goal: string;
  target_date: string | null;
  status: ProjectStatus;
  assumptions: string;
  dependencies: string;
  source: Project["source"];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
interface MilestoneRow {
  id: string;
  project_id: string;
  title: string;
  target_date: string | null;
  status: "open" | "done";
  position: number;
  done_at: string | null;
}

const toMilestone = (r: MilestoneRow): Milestone => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  targetDate: r.target_date,
  status: r.status,
  position: r.position,
  doneAt: r.done_at,
});

function toProject(r: ProjectRow, milestones: Milestone[]): Project {
  return {
    id: r.id,
    title: r.title,
    goal: r.goal,
    targetDate: r.target_date,
    status: r.status,
    assumptions: JSON.parse(r.assumptions) as string[],
    dependencies: JSON.parse(r.dependencies) as string[],
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    milestones,
  };
}

export function listProjects(db: DB): Project[] {
  const ms = new Map<string, Milestone[]>();
  for (const m of db.prepare("SELECT * FROM milestones ORDER BY project_id, position").all() as MilestoneRow[]) {
    if (!ms.has(m.project_id)) ms.set(m.project_id, []);
    ms.get(m.project_id)!.push(toMilestone(m));
  }
  return (db.prepare("SELECT * FROM projects ORDER BY created_at, rowid").all() as ProjectRow[]).map((r) => toProject(r, ms.get(r.id) ?? []));
}

export function getProject(db: DB, id: string): Project | null {
  return listProjects(db).find((p) => p.id === id) ?? null;
}

const RANK = { high: 0, normal: 1, low: 2 } as const;

/** Progress and next actions, from the real state of the project's tasks and milestones. */
export function projectViews(db: DB, tasks: Task[], today: string): ProjectView[] {
  const last = new Map(
    (db.prepare("SELECT t.project_id AS pid, MAX(s.ended_at) AS at FROM work_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.project_id IS NOT NULL AND s.verified = 1 GROUP BY t.project_id").all() as { pid: string; at: string | null }[]).map((r) => [r.pid, r.at]),
  );
  return listProjects(db).map((p) => {
    const mine = tasks.filter((t) => t.projectId === p.id && t.type === "action");
    const order = new Map(p.milestones.map((m) => [m.id, m.position]));
    const open = mine.filter((t) => t.status === "open");
    // Earliest unfinished milestone first, so a project never suggests work from months ahead.
    const openMilestones = p.milestones.filter((m) => m.status === "open");
    const frontier = openMilestones[0]?.id ?? null;
    const ranked = [...open].sort(
      (a, b) =>
        (a.milestoneId === frontier ? 0 : a.milestoneId ? 1 : 2) - (b.milestoneId === frontier ? 0 : b.milestoneId ? 1 : 2) ||
        (order.get(a.milestoneId ?? "") ?? 999) - (order.get(b.milestoneId ?? "") ?? 999) ||
        RANK[a.priority] - RANK[b.priority] ||
        a.createdAt.localeCompare(b.createdAt),
    );
    const progress: ProjectProgress = {
      tasksTotal: mine.length,
      tasksDone: mine.filter((t) => t.status === "done").length,
      milestonesTotal: p.milestones.length,
      milestonesDone: p.milestones.filter((m) => m.status === "done").length,
      workedMinutes: mine.reduce((a, t) => a + t.spentMinutes, 0),
      lastWorkedAt: last.get(p.id) ?? null,
      unassigned: open.filter((t) => !t.plannedDate).length,
      nextActionIds: p.status === "active" ? ranked.slice(0, 3).map((t) => t.id) : [],
      overdueMilestoneIds: p.milestones.filter((m) => m.status === "open" && m.targetDate && m.targetDate < today).map((m) => m.id),
    };
    return { ...p, progress };
  });
}

// ---------- proposals: validate and apply ----------

export function validateProjectDraft(d: ProjectDraft, ctx: { today: string; existing: Project | null }): string[] {
  const errors: string[] = [];
  if (!d.title.trim()) errors.push("The project needs a title.");
  if (d.projectId && !ctx.existing) errors.push(`Project "${d.projectId}" doesn't exist.`);
  if (ctx.existing && ctx.existing.status === "archived") errors.push("That project is archived; it has to be restored before it can change.");
  if (d.targetDate && (!isValidDate(d.targetDate) || d.targetDate < ctx.today)) errors.push(`The target date "${d.targetDate}" isn't a valid date today or later.`);
  const refs = new Set<string>();
  const ids = new Set(ctx.existing?.milestones.map((m) => m.id) ?? []);
  for (const m of d.milestones) {
    if (!m.title.trim()) errors.push("A milestone has no title.");
    if (refs.has(m.ref)) errors.push(`Milestone ref "${m.ref}" is used twice.`);
    refs.add(m.ref);
    if (m.id && !ids.has(m.id)) errors.push(`Milestone "${m.id}" doesn't belong to this project.`);
    if (m.targetDate && (!isValidDate(m.targetDate) || m.targetDate < ctx.today)) errors.push(`Milestone "${m.title}" has an invalid or past date (${m.targetDate}).`);
    const end = d.targetDate ?? ctx.existing?.targetDate;
    if (m.targetDate && end && m.targetDate > end && !m.remove) errors.push(`Milestone "${m.title}" (${m.targetDate}) is after the project's target date (${end}).`);
  }
  if (d.milestones.filter((m) => !m.remove).length + (ctx.existing?.milestones.filter((m) => !d.milestones.some((x) => x.id === m.id)).length ?? 0) > 12) errors.push("Keep it to at most 12 milestones.");
  if (d.tasks.length > 40) errors.push("Propose at most 40 tasks at once; the rest can be added when their milestone comes up.");
  for (const t of d.tasks) {
    if (!t.title.trim()) errors.push("A task has no title.");
    if (t.milestoneRef && !refs.has(t.milestoneRef) && !ids.has(t.milestoneRef)) errors.push(`Task "${t.title}" refers to an unknown milestone "${t.milestoneRef}".`);
  }
  if (!ctx.existing && !d.milestones.length && !d.tasks.length) errors.push("A new project needs at least one milestone or task.");
  return errors;
}

/** Creates or revises a project. Everything happens in one transaction. Tasks are created unassigned (no day). */
export function applyProjectDraft(db: DB, d: ProjectDraft, opts: { source: Project["source"]; tasksSource: Task["source"] }): { projectId: string; createdTaskIds: string[]; changedTarget: boolean } {
  return db.transaction(() => {
    const now = clockIso();
    let id = d.projectId;
    let changedTarget = false;
    if (id) {
      const cur = getProject(db, id)!;
      changedTarget = (d.targetDate ?? cur.targetDate) !== cur.targetDate;
      db.prepare("UPDATE projects SET title = ?, goal = ?, target_date = ?, assumptions = ?, dependencies = ?, updated_at = ? WHERE id = ?").run(
        d.title.trim() || cur.title,
        d.goal.trim() || cur.goal,
        d.targetDate ?? cur.targetDate,
        JSON.stringify(d.assumptions.length ? d.assumptions : cur.assumptions),
        JSON.stringify(d.dependencies.length ? d.dependencies : cur.dependencies),
        now,
        id,
      );
      if (d.title.trim() && d.title.trim() !== cur.title) db.prepare("UPDATE tasks SET project = ? WHERE project_id = ?").run(d.title.trim(), id);
    } else {
      id = newId("pj");
      db.prepare("INSERT INTO projects (id, title, goal, target_date, status, assumptions, dependencies, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)").run(
        id,
        d.title.trim(),
        d.goal.trim(),
        d.targetDate,
        JSON.stringify(d.assumptions),
        JSON.stringify(d.dependencies),
        opts.source,
        now,
        now,
      );
    }
    const refToId = new Map<string, string>();
    let position = (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM milestones WHERE project_id = ?").get(id) as { p: number }).p;
    for (const m of d.milestones) {
      if (m.id) {
        refToId.set(m.ref, m.id);
        if (m.remove) {
          db.prepare("UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?").run(m.id);
          db.prepare("DELETE FROM milestones WHERE id = ?").run(m.id);
        } else db.prepare("UPDATE milestones SET title = ?, target_date = ? WHERE id = ?").run(m.title.trim(), m.targetDate, m.id);
      } else if (!m.remove) {
        const mid = newId("ms");
        refToId.set(m.ref, mid);
        db.prepare("INSERT INTO milestones (id, project_id, title, target_date, status, position) VALUES (?, ?, ?, ?, 'open', ?)").run(mid, id, m.title.trim(), m.targetDate, ++position);
      }
    }
    const title = (db.prepare("SELECT title FROM projects WHERE id = ?").get(id) as { title: string }).title;
    const createdTaskIds: string[] = [];
    for (const t of d.tasks) {
      const created = createTask(db, {
        title: t.title,
        priority: t.priority,
        estimateMinutes: t.estimateMinutes,
        projectId: id,
        milestoneId: t.milestoneRef ? (refToId.get(t.milestoneRef) ?? t.milestoneRef) : null,
        project: title,
        source: opts.tasksSource,
      });
      createdTaskIds.push(created.id);
    }
    return { projectId: id!, createdTaskIds, changedTarget };
  })();
}

export function setProjectStatus(db: DB, id: string, status: ProjectStatus): Project {
  const p = getProject(db, id);
  if (!p) throw new UserFacingError("Project not found.", 404, "not_found");
  if (p.status === status) return p;
  db.prepare("UPDATE projects SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?").run(status, clockIso(), status === "completed" ? clockIso() : null, id);
  return getProject(db, id)!;
}

export function setMilestoneStatus(db: DB, id: string, status: "open" | "done"): Milestone {
  const m = db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as MilestoneRow | undefined;
  if (!m) throw new UserFacingError("Milestone not found.", 404, "not_found");
  db.prepare("UPDATE milestones SET status = ?, done_at = ? WHERE id = ?").run(status, status === "done" ? clockIso() : null, id);
  return toMilestone(db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as MilestoneRow);
}

/** Links a task to a project (and milestone), or unlinks it. The task keeps all its own settings. */
export function linkTask(db: DB, taskId: string, projectId: string | null, milestoneId: string | null): Task {
  const task = getTask(db, taskId);
  if (!task) throw new UserFacingError("Task not found.", 404, "not_found");
  let label: string | null = null;
  if (projectId) {
    const p = getProject(db, projectId);
    if (!p) throw new UserFacingError("Project not found.", 404, "not_found");
    if (p.status === "archived") throw new UserFacingError("That project is archived.", 409, "archived");
    if (milestoneId && !p.milestones.some((m) => m.id === milestoneId)) throw new UserFacingError("That milestone isn't part of this project.", 400, "invalid");
    label = p.title;
  }
  return updateTask(db, taskId, { projectId, milestoneId: projectId ? milestoneId : null, project: label })!;
}

export const openProjectTasks = (db: DB, projectId: string) => listTasks(db).filter((t) => t.projectId === projectId && t.status !== "done");
