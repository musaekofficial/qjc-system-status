// 맥미니에 실제 브라우저 창을 띄우고, 사람이 하듯이 클릭·입력한다(Playwright).
// 사람마다 브라우저 프로필이 따로 있어서 로그인·쿠키가 섞이지 않는다.
// 되돌릴 수 없는 동작(게시, 결제, 전송, 삭제 등)은 여기서 "위험"으로 분류하고,
// 실행은 agent.ts가 사장님 승인을 받은 뒤에만 한다(결정 셋).
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { CONFIG, DATA_DIR } from "./config.ts";
import { formatSize, MAX_DOWNLOAD_BYTES, saveDownload, type FileRow } from "./files.ts";
import type { VaultEntry } from "./vault.ts";

export interface ElementInfo {
  ref: string;
  tag: string;
  type: string;
  role: string;
  name: string;
  href: string;
  inForm: boolean;
  formMethod: string; // get | post | ""
  formHasPassword: boolean;
  isSubmit: boolean;
  isPassword: boolean;
  isFileInput: boolean;
  searchLike: boolean;
  editable: boolean; // textarea / contenteditable
}

export type Risk = { risky: false } | { risky: true; reason: string };

// 버튼 글자에 이런 말이 있으면 되돌릴 수 없는 동작으로 본다.
const RISKY_WORDS =
  /(결제|구매|주문|송금|이체|입금|게시|발행|등록|올리기|업로드|보내기|전송|제출|신청|예약|확정|삭제|탈퇴|해지|구독|가입|공유|댓글\s?작성|답장|pay|buy|purchase|order|checkout|post|publish|submit|send|delete|remove|subscribe|sign\s?up|book|reserve|share|upload|tweet|reply|comment)/i;

export function classifyClick(info: ElementInfo, acceptDialog: boolean): Risk {
  if (acceptDialog) return { risky: true, reason: "확인 대화상자 수락" };
  if (RISKY_WORDS.test(info.name)) return { risky: true, reason: `버튼 글자 "${info.name}"` };
  if (info.isSubmit && info.formMethod === "post" && !info.formHasPassword) {
    return { risky: true, reason: "서버로 내용을 보내는 양식 제출" };
  }
  return { risky: false };
}

// 파일 선택 창을 여는 버튼으로 보이는 이름. browser_upload가 이런 버튼을 누르는 것은 올리기 자체와 같은 일로 본다.
const FILE_PICKER_WORDS = /(업로드|올리기|첨부|파일|사진|이미지|찾아보기|불러오기|upload|attach|file|photo|image|browse|choose)/i;

// browser_upload가 파일 선택 창을 열려고 누르는 요소가, 파일 고르기 말고 다른 위험한 일을 하는 버튼은 아닌지 본다.
export function classifyUploadTarget(info: ElementInfo): Risk {
  if (info.isFileInput) return { risky: false };
  const risk = classifyClick(info, false);
  if (risk.risky && FILE_PICKER_WORDS.test(info.name) && !(info.isSubmit && info.formMethod === "post")) return { risky: false };
  return risk;
}

export function classifyEnter(info: ElementInfo | null): Risk {
  if (!info) return { risky: false };
  if (info.editable) return { risky: true, reason: "글 입력칸에서 Enter (메시지·댓글 전송일 수 있음)" };
  if (info.searchLike) return { risky: false };
  if (info.inForm && (info.formMethod === "get" || info.formHasPassword)) return { risky: false };
  if (info.tag === "input") return { risky: true, reason: "입력칸에서 Enter (양식 제출일 수 있음)" };
  return { risky: false };
}

// ---- 페이지 안에서 실행되는 함수들 (브라우저 쪽 코드) ----

interface SnapshotArgs {
  prefix: string; // 이번 스냅샷 번호
  start: number; // 앞 프레임들이 이미 쓴 요소 번호
  max: number; // 이 프레임에서 더 붙일 수 있는 요소 수
  textMax: number;
  isChild: boolean; // 페이지 안의 프레임(iframe)인가
}

