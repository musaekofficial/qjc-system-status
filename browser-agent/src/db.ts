// SQLite 저장소. 대화, 작업, 승인, 기억, 비용 기록.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";

export const db = new DatabaseSync(path.join(DATA_DIR, "agent.db"));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,           -- 클라이언트가 만든 id. 같은 id가 다시 오면 무시한다(함정 둘: 중복)
  user TEXT NOT NULL,            -- 이 대화방의 주인(Tailscale 로그인)
  role TEXT NOT NULL,            -- user | assistant | notice
  text TEXT NOT NULL,
  task_id TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_user ON messages(user, created);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued | running | waiting_approval | done | failed | stopped | interrupted
  steps INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  error TEXT,
  created INTEGER NOT NULL,
  finished INTEGER
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  requested_for TEXT NOT NULL,   -- 작업을 시킨 사람
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending | approved | rejected | expired
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,           -- 사람 로그인 또는 'shared'
  content TEXT NOT NULL,
  source_message_id TEXT NOT NULL, -- 근거가 된 사람 메시지. 근거 없는 기억은 저장하지 않는다(결정 넷)
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  user TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost REAL NOT NULL,
  day TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_day ON usage(day, user);
`);

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface MessageRow {
  id: string;
  user: string;
  role: "user" | "assistant" | "notice";
  text: string;
  task_id: string | null;
  created: number;
}

export function insertMessage(row: Omit<MessageRow, "created"> & { created?: number }): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO messages (id, user, role, text, task_id, created) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.id, row.user, row.role, row.text, row.task_id, row.created ?? Date.now());
  return result.changes > 0;
}

export function getMessage(id: string): MessageRow | undefined {
  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
}

export function recentMessages(user: string, limit: number): MessageRow[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE user = ? ORDER BY created DESC, rowid DESC LIMIT ?")
    .all(user, limit) as unknown as MessageRow[];
  return rows.reverse();
}

export function spentToday(user?: string): number {
  const row = user
    ? db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM usage WHERE day = ? AND user = ?").get(today(), user)
    : db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM usage WHERE day = ?").get(today());
  return Number((row as { c: number }).c);
}

// 서버가 작업 도중 죽었다면, 재시작 때 그 작업을 '중단됨'으로 바꾸고 알린다(함정 셋, 다섯).
export function markInterruptedTasks(): { id: string; user: string }[] {
  const rows = db
    .prepare("SELECT id, user FROM tasks WHERE status IN ('queued', 'running', 'waiting_approval')")
    .all() as { id: string; user: string }[];
  db.prepare(
    "UPDATE tasks SET status = 'interrupted', finished = ? WHERE status IN ('queued', 'running', 'waiting_approval')",
  ).run(Date.now());
  db.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending'").run();
  return rows;
}
