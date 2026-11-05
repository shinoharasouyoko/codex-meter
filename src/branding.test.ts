import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("MyCoMeter branding", () => {
  it("uses MyCoMeter for the application and page titles", async () => {
    const [configSource, pageSource] = await Promise.all([
      readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
      readFile(new URL("../index.html", import.meta.url), "utf8"),
    ]);

    expect(configSource).toContain('"productName": "MyCoMeter"');
    expect(pageSource).toContain("<title>MyCoMeter</title>");
    expect(configSource).not.toContain("CodexMeter");
    expect(pageSource).not.toContain("CodexMeter");
  });
});
