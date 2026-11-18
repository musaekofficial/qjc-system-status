// 파일 보관함. 사람이 채팅에 첨부한 파일과, 브라우저가 내려받은 파일을 사람별 폴더에 둔다.
// AI는 파일의 id, 이름, 크기만 보고, 내용은 보지 않는다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { db } from "./db.ts";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 채팅 첨부 한 개
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 브라우저가 내려받은 파일 한 개
export const MAX_FILES_PER_MESSAGE = 5;

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  source TEXT NOT NULL,          -- upload(채팅 첨부) | download(브라우저가 받음)
  message_id TEXT,               -- 첨부된 사람 메시지. 그 메시지가 시킨 작업에서는 승인 없이 올릴 수 있다
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_user ON files(user, created);
`);

export interface FileRow {
  id: string;
  user: string;
  name: string;
  path: string;
  size: number;
  source: "upload" | "download";
  message_id: string | null;
  created: number;
}

// 사이트는 파일 이름과 확장자를 보므로 원래 이름을 최대한 살리되, 경로로 쓰일 수 있는 글자는 뺀다.
export function safeName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;
  const ext = path.extname(cleaned).slice(0, 12);
  return cleaned.slice(0, 120 - ext.length) + ext;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function newSlot(user: string, name: string): { id: string; file: string; name: string } {
  const id = `f_${crypto.randomBytes(6).toString("hex")}`;
  const dir = path.join(DATA_DIR, "files", user.replace(/[^a-z0-9._-]/gi, "_"), id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = safeName(name);
  return { id, file: path.join(dir, safe), name: safe };
}

function insert(row: FileRow): FileRow {
  db.prepare("INSERT INTO files (id, user, name, path, size, source, message_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    row.id,
    row.user,
    row.name,
    row.path,
    row.size,
    row.source,
    row.message_id,
    row.created,
  );
  return row;
}

export function saveUpload(user: string, name: string, data: Buffer): FileRow {
  const slot = newSlot(user, name);
  fs.writeFileSync(slot.file, data, { mode: 0o600 });
  return insert({ id: slot.id, user, name: slot.name, path: slot.file, size: data.length, source: "upload", message_id: null, created: Date.now() });
}

// 브라우저가 내려받은 파일을 보관함으로 옮긴다. save는 지정한 경로에 파일을 쓰는 함수(Playwright의 download.saveAs).
export async function saveDownload(user: string, name: string, save: (file: string) => Promise<void>): Promise<FileRow | { tooLarge: number; name: string }> {
  const slot = newSlot(user, name);
  await save(slot.file);
  const size = fs.statSync(slot.file).size;
  if (size > MAX_DOWNLOAD_BYTES) {
    fs.rmSync(path.dirname(slot.file), { recursive: true, force: true });
    return { tooLarge: size, name: slot.name };
  }
  return insert({ id: slot.id, user, name: slot.name, path: slot.file, size, source: "download", message_id: null, created: Date.now() });
}

export function getFile(id: string): FileRow | undefined {
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
}

export function filesFor(user: string, limit = 30): FileRow[] {
  return db.prepare("SELECT * FROM files WHERE user = ? ORDER BY created DESC, rowid DESC LIMIT ?").all(user, limit) as unknown as FileRow[];
}

// 메시지에 붙일 파일을 확인한다. 본인이 올렸고 아직 다른 메시지에 붙지 않은 파일만 된다.
export function claimable(user: string, ids: string[]): FileRow[] | string {
  if (ids.length > MAX_FILES_PER_MESSAGE) return `파일은 한 번에 ${MAX_FILES_PER_MESSAGE}개까지 붙일 수 있어요`;
  const rows: FileRow[] = [];
  for (const id of new Set(ids)) {
    const row = getFile(id);
    if (!row || row.user !== user || row.source !== "upload" || row.message_id) return "첨부 파일을 찾을 수 없어요. 다시 첨부해 주세요";
    rows.push(row);
  }
  return rows;
}

export function attachToMessage(rows: FileRow[], messageId: string): void {
  for (const row of rows) db.prepare("UPDATE files SET message_id = ? WHERE id = ?").run(messageId, row.id);
}

// 올리려는 파일이 전부 "이 작업을 시킨 메시지에 사람이 직접 첨부한 파일"이면 승인 없이 올린다.
// 그 밖의 파일(예전에 첨부한 파일, 브라우저가 내려받은 파일)을 사이트에 올리는 것은 밖으로 내보내는 일이라 승인이 필요하다.
export function uploadNeedsApproval(files: FileRow[], taskMessageIds: Set<string>): string | null {
  const other = files.filter((f) => !(f.source === "upload" && f.message_id && taskMessageIds.has(f.message_id)));
  if (other.length === 0) return null;
  return `이번 요청에 첨부되지 않은 파일을 사이트에 올림 (${other.map((f) => f.name).join(", ")})`;
}
