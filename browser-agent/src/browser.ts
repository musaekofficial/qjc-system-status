// 맥미니에 실제 브라우저 창을 띄우고, 사람이 하듯이 클릭·입력한다(Playwright).
// 사람마다 브라우저 프로필이 따로 있어서 로그인·쿠키가 섞이지 않는다.
// 되돌릴 수 없는 동작(게시, 결제, 전송, 삭제 등)은 여기서 "위험"으로 분류하고,
// 실행은 agent.ts가 사장님 승인을 받은 뒤에만 한다(결정 셋).
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CONFIG, DATA_DIR } from "./config.ts";
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

export function classifyEnter(info: ElementInfo | null): Risk {
  if (!info) return { risky: false };
  if (info.editable) return { risky: true, reason: "글 입력칸에서 Enter (메시지·댓글 전송일 수 있음)" };
  if (info.searchLike) return { risky: false };
  if (info.inForm && (info.formMethod === "get" || info.formHasPassword)) return { risky: false };
  if (info.tag === "input") return { risky: true, reason: "입력칸에서 Enter (양식 제출일 수 있음)" };
  return { risky: false };
}

// ---- 페이지 안에서 실행되는 함수들 (브라우저 쪽 코드) ----

function pageSnapshot(maxElements: number) {
  const SELECTOR =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="combobox"], [role="searchbox"], [role="textbox"], [contenteditable=""], [contenteditable="true"], [onclick]';
  for (const el of Array.from(document.querySelectorAll("[data-agent-ref]"))) el.removeAttribute("data-agent-ref");
  const w = window as unknown as { __agentRefSeq?: number };
  w.__agentRefSeq = (w.__agentRefSeq ?? 0) + 1;
  const prefix = `${w.__agentRefSeq}`;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const clean = (t: string | null | undefined, n = 80) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const lines: string[] = [];
  let count = 0;
  let total = 0;
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (!visible(el)) continue;
    total++;
    if (count >= maxElements) continue;
    count++;
    const ref = `${prefix}-${count}`;
    el.setAttribute("data-agent-ref", ref);
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const type = (input.type ?? "").toLowerCase();
    const role = el.getAttribute("role") ?? "";
    const label =
      clean(el.getAttribute("aria-label")) ||
      clean((el as HTMLElement).innerText) ||
      clean(el.getAttribute("placeholder")) ||
      clean(el.getAttribute("title")) ||
      clean(el.getAttribute("alt")) ||
      clean(el.getAttribute("name"));
    let extra = "";
    if (tag === "a") extra += ` href=${clean((el as HTMLAnchorElement).href, 120)}`;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (type === "password") extra += " [비밀번호칸]";
      else if (type === "checkbox" || type === "radio") extra += input.checked ? " [체크됨]" : " [체크안됨]";
      else if (input.value) extra += ` 값="${clean(input.value, 60)}"`;
    }
    if ((el as HTMLButtonElement).disabled) extra += " [비활성]";
    const kind = role || (tag === "input" ? `input:${type || "text"}` : tag);
    lines.push(`[${ref}] ${kind} "${label}"${extra}`);
  }
  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    url: location.href,
    title: document.title,
    elements: lines,
    truncated: total > count ? total - count : 0,
    text: text.slice(0, 6000),
    textTruncated: text.length > 6000,
  };
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
    searchLike:
      type === "search" || el.getAttribute("role") === "searchbox" || /검색|search|찾기|query|keyword/i.test(hint),
    editable: tag === "textarea" || (el as HTMLElement).isContentEditable,
  };
}

// ---- 사람 한 명의 브라우저 ----

export class BrowserSession {
  readonly login: string;
  private context: BrowserContext;
  private active: Page | null = null;
  private submitAllowed = false; // 승인된(또는 로그인) 동작 하나를 실행하는 동안에만 true
  private acceptNextDialog = false;
  private notices: string[] = [];
  lastScreenshot: Buffer | null = null;

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
    });
    const session = new BrowserSession(login, context);
    // 양식 제출(POST 페이지 이동)은 승인된 동작을 실행하는 그 순간에만 허용한다.
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

  async snapshot(): Promise<string> {
    const page = await this.page();
    const snap = await page.evaluate(pageSnapshot, 250);
    const parts = [
      `주소: ${snap.url}`,
      `제목: ${snap.title}`,
      `누를 수 있는 요소 (ref로 지정):`,
      ...snap.elements,
    ];
    if (snap.truncated) parts.push(`(요소 ${snap.truncated}개 더 있음. 스크롤 후 다시 스냅샷)`);
    parts.push("", "페이지 글:", snap.text + (snap.textTruncated ? "\n(글이 길어서 잘림)" : ""));
    return parts.join("\n");
  }

  async describe(ref: string): Promise<ElementInfo | null> {
    const page = await this.page();
    const handle = await page.$(`[data-agent-ref="${cssEscape(ref)}"]`);
    if (!handle) return null;
    const info = await handle.evaluate(describeElement);
    await handle.dispose();
    return info;
  }

  async focusedInfo(): Promise<ElementInfo | null> {
    const page = await this.page();
    const handle = await page.evaluateHandle(() =>
      document.activeElement && document.activeElement !== document.body ? document.activeElement : null,
    );
    const el = handle.asElement();
    const info = el ? await el.evaluate(describeElement) : null;
    await handle.dispose();
    return info;
  }

  async goto(url: string, newTab: boolean): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("http(s) 주소만 열 수 있습니다");
    const page = newTab ? await this.context.newPage() : await this.page();
    this.active = page;
    await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
  }

  async click(ref: string, opts: { acceptDialog: boolean; allowSubmit: boolean }): Promise<void> {
    const page = await this.page();
    await this.withSubmit(opts.allowSubmit, async () => {
      if (opts.acceptDialog) this.acceptNextDialog = true;
      await page.locator(`[data-agent-ref="${cssEscape(ref)}"]`).first().click({ timeout: 10000 });
      await this.settle(page);
    });
  }

  async type(ref: string, text: string): Promise<void> {
    const page = await this.page();
    await page.locator(`[data-agent-ref="${cssEscape(ref)}"]`).first().fill(text, { timeout: 10000 });
  }

  async press(key: string, allowSubmit = false): Promise<void> {
    const page = await this.page();
    await this.withSubmit(allowSubmit, async () => {
      await page.keyboard.press(key);
      await this.settle(page);
    });
  }

  async select(ref: string, values: string[]): Promise<void> {
    const page = await this.page();
    await page.locator(`[data-agent-ref="${cssEscape(ref)}"]`).first().selectOption(values, { timeout: 10000 });
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
  async fillLogin(entry: VaultEntry): Promise<void> {
    const page = await this.page();
    const origin = new URL(page.url()).origin;
    if (origin !== entry.origin) {
      throw new Error(`지금 주소(${origin})는 이 로그인 정보의 주소(${entry.origin})와 달라서 입력하지 않았습니다`);
    }
    const password = page.locator('input[type="password"]:visible').first();
    if ((await password.count()) === 0) throw new Error("이 페이지에 비밀번호 칸이 보이지 않습니다");
    const user = page
      .locator(
        'input[autocomplete="username"]:visible, input[type="email"]:visible, input[name*="id" i]:visible, input[name*="user" i]:visible, input[name*="email" i]:visible, input[name*="login" i]:visible, input[type="text"]:visible',
      )
      .first();
    if ((await user.count()) > 0) await user.fill(entry.username);
    await password.fill(entry.password);
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
