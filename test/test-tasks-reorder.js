/**
 * Modul: Aufgaben - Handordnung innerhalb einer Kategorie (PATCH /tasks/reorder)
 * Zweck: End-to-End ueber den echten Router gegen eine migrierte Datenbank.
 *        Die Route vergibt die Raenge 1..n in der Reihenfolge der Anfrage und
 *        weist ab, was nicht umsortiert werden darf: leere oder doppelte
 *        Listen, Unteraufgaben, unsichtbare und unbekannte Aufgaben.
 * Ausfuehren: npm run test:tasks-reorder
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'tasks-reorder-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const ALICE = seedUser('alice', 'admin');
const BOB = seedUser('bob', 'member');
const alice = { id: ALICE, role: 'admin' };
const bob = { id: BOB, role: 'member' };

let actor = alice;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeTask(title, extra = {}) {
  const r = await call('POST', '/', { as: alice, body: { title, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.id;
}

const rankOf = (id) => db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(id).sort_order;

test('Migration 231: tasks.sort_order ist nullbar, neue Aufgaben haben keinen Rang', async () => {
  const col = db.prepare('PRAGMA table_info(tasks)').all().find((c) => c.name === 'sort_order');
  assert.ok(col, 'die Spalte existiert');
  assert.equal(col.notnull, 0, 'NULL = nie von Hand eingeordnet');
  const id = await makeTask('ohne Rang');
  assert.equal(rankOf(id), null);
});

test('PATCH /reorder: vergibt die Raenge 1..n in Anfragereihenfolge', async () => {
  const a = await makeTask('A');
  const b = await makeTask('B');
  const c = await makeTask('C');
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [c, a, b] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, [
    { id: c, sort_order: 1 }, { id: a, sort_order: 2 }, { id: b, sort_order: 3 },
  ]);
  assert.equal(rankOf(c), 1);
  assert.equal(rankOf(a), 2);
  assert.equal(rankOf(b), 3);
});

test('PATCH /reorder: zweiter Aufruf ordnet neu, nicht angefuegt', async () => {
  const a = await makeTask('A2');
  const b = await makeTask('B2');
  await call('PATCH', '/reorder', { as: alice, body: { order: [a, b] } });
  await call('PATCH', '/reorder', { as: alice, body: { order: [b, a] } });
  assert.equal(rankOf(b), 1);
  assert.equal(rankOf(a), 2);
});

test('PATCH /reorder: GET liefert den Rang mit', async () => {
  const a = await makeTask('GET-A');
  const b = await makeTask('GET-B');
  await call('PATCH', '/reorder', { as: alice, body: { order: [b, a] } });
  const list = await call('GET', '/', { as: alice });
  const row = list.body.data.find((t) => t.id === b);
  assert.equal(row.sort_order, 1);
});

test('PATCH /reorder: Teilmenge ist erlaubt, Ausgelassene behalten ihren Rang', async () => {
  const a = await makeTask('T-A');
  const b = await makeTask('T-B');
  const c = await makeTask('T-C');
  await call('PATCH', '/reorder', { as: alice, body: { order: [a, b, c] } });
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [c, a] } });
  assert.equal(r.status, 200);
  assert.equal(rankOf(b), 2, 'b war nicht Teil der Anfrage');
});

test('PATCH /reorder: leere, fehlende und nicht-numerische Listen -> 400', async () => {
  for (const order of [undefined, [], 'x', [1, 'abc'], [1.5]]) {
    const r = await call('PATCH', '/reorder', { as: alice, body: { order } });
    assert.equal(r.status, 400, `order=${JSON.stringify(order)}`);
  }
});

test('PATCH /reorder: doppelte ID -> 400, nichts geaendert', async () => {
  const a = await makeTask('D-A');
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [a, a] } });
  assert.equal(r.status, 400);
  assert.equal(rankOf(a), null);
});

test('PATCH /reorder: unbekannte ID -> 404, nichts geaendert', async () => {
  const a = await makeTask('U-A');
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [a, 999999] } });
  assert.equal(r.status, 404);
  assert.equal(rankOf(a), null, 'die Anfrage ist atomar: auch die gueltige ID bleibt unberuehrt');
});

test('PATCH /reorder: Unteraufgaben lassen sich nicht einordnen -> 404', async () => {
  const parent = await makeTask('Eltern');
  const sub = (await call('POST', '/', { as: alice, body: { title: 'Kind', parent_task_id: parent } })).body.data.id;
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [parent, sub] } });
  assert.equal(r.status, 404);
  assert.equal(rankOf(sub), null);
});

test('PATCH /reorder: eine fuer die Person unsichtbare Aufgabe -> 404', async () => {
  const privat = await makeTask('nur Alice', { visibility: 'private' });
  const offen = await makeTask('fuer alle', { visibility: 'all' });
  const r = await call('PATCH', '/reorder', { as: bob, body: { order: [offen, privat] } });
  assert.equal(r.status, 404);
  assert.equal(rankOf(privat), null, 'die private Aufgabe wurde nicht umnummeriert');
  assert.equal(rankOf(offen), null);
  const ok = await call('PATCH', '/reorder', { as: bob, body: { order: [offen] } });
  assert.equal(ok.status, 200);
});

test('PATCH /reorder: wird nicht als /:id gelesen (Routenreihenfolge)', async () => {
  const r = await call('PATCH', '/reorder', { as: alice, body: { order: [] } });
  assert.equal(r.status, 400, 'die Reorder-Route antwortet, nicht /:id/status oder ein 404');
  assert.match(r.body.error, /order/);
});
