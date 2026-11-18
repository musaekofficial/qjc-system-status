// 코드로 강제하는 규칙들(가림, 위험 분류, 승인 명령, 기억 잠금)을 확인한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-unit-"));
fs.writeFileSync(
  path.join(tmp, "users.json"),
  JSON.stringify({ "boss@x.com": { name: "사장님", role: "owner" }, "staff@x.com": { name: "직원", role: "staff" } }),
);
process.env.USERS_FILE = path.join(tmp, "users.json");
process.env.DATA_DIR = path.join(tmp, "data");
process.env.VAULT_KEY_FILE = path.join(tmp, "master.key");

const { redact } = await import("../src/redact.ts");
const { classifyClick, classifyEnter } = await import("../src/browser.ts");
const { parseApprovalCommand, requestApproval, decide } = await import("../src/approvals.ts");
const { remember } = await import("../src/memory.ts");
const { insertMessage } = await import("../src/db.ts");
const { USERS } = await import("../src/config.ts");
const vault = await import("../src/vault.ts");

test("카드번호·비밀번호·주민번호를 가린다", () => {
  const r = redact("카드 4111 1111 1111 1111 이고 비밀번호는 abc123! 이에요. 주민번호 900101-1234567");
  assert.ok(!r.text.includes("4111"));
  assert.ok(!r.text.includes("abc123"));
  assert.ok(!r.text.includes("1234567"));
  assert.match(r.text, /\[카드번호 가림\]/);
  // 평범한 숫자와 단어는 건드리지 않는다
  const plain = redact("주문번호 20261118001 확인하고 shopping 목록 정리해줘");
  assert.equal(plain.text, "주문번호 20261118001 확인하고 shopping 목록 정리해줘");
  assert.deepEqual(plain.redacted, []);
});

const base = {
  ref: "1-1", tag: "button", type: "submit", role: "", name: "", href: "", inForm: true, formMethod: "post",
  formHasPassword: false, isSubmit: true, isPassword: false, isFileInput: false, searchLike: false, editable: false,
};

test("되돌릴 수 없는 클릭은 위험으로 분류한다", () => {
  assert.equal(classifyClick({ ...base, name: "게시하기", inForm: false, isSubmit: false, formMethod: "" }, false).risky, true);
  assert.equal(classifyClick({ ...base, name: "결제하기" }, false).risky, true);
  assert.equal(classifyClick({ ...base, name: "다음" }, false).risky, true, "POST 양식 제출");
  assert.equal(classifyClick({ ...base, name: "로그인", formHasPassword: true }, false).risky, false, "로그인 양식은 허용");
  assert.equal(classifyClick({ ...base, name: "더보기", isSubmit: false, inForm: false, formMethod: "" }, false).risky, false);
  assert.equal(classifyClick({ ...base, name: "더보기", isSubmit: false, inForm: false, formMethod: "" }, true).risky, true, "확인창 수락");
});

test("Enter는 검색칸에서만 자유롭다", () => {
  assert.equal(classifyEnter({ ...base, tag: "textarea", editable: true }).risky, true);
  assert.equal(classifyEnter({ ...base, tag: "input", type: "search", searchLike: true }).risky, false);
  assert.equal(classifyEnter({ ...base, tag: "input", type: "text", formMethod: "get" }).risky, false);
  assert.equal(classifyEnter({ ...base, tag: "input", type: "text", inForm: false, formMethod: "" }).risky, true);
});

test("승인 명령은 정해진 말만 받는다", () => {
  assert.deepEqual(parseApprovalCommand("승인 3"), { decision: "approved", id: 3 });
  assert.deepEqual(parseApprovalCommand("승인#12"), { decision: "approved", id: 12 });
  assert.deepEqual(parseApprovalCommand("거절"), { decision: "rejected", id: null });
  assert.equal(parseApprovalCommand("승인해도 될 것 같아"), null);
  assert.equal(parseApprovalCommand("올려"), null);
});

test("승인: 직원은 못 하고, 여러 개면 번호가 필요하다", async () => {
  const boss = USERS.get("boss@x.com")!;
  const staff = USERS.get("staff@x.com")!;
  const a = requestApproval({ taskId: "t1", requestedFor: staff.login, summary: "a", detail: "" });
  const b = requestApproval({ taskId: "t1", requestedFor: staff.login, summary: "b", detail: "" });
  assert.match(decide(a.id, "approved", staff), /사장님/);
  assert.match(decide(null, "approved", boss), /번호/);
  assert.match(decide(a.id, "approved", boss), /승인했어요/);
  assert.equal(await a.decision, "approved");
  assert.match(decide(a.id, "rejected", boss), /이미 처리/);
  decide(b.id, "rejected", boss);
  assert.equal(await b.decision, "rejected");
});

test("기억: 웹을 읽은 뒤에는 못 바꾸고, 근거 메시지가 있어야 한다", () => {
  const staff = USERS.get("staff@x.com")!;
  insertMessage({ id: "m_staff_1", user: staff.login, role: "user", text: "앞으로 반말로 해", task_id: null });
  const allowed = new Set(["m_staff_1"]);
  assert.throws(() => remember({ user: staff, tainted: true, allowedMessageIds: allowed }, { content: "반말", scope: "me", source_message_id: "m_staff_1" }), /웹 내용/);
  assert.throws(() => remember({ user: staff, tainted: false, allowedMessageIds: allowed }, { content: "반말", scope: "me", source_message_id: "m_fake" }), /찾을 수 없습니다/);
  assert.throws(() => remember({ user: staff, tainted: false, allowedMessageIds: allowed }, { content: "반말", scope: "shared", source_message_id: "m_staff_1" }), /사장님만/);
  assert.match(remember({ user: staff, tainted: false, allowedMessageIds: allowed }, { content: "반말", scope: "me", source_message_id: "m_staff_1" }), /저장/);
});

test("금고: 암호화해서 저장하고, AI용 목록에는 아이디·비밀번호가 없다", () => {
  const e = vault.addEntry({ label: "테스트", origin: "https://example.com/login", username: "me", password: "s3cret!", scope: "shared" });
  assert.equal(e.origin, "https://example.com");
  const raw = fs.readFileSync(path.join(tmp, "data", "vault.enc"));
  assert.ok(!raw.includes(Buffer.from("s3cret!")));
  const listed = JSON.stringify(vault.listForUser("staff@x.com"));
  assert.ok(!listed.includes("s3cret!") && !listed.includes('"me"'));
  assert.equal(vault.getForFill(e.id, "staff@x.com")?.password, "s3cret!");
});