// 한 프레임(문서)의 요소 목록과 글을 읽는다. 열린 shadow DOM 안쪽까지 들어간다.
function pageSnapshot(args: SnapshotArgs) {
  const SELECTOR =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="combobox"], [role="searchbox"], [role="textbox"], [contenteditable=""], [contenteditable="true"], [onclick]';
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const clean = (t: string | null | undefined, n = 80) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const candidates: Element[] = [];
  const shadowTexts: string[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.hasAttribute("data-agent-ref")) el.removeAttribute("data-agent-ref");
      if (el.matches(SELECTOR)) candidates.push(el);
      if (el.shadowRoot) {
        // innerText는 shadow DOM 안의 글을 포함하지 않아서 따로 모은다.
        for (const child of Array.from(el.shadowRoot.children)) {
          if (child.tagName !== "SLOT" && child.tagName !== "STYLE") shadowTexts.push((child as HTMLElement).innerText ?? "");
        }
        walk(el.shadowRoot);
      }
    }
  };
  walk(document);
  // 글 편집기처럼 문서 전체가 편집칸인 프레임
  if (args.isChild && document.body && (document.designMode === "on" || document.body.isContentEditable) && !candidates.includes(document.body)) {
    candidates.unshift(document.body);
  }
  const lines: string[] = [];
  const refs: string[] = [];
  let count = 0;
  let total = 0;
  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const type = (input.type ?? "").toLowerCase();
    const isFile = tag === "input" && type === "file";
    // 파일 선택칸은 보통 숨겨져 있지만 browser_upload로 쓸 수 있으니 목록에 넣는다.
    if (!isFile && !visible(el)) continue;
    total++;
    if (count >= args.max) continue;
    count++;
    const ref = `${args.prefix}-${args.start + count}`;
    el.setAttribute("data-agent-ref", ref);
    refs.push(ref);
    const role = el.getAttribute("role") ?? "";
    const label =
      clean(el.getAttribute("aria-label")) ||
      (tag === "body" ? "글 편집칸" : clean((el as HTMLElement).innerText)) ||
      clean(el.getAttribute("placeholder")) ||
      clean(el.getAttribute("title")) ||
      clean(el.getAttribute("alt")) ||
      clean(el.getAttribute("name"));
    let extra = "";
    if (tag === "a") extra += ` href=${clean((el as HTMLAnchorElement).href, 120)}`;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (type === "password") extra += " [비밀번호칸]";
      else if (isFile) extra += ` [파일 선택칸${input.multiple ? ", 여러 개 가능" : ""}${input.accept ? `, ${clean(input.accept, 60)}` : ""}]`;
      else if (type === "checkbox" || type === "radio") extra += input.checked ? " [체크됨]" : " [체크안됨]";
      else if (input.value) extra += ` 값="${clean(input.value, 60)}"`;
    }
    if ((el as HTMLButtonElement).disabled) extra += " [비활성]";
    const kind = role || (tag === "input" ? `input:${type || "text"}` : tag === "body" ? "textbox" : tag);
    lines.push(`[${ref}] ${kind} "${label}"${extra}`);
  }
  const text = [document.body?.innerText ?? "", ...shadowTexts]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    url: location.href,
    title: document.title,
    elements: lines,
    refs,
    truncated: total > count ? total - count : 0,
    text: text.slice(0, args.textMax),
    textTruncated: text.length > args.textMax,
  };
}

// 지금 글자 입력을 받는 요소. shadow DOM 안쪽까지 따라 들어간다.
function deepActiveElement(isChild: boolean): Element | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  if (!a) return null;
  if (a === document.body) {
    return isChild && (document.designMode === "on" || document.body.isContentEditable) ? a : null;
  }
  return a;
}

