// 설정: .env, users.json, 한도와 모델 가격표를 한곳에서 읽는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

export type Role = "owner" | "staff";
export interface UserInfo {
  login: string; // Tailscale 로그인 (예: someone@gmail.com)
  name: string; // 채팅에 보일 이름
  role: Role;
}

const usersFile = process.env.USERS_FILE ?? path.join(ROOT, "users.json");

function loadUsers(): Map<string, UserInfo> {
  if (!fs.existsSync(usersFile)) {
    throw new Error(`users file not found: ${usersFile} (copy users.example.json to users.json and edit it)`);
  }
  const raw = JSON.parse(fs.readFileSync(usersFile, "utf8")) as Record<string, { name?: string; role?: string }>;
  const users = new Map<string, UserInfo>();
  for (const [login, info] of Object.entries(raw)) {
    if (info.role !== "owner" && info.role !== "staff") throw new Error(`users.json: ${login} needs role "owner" or "staff"`);
    users.set(login.toLowerCase(), { login: login.toLowerCase(), name: info.name ?? login, role: info.role });
  }
  if (![...users.values()].some((u) => u.role === "owner")) throw new Error("users.json needs at least one owner");
  return users;
}

export const USERS = loadUsers();

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export const CONFIG = {
  port: num("PORT", 3080),
  model: process.env.MODEL ?? "claude-opus-5-5",
  effort: (process.env.EFFORT ?? "high") as "low" | "medium" | "high" | "xhigh" | "max",
  // 브라우저: 맥미니에서는 창을 띄워(headless=false) 실제 사람이 쓰는 것처럼 보이게 한다.
  headless: process.env.HEADLESS === "1",
  browserChannel: process.env.BROWSER_CHANNEL || undefined, // "chrome" 이면 설치된 구글 크롬 사용
  // 결정 다섯: 비용 상한 (달러). 작업 하나 / 사람 한 명 하루 / 서비스 전체 하루.
  limitTaskUsd: num("LIMIT_TASK_USD", 3),
  limitUserDayUsd: num("LIMIT_USER_DAY_USD", 15),
  limitTotalDayUsd: num("LIMIT_TOTAL_DAY_USD", 30),
  // 함정 넷(끝나지 않는 에이전트)과 셋(조용히 멈춤) 대비.
  maxSteps: num("MAX_STEPS", 60),
  taskTimeoutMin: num("TASK_TIMEOUT_MIN", 20),
  // 결정 셋: 승인 요청 유효 시간.
  approvalTtlMin: num("APPROVAL_TTL_MIN", 15),
  // 결정 넷: 기억 개수 상한 (사람별, 공용 각각).
  maxMemories: num("MAX_MEMORIES", 40),
  // 함정 하나(문자 순서): 메시지를 받고 이만큼 기다렸다가 순서대로 처리한다.
  orderWindowMs: num("ORDER_WINDOW_MS", 1200),
  vaultKeyFile: process.env.VAULT_KEY_FILE ?? path.join(os.homedir(), ".browser-agent", "master.key"),
};

// 달러/100만 토큰. 비용 상한 계산용. cacheWrite는 5분 캐시 기준(입력가의 1.25배).
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function priceFor(model: string) {
  // 모르는 모델이면 가장 비싼 가격으로 계산해서 상한이 느슨해지지 않게 한다.
  return PRICES[model] ?? PRICES["claude-fable-5-2"];
}

if (!PRICES[CONFIG.model]) {
  console.warn(`[config] no price entry for ${CONFIG.model}; cost caps will use the highest known price`);
}
