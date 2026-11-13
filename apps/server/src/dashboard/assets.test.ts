import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { appDocument, type ShellContext } from "./ui/components.js";
import { html } from "./ui/html.js";
import { renderLogin } from "./views/login.js";
import { renderActivate } from "./views/activate.js";
import { renderConnect } from "./views/connect.js";
import { renderSupportDashboard, type SupportFormState } from "./views/support.js";
import { renderConsentPage } from "../oauth/consent-page.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
async function asset() {
  const db = createDatabase(":memory:");
  const app = buildApp({ db, config: { databasePath: ":memory:", publicBaseUrl: new URL("http://127.0.0.1:4413"), environment: "test" } });
  cleanup.push(async () => { await app.close(); db.close(); });
  return app.inject({ method: "GET", url: "/dashboard/assets/ui.js" });
}
const ctx: ShellContext = { locale: "en", account: null, nav: "overview", path: "/dashboard", csrf: "fixture", publicBaseUrl: new URL("http://127.0.0.1:4413") };

// Small DOM boundary double: no browser dependency in the server suite. The
// same script is also checked in a real, account-free browser fixture during QA.
class Element {
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  value = ""; type = "text"; name = ""; id = ""; className = ""; textContent = "";
  min = ""; max = ""; step = "";
  validity = { valid: true, rangeOverflow: false }; validityReports = 0;
  required = false; disabled = false; hidden = false; maxLength = 0; parent: Element | null = null;
  children: Element[] = []; elements: Element[] = [];
  events = new Map<string, Array<(e: any) => unknown>>();
  style: Record<string, string> = {};
  focused = false; selected = false;
  classList = { add: (c: string) => { this.className += " " + c; }, remove: (c: string) => { this.className = this.className.split(" ").filter(x => x !== c).join(" "); }, toggle: (c: string, on: boolean) => { this.classList.remove(c); if (on) this.classList.add(c); }, contains: (c: string) => this.className.split(" ").includes(c) };
  constructor(readonly tagName: string) {}
  get form(): Element | null { return this.tagName === "FORM" ? null : this.closest("form"); }
  get selectedOptions() { return this.children.filter(child => child.tagName === "OPTION" && child.value === this.value); }
  reportValidity() { this.validityReports++; return this.validity.valid; }
  setAttribute(k: string, v: string) { this.attributes[k] = String(v); }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  removeAttribute(k: string) { delete this.attributes[k]; if (k === "required") this.required = false; }
  addEventListener(name: string, fn: (e: any) => unknown) { this.events.set(name, [...(this.events.get(name) ?? []), fn]); }
  async fire(name: string, fields: Record<string, unknown> = {}) {
    const event = { target: this, prevented: false, preventDefault() { this.prevented = true; }, ...fields };
    for (const fn of this.events.get(name) ?? []) await fn(event);
    return event;
  }
  append(...nodes: Element[]) { for (const el of nodes) { el.parent = this; this.children.push(el); } }
  appendChild(el: Element) { this.append(el); return el; }
  after(el: Element) { this.parent?.append(el); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  closest(selector: string): Element | null { return selector === "form" && this.tagName === "FORM" ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector: string): Element[] {
    const descendants = this.children.flatMap(c => [c, ...c.querySelectorAll("*")]);
    if (selector === "*") return descendants;
    if (selector === ".cell") return descendants.filter(c => c.classList.contains("cell"));
    if (selector === '[data-copy-label]') return descendants.filter(c => "copyLabel" in c.dataset);
    if (selector.includes("submit")) return descendants.filter(c => c.type === "submit");
    return [];
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  setSelectionRange() { this.selected = true; }
}
async function dom(options: { rejectCopy?: boolean; noTargets?: boolean } = {}) {
  const response = await asset(); expect(response.statusCode).toBe(200);
  const body = new Element("BODY"), form = new Element("FORM"), input = new Element("INPUT"), submit = new Element("BUTTON");
  input.id = "pairing-code"; input.name = "userCode"; input.dataset = { codeInput: "", cellLabel: "Code character {index}" }; input.required = true; input.value = "k7qm4wxp";
  submit.type = "submit"; form.append(input, submit); form.elements = [input, submit]; body.append(form);
  const copy = new Element("BUTTON"), label = new Element("SPAN"); copy.dataset = { copy: '<a>&command', copiedLabel: "Copied" }; label.dataset.copyLabel = ""; label.textContent = "Copy"; copy.append(label); body.append(copy);
  const suggestion = new Element("BUTTON"), name = new Element("INPUT"); suggestion.dataset.fillTarget = "friendly-name"; suggestion.textContent = "Work PC"; name.id = "friendly-name"; body.append(suggestion, name);
  const danger = new Element("FORM"), confirm = new Element("INPUT"), dangerSubmit = new Element("BUTTON"); confirm.dataset.confirmMatch = "revoke all"; dangerSubmit.type = "submit"; danger.append(confirm, dangerSubmit); danger.elements = [confirm, dangerSubmit]; body.append(danger);
  const copied: string[] = [], timers: Array<() => void> = [];
  const targets: Record<string, Element[]> = { "[data-copy]": [copy], "input[data-code-input]": [input], "[data-fill-target]": [suggestion], "input[data-confirm-match]": [confirm] };
  const document = { body, createElement: (tag: string) => new Element(tag.toUpperCase()), querySelectorAll: (s: string) => options.noTargets ? [] : targets[s] ?? [], getElementById: (id: string) => id === name.id ? name : id === input.id ? input : null };
  runInNewContext(response.body, { document, navigator: { clipboard: { writeText: async (text: string) => { if (options.rejectCopy) throw Error("denied"); copied.push(text); } } }, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, Event: class { constructor(public type: string) {} } });
  return { body, form, input, submit, copy, label, suggestion, name, confirm, dangerSubmit, copied, timers, cells: () => body.querySelectorAll(".cell") };
}

async function durationDom(state: SupportFormState = {}) {
  const response = await asset();
  const page = renderSupportDashboard(ctx, [], new Map(), true, state);
  const inputTag = page.match(/<input\b[^>]*name="inviteDuration"[^>]*>/)?.[0] ?? "";
  const selectTag = page.match(/<select\b[^>]*name="inviteDurationUnit"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
  const attribute = (tag: string, name: string) => tag.match(new RegExp(name + '="([^"]*)"'))?.[1] ?? "";
  const input = new Element("INPUT"), unit = new Element("SELECT"), form = new Element("FORM");
  const formTag = page.match(/<form\b[^>]*action="\/dashboard\/support\/create"[^>]*>/)?.[0] ?? "";
  const serverValidationOnly = /\bnovalidate\b/.test(formTag);
  if (serverValidationOnly) form.setAttribute("novalidate", "");
  form.append(input, unit);
  input.id = attribute(inputTag, "id"); input.value = attribute(inputTag, "value");
  input.min = attribute(inputTag, "min"); input.max = attribute(inputTag, "max"); input.step = attribute(inputTag, "step");
  unit.dataset.durationInput = attribute(selectTag, "data-duration-input");
  for (const tag of selectTag.match(/<option\b[^>]*>/g) ?? []) {
    const option = new Element("OPTION");
    option.value = attribute(tag, "value"); option.dataset.max = attribute(tag, "data-max");
    unit.append(option);
    if (/\bselected\b/.test(tag)) unit.value = option.value;
  }
  for (const [element, tag] of [[input, inputTag], [unit, selectTag]] as const) {
    element.setAttribute("aria-invalid", attribute(tag, "aria-invalid"));
    element.setAttribute("aria-describedby", attribute(tag, "aria-describedby"));
  }
  runInNewContext(response.body, { document: {
    querySelectorAll: (selector: string) => selector === "select[data-duration-input]" && unit.dataset.durationInput ? [unit] : [],
    getElementById: (id: string) => id === input.id ? input : null,
  } });
  return { input, unit, form, serverValidationOnly };
}

describe("dashboard enhancement asset", () => {
  it("polls live detail state without interrupting edits or binding onboarding copy handlers", async () => {
    const response = await asset();
    const card = { dataset: { deviceId: "device-1", state: "OFFLINE" } };
    const name = { value: "Owned", defaultValue: "Owned" };
    const document = { activeElement: { tagName: "BODY" }, querySelectorAll: (s: string) => s === "[data-live-status]" ? [card] : s === 'input[name="name"]' ? [name] : [] };
    let state = "OFFLINE", reloads = 0, ok = true;
    let poll: (() => Promise<void>) | undefined;
    const requests: unknown[][] = [];
    runInNewContext(response.body, {
      document,
      fetch: async (...args: unknown[]) => { requests.push(args); return { ok, json: async () => ({ state }) }; },
      location: { reload: () => { reloads++; } },
      setInterval: (fn: () => Promise<void>, ms: number) => { expect(ms).toBe(2500); poll = fn; },
    });
    await poll!();
    expect(requests[0]).toEqual(["/dashboard/devices/device-1/status", { credentials: "same-origin", cache: "no-store" }]);
    expect(reloads).toBe(0);
    state = "READY"; document.activeElement.tagName = "INPUT";
    await poll!(); expect(reloads).toBe(0);
    name.value = "Unsaved rename"; document.activeElement.tagName = "BUTTON";
    await poll!(); expect(reloads).toBe(0);
    name.value = name.defaultValue;
    document.activeElement.tagName = "BODY";
    await poll!(); expect(reloads).toBe(1);
    ok = false; await poll!(); expect(reloads).toBe(1);
  });
  it("serves a small same-origin JavaScript asset with safe response headers", async () => {
    const response = await asset();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.byteLength(response.body)).toBeLessThan(6 * 1024);
    expect(response.body).toContain("data-copy"); expect(response.body).toContain("data-code-input");
  });
  it("enhances dashboard, standalone pairing and every wizard step, never private pages", () => {
    const script = '<script src="/dashboard/assets/ui.js" defer></script>';
    expect(appDocument({ ctx, title: "Overview", body: html`<h1>Overview</h1>` })).toContain(script);
    expect(renderActivate(ctx, { error: null, values: { userCode: "", friendlyName: "" } })).toContain(script);
    for (const step of [1, 2, 3] as const) expect(renderConnect(ctx, { step, os: "win", error: null, values: { userCode: "", friendlyName: "" } })).toContain(script);
    expect(renderLogin({ locale: "en", returnTo: "/dashboard", csrf: "x", githubEnabled: true, error: null })).not.toContain("<script");
    expect(renderConsentPage({ returnTo: "/oauth/authorize?x=1", csrf: "x", clientId: "x", redirectUri: "https://client.example/cb", scope: "mcp offline_access" })).not.toContain("<script");
  });
  it("enables native validation only when unit synchronization is available", async () => {
    const d = await durationDom({ inviteDuration: "8", inviteDurationUnit: "days", expiryError: true });
    expect(d.serverValidationOnly).toBe(true);
    expect(d.form.getAttribute("novalidate")).toBeNull();
    expect(d.input.max).toBe("7");
    expect(d.input.value).toBe("8");
  });
  it("updates duration limits without replacing the typed value and reports an overflow", async () => {
    const d = await durationDom({ inviteDuration: "169" });
    expect(d.input.max).toBe("10080");
    for (const [unit, max] of [["hours", "168"], ["days", "7"]] as const) {
      d.unit.value = unit;
      // Native validity is supplied at the DOM boundary; real-browser QA checks it.
      d.input.validity = { valid: false, rangeOverflow: true };
      await d.unit.fire("change", { type: "change" });
      expect(d.input.max).toBe(max);
      expect(d.input.value).toBe("169");
      expect(d.input.getAttribute("aria-invalid")).toBe("true");
      expect(d.unit.getAttribute("aria-invalid")).toBe("true");
    }
    expect(d.input.validityReports).toBe(2);
    d.unit.value = "minutes"; d.input.validity = { valid: true, rangeOverflow: false };
    await d.unit.fire("change", { type: "change" });
    expect(d.input.max).toBe("10080"); expect(d.input.value).toBe("169");
    expect(d.input.min).toBe("1"); expect(d.input.step).toBe("1");
    expect(d.input.getAttribute("aria-invalid")).toBe("false");
    expect(d.unit.getAttribute("aria-invalid")).toBe("false");
    expect(d.input.validityReports).toBe(2);
  });
  it("preserves a server error on load and clears invalid state when the value is corrected", async () => {
    const d = await durationDom({ inviteDuration: "8", inviteDurationUnit: "days", expiryError: true });
    expect(d.input.max).toBe("7"); expect(d.input.value).toBe("8");
    for (const field of [d.input, d.unit]) {
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe("support-invite-duration-hint support-invite-duration-error");
    }
    d.input.value = "7"; d.input.validity = { valid: true, rangeOverflow: false };
    await d.input.fire("input", { type: "input" });
    expect(d.input.max).toBe("7"); expect(d.input.value).toBe("7");
    expect(d.input.getAttribute("aria-invalid")).toBe("false");
    expect(d.unit.getAttribute("aria-invalid")).toBe("false");
    for (const field of [d.input, d.unit]) {
      expect(field.getAttribute("aria-describedby")).toBe("support-invite-duration-hint");
    }
    expect(d.input.validityReports).toBe(0);
  });
  it("keeps an unselected unit invalid until the user chooses a supported unit", async () => {
    const d = await durationDom({ inviteDuration: "2", inviteDurationUnit: "weeks", expiryError: true });
    d.unit.validity = { valid: false, rangeOverflow: false };
    await d.input.fire("input", { type: "input" });
    expect(d.unit.getAttribute("aria-invalid")).toBe("true");
    d.unit.value = "hours"; d.unit.validity = { valid: true, rangeOverflow: false };
    await d.unit.fire("change", { type: "change" });
    expect(d.input.max).toBe("168"); expect(d.input.value).toBe("2");
    expect(d.input.getAttribute("aria-invalid")).toBe("false");
    expect(d.unit.getAttribute("aria-invalid")).toBe("false");
  });
  it("does nothing on a page without enhancement targets", async () => { const d = await dom({ noTargets: true }); expect(d.cells()).toHaveLength(0); expect(d.input.type).toBe("text"); });
  it("copies the exact payload and restores the localized label", async () => {
    const d = await dom(); await d.copy.fire("click"); expect(d.copied).toEqual(['<a>&command']); expect(d.label.textContent).toBe("Copied"); d.timers.forEach(fn => fn()); expect(d.label.textContent).toBe("Copy");
  });
  it("selects a visible fallback without claiming copy succeeded when clipboard is denied", async () => {
    const d = await dom({ rejectCopy: true }); await d.copy.fire("click"); expect(d.copied).toEqual([]); expect(d.label.textContent).toBe("Copy"); expect(d.body.children.some(n => n.tagName === "TEXTAREA" && n.value === '<a>&command' && n.selected)).toBe(true);
  });
  it("keeps the original submitted name and creates eight labeled required cells", async () => {
    const d = await dom(); expect(d.input.type).toBe("hidden"); expect(d.input.name).toBe("userCode"); expect(d.cells()).toHaveLength(8); expect(d.input.value).toBe("K7QM-4WXP"); expect(d.cells()[7]?.getAttribute("aria-label")).toBe("Code character 8"); expect(d.cells().every(c => c.required)).toBe(true);
  });
  it("uppercases, filters invalid characters, advances and backspaces", async () => {
    const d = await dom(); const first = d.cells()[0]!, second = d.cells()[1]!;
    first.value = "z"; await first.fire("input"); expect(first.value).toBe("Z"); expect(second.focused).toBe(true);
    second.value = "0O1I"; await second.fire("input"); expect(second.value).toBe("");
    await second.fire("keydown", { key: "Backspace" }); expect(first.value).toBe(""); expect(first.focused).toBe(true);
    expect(d.input.value).not.toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
  it("distributes a whole-code paste and clears stale trailing characters", async () => {
    const d = await dom(); await d.cells()[0]!.fire("paste", { clipboardData: { getData: () => "abcd-efgh" } }); expect(d.input.value).toBe("ABCD-EFGH");
    await d.cells()[0]!.fire("paste", { clipboardData: { getData: () => "k7" } }); expect(d.cells().slice(2).every(c => c.value === "")).toBe(true);
    const submit = await d.form.fire("submit"); expect(submit.prevented).toBe(true);
  });
  it("fills suggested names and requires exact confirmation text", async () => {
    const d = await dom(); await d.suggestion.fire("click"); expect(d.name.value).toBe("Work PC"); expect(d.dangerSubmit.disabled).toBe(true);
    d.confirm.value = "revoke all "; await d.confirm.fire("input"); expect(d.dangerSubmit.disabled).toBe(true);
    d.confirm.value = "revoke all"; await d.confirm.fire("input"); expect(d.dangerSubmit.disabled).toBe(false);
  });
});
