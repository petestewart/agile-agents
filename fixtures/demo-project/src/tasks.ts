/**
 * demo-project — a tiny in-memory task tracker. Not a real product: this is
 * the T021 demo fixture Agile Agents' seeded epic implements against
 * (agile-agents' own `fixtures/demo-project`, not an artifact of the
 * fixture's *own* history — there is no ticket 0).
 */

export interface Task {
  id: string;
  title: string;
  dueDate: string; // ISO date, e.g. "2026-09-10"
  done: boolean;
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private nextId = 1;

  /** Creates a task due on `dueDate` (ISO date string). Throws on a blank title or an unparseable date. */
  createTask(title: string, dueDate: string): Task {
    if (title.trim().length === 0) {
      throw new Error('createTask: title must not be blank');
    }
    if (Number.isNaN(Date.parse(dueDate))) {
      throw new Error(`createTask: "${dueDate}" is not a valid date`);
    }
    const task: Task = { id: `T-${this.nextId++}`, title, dueDate, done: false };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Every task currently tracked, oldest-created first. */
  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }
}
