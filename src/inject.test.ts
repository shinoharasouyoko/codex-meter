import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseControlLine, probeSession } from "../src-tauri/resources/injector.mjs";

interface InjectedState {
  timer?: unknown;
  setQuota: (quota: {
    status: string;
    shortWindow: { percent: number; resetsAt: string | null } | null;
    weeklyWindow: { percent: number; resetsAt: string | null } | null;
  }) => void;
  getFontColor: () => string | null;
  setFontColor: (color: string | null) => void;
  setWeather: (weather: {
    status: string;
    current: { emoji: string; description: string; temperature: number } | null;
    nextHour: { emoji: string; description: string; temperature: number } | null;
    tomorrow: { emoji: string; description: string; temperatureMin: number; temperatureMax: number } | null;
  }) => void;
  dispose: () => void;
}

describe("title-bar quota injection", () => {
  it("keeps both quota windows when parsing an injector update", () => {
    expect(parseControlLine('{"type":"quota","status":"ok","shortWindow":{"percent":49,"resetsAt":"2026-08-20T00:00:00Z"},"weeklyWindow":{"percent":83,"resetsAt":"2026-08-25T00:00:00Z"}}')).toEqual({
      type: "quota",
      status: "ok",
      shortWindow: { percent: 49, resetsAt: "2026-08-20T00:00:00Z" },
      weeklyWindow: { percent: 83, resetsAt: "2026-08-25T00:00:00Z" },
    });
  });

  it("parses a weather update with only safe display fields", () => {
    expect(parseControlLine('{"type":"weather","status":"ok","current":{"emoji":"☀️","description":"晴","temperature":21.4},"nextHour":{"emoji":"🌤️","description":"晴间多云","temperature":22.1},"tomorrow":{"emoji":"☁️","description":"阴","temperatureMin":14,"temperatureMax":23}}')).toEqual({
      type: "weather",
      status: "ok",
      current: { emoji: "☀️", description: "晴", temperature: 21.4 },
      nextHour: { emoji: "🌤️", description: "晴间多云", temperature: 22.1 },
      tomorrow: { emoji: "☁️", description: "阴", temperatureMin: 14, temperatureMax: 23 },
    });
  });

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
      shortWindow: { percent: 49, resetsAt: "2026-08-20T20:10:00" },
      weeklyWindow: { percent: 83, resetsAt: "2026-08-25T00:00:00" },
    });
    const host = dom.window.document.getElementById("myco-meter-widget");
    const battery = host?.shadowRoot?.querySelector<HTMLElement>(".battery");
    const fill = host?.shadowRoot?.querySelector<HTMLElement>(".battery-fill");
    const text = host?.shadowRoot?.querySelector<HTMLElement>(".battery-text");
    const fillText = host?.shadowRoot?.querySelector<HTMLElement>(".battery-text-fill");
    const resetTime = host?.shadowRoot?.querySelector<HTMLElement>(".reset-time");
    const labels = Array.from(host?.shadowRoot?.querySelectorAll<HTMLElement>(".quota-label") ?? []);
    const weeklyValue = host?.shadowRoot?.querySelector<HTMLElement>(".weekly-value");
    const styleText = host?.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(host?.previousElementSibling?.getAttribute("aria-label")).toBe("帮助");
    expect(battery?.dataset.level).toBe("warning");
    expect(fill?.style.width).toBe("49%");
    expect(text?.textContent).toBe("49");
    expect(fillText?.textContent).toBe("49");
    expect(battery?.style.getPropertyValue("--battery-percent")).toBe("49%");
    expect(resetTime?.textContent).toBe("20:10");
    expect(styleText).toMatch(/\.reset-time\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(styleText).not.toContain(".widget:hover .date");
    expect(styleText).toContain("clip-path: inset(0 calc(100% - var(--battery-percent, 0%)) 0 0)");
    expect(styleText).toContain("--meter-default-font-color: #767680");
    expect(styleText).toMatch(/\.battery-text\s*\{[^}]*color:\s*var\(--meter-default-font-color\)/);
    expect(labels.map((label) => label.textContent)).toEqual(["5小时", "本周"]);
    expect(weeklyValue?.textContent).toBe("83%");
    expect(weeklyValue?.title).toBe("重置日期：8月25日");

    state.setFontColor("#aBc123");
    expect(state.getFontColor()).toBe("#ABC123");
    expect(host?.dataset.fontColor).toBe("custom");
    expect(host?.style.getPropertyValue("--meter-font-color")).toBe("#ABC123");
    state.setFontColor(null);
    expect(state.getFontColor()).toBeNull();
    expect(host?.dataset.fontColor).toBeUndefined();

    state.setQuota({
      status: "ok",
      shortWindow: { percent: 19, resetsAt: "2026-08-20T00:00:00" },
      weeklyWindow: null,
    });
    expect(battery?.dataset.level).toBe("critical");
    expect(fill?.style.width).toBe("19%");
    expect(text?.textContent).toBe("19");
    expect(fillText?.textContent).toBe("19");

    state.setQuota({ status: "unavailable", shortWindow: null, weeklyWindow: null });
    expect(text?.textContent).toBe("--");
    expect(fillText?.textContent).toBe("--");
    expect(battery?.style.getPropertyValue("--battery-percent")).toBe("0%");
    expect(resetTime?.textContent).toBe("--:--");
    expect(weeklyValue?.textContent).toBe("--");

    state.dispose();
    expect(dom.window.document.getElementById("myco-meter-widget")).toBeNull();
    dom.window.close();
  });

  it("renders current and next-hour weather after the quota widget", async () => {
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
    state.setWeather({
      status: "ok",
      current: { emoji: "☀️", description: "晴", temperature: 21.4 },
      nextHour: { emoji: "🌤️", description: "晴间多云", temperature: 22.1 },
      tomorrow: { emoji: "☁️", description: "阴", temperatureMin: 14, temperatureMax: 23 },
    });

    const host = dom.window.document.getElementById("myco-meter-widget");
    const weather = host?.shadowRoot?.querySelector<HTMLElement>(".weather");
    const values = Array.from(
      host?.shadowRoot?.querySelectorAll<HTMLElement>(".weather-value") ?? [],
    ).map((element) => element.textContent);
    const styleText = host?.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(weather?.dataset.status).toBe("ok");
    expect(values).toEqual(["☀️ 晴 21°", "1小时后 🌤️ 晴间多云 22°", "　|　明天 ☁️ 阴 14°/23°"]);
    expect(styleText).toMatch(/\.weather\s*\{[^}]*margin-left:\s*50px/);
    expect(styleText).toContain("@media (max-width: 900px)");

    state.setWeather({ status: "unavailable", current: null, nextHour: null, tomorrow: null });
    expect(weather?.textContent).toContain("天气暂不可用");

    state.dispose();
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

    const host = dom.window.document.getElementById("myco-meter-widget");
    expect(host).not.toBeNull();
    expect(host?.previousElementSibling?.getAttribute("aria-label")).toBe("Help");

    (dom.window as unknown as { __CODEX_METER_STATE__: InjectedState })
      .__CODEX_METER_STATE__.dispose();
    dom.window.close();
  });

  it("mounts in the updated Codex shell when the native menu is absent", async () => {
    const script = await readFile(
      new URL("../src-tauri/resources/inject.js", import.meta.url),
      "utf8",
    );
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="root">
        <main class="relative h-screen w-screen bg-transparent overflow-hidden">
          <section class="relative h-full w-full">
            <div class="pointer-events-auto contents">
              <div class="absolute z-20 h-10 controls-MvwPRC controls-rzOzQx"></div>
            </div>
          </section>
        </main>
      </div>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });

    dom.window.eval(script);

    const host = dom.window.document.getElementById("myco-meter-widget");
    const styleText = host?.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(host?.parentElement?.id).toBe("root");
    expect(host?.dataset.mount).toBe("shell-overlay");
    expect(styleText).toMatch(/:host\(\[data-mount="shell-overlay"\]\)\s*\{[^}]*position:\s*fixed/);

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

    expect(dom.window.document.getElementById("myco-meter-widget")).toBeNull();
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

  it("recognizes the Codex 26.1029 shell that exposes top controls without the legacy header", async () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="root">
        <main class="relative h-screen w-screen">
          <section>
            <div class="controls-MvwPRC"></div>
            <textarea aria-label="Ask Codex"></textarea>
          </section>
        </main>
      </div>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });

    const probe = await probeSession({
      evaluate: async (expression: string) => dom.window.eval(expression),
    });

    expect(probe.codex).toBe(true);
    dom.window.close();
  });

  it("mounts on the current Codex workspace toolbar when floating controls are absent", async () => {
    const script = await readFile(
      new URL("../src-tauri/resources/inject.js", import.meta.url),
      "utf8",
    );
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="root">
        <main class="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
          <header class="flex h-toolbar w-full draggable">
            <button aria-label="Back to ChatGPT"></button>
          </header>
          <div><aside></aside><textarea aria-label="Ask Codex"></textarea></div>
        </main>
      </div>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });

    const probe = await probeSession({
      evaluate: async (expression: string) => dom.window.eval(expression),
    });
    dom.window.eval(script);

    const host = dom.window.document.getElementById("myco-meter-widget");
    expect(probe.codex).toBe(true);
    expect(host?.parentElement?.id).toBe("root");
    expect(host?.dataset.mount).toBe("shell-overlay");

    (dom.window as unknown as { __CODEX_METER_STATE__: InjectedState })
      .__CODEX_METER_STATE__.dispose();
    dom.window.close();
  });

  it("mounts on the nested native toolbar while a Codex workspace panel is open", async () => {
    const script = await readFile(
      new URL("../src-tauri/resources/inject.js", import.meta.url),
      "utf8",
    );
    const dom = new JSDOM(`<!doctype html><html><body>
      <div id="root"><div>
        <main class="flex h-full min-h-0 flex-col overflow-hidden bg-surface no-drag">
          <header class="flex h-toolbar w-full draggable">
            <button aria-label="Back to ChatGPT"></button>
          </header>
        </main>
      </div></div>
    </body></html>`, {
      runScripts: "outside-only",
      url: "app://-/index.html",
    });

    const probe = await probeSession({
      evaluate: async (expression: string) => dom.window.eval(expression),
    });
    dom.window.eval(script);

    const host = dom.window.document.getElementById("myco-meter-widget");
    expect(probe.codex).toBe(true);
    expect(host?.parentElement?.id).toBe("root");
    expect(host?.dataset.mount).toBe("shell-overlay");

    (dom.window as unknown as { __CODEX_METER_STATE__: InjectedState })
      .__CODEX_METER_STATE__.dispose();
    dom.window.close();
  });

  it("mounts in the trusted ChatGPT Codex WebView when the application shell is hidden", async () => {
    const script = await readFile(
      new URL("../src-tauri/resources/inject.js", import.meta.url),
      "utf8",
    );
    const dom = new JSDOM(`<!doctype html><html><body>
      <header class="draggable no-draggable-children sticky top-0"></header>
      <main><textarea aria-label="Ask Codex"></textarea></main>
    </body></html>`, {
      runScripts: "outside-only",
      url: "https://chatgpt.com/codex",
    });

    const probe = await probeSession({
      evaluate: async (expression: string) => dom.window.eval(expression),
    });
    dom.window.eval(script);

    const host = dom.window.document.getElementById("myco-meter-widget");
    expect(probe.codex).toBe(true);
    expect(host?.parentElement).toBe(dom.window.document.body);
    expect(host?.dataset.mount).toBe("shell-overlay");

    (dom.window as unknown as { __CODEX_METER_STATE__: InjectedState })
      .__CODEX_METER_STATE__.dispose();
    dom.window.close();
  });
});
