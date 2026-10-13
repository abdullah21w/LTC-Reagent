// jsdom environment for interaction tests: the real React components, rendered
// with react-dom/client and driven like a user (click, type, select).
import { JSDOM } from "jsdom";

export function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  const w = dom.window;
  for (const k of Object.getOwnPropertyNames(w)) if (!(k in globalThis)) { try { globalThis[k] = w[k]; } catch {} }
  for (const [k, v] of Object.entries({ window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, Node: w.Node, Event: w.Event, localStorage: w.localStorage })) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // React errors/warnings are collected and asserted on by each suite.
  const errors = [];
  const original = console.error;
  console.error = (...a) => { const m = a.map(String).join(" "); if (!/not wrapped in act|width\(0\) and height\(0\)/.test(m)) errors.push(m.slice(0, 300)); };
  return { w, errors, close() { console.error = original; w.close(); } };
}

/** Rendering and user-event helpers bound to a bundle exporting createRoot/act. */
export function ui(A, w) {
  let root = null, host = null;
  const api = {
    get host() { return host; },
    async mount(el) {
      host = document.createElement("div"); document.body.appendChild(host);
      root = A.createRoot(host);
      await A.act(async () => { root.render(el); });
      await A.act(async () => {});
      return host;
    },
    async unmount() { await A.act(async () => root.unmount()); host.remove(); host = null; },
    /** Visible text with a space between separate text nodes (like reading the screen). */
    textOf(el) { const out = []; const it = document.createTreeWalker(el, 4); let n; while ((n = it.nextNode())) out.push(n.nodeValue); return out.join(" ").replace(/\s+/g, " ").trim(); },
    text() { return host.textContent.replace(/\s+/g, " "); },
    buttons(label) { return [...host.querySelectorAll("button")].filter((b) => b.textContent.replace(/\s+/g, " ").trim() === label); },
    inputByLabel(label) { return [...host.querySelectorAll("label")].find((l) => l.textContent.startsWith(label))?.querySelector("input"); },
    async click(el) { if (!el) throw new Error("nothing to click"); await A.act(async () => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); }); },
    async type(input, value) {
      if (!input) throw new Error("no input");
      const proto = input.tagName === "SELECT" ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
      await A.act(async () => { input.dispatchEvent(new w.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
    },
    async settle() { await A.act(async () => {}); },
  };
  return api;
}

/**
 * Supabase stub source: reads resolve with empty data (or the counts in
 * globalThis.__history for the Edit Lot history lookup); every write is
 * recorded in globalThis.__writes and never performed.
 */
export const STUB_SUPABASE = `
const rec = (t, op) => { (globalThis.__writes ||= []).push([t, op]); };
export const supabase = { from: (t) => {
  const h = globalThis.__history || { logs: 0, countLines: 0 };
  const o = new Proxy({}, { get: (_, k) => {
    if (k === "then") return (r) => h.hang ? new Promise(() => {}) : r(h.error ? { data: null, count: null, error: { message: "lookup failed" } } : { data: [], count: t === "consumption_logs" ? h.logs : t === "inventory_count_items" ? h.countLines : 0, error: null });
    if (["insert", "update", "delete", "upsert"].includes(k)) return () => { rec(t, k); return o; };
    return () => o;
  } });
  return o;
}, rpc: (n) => { rec("rpc", n); return Promise.resolve({ data: null, error: null }); } };
`;
