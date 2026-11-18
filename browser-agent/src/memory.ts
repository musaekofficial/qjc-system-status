// 결정 넷: 기억은 사람 말로만 만든다.
// - 웹페이지·댓글을 읽은 작업에서는 기억을 바꿀 수 없다(남이 쓴 글 한 줄이 에이전트 성격을 바꾸지 못하게).
// - 모든 기억에는 근거가 된 사람 메시지 id가 붙는다. 근거 없는 기억은 저장하지 않는다.
// - 개수 상한이 있다. 넘치면 오래된 것을 지우라고 안내한다.
import { CONFIG, type UserInfo } from "./config.ts";
import { db, getMessage } from "./db.ts";

export interface MemoryRow {
  id: number;
  scope: string;
  content: string;
  source_message_id: string;
  created: number;
}

export interface MemoryContext {
  user: UserInfo;
  tainted: boolean; // 이 작업에서 웹 내용을 읽었는지
  allowedMessageIds: Set<string>; // 이 작업에서 근거로 쓸 수 있는 사람 메시지 id
}

export function memoriesFor(login: string): { mine: MemoryRow[]; shared: MemoryRow[] } {
  const q = db.prepare("SELECT * FROM memories WHERE scope = ? ORDER BY id");
  return {
    mine: q.all(login) as unknown as MemoryRow[],
    shared: q.all("shared") as unknown as MemoryRow[],
  };
}

function guard(ctx: MemoryContext, sourceMessageId: string) {
  if (ctx.tainted) {
    throw new Error(
      "이 작업에서 이미 웹 내용을 읽어서 기억을 바꿀 수 없습니다. 기억할 내용이 있으면 사용자에게 따로 말해 달라고 하세요.",
    );
  }
  const msg = getMessage(sourceMessageId);
  if (!msg || msg.role !== "user" || msg.user !== ctx.user.login || !ctx.allowedMessageIds.has(sourceMessageId)) {
    throw new Error(`근거 메시지 ${sourceMessageId}를 찾을 수 없습니다. 사용자가 직접 보낸 이번 메시지의 id를 쓰세요.`);
  }
}

export function remember(ctx: MemoryContext, input: { content: string; scope: "me" | "shared"; source_message_id: string }): string {
  guard(ctx, input.source_message_id);
  const scope = input.scope === "shared" ? "shared" : ctx.user.login;
  if (scope === "shared" && ctx.user.role !== "owner") throw new Error("회사 공용 기억은 사장님만 바꿀 수 있습니다.");
  const count = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE scope = ?").get(scope) as { c: number }).c;
  if (count >= CONFIG.maxMemories) {
    throw new Error(`기억이 ${CONFIG.maxMemories}개로 꽉 찼습니다. 사용자에게 지울 기억을 물어보고 forget으로 지운 뒤 다시 시도하세요.`);
  }
  const content = input.content.trim().slice(0, 500);
  const r = db
    .prepare("INSERT INTO memories (scope, content, source_message_id, created_by, created) VALUES (?, ?, ?, ?, ?)")
    .run(scope, content, input.source_message_id, ctx.user.login, Date.now());
  return `기억 #${r.lastInsertRowid} 저장 (${scope === "shared" ? "회사 공용" : "개인"})`;
}

export function forget(ctx: MemoryContext, input: { memory_id: number; source_message_id: string }): string {
  guard(ctx, input.source_message_id);
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(input.memory_id) as MemoryRow | undefined;
  if (!row) throw new Error(`기억 #${input.memory_id} 없음`);
  if (row.scope === "shared" ? ctx.user.role !== "owner" : row.scope !== ctx.user.login) {
    throw new Error("이 기억을 지울 권한이 없습니다.");
  }
  db.prepare("DELETE FROM memories WHERE id = ?").run(input.memory_id);
  return `기억 #${input.memory_id} 삭제`;
}
