// 채팅 웹 서버. 127.0.0.1에서만 열고, `tailscale serve`가 tailnet 안의 요청만 넘겨준다.
// 누가 보냈는지는 tailscale serve가 붙여 주는 Tailscale-User-Login 헤더로 안다(로그인 화면 없음).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { overallLimitReached, runTask, stopTask } from "./agent.ts";
import { decide, parseApprovalCommand, pendingApprovals } from "./approvals.ts";
import { closeAllBrowsers, openedBrowser } from "./browser.ts";
import { CONFIG, ROOT, USERS, type UserInfo } from "./config.ts";
import { db, insertMessage, markInterruptedTasks, recentMessages } from "./db.ts";
import { bus, emit, type AgentEvent } from "./events.ts";
import { redact } from "./redact.ts";

const INDEX = path.join(ROOT, "public", "index.html");

// ---- 누가 보냈나 ----

function identify(req: http.IncomingMessage): UserInfo | null {
  const remote = req.socket.remoteAddress ?? "";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (!local) return null; // tailscale serve를 거치지 않은 요청은 받지 않는다
  const header = req.headers["tailscale-user-login"];
  const login = (Array.isArray(header) ? header[0] : header) ?? process.env.DEV_LOGIN; // DEV_LOGIN은 개발용
  if (!login) return null;
  return USERS.get(login.toLowerCase()) ?? null;
}

// 다른 사이트가 사용자 브라우저를 통해 몰래 명령을 보내지 못하게(CSRF): JSON + 같은 출처 + 전용 헤더만 받는다.
function sameOrigin(req: http.IncomingMessage): boolean {
  if (req.headers["x-agent-client"] !== "1") return false;
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32_000) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

// ---- 사람별 대기열 (함정 하나: 순서, 둘: 중복) ----

interface Pending {
  id: string;
  seq: number;
  text: string;
}

const queues = new Map<string, { items: Pending[]; timer: NodeJS.Timeout | null; running: boolean }>();

function queueFor(login: string) {
  let q = queues.get(login);
  if (!q) {
    q = { items: [], timer: null, running: false };
    queues.set(login, q);
  }
  return q;
}

function enqueue(user: UserInfo, item: Pending) {
  const q = queueFor(user.login);
  q.items.push(item);
  q.items.sort((a, b) => a.seq - b.seq); // 늦게 도착한 앞 메시지를 제자리로
  schedule(user);
}

function schedule(user: UserInfo) {
  const q = queueFor(user.login);
  if (q.timer) clearTimeout(q.timer);
  // 잇달아 보낸 메시지를 잠깐 모았다가 한 작업으로 묶어서, 보낸 순서대로 처리한다.
  q.timer = setTimeout(() => {
    q.timer = null;
    if (q.running || q.items.length === 0) return;
    const batch = q.items.splice(0, q.items.length);
    q.running = true;
    runTask({ user, messages: batch.map((b) => ({ id: b.id, text: b.text })) })
      .catch((err) => console.error("[task] crashed", err))
      .finally(() => {
        q.running = false;
        if (q.items.length) schedule(user);
      });
  }, CONFIG.orderWindowMs);
}

function notice(user: UserInfo, text: string) {
  const id = `notice_${crypto.randomUUID()}`;
  const created = Date.now();
  insertMessage({ id, user: user.login, role: "notice", text, task_id: null, created });
  emit({ type: "message", user: user.login, id, role: "notice", text, created });
}

// ---- 메시지 받기 ----

