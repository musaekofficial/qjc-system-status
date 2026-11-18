// 결정 셋: 되돌릴 수 없는 동작은 AI가 아니라 코드가, 사장님이 정해진 말로 답했을 때만 실행한다.
// - 승인 요청마다 번호를 붙인다. 여러 개가 열려 있으면 번호 없이 "승인"만 보내면 받지 않는다.
// - 만료된 뒤에 온 답은 받지 않는다.
// - 누가 승인했는지는 Tailscale 로그인으로 확인하고, owner만 승인할 수 있다.
import { CONFIG, USERS, type UserInfo } from "./config.ts";
import { db } from "./db.ts";
import { emit } from "./events.ts";

export type Decision = "approved" | "rejected" | "expired";

interface Waiter {
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
}

const waiters = new Map<number, Waiter>();

export interface ApprovalRow {
  id: number;
  task_id: string;
  requested_for: string;
  summary: string;
  detail: string;
  status: string;
  created: number;
  expires: number;
  decided_by: string | null;
}

function broadcast(row: ApprovalRow) {
  const event = {
    type: "approval" as const,
    id: row.id,
    status: row.status,
    summary: row.summary,
    detail: row.detail,
    expires: row.expires,
    requestedFor: row.requested_for,
  };
  // 요청한 사람과 모든 owner 화면에 보낸다.
  const targets = new Set([row.requested_for, ...[...USERS.values()].filter((u) => u.role === "owner").map((u) => u.login)]);
  for (const user of targets) emit({ ...event, user });
}

export function requestApproval(input: { taskId: string; requestedFor: string; summary: string; detail: string }): {
  id: number;
  decision: Promise<Decision>;
} {
  const now = Date.now();
  const expires = now + CONFIG.approvalTtlMin * 60_000;
  const result = db
    .prepare(
      "INSERT INTO approvals (task_id, requested_for, summary, detail, status, created, expires) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    )
    .run(input.taskId, input.requestedFor, input.summary, input.detail, now, expires);
  const id = Number(result.lastInsertRowid);
  const decision = new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      finish(id, "expired", null);
    }, expires - now);
    waiters.set(id, { resolve, timer });
  });
  broadcast(get(id)!);
  return { id, decision };
}

function get(id: number): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
}

function finish(id: number, status: Decision, by: string | null) {
  const changed = db
    .prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(status, by, Date.now(), id).changes;
  const waiter = waiters.get(id);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiters.delete(id);
    waiter.resolve(status);
  }
  if (changed) broadcast(get(id)!);
}

export function pendingApprovals(): ApprovalRow[] {
  return db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all() as unknown as ApprovalRow[];
}

export function cancelApprovalsForTask(taskId: string) {
  for (const row of pendingApprovals()) if (row.task_id === taskId) finish(row.id, "rejected", "system");
}

export function decide(id: number | null, decision: "approved" | "rejected", by: UserInfo): string {
  if (by.role !== "owner") return "승인과 거절은 사장님(owner)만 할 수 있어요.";
  let target: ApprovalRow | undefined;
  if (id === null) {
    const pending = pendingApprovals();
    if (pending.length === 0) return "기다리는 승인 요청이 없어요.";
    if (pending.length > 1) {
      return `승인 요청이 ${pending.length}개 열려 있어요. 번호를 붙여 주세요: ${pending.map((p) => `#${p.id}`).join(", ")}`;
    }
    target = pending[0];
  } else {
    target = get(id);
  }
  if (!target) return `#${id} 승인 요청이 없어요.`;
  if (target.status === "expired" || (target.status === "pending" && Date.now() > target.expires)) {
    if (target.status === "pending") finish(target.id, "expired", null);
    return `#${target.id} 요청은 이미 만료됐어요. 필요하면 작업을 다시 시켜 주세요.`;
  }
  if (target.status !== "pending") return `#${target.id} 요청은 이미 처리됐어요 (${target.status}).`;
  finish(target.id, decision, by.login);
  return decision === "approved" ? `#${target.id} 승인했어요.` : `#${target.id} 거절했어요.`;
}

// 채팅으로 온 승인/거절 명령. 정해진 말만 받는다. 그 밖의 말은 승인으로 보지 않는다.
const APPROVE = /^\s*(승인|ㅇㅋ|ok|okay|yes)\s*#?\s*(\d+)?\s*$/i;
const REJECT = /^\s*(거절|취소|ㄴㄴ|no)\s*#?\s*(\d+)?\s*$/i;

export function parseApprovalCommand(text: string): { decision: "approved" | "rejected"; id: number | null } | null {
  const a = APPROVE.exec(text);
  if (a) return { decision: "approved", id: a[2] ? Number(a[2]) : null };
  const r = REJECT.exec(text);
  if (r) return { decision: "rejected", id: r[2] ? Number(r[2]) : null };
  return null;
}
