/**
 * Modul: Aufgaben - Handordnung in der Liste (Oberflaeche)
 * Zweck: Was die Route nicht sieht: wann die Liste Griffe zeigt und wie die
 *        Kategorie-Gruppe sortiert.
 *
 *        Deckt ab:
 *          - sortTasksManual: Rang vor Standardordnung, Rangloses danach
 *          - canReorderTasks: nur Liste + Kategorie, nicht im Auswahlmodus,
 *            nicht bei `tasks: read`, nicht am Wandtablett
 *          - renderTaskCard: der Griff erscheint nur mit `reorderable`
 *          - die Ziehgeste ist kein Wisch (`ignore`), der Griff traegt keine
 *            data-action (ein Klick darauf darf nichts ausloesen)
 * Ausfuehren: npm run test:tasks-reorder-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.document = globalThis.document ?? {
  documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
};

const { __test: tasks } = await import('../public/pages/tasks.js');

const task = (over = {}) => ({
  id: 1, title: 'X', status: 'open', category: 'household', priority: 'none',
  due_date: null, visibility: 'all', subtasks: [], ...over,
});
const NOW = new Date('2030-01-01T12:00:00Z');
const ids = (list) => list.map((t) => t.id);

test('sortTasksManual: eingeordnete Aufgaben nach Rang, ohne Ruecksicht auf Faelligkeit', () => {
  const frueh = task({ id: 1, sort_order: 2, due_date: '2030-01-02' });
  const spaet = task({ id: 2, sort_order: 1, due_date: '2030-06-01' });
  assert.deepEqual(ids([frueh, spaet].sort((a, b) => tasks.sortTasksManual(a, b, NOW))), [2, 1]);
});

test('sortTasksManual: Rangloses steht hinter allem Eingeordneten', () => {
  const dringend = task({ id: 1, sort_order: null, priority: 'urgent', due_date: '2030-01-02' });
  const ranked = task({ id: 2, sort_order: 5 });
  const sorted = [dringend, ranked].sort((a, b) => tasks.sortTasksManual(a, b, NOW));
  assert.deepEqual(ids(sorted), [2, 1], 'auch eine dringende neue Aufgabe verschiebt die Handordnung nicht');
});

test('sortTasksManual: ohne jeden Rang gilt die bisherige Ordnung', () => {
  const a = task({ id: 1, priority: 'low', due_date: '2030-02-01' });
  const b = task({ id: 2, priority: 'high', due_date: '2030-01-05' });
  const manual = [a, b].sort((x, y) => tasks.sortTasksManual(x, y, NOW));
  const standard = [a, b].sort((x, y) => tasks.sortTasks(x, y, NOW));
  assert.deepEqual(ids(manual), ids(standard));
});

test('sortTasksManual: gleicher Rang faellt auf die bisherige Ordnung zurueck', () => {
  const a = task({ id: 1, sort_order: 3, priority: 'low' });
  const b = task({ id: 2, sort_order: 3, priority: 'urgent' });
  assert.deepEqual(ids([a, b].sort((x, y) => tasks.sortTasksManual(x, y, NOW))), [2, 1]);
});

function mitZustand(patch, fn) {
  const s = tasks.state;
  const vorher = { viewMode: s.viewMode, bulkSelectMode: s.bulkSelectMode, user: s.user };
  Object.assign(s, { viewMode: 'list', bulkSelectMode: false, user: { id: 2 } }, patch);
  try { return fn(); } finally { Object.assign(s, vorher); }
}

test('canReorderTasks: nur in der Liste, gruppiert nach Kategorie', () => {
  mitZustand({}, () => {
    assert.equal(tasks.canReorderTasks('category'), true);
    assert.equal(tasks.canReorderTasks('due'), false, 'nach Faelligkeit hat die Position keine Aussage');
  });
  mitZustand({ viewMode: 'kanban' }, () => assert.equal(tasks.canReorderTasks('category'), false));
  mitZustand({ viewMode: 'history' }, () => assert.equal(tasks.canReorderTasks('category'), false));
});

test('canReorderTasks: nicht im Auswahlmodus und nicht am Wandtablett', () => {
  mitZustand({ bulkSelectMode: true }, () => assert.equal(tasks.canReorderTasks('category'), false));
  mitZustand({ user: { id: 4, access_scope: 'display' } }, () => {
    assert.equal(tasks.canReorderTasks('category'), false);
  });
});

test('renderTaskCard: Griff nur mit reorderable, ohne data-action', () => {
  const mit = mitZustand({}, () => tasks.renderTaskCard(task(), { reorderable: true }));
  const ohne = mitZustand({}, () => tasks.renderTaskCard(task(), {}));
  assert.match(mit, /class="row-action list-row__drag"/, 'Gegenfall: der Griff wird gezeichnet');
  assert.ok(!ohne.includes('list-row__drag'), 'ohne reorderable kein Griff');
  const griff = mit.match(/<button[^>]*list-row__drag[^>]*>/)[0];
  assert.ok(!griff.includes('data-action'), 'ein Klick auf den Griff darf keine Listenaktion ausloesen');
  assert.match(griff, /aria-label=/, 'der Griff hat einen Namen');
});

test('Quelltext: der Zug am Griff ist keine Wischgeste, der Tastaturpfad ruft denselben Handler', () => {
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  assert.match(src, /card: '\.task-card',\s*\n\s*\/\/[^\n]*\n\s*ignore: '\.list-row__drag'/,
    'wireSwipeRows ignoriert den Griff');
  assert.match(src, /onEnd: \(evt\) => persistTaskOrder\(/, 'das Drag-Ende sichert die Reihenfolge');
  assert.match(src, /moveTaskRow\([^)]*\)[\s\S]{0,400}persistTaskOrder\(/, 'die Pfeiltasten gehen durch denselben Handler');
  assert.match(src, /ArrowUp/, 'Pfeiltasten am Griff');
});
