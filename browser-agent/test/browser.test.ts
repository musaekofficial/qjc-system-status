// 실제 Chromium(창 없음)으로 브라우저 쪽 기능을 확인한다: 안쪽 프레임(iframe), shadow DOM, 파일 올리기·내려받기.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-"));
fs.writeFileSync(path.join(tmp, "users.json"), JSON.stringify({ "boss@x.com": { name: "사장님", role: "owner" } }));
process.env.USERS_FILE = path.join(tmp, "users.json");
process.env.DATA_DIR = path.join(tmp, "data");
process.env.VAULT_KEY_FILE = path.join(tmp, "master.key");
process.env.HEADLESS = "1";
process.env.BROWSER_CHANNEL = "";

const { BrowserSession, classifyUploadTarget, closeAllBrowsers } = await import("../src/browser.ts");
const files = await import("../src/files.ts");

const site = http.createServer((req, res) => {
  const port = (site.address() as { port: number }).port;
  const html = (body: string) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>${body}`);
  };
  if (req.url === "/inner") {
    return html(`<title>안쪽</title><button onclick="document.getElementById('o').textContent='프레임 눌림'">프레임 버튼</button>
      <input aria-label="프레임 입력"><p id="o">프레임 글</p>`);
  }
  if (req.url === "/tracker") return html(`<button>추적 버튼</button>`);
  if (req.url === "/upload") {
    return html(`<title>올리기</title><input type="file" id="f" hidden onchange="out.textContent='받음: '+this.files[0].name">
      <button onclick="f.click()">사진 선택</button><button onclick="out.textContent='아무 일 없음'">그냥 버튼</button><p id="out"></p>`);
  }
  if (req.url === "/dl") return html(`<title>받기</title><a href="/orders.csv">주문 목록 받기</a>`);
  if (req.url === "/orders.csv") {
    res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="orders.csv"' });
    return res.end("id,name\n1,kim\n");
  }
  // 다른 출처(localhost)의 프레임, 화면에 안 보이는 프레임, shadow DOM이 있는 페이지
  html(`<title>바깥</title><h1>바깥 글</h1>
    <iframe src="http://localhost:${port}/inner" width="600" height="200"></iframe>
    <iframe src="/tracker" width="1" height="1"></iframe>
    <x-box></x-box>
    <script>
      const root = document.querySelector("x-box").attachShadow({ mode: "open" });
      root.innerHTML = '<button>그림자 버튼</button><p>그림자 글</p>';
      root.querySelector("button").onclick = () => { root.querySelector("p").textContent = "그림자 눌림"; };
    </script>`);
});

let browser: Awaited<ReturnType<typeof BrowserSession.open>>;
let base = "";
const refOf = (snap: string, label: string) => {
  const m = snap.split("\n").find((l) => l.includes(`"${label}"`))?.match(/^\[(\d+-\d+)\]/);
  assert.ok(m, `스냅샷에 "${label}"이 있어야 한다:\n${snap}`);
  return m[1];
};

before(async () => {
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  browser = await BrowserSession.open("boss@x.com");
});

after(async () => {
  await browser.close();
  await closeAllBrowsers();
  site.close();
});

test("안쪽 프레임과 shadow DOM의 요소를 읽고 누를 수 있다", async () => {
  await browser.goto(`${base}/`, false);
  let snap = await browser.snapshot();
  assert.match(snap, /바깥 글/);
  assert.match(snap, /프레임 글/, "다른 출처 프레임의 글");
  assert.match(snap, /그림자 글/, "shadow DOM 안의 글");
  assert.ok(!snap.includes("추적 버튼"), "보이지 않는 프레임은 읽지 않는다");

  const info = await browser.describe(refOf(snap, "프레임 버튼"));
  assert.equal(info?.name, "프레임 버튼");
  await browser.click(refOf(snap, "프레임 버튼"), { acceptDialog: false, allowSubmit: false });
  await browser.click(refOf(snap, "그림자 버튼"), { acceptDialog: false, allowSubmit: false });
  await browser.type(refOf(snap, "프레임 입력"), "안녕");
  assert.equal((await browser.focusedInfo())?.name, "프레임 입력", "프레임 안에서 입력 중인 칸을 안다");
  const oldRef = refOf(snap, "프레임 버튼");

  snap = await browser.snapshot();
  assert.match(snap, /프레임 눌림/);
  assert.match(snap, /그림자 눌림/);
  assert.match(snap, /값="안녕"/);
  assert.equal(await browser.describe(oldRef), null, "지난 스냅샷의 ref는 쓸 수 없다");
});

test("숨은 파일 선택칸과 파일 선택 창 버튼으로 파일을 올린다", async () => {
  const file = files.saveUpload("boss@x.com", "상품 사진.jpg", Buffer.from("jpeg"));
  await browser.goto(`${base}/upload`, false);
  let snap = await browser.snapshot();
  assert.match(snap, /\[파일 선택칸\]/, "숨은 파일 선택칸도 목록에 나온다");

  // 1) 버튼을 눌러 열리는 파일 선택 창으로
  const button = await browser.describe(refOf(snap, "사진 선택"));
  assert.deepEqual(classifyUploadTarget(button!), { risky: false });
  await browser.upload(refOf(snap, "사진 선택"), [file.path], { isFileInput: false, allowSubmit: false });
  assert.match(await browser.snapshot(), /받음: 상품 사진\.jpg/);

  // 2) 파일 선택칸에 직접
  await browser.goto(`${base}/upload`, false);
  snap = await browser.snapshot();
  const inputRef = snap.split("\n").find((l) => l.includes("[파일 선택칸]"))!.match(/^\[(\d+-\d+)\]/)![1];
  assert.equal((await browser.describe(inputRef))?.isFileInput, true);
  await browser.upload(inputRef, [file.path], { isFileInput: true, allowSubmit: false });
  snap = await browser.snapshot();
  assert.match(snap, /받음: 상품 사진\.jpg/);

  // 3) 파일 선택 창을 열지 않는 버튼이면 알려 준다
  await assert.rejects(browser.upload(refOf(snap, "그냥 버튼"), [file.path], { isFileInput: false, allowSubmit: false }), /파일 선택 창이 열리지 않았습니다/);
});

test("내려받은 파일은 보관함에 들어간다", async () => {
  const got: string[] = [];
  browser.onDownload = (f) => got.push(f.name);
  await browser.goto(`${base}/dl`, false);
  const snap = await browser.snapshot();
  await browser.click(refOf(snap, "주문 목록 받기"), { acceptDialog: false, allowSubmit: false });
  const end = Date.now() + 10000;
  while (got.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got, ["orders.csv"]);
  const row = files.filesFor("boss@x.com").find((f) => f.source === "download");
  assert.equal(row?.name, "orders.csv");
  assert.equal(fs.readFileSync(row!.path, "utf8"), "id,name\n1,kim\n");
  assert.ok(browser.takeNotices().some((n) => n.includes(row!.id)), "AI에게 파일 id를 알린다");
});

test("이번 요청에 첨부한 파일만 승인 없이 올릴 수 있다", () => {
  const mine = files.saveUpload("boss@x.com", "a.png", Buffer.from("x"));
  files.attachToMessage([mine], "msg_now");
  const attached = files.getFile(mine.id)!;
  assert.equal(files.uploadNeedsApproval([attached], new Set(["msg_now"])), null);
  assert.match(files.uploadNeedsApproval([attached], new Set(["msg_other"]))!, /a\.png/, "예전 요청의 첨부는 승인 필요");
  const downloaded = files.filesFor("boss@x.com").find((f) => f.source === "download")!;
  assert.match(files.uploadNeedsApproval([attached, downloaded], new Set(["msg_now"]))!, /orders\.csv/, "내려받은 파일은 승인 필요");
  assert.equal(typeof files.claimable("boss@x.com", [mine.id]), "string", "이미 붙인 파일은 다시 붙일 수 없다");
  assert.equal(typeof files.claimable("other@x.com", [downloaded.id]), "string");
  assert.equal(files.safeName("../../etc/pass:wd"), "__.._etc_pass_wd");
});