function describeElement(el: Element | null) {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  const type = (input.type ?? "").toLowerCase();
  const form = el.closest("form");
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const name =
    clean(el.getAttribute("aria-label")) ||
    clean((el as HTMLElement).innerText) ||
    clean(input.value) ||
    clean(el.getAttribute("title")) ||
    clean(el.getAttribute("placeholder"));
  const hint = `${el.getAttribute("name") ?? ""} ${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.id}`;
  const isSubmit =
    (tag === "button" && (type === "submit" || (!el.getAttribute("type") && !!form))) ||
    (tag === "input" && (type === "submit" || type === "image"));
  return {
    ref: el.getAttribute("data-agent-ref") ?? "",
    tag,
    type,
    role: el.getAttribute("role") ?? "",
    name,
    href: tag === "a" ? (el as HTMLAnchorElement).href : "",
    inForm: !!form,
    formMethod: form ? (form.getAttribute("method") ?? "get").toLowerCase() : "",
    formHasPassword: !!form?.querySelector('input[type="password"]'),
    isSubmit,
    isPassword: type === "password",
    isFileInput: tag === "input" && type === "file",
    searchLike:
      type === "search" || el.getAttribute("role") === "searchbox" || /검색|search|찾기|query|keyword/i.test(hint),
    editable: tag === "textarea" || (el as HTMLElement).isContentEditable || el.ownerDocument.designMode === "on",
  };
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain", ".zip": "application/zip", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// 파일을 브라우저에 넘기는 형태. 가능하면 내용을 직접 넘긴다: 경로로 넘기면 시스템 언어 설정에 따라
// 한글 이름 파일이 조용히 빠지는 경우가 있다. 합쳐서 40MB가 넘으면(Playwright 한도 50MB) 경로로 넘긴다.
function uploadPayload(paths: string[]): string[] | { name: string; mimeType: string; buffer: Buffer }[] {
  const total = paths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  if (total > 40 * 1024 * 1024) return paths;
  return paths.map((p) => ({
    name: path.basename(p),
    mimeType: MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream",
    buffer: fs.readFileSync(p),
  }));
}

// ---- 사람 한 명의 브라우저 ----

const MAX_ELEMENTS = 250;
const MAX_CHILD_FRAMES = 10;

export class BrowserSession {
  readonly login: string;
  private context: BrowserContext;
  private active: Page | null = null;
  private submitAllowed = false; // 승인된(또는 로그인) 동작 하나를 실행하는 동안에만 true
  private acceptNextDialog = false;
  private expectingChooser = false; // browser_upload가 파일 선택 창을 기다리는 중
  private notices: string[] = [];
  private snapSeq = 0;
  private refFrames = new Map<string, Frame>(); // 마지막 스냅샷의 ref가 어느 프레임에 있는지
  lastScreenshot: Buffer | null = null;
  // 브라우저가 파일을 내려받았을 때 채팅에 알리는 함수. 작업이 시작될 때 agent.ts가 넣는다.
  onDownload: ((file: FileRow) => void) | null = null;

  private constructor(login: string, context: BrowserContext) {
    this.login = login;
    this.context = context;
  }

  static async open(login: string): Promise<BrowserSession> {
    const profileDir = path.join(DATA_DIR, "profiles", login.replace(/[^a-z0-9._-]/gi, "_"));
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: CONFIG.headless,
      channel: CONFIG.browserChannel,
      viewport: { width: 1280, height: 860 },
      locale: "ko-KR",
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      acceptDownloads: true,
    });
    const session = new BrowserSession(login, context);
    // 양식 제출(POST 페이지 이동)은 승인된 동작을 실행하는 그 순간에만 허용한다. 페이지 안의 프레임도 같다.
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.method() !== "GET" && !session.submitAllowed) {
        session.notices.push(`승인 없이 양식을 제출하려는 이동을 막았습니다: ${req.method()} ${req.url().slice(0, 120)}`);
        return route.abort("blockedbyclient");
      }
      return route.fallback();
    });
    for (const page of context.pages()) session.watch(page);
    context.on("page", (page) => {
      session.watch(page);
      session.active = page;
    });
    return session;
  }

  private watch(page: Page) {
    page.on("dialog", (dialog) => {
      const msg = dialog.message().slice(0, 200);
      if (this.acceptNextDialog) {
        this.acceptNextDialog = false;
        this.notices.push(`대화상자를 수락했습니다: "${msg}"`);
        void dialog.accept();
      } else {
        this.notices.push(`대화상자가 떠서 취소했습니다: "${msg}". 수락이 필요하면 같은 버튼을 accept_dialog=true로 다시 누르세요(승인 필요).`);
        void dialog.dismiss();
      }
    });
    // 이 리스너가 있어야 맥미니 화면에 파일 선택 창이 실제로 뜨지 않는다(뜨면 아무도 닫지 못해 멈춘다).
    page.on("filechooser", () => {
      if (!this.expectingChooser) {
        this.notices.push("파일 선택 창이 열렸지만 아무 파일도 고르지 않았습니다. 파일을 올리려면 같은 요소에 browser_upload를 쓰세요.");
      }
    });
    page.on("download", (download) => {
      const name = download.suggestedFilename();
      saveDownload(this.login, name, (file) => download.saveAs(file))
        .then((result) => {
          if ("tooLarge" in result) {
            this.notices.push(`내려받은 파일 "${result.name}"이 너무 커서(${formatSize(result.tooLarge)}, 한도 ${formatSize(MAX_DOWNLOAD_BYTES)}) 보관하지 않았습니다.`);
            return;
          }
          this.notices.push(`파일을 내려받아 보관함에 넣었습니다: ${result.id} "${result.name}" (${formatSize(result.size)}). 사용자는 채팅에서 받을 수 있습니다.`);
          this.onDownload?.(result);
        })
        .catch((err) => this.notices.push(`파일 "${name}" 내려받기에 실패했습니다: ${String((err as Error).message ?? err).slice(0, 200)}`));
    });
    page.on("close", () => {
      if (this.active === page) this.active = this.context.pages().at(-1) ?? null;
    });
  }

  private async page(): Promise<Page> {
    if (this.active && !this.active.isClosed()) return this.active;
    this.active = this.context.pages().find((p) => !p.isClosed()) ?? (await this.context.newPage());
    return this.active;
  }

  // fn을 실행하는 동안에만 양식 제출을 허용하고, 끝나면 바로 닫는다.
  private async withSubmit(allow: boolean, fn: () => Promise<void>): Promise<void> {
    this.submitAllowed = allow;
    try {
      await fn();
    } finally {
      this.submitAllowed = false;
      this.acceptNextDialog = false;
    }
  }

  takeNotices(): string[] {
    const n = this.notices;
    this.notices = [];
    return n;
  }

  private async settle(page: Page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
  }

  // 화면에 보이는 안쪽 프레임(iframe)들. 광고·추적용의 보이지 않는 프레임은 뺀다.
  private async visibleChildFrames(page: Page): Promise<Frame[]> {
    const out: Frame[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      if (out.length >= MAX_CHILD_FRAMES) break;
      try {
        const el = await frame.frameElement();
        const box = await el.boundingBox();
        await el.dispose();
        if (box && box.width >= 50 && box.height >= 30) out.push(frame);
      } catch {
        // 사라진 프레임
      }
    }
    return out;
  }

  async snapshot(): Promise<string> {
    const page = await this.page();
    this.snapSeq++;
    this.refFrames.clear();
    const prefix = String(this.snapSeq);
    let used = 0;
    let truncated = 0;
    const read = async (frame: Frame, isChild: boolean) => {
      const snap = await frame.evaluate(pageSnapshot, { prefix, start: used, max: MAX_ELEMENTS - used, textMax: isChild ? 2000 : 6000, isChild });
      for (const ref of snap.refs) this.refFrames.set(ref, frame);
      used += snap.refs.length;
      truncated += snap.truncated;
      return snap;
    };
    const main = await read(page.mainFrame(), false);
    const parts = [`주소: ${main.url}`, `제목: ${main.title}`, `누를 수 있는 요소 (ref로 지정):`, ...main.elements];
    const texts = [main.text + (main.textTruncated ? "\n(글이 길어서 잘림)" : "")];
    for (const frame of await this.visibleChildFrames(page)) {
      const snap = await read(frame, true).catch(() => null);
      if (!snap || (snap.elements.length === 0 && !snap.text)) continue;
      const label = `안쪽 프레임 (${snap.url.slice(0, 120)})`;
      if (snap.elements.length) parts.push(`-- ${label}의 요소 --`, ...snap.elements);
      if (snap.text) texts.push(`-- ${label}의 글 --\n${snap.text}${snap.textTruncated ? "\n(글이 길어서 잘림)" : ""}`);
    }
    if (truncated) parts.push(`(요소 ${truncated}개 더 있음. 스크롤 후 다시 스냅샷)`);
    parts.push("", "페이지 글:", texts.join("\n\n"));
    return parts.join("\n");
  }

  // 마지막 스냅샷에서 붙인 ref만 찾는다.
  private locate(ref: string): Locator | null {
    const frame = this.refFrames.get(cssEscape(ref));
    if (!frame || frame.isDetached()) return null;
    return frame.locator(`[data-agent-ref="${ref}"]`).first();
  }

  private mustLocate(ref: string): Locator {
    const locator = this.locate(ref);
    if (!locator) throw new Error(`ref ${ref}를 찾을 수 없습니다. 스냅샷을 다시 찍으세요.`);
    return locator;
  }

  async describe(ref: string): Promise<ElementInfo | null> {
    const locator = this.locate(ref);
    if (!locator) return null;
    const handle = await locator.elementHandle({ timeout: 2000 }).catch(() => null);
    if (!handle) return null;
    const info = await handle.evaluate(describeElement);
    await handle.dispose();
    return info;
  }

  // 지금 글자 입력을 받는 요소. 안쪽 프레임에 있으면 그 안까지 따라 들어간다.
  async focusedInfo(): Promise<ElementInfo | null> {
    const page = await this.page();
    let frame: Frame = page.mainFrame();
    for (let depth = 0; depth < 6; depth++) {
      const handle = await frame.evaluateHandle(deepActiveElement, depth > 0);
      const el = handle.asElement();
      if (!el) {
        await handle.dispose();
        return null;
      }
      const inner = await el.contentFrame();
      if (!inner) {
        const info = await el.evaluate(describeElement);
        await handle.dispose();
        return info;
      }
      await handle.dispose();
      frame = inner;
    }
    return null;
  }

  async goto(url: string, newTab: boolean): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("http(s) 주소만 열 수 있습니다");
    const page = newTab ? await this.context.newPage() : await this.page();
    this.active = page;
    try {
      await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (err) {
      // 주소가 바로 파일 내려받기로 이어지면 이동은 실패로 끝난다. 내려받기는 따로 처리된다.
      if (!/Download is starting/i.test(String((err as Error).message))) throw err;
    }
    await page.waitForTimeout(800);
  }

  async click(ref: string, opts: { acceptDialog: boolean; allowSubmit: boolean }): Promise<void> {
    const page = await this.page();
    const locator = this.mustLocate(ref);
    await this.withSubmit(opts.allowSubmit, async () => {
      if (opts.acceptDialog) this.acceptNextDialog = true;
      await locator.click({ timeout: 10000 });
      await this.settle(page);
    });
  }

  async type(ref: string, text: string): Promise<void> {
    await this.mustLocate(ref).fill(text, { timeout: 10000 });
  }

  async press(key: string, allowSubmit = false): Promise<void> {
    const page = await this.page();
    await this.withSubmit(allowSubmit, async () => {
      await page.keyboard.press(key);
      await this.settle(page);
    });
  }

  async select(ref: string, values: string[]): Promise<void> {
    await this.mustLocate(ref).selectOption(values, { timeout: 10000 });
  }

  // 파일 선택칸에 파일을 넣는다. ref가 파일 선택칸이 아니면 눌러서 파일 선택 창을 열고 거기에 넣는다.
  async upload(ref: string, paths: string[], opts: { isFileInput: boolean; allowSubmit: boolean }): Promise<void> {
    const page = await this.page();
    const locator = this.mustLocate(ref);
    const files = uploadPayload(paths);
    await this.withSubmit(opts.allowSubmit, async () => {
      if (opts.isFileInput) {
        await locator.setInputFiles(files, { timeout: 10000 });
      } else {
        this.expectingChooser = true;
        try {
          const waiting = page.waitForEvent("filechooser", { timeout: 6000 });
          waiting.catch(() => {}); // 클릭이 먼저 실패해도 처리되지 않은 오류로 남지 않게
          await locator.click({ timeout: 10000 });
          const chooser = await waiting.catch(() => null);
          if (!chooser) throw new Error("이 요소를 눌러도 파일 선택 창이 열리지 않았습니다. 스냅샷에서 [파일 선택칸] 표시가 있는 요소나 다른 버튼을 찾아보세요.");
          if (files.length > 1 && !chooser.isMultiple()) throw new Error("이 파일 선택 창은 파일을 한 개만 받습니다. 한 개씩 올리세요.");
          await chooser.setFiles(files, { timeout: 10000 });
        } finally {
          this.expectingChooser = false;
        }
      }
      await this.settle(page);
    });
  }

  async scroll(direction: "up" | "down", screens: number): Promise<void> {
    const page = await this.page();
    await page.mouse.wheel(0, (direction === "down" ? 1 : -1) * 700 * screens);
    await page.waitForTimeout(500);
  }

  async back(): Promise<void> {
    const page = await this.page();
    await page.goBack({ timeout: 15000 }).catch(() => {});
    await this.settle(page);
  }

  async screenshot(): Promise<Buffer> {
    const page = await this.page();
    const shot = await page.screenshot({ type: "jpeg", quality: 70 });
    this.lastScreenshot = shot;
    return shot;
  }

  async tabs(): Promise<string> {
    const pages = this.context.pages();
    const current = await this.page();
    const rows = await Promise.all(
      pages.map(async (p, i) => `${i}${p === current ? " (현재)" : ""}: ${await p.title().catch(() => "")} - ${p.url()}`),
    );
    return rows.join("\n");
  }

  async switchTab(index: number): Promise<void> {
    const page = this.context.pages()[index];
    if (!page) throw new Error(`탭 ${index} 없음`);
    this.active = page;
    await page.bringToFront();
  }

  async closeTab(index: number): Promise<void> {
    const page = this.context.pages()[index];
    if (!page) throw new Error(`탭 ${index} 없음`);
    await page.close();
  }

  async currentOrigin(): Promise<string> {
    return new URL((await this.page()).url()).origin;
  }

  // 금고의 로그인 정보를 화면에 직접 입력한다. 값은 AI에게 돌아가지 않는다.
  // 비밀번호 칸이 안쪽 프레임에 있으면, 그 프레임의 주소가 저장된 주소와 같아야 한다.
  async fillLogin(entry: VaultEntry): Promise<void> {
    const page = await this.page();
    const frames = [page.mainFrame(), ...(await this.visibleChildFrames(page))];
    const seen: string[] = [];
    let hasPassword = false;
    for (const frame of frames) {
      const password = frame.locator('input[type="password"]:visible').first();
      if ((await password.count().catch(() => 0)) === 0) continue;
      hasPassword = true;
      let origin = "";
      try {
        origin = new URL(frame.url()).origin;
      } catch {
        // about:blank 같은 프레임
      }
      if (origin !== entry.origin) {
        seen.push(origin || frame.url());
        continue;
      }
      const user = frame
        .locator(
          'input[autocomplete="username"]:visible, input[type="email"]:visible, input[name*="id" i]:visible, input[name*="user" i]:visible, input[name*="email" i]:visible, input[name*="login" i]:visible, input[type="text"]:visible',
        )
        .first();
      if ((await user.count()) > 0) await user.fill(entry.username);
      await password.fill(entry.password);
      return;
    }
    if (!hasPassword) throw new Error("이 페이지에 비밀번호 칸이 보이지 않습니다");
    throw new Error(`비밀번호 칸이 있는 주소(${seen.join(", ")})는 이 로그인 정보의 주소(${entry.origin})와 달라서 입력하지 않았습니다`);
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }
}

function cssEscape(ref: string): string {
  if (!/^[0-9]+-[0-9]+$/.test(ref)) throw new Error(`잘못된 ref: ${ref}`);
  return ref;
}

const sessions = new Map<string, Promise<BrowserSession>>();

export function browserFor(login: string): Promise<BrowserSession> {
  let s = sessions.get(login);
  if (!s) {
    s = BrowserSession.open(login);
    sessions.set(login, s);
    s.catch(() => sessions.delete(login));
  }
  return s;
}

// 이미 열린 브라우저만 돌려준다(화면 보기 요청 때문에 새 브라우저를 띄우지 않도록).
export function openedBrowser(login: string): Promise<BrowserSession> | undefined {
  return sessions.get(login);
}

export async function closeAllBrowsers(): Promise<void> {
  for (const s of sessions.values()) await (await s).close();
  sessions.clear();
}
