(() => {
  const HOST_ID = "myco-meter-widget";
  const VERSION = "0.4.12";

  const previous = window.__CODEX_METER_STATE__;
  if (typeof previous?.dispose === "function") {
    previous.dispose();
  } else {
    if (previous?.observer) previous.observer.disconnect();
    if (previous?.timer) clearInterval(previous.timer);
    if (previous?.ensureTimer) clearInterval(previous.ensureTimer);
    previous?.cancelScheduledUpdate?.();
  }
  document.getElementById(HOST_ID)?.remove();

  let currentQuota = {
    status: "loading",
    shortWindow: null,
    weeklyWindow: null,
  };
  let currentWeather = {
    status: "loading",
    current: null,
    nextHour: null,
    tomorrow: null,
  };
  const HEX_COLOR = /^#[0-9a-f]{6}$/i;
  let fontColor = typeof previous?.getFontColor === "function"
    ? previous.getFontColor()
    : null;
  if (typeof fontColor !== "string" || !HEX_COLOR.test(fontColor)) fontColor = null;

  // --- CSS (Shadow DOM, isolated from host page) ---
  const cssText = `
    :host {
      all: initial;
      --meter-default-font-color: #767680;
      display: inline-flex;
      align-self: center;
      flex: 0 0 auto;
      height: 24px;
      color: var(--titlebar-text-color, currentColor);
      pointer-events: none;
      font-family: var(--titlebar-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      -webkit-font-smoothing: antialiased;
      -webkit-app-region: no-drag;
    }
    :host([data-mount="shell-overlay"]) {
      position: fixed;
      top: 8px;
      left: 50%;
      z-index: 2147483647;
      transform: translateX(-50%);
    }
    .widget {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 24px;
      padding: 4px 8px 4px 6px;
      pointer-events: auto;
      cursor: default;
      user-select: none;
      -webkit-user-select: none;
      transition: opacity 200ms ease;
    }
    .widget:hover { opacity: 0.85; }

    /* --- Battery --- */
    .battery {
      position: relative;
      display: inline-flex;
      align-items: center;
      width: 32px;
      height: 17px;
      flex-shrink: 0;
    }
    .battery-body {
      position: relative;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      border: 1.5px solid var(--titlebar-text-color, currentColor);
      border-radius: 3.5px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .battery-tip {
      position: absolute;
      right: -3.5px;
      top: 50%;
      transform: translateY(-50%);
      width: 2.5px;
      height: 7px;
      border-radius: 0 1.5px 1.5px 0;
      background: var(--titlebar-text-color, currentColor);
    }
    .battery-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      border-radius: 2px 0 0 2px;
      transition: width 600ms cubic-bezier(0.25, 0.1, 0.25, 1),
                  background-color 400ms ease;
    }
    .battery-text,
    .battery-text-fill {
      position: relative;
      z-index: 1;
      position: absolute;
      inset: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 750;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
      line-height: 1;
      text-shadow: none;
      transform: translateY(-0.5px);
    }
    .battery-text {
      color: var(--meter-default-font-color);
    }
    .battery-text-fill {
      z-index: 2;
      color: var(--meter-default-font-color);
      clip-path: inset(0 calc(100% - var(--battery-percent, 0%)) 0 0);
    }
    :host([data-font-color]) :is(.battery-text, .battery-text-fill) {
      color: var(--meter-font-color);
    }
    .battery[data-level="unknown"] .battery-text-fill {
      display: none;
    }

    /* --- Short-window reset time --- */
    .reset-time {
      font-family: var(--titlebar-font-family, inherit);
      font-size: 11px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: var(--meter-default-font-color);
      white-space: nowrap;
    }
    .quota-label,
    .weekly-value {
      font-family: var(--titlebar-font-family, inherit);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .quota-label {
      color: var(--meter-default-font-color);
      font-size: 11px;
      font-weight: 500;
    }
    .quota-separator {
      width: 1px;
      height: 13px;
      margin: 0 1px;
      background: color-mix(in srgb, var(--titlebar-text-color, currentColor) 25%, transparent);
    }
    .weekly-value {
      font-size: 12px;
      font-weight: 700;
      color: var(--fill-green);
    }
    .weekly-value[data-level="warning"] { color: var(--fill-yellow); }
    .weekly-value[data-level="critical"] { color: var(--fill-red); }
    .weekly-value[data-level="unknown"] { color: var(--meter-default-font-color); }

    /* --- Weather --- */
    .weather {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-left: 50px;
      color: var(--meter-default-font-color);
      font-family: var(--titlebar-font-family, inherit);
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }
    .weather-value { font-variant-numeric: tabular-nums; }
    .weather[data-status="unavailable"] { opacity: 0.8; }
    @media (max-width: 900px) {
      .weather { display: none; }
    }

    /* --- Theme: dark (default) --- */
    :host {
      --fill-green: #30d158;
      --fill-yellow: #FFCC00;
      --fill-red: #FF3B30;
    }
    /* --- Theme: light --- */
    :host([data-theme="light"]) {
      --fill-green: #34c759;
      --fill-yellow: #FFCC00;
      --fill-red: #FF3B30;
    }
  `;

  // --- Helpers ---
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  let disposed = false;

  function detectTheme() {
    const root = document.documentElement;
    const body = document.body;
    const classes = `${root?.className || ""} ${body?.className || ""}`.toLowerCase();
    if (/\b(dark|electron-dark|theme-dark|appearance-dark)\b/.test(classes)) return "dark";
    if (/\b(light|electron-light|theme-light|appearance-light)\b/.test(classes)) return "light";
    const dataTheme = (
      root?.getAttribute?.("data-theme") ||
      root?.getAttribute?.("data-appearance") ||
      root?.getAttribute?.("data-color-mode") ||
      body?.getAttribute?.("data-theme") ||
      ""
    ).toLowerCase();
    if (dataTheme.includes("dark")) return "dark";
    if (dataTheme.includes("light")) return "light";
    try {
      if (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches) return "dark";
    } catch { /* ignore */ }
    return "light";
  }

  function fillColor(percent) {
    if (percent < 20) return "var(--fill-red)";
    if (percent < 50) return "var(--fill-yellow)";
    return "var(--fill-green)";
  }

  function fillLevel(percent) {
    if (percent < 20) return "critical";
    if (percent < 50) return "warning";
    return "normal";
  }

  function formatResetTime(value) {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function formatResetDate(value) {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function buttonLabel(button) {
    return (
      button.getAttribute("aria-label") ||
      button.getAttribute("title") ||
      button.textContent ||
      ""
    ).replace(/\s+/g, " ").trim();
  }

  function isHelpButton(button) {
    return /^(?:help|support|帮助|帮助[与和]反馈)$/i.test(buttonLabel(button));
  }

  function findAnchorIn(container) {
    if (!container) return null;
    const buttons = Array.from(container.querySelectorAll('button, [role="button"]'));
    return buttons.find(isHelpButton) ||
      buttons.find((button) => button.getAttribute("aria-haspopup") === "menu") ||
      buttons.at(-1) || null;
  }

  function findTitlebarAnchor() {
    // Old Codex used a Tailwind-style class; current 26.727 builds use a CSS
    // Modules class. Both identify the native application menu, unlike the
    // app-shell header, which is the title of the active conversation.
    const titlebar = document.querySelector(
      ':is([class~="group/application-menu-top-bar"], [class*="_ApplicationMenuTopBar_"])',
    );
    if (!titlebar) return null;

    // The menu bar keeps the quota widget beside File/Edit/View/Help, rather
    // than beside navigation buttons that share the same native title bar.
    return findAnchorIn(titlebar.querySelector('[role="menubar"]') || titlebar);
  }

  function findShellMountRoot() {
    const root = document.getElementById("root");
    if (!root) return null;

    // Codex 26.1029 replaced its native menu with the floating controls shell.
    // Mounting on its stable application root keeps the meter away from chat headers.
    return root.querySelector(':scope > main > section [class*="controls-"]') ? root : null;
  }

  function findWorkspaceShellMountRoot() {
    const root = document.getElementById("root");
    const main = root?.querySelector('main.no-drag') || root?.querySelector(':scope > main');
    if (!main) return null;

    // Current Codex workspace windows have a native draggable toolbar instead
    // of floating controls. Require both the workspace sidebar and prompt so
    // this cannot match an active conversation header.
    const toolbar = main.querySelector(':scope > header.draggable');
    const sidebar = main.querySelector('aside');
    const input = main.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    return toolbar && (main.classList.contains("no-drag") || (sidebar && input)) ? root : null;
  }

  function findTrustedCodexWebViewMountRoot() {
    if (location.origin !== "https://chatgpt.com") return null;
    const header = document.querySelector("header.draggable");
    const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    return header && input ? document.body : null;
  }

  function syncTitlebarStyles(anchor) {
    const style = getComputedStyle(anchor);
    host.style.setProperty("--titlebar-text-color", style.color);
    host.style.setProperty("--titlebar-font-family", style.fontFamily);
    host.style.setProperty("--titlebar-font-size", style.fontSize);
    host.style.setProperty("--titlebar-font-weight", style.fontWeight);
    host.style.setProperty("--titlebar-line-height", style.lineHeight);
  }

  function mountInTitlebar() {
    if (disposed) return false;
    const anchor = findTitlebarAnchor();
    if (anchor) {
      if (host.parentElement !== anchor.parentElement || host.previousElementSibling !== anchor) {
        anchor.insertAdjacentElement("afterend", host);
      }
      delete host.dataset.mount;
      syncTitlebarStyles(anchor);
      return true;
    }

    const shellRoot = findShellMountRoot() ||
      findWorkspaceShellMountRoot() || findTrustedCodexWebViewMountRoot();
    if (!shellRoot) return false;
    if (host.parentElement !== shellRoot) {
      shellRoot.appendChild(host);
    }
    host.dataset.mount = "shell-overlay";
    syncTitlebarStyles(shellRoot);
    return true;
  }

  // --- Build DOM ---
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("data-theme", detectTheme());

  const shadow = host.attachShadow({ mode: "open" });

  function setFontColor(value) {
    fontColor = typeof value === "string" && HEX_COLOR.test(value) ? value.toUpperCase() : null;
    if (fontColor) {
      host.dataset.fontColor = "custom";
      host.style.setProperty("--meter-font-color", fontColor);
    } else {
      delete host.dataset.fontColor;
      host.style.removeProperty("--meter-font-color");
    }
  }

  const styleNode = document.createElement("style");
  styleNode.textContent = cssText;

  const widget = document.createElement("div");
  widget.className = "widget";

  // Battery container
  const battery = document.createElement("div");
  battery.className = "battery";

  const batteryBody = document.createElement("div");
  batteryBody.className = "battery-body";

  const batteryFill = document.createElement("div");
  batteryFill.className = "battery-fill";

  const batteryText = document.createElement("span");
  batteryText.className = "battery-text";

  const batteryTextFill = document.createElement("span");
  batteryTextFill.className = "battery-text-fill";
  batteryTextFill.setAttribute("aria-hidden", "true");

  const batteryTip = document.createElement("div");
  batteryTip.className = "battery-tip";

  batteryBody.appendChild(batteryFill);
  batteryBody.appendChild(batteryText);
  batteryBody.appendChild(batteryTextFill);
  battery.appendChild(batteryBody);
  battery.appendChild(batteryTip);

  // Short-window reset time
  const resetTimeEl = document.createElement("span");
  resetTimeEl.className = "reset-time";

  const shortLabel = document.createElement("span");
  shortLabel.className = "quota-label";
  shortLabel.textContent = "5小时";

  const separator = document.createElement("span");
  separator.className = "quota-separator";

  const weeklyLabel = document.createElement("span");
  weeklyLabel.className = "quota-label";
  weeklyLabel.textContent = "本周";

  const weeklyValue = document.createElement("span");
  weeklyValue.className = "weekly-value";

  const weather = document.createElement("span");
  weather.className = "weather";
  const currentWeatherEl = document.createElement("span");
  currentWeatherEl.className = "weather-value";
  const nextWeatherEl = document.createElement("span");
  nextWeatherEl.className = "weather-value";
    const tomorrowWeatherEl = document.createElement("span");
    tomorrowWeatherEl.className = "weather-value";
  weather.appendChild(currentWeatherEl);
  weather.appendChild(nextWeatherEl);
    weather.appendChild(tomorrowWeatherEl);

  widget.appendChild(shortLabel);
  widget.appendChild(battery);
  widget.appendChild(resetTimeEl);
  widget.appendChild(separator);
  widget.appendChild(weeklyLabel);
  widget.appendChild(weeklyValue);
  widget.appendChild(weather);
  shadow.appendChild(styleNode);
  shadow.appendChild(widget);
  setFontColor(fontColor);
  mountInTitlebar();

  // --- Update ---
  function update() {
    if (disposed) return;
    const percent = currentQuota.shortWindow?.percent;
    const available = Number.isFinite(percent);
    if (available) {
      const normalized = clamp(Math.round(percent), 0, 100);
      batteryFill.style.width = `${normalized}%`;
      batteryFill.style.backgroundColor = fillColor(normalized);
      battery.style.setProperty("--battery-percent", `${normalized}%`);
      batteryText.textContent = String(normalized);
      batteryTextFill.textContent = String(normalized);
      battery.dataset.level = fillLevel(normalized);
    } else {
      batteryFill.style.width = "0%";
      batteryFill.style.backgroundColor = "transparent";
      battery.style.setProperty("--battery-percent", "0%");
      batteryText.textContent = "--";
      batteryTextFill.textContent = "--";
      battery.dataset.level = "unknown";
    }

    const resetTime = available ? formatResetTime(currentQuota.shortWindow?.resetsAt) : "";
    resetTimeEl.textContent = resetTime || "--:--";
    const weeklyPercent = currentQuota.weeklyWindow?.percent;
    const weeklyAvailable = Number.isFinite(weeklyPercent);
    const normalizedWeekly = weeklyAvailable ? clamp(Math.round(weeklyPercent), 0, 100) : null;
    weeklyValue.textContent = normalizedWeekly === null ? "--" : `${normalizedWeekly}%`;
    weeklyValue.dataset.level = normalizedWeekly === null ? "unknown" : fillLevel(normalizedWeekly);
    const weeklyResetDate = weeklyAvailable ? formatResetDate(currentQuota.weeklyWindow?.resetsAt) : "";
    weeklyValue.title = weeklyResetDate ? `重置日期：${weeklyResetDate}` : "额度暂不可用";
    if (currentWeather.status === "ok" && currentWeather.current && currentWeather.nextHour && currentWeather.tomorrow) {
      currentWeatherEl.textContent = `${currentWeather.current.emoji} ${currentWeather.current.description} ${Math.round(currentWeather.current.temperature)}°`;
      nextWeatherEl.textContent = `1小时后 ${currentWeather.nextHour.emoji} ${currentWeather.nextHour.description} ${Math.round(currentWeather.nextHour.temperature)}°`;
      tomorrowWeatherEl.textContent = `　|　明天 ${currentWeather.tomorrow.emoji} ${currentWeather.tomorrow.description} ${Math.round(currentWeather.tomorrow.temperatureMin)}°/${Math.round(currentWeather.tomorrow.temperatureMax)}°`;
      weather.dataset.status = "ok";
      weather.title = "天气数据：Open-Meteo；Windows 系统定位";
    } else {
      currentWeatherEl.textContent = "天气暂不可用";
      nextWeatherEl.textContent = "右键托盘后立即刷新";
      tomorrowWeatherEl.textContent = "";
      weather.dataset.status = "unavailable";
      weather.title = "天气获取失败，可通过托盘立即刷新重试";
    }
    host.dataset.status = currentQuota.status;
    host.setAttribute("data-theme", detectTheme());
    mountInTitlebar();
  }

  function setQuota(payload) {
    const normalizeWindow = (value) => {
      const percent = value?.percent;
      return typeof percent === "number" && Number.isFinite(percent)
        ? {
            percent: clamp(percent, 0, 100),
            resetsAt: typeof value?.resetsAt === "string" ? value.resetsAt : null,
          }
        : null;
    };
    currentQuota = {
      status: typeof payload?.status === "string" ? payload.status : "unavailable",
      shortWindow: normalizeWindow(payload?.shortWindow),
      weeklyWindow: normalizeWindow(payload?.weeklyWindow),
    };
    update();
  }

  function setWeather(payload) {
    const normalize = (value) => (
      typeof value?.emoji === "string" && value.emoji &&
      typeof value?.description === "string" && value.description &&
      typeof value?.temperature === "number" && Number.isFinite(value.temperature)
    ) ? {
      emoji: value.emoji,
      description: value.description,
      temperature: value.temperature,
    } : null;
    currentWeather = {
      status: typeof payload?.status === "string" ? payload.status : "unavailable",
      current: normalize(payload?.current),
      nextHour: normalize(payload?.nextHour),
      tomorrow: (
        normalize({
          emoji: payload?.tomorrow?.emoji,
          description: payload?.tomorrow?.description,
          temperature: payload?.tomorrow?.temperatureMax,
        }) &&
        typeof payload?.tomorrow?.temperatureMin === "number" && Number.isFinite(payload.tomorrow.temperatureMin)
      ) ? {
        emoji: payload.tomorrow.emoji,
        description: payload.tomorrow.description,
        temperatureMin: payload.tomorrow.temperatureMin,
        temperatureMax: payload.tomorrow.temperatureMax,
      } : null,
    };
    update();
  }

  update();

  // --- Theme observer ---
  let observer = null;
  let observerTimeout = null;
  const cancelScheduledUpdate = () => {
    if (!observerTimeout) return;
    clearTimeout(observerTimeout);
    observerTimeout = null;
  };
  const scheduleUpdate = () => {
    if (disposed) return;
    cancelScheduledUpdate();
    observerTimeout = setTimeout(() => {
      observerTimeout = null;
      update();
    }, 200);
  };
  observer = new MutationObserver(() => scheduleUpdate());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-theme", "data-appearance", "data-color-mode"],
  });

  // --- Re-attach if Codex re-renders its title bar ---
  const ensureAlive = () => {
    mountInTitlebar();
  };
  const ensureTimer = setInterval(ensureAlive, 1000);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    cancelScheduledUpdate();
    clearInterval(ensureTimer);
    host.remove();
    if (window.__CODEX_METER_STATE__?.dispose === dispose) {
      delete window.__CODEX_METER_STATE__;
    }
  };

  // --- State ---
  window.__CODEX_METER_STATE__ = {
    observer,
    cancelScheduledUpdate,
    ensureTimer,
    setQuota,
    setWeather,
    getFontColor: () => fontColor,
    setFontColor,
    dispose,
    version: VERSION,
  };

  console.log(`[myco-meter] widget injected (v${VERSION})`);
})();
