import { describe, expect, test } from 'bun:test';
import { TaskStore } from './tasks';

describe('TaskStore', () => {
  test('createTask assigns an id and stores the task', () => {
    const store = new TaskStore();
    const task = store.createTask('write the demo fixture', '2026-09-10');
    expect(task.id).toBe('T-1');
    expect(task.done).toBe(false);
    expect(store.getTask(task.id)).toEqual(task);
  });

  test('createTask rejects a blank title', () => {
    const store = new TaskStore();
    expect(() => store.createTask('  ', '2026-09-10')).toThrow(/blank/);
  });

  test('createTask rejects an unparseable due date', () => {
    const store = new TaskStore();
    expect(() => store.createTask('x', 'not-a-date')).toThrow(/valid date/);
  });

  test('listTasks returns every created task', () => {
    const store = new TaskStore();
    store.createTask('a', '2026-09-10');
    store.createTask('b', '2026-09-11');
    expect(store.listTasks().map((t) => t.title)).toEqual(['a', 'b']);
  });
});
