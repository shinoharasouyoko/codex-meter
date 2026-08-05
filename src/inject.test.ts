import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { probeSession } from "../src-tauri/resources/injector.mjs";

interface InjectedState {
  timer?: unknown;
  setQuota: (quota: { status: string; percent: number | null; resetsAt: string | null }) => void;
  getFontColor: () => string | null;
  setFontColor: (color: string | null) => void;
  dispose: () => void;
}

describe("title-bar quota injection", () => {
  it("renders pushed quota data without a mock timer", async () => {
    const script = await readFile(
      new URL("../src-tauri/resources/inject.js", import.meta.url),
      "utf8",
    );
    const dom = new JSDOM(`<!doctype html><html><body>
      <div class="group/application-menu-top-bar">
        <div><button aria-haspopup="menu" aria-label="帮助">帮助</button></div>
      </div>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });

    dom.window.eval(script);
    const state = (dom.window as unknown as { __CODEX_METER_STATE__: InjectedState })
      .__CODEX_METER_STATE__;
    expect(state).toBeDefined();
    expect(state.timer).toBeUndefined();

    state.setQuota({
      status: "ok",
      percent: 49,
      resetsAt: "2026-08-20T00:00:00",
    });
    const host = dom.window.document.getElementById("codex-meter-widget");
    const battery = host?.shadowRoot?.querySelector<HTMLElement>(".battery");
    const fill = host?.shadowRoot?.querySelector<HTMLElement>(".battery-fill");
    const text = host?.shadowRoot?.querySelector<HTMLElement>(".battery-text");
    const fillText = host?.shadowRoot?.querySelector<HTMLElement>(".battery-text-fill");
    const date = host?.shadowRoot?.querySelector<HTMLElement>(".date");
    const styleText = host?.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(host?.previousElementSibling?.getAttribute("aria-label")).toBe("帮助");
    expect(battery?.dataset.level).toBe("warning");
    expect(fill?.style.width).toBe("49%");
    expect(text?.textContent).toBe("49");
    expect(fillText?.textContent).toBe("49");
    expect(battery?.style.getPropertyValue("--battery-percent")).toBe("49%");
    expect(date?.textContent).toBe("8月20日");
    expect(date?.hidden).toBe(false);
    expect(styleText).toMatch(/\.date\s*\{[^}]*display:\s*none/);
    expect(styleText).toMatch(/\.widget:hover \.date\s*\{[^}]*display:\s*inline/);
    expect(styleText).toContain("clip-path: inset(0 calc(100% - var(--battery-percent, 0%)) 0 0)");
    expect(styleText).toContain("--meter-default-font-color: #767680");
    expect(styleText).toMatch(/\.battery-text\s*\{[^}]*color:\s*var\(--meter-default-font-color\)/);

    state.setFontColor("#aBc123");
    expect(state.getFontColor()).toBe("#ABC123");
    expect(host?.dataset.fontColor).toBe("custom");
    expect(host?.style.getPropertyValue("--meter-font-color")).toBe("#ABC123");
    state.setFontColor(null);
    expect(state.getFontColor()).toBeNull();
    expect(host?.dataset.fontColor).toBeUndefined();

    state.setQuota({
      status: "ok",
      percent: 19,
      resetsAt: "2026-08-20T00:00:00",
    });
    expect(battery?.dataset.level).toBe("critical");
    expect(fill?.style.width).toBe("19%");
    expect(text?.textContent).toBe("19");
    expect(fillText?.textContent).toBe("19");

    state.setQuota({ status: "unavailable", percent: null, resetsAt: null });
    expect(text?.textContent).toBe("--");
    expect(fillText?.textContent).toBe("--");
    expect(battery?.style.getPropertyValue("--battery-percent")).toBe("0%");
    expect(date?.hidden).toBe(true);

    state.dispose();
    expect(dom.window.document.getElementById("codex-meter-widget")).toBeNull();
    dom.window.close();
  });

  it("mounts in the current native application menu after Help", async () => {
    const script = await readFile(
      new URL("../src-tauri/resources/inject.js", import.meta.url),
      "utf8",
    );
    const dom = new JSDOM(`<!doctype html><html><body>
      <div class="_ApplicationMenuTopBar_zbk1f_3">
        <div role="menubar"><button role="menuitem" aria-label="Help">?</button></div>
      </div>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });

    dom.window.eval(script);

    const host = dom.window.document.getElementById("codex-meter-widget");
    expect(host).not.toBeNull();
    expect(host?.previousElementSibling?.getAttribute("aria-label")).toBe("Help");

    (dom.window as unknown as { __CODEX_METER_STATE__: InjectedState })
      .__CODEX_METER_STATE__.dispose();
    dom.window.close();
  });

  it("does not mount in the active conversation header", async () => {
    const script = await readFile(
      new URL("../src-tauri/resources/inject.js", import.meta.url),
      "utf8",
    );
    const dom = new JSDOM(`<!doctype html><html><body>
      <header data-testid="app-shell-header-context-menu-surface">
        <button role="button" aria-label="Help">?</button>
      </header>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });

    dom.window.eval(script);

    expect(dom.window.document.getElementById("codex-meter-widget")).toBeNull();
    (dom.window as unknown as { __CODEX_METER_STATE__: InjectedState })
      .__CODEX_METER_STATE__.dispose();
    dom.window.close();
  });

  it("recognizes the Codex 26.727 Settings surface before a main region exists", async () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <section data-settings-panel-slug="general-settings"></section>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });
    const probe = await probeSession({
      evaluate: async (expression: string) => dom.window.eval(expression),
    });

    expect(probe.codex).toBe(true);
    expect(probe.markers.settings).toBe(true);
    dom.window.close();
  });
});
