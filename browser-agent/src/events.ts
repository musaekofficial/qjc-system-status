// 채팅 화면(SSE)으로 보내는 실시간 이벤트.
import { EventEmitter } from "node:events";

export type AgentEvent =
  | { type: "message"; user: string; id: string; role: "user" | "assistant" | "notice"; text: string; created: number }
  | { type: "progress"; user: string; taskId: string; text: string }
  | { type: "status"; user: string; taskId: string; status: string; steps: number; cost: number }
  | { type: "screenshot"; user: string; taskId: string }
  | { type: "approval"; user: string; id: number; status: string; summary: string; detail: string; expires: number; requestedFor: string };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(event: AgentEvent): void {
  bus.emit("event", event);
}