async function handleMessage(user: UserInfo, body: Record<string, unknown>) {
  const id = typeof body.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.id) ? body.id : null;
  const seq = typeof body.seq === "number" ? body.seq : Date.now();
  const raw = typeof body.text === "string" ? body.text.trim() : "";
  if (!id || !raw) return { status: 400, body: { error: "id와 text가 필요해요" } };
  if (raw.length > 4000) return { status: 400, body: { error: "메시지가 너무 길어요 (4000자까지)" } };

  // 결정 둘: 카드번호·비밀번호는 저장 전에 가린다. 가린 원문은 어디에도 남지 않는다.
  const { text, redacted } = redact(raw);
  const created = Date.now();
  if (!insertMessage({ id, user: user.login, role: "user", text, task_id: null, created })) {
    return { status: 200, body: { duplicate: true } }; // 같은 메시지가 두 번 왔다
  }
  emit({ type: "message", user: user.login, id, role: "user", text, created });
  if (redacted.length) {
    notice(user, `보안을 위해 ${[...new Set(redacted)].join(", ")}을(를) 가리고 저장했어요. 사이트 비밀번호는 맥미니에서 금고에 등록해 주세요.`);
  }

  const command = parseApprovalCommand(text);
  if (command) {
    notice(user, decide(command.id, command.decision, user));
    return { status: 200, body: { ok: true } };
  }
  if (/^\s*(멈춰|중지|그만|stop)\s*[!.]*\s*$/i.test(text)) {
    const q = queueFor(user.login);
    q.items.length = 0;
    if (!stopTask(user.login)) notice(user, "진행 중인 작업이 없어요.");
    return { status: 200, body: { ok: true } };
  }
  if (overallLimitReached()) {
    notice(user, "지금은 요청이 많아서 처리할 수 없어요. 내일 다시 시켜 주세요.");
    return { status: 200, body: { ok: true } };
  }
  enqueue(user, { id, seq, text });
  if (queueFor(user.login).running) notice(user, "지금 하던 작업이 끝나면 바로 이어서 할게요.");
  return { status: 200, body: { ok: true } };
}

// ---- HTTP ----

const server = http.createServer(async (req, res) => {
  const user = identify(req);
  if (!user) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("tailnet의 등록된 사용자만 쓸 수 있어요. users.json에 Tailscale 로그인을 추가해 주세요.");
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      });
      res.end(fs.readFileSync(INDEX));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const owner = user.role === "owner";
      const approvals = pendingApprovals().filter((a) => owner || a.requested_for === user.login);
      const task = db.prepare("SELECT id, status, steps, cost FROM tasks WHERE user = ? ORDER BY created DESC LIMIT 1").get(user.login);
      send(res, 200, {
        me: { name: user.name, role: user.role },
        users: Object.fromEntries([...USERS.values()].map((u) => [u.login, u.name])),
        messages: recentMessages(user.login, 80),
        approvals,
        task,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      const onEvent = (event: AgentEvent) => {
        if (event.user === user.login) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      bus.on("event", onEvent);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        bus.off("event", onEvent);
        clearInterval(ping);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/screenshot") {
      // 사장님은 다른 사람 브라우저 화면도 볼 수 있다(승인 판단용).
      const target = url.searchParams.get("user")?.toLowerCase() ?? user.login;
      if (target !== user.login && user.role !== "owner") return send(res, 403, { error: "권한 없음" });
      if (!USERS.has(target)) return send(res, 404, { error: "없는 사용자" });
      const opened = openedBrowser(target);
      const shot = opened ? (await opened).lastScreenshot : null;
      if (!shot) return send(res, 404, { error: "아직 화면이 없어요" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
      res.end(shot);
      return;
    }
    if (req.method === "POST") {
      if (!sameOrigin(req)) return send(res, 403, { error: "잘못된 요청 출처" });
      const body = await readJson(req);
      if (url.pathname === "/api/messages") {
        const r = await handleMessage(user, body);
        return send(res, r.status, r.body);
      }
      const m = /^\/api\/approvals\/(\d+)$/.exec(url.pathname);
      if (m) {
        const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;
        if (!decision) return send(res, 400, { error: "decision은 approved 또는 rejected" });
        const message = decide(Number(m[1]), decision, user);
        notice(user, message);
        return send(res, 200, { message });
      }
      if (url.pathname === "/api/stop") {
        queueFor(user.login).items.length = 0;
        return send(res, 200, { stopped: stopTask(user.login) });
      }
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[http]", err);
    if (!res.headersSent) send(res, 500, { error: "서버 오류" });
  }
});

// 서버가 작업 도중 꺼졌었다면, 해당 사람에게 알린다(함정 셋, 다섯).
for (const t of markInterruptedTasks()) {
  const u = USERS.get(t.user);
  if (u) notice(u, "서버가 다시 시작되면서 하던 작업이 중단됐어요. 필요하면 다시 시켜 주세요.");
}

server.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`browser-agent: http://127.0.0.1:${CONFIG.port} (model ${CONFIG.model})`);
  console.log(`tailnet에 공개: tailscale serve --bg ${CONFIG.port}`);
});

async function shutdown() {
  server.close();
  await closeAllBrowsers();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
