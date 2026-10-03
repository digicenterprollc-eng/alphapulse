// DigiCorp Office — persistent state (SQLite)
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const DATA = process.env.OFFICE_DATA || "/data";
export const WORK = path.join(DATA, "work");
export const SITES = path.join(DATA, "sites");
for (const d of [DATA, WORK, SITES]) fs.mkdirSync(d, { recursive: true });

export const db = new Database(path.join(DATA, "office.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT, role TEXT, dept TEXT, color TEXT, bio TEXT,
  status TEXT DEFAULT 'idle', doing TEXT, current_task TEXT,
  shifts INTEGER DEFAULT 0, actions INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
  last_active TEXT, next_shift TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT,
  assignee TEXT, created_by TEXT, status TEXT DEFAULT 'todo', priority INTEGER DEFAULT 2,
  result TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, kind TEXT, tool TEXT,
  args TEXT, output TEXT, error INTEGER DEFAULT 0, ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, name TEXT, description TEXT, price REAL, currency TEXT DEFAULT 'EUR',
  site TEXT, created_by TEXT, active INTEGER DEFAULT 1, delivery TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, product_id TEXT, amount REAL, currency TEXT, status TEXT,
  agent TEXT, customer_email TEXT, paid_amount REAL, tx TEXT, sandbox INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), paid_at TEXT
);
CREATE TABLE IF NOT EXISTS sites (
  slug TEXT PRIMARY KEY, title TEXT, agent TEXT, visits INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, key TEXT, value TEXT,
  ts TEXT DEFAULT (datetime('now')), UNIQUE(agent, key)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT, to_agent TEXT, text TEXT,
  read INTEGER DEFAULT 0, ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS llm_usage (
  day TEXT, model TEXT, calls INTEGER DEFAULT 0, ok INTEGER DEFAULT 0, PRIMARY KEY(day, model)
);
`);

try { db.exec("ALTER TABLE products ADD COLUMN delivery TEXT"); } catch {}
try { db.exec("ALTER TABLE products ADD COLUMN files TEXT"); } catch {}
try { db.exec("ALTER TABLE sales ADD COLUMN downloads INTEGER DEFAULT 0"); } catch {}

export const q = (sql, ...p) => db.prepare(sql).all(...p);
export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function logEvent(agent, kind, tool, args, output, error = false) {
  run("INSERT INTO events(agent,kind,tool,args,output,error) VALUES(?,?,?,?,?,?)",
    agent, kind, tool || null,
    typeof args === "string" ? args : JSON.stringify(args ?? null),
    String(output ?? "").slice(0, 6000), error ? 1 : 0);
}
