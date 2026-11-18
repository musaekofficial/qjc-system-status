// 결정 둘: 금고. 사이트 로그인 정보는 암호화해서 보관하고, 에이전트(AI)는 값을 절대 보지 못한다.
// AI는 "어느 로그인 정보를 쓸지" id만 고르고, 실제 입력은 이 코드가 브라우저에 직접 한다.
// 마스터 키는 프로젝트 폴더 밖(~/.browser-agent/master.key)에 둔다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG, DATA_DIR } from "./config.ts";

export interface VaultEntry {
  id: string;
  label: string; // 예: "네이버 회사 계정"
  origin: string; // 이 주소에서만 입력 가능. 예: https://nid.naver.com
  username: string;
  password: string;
  scope: string; // 'shared' 또는 특정 사람 로그인
}

const VAULT_FILE = path.join(DATA_DIR, "vault.enc");

function masterKey(): Buffer {
  const file = CONFIG.vaultKeyFile;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`vault key in ${file} is not 32 bytes`);
  return key;
}

function load(): VaultEntry[] {
  if (!fs.existsSync(VAULT_FILE)) return [];
  const blob = fs.readFileSync(VAULT_FILE);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as VaultEntry[];
}

function save(entries: VaultEntry[]): void {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
  const tmp = `${VAULT_FILE}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE);
}

export function normalizeOrigin(url: string): string {
  return new URL(url).origin;
}

export function addEntry(entry: Omit<VaultEntry, "id">): VaultEntry {
  const entries = load();
  const full: VaultEntry = { ...entry, origin: normalizeOrigin(entry.origin), id: `cred_${crypto.randomBytes(3).toString("hex")}` };
  entries.push(full);
  save(entries);
  return full;
}

export function removeEntry(id: string): boolean {
  const entries = load();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  save(next);
  return true;
}

export function listAll(): Omit<VaultEntry, "password">[] {
  return load().map(({ password: _password, ...rest }) => rest);
}

// AI에게 보여 주는 목록: id, 이름, 주소만. 아이디/비밀번호는 없음.
export function listForUser(login: string): { id: string; label: string; origin: string }[] {
  return load()
    .filter((e) => e.scope === "shared" || e.scope === login)
    .map((e) => ({ id: e.id, label: e.label, origin: e.origin }));
}

export function getForFill(id: string, login: string): VaultEntry | undefined {
  return load().find((e) => e.id === id && (e.scope === "shared" || e.scope === login));
}
