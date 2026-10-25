import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getWindowThemeOptions, createWindowThemeController } = require("../desktop/theme.cjs");
const channel = "oxford:theme:set-source";
type ThemeSource = "system" | "light" | "dark";

function setup(systemDark = false) {
  const nativeTheme = Object.assign(new EventEmitter(), {
    themeSource: "system" as ThemeSource,
    systemDark,
    get shouldUseDarkColors() { return false; },
  });
  Object.defineProperty(nativeTheme, "shouldUseDarkColors", {
    get() { return this.themeSource === "system" ? this.systemDark : this.themeSource === "dark"; },
  });
  const handlers = new Map<string, (event: unknown, source: unknown) => void>();
  const ipcMain = {
    handle(name: string, handler: (event: unknown, source: unknown) => void) { handlers.set(name, handler); },
    removeHandler(name: string) { handlers.delete(name); },
  };
  const frame = { url: "oxford://app/index.html" };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  const backgrounds: string[] = [];
  const overlays: { color: string; symbolColor: string; height: number }[] = [];
  const window = {
    webContents: contents,
    isDestroyed: () => false,
    setBackgroundColor(color: string) { backgrounds.push(color); },
    setTitleBarOverlay(overlay: { color: string; symbolColor: string; height: number }) { overlays.push(overlay); },
  };
  const controller = createWindowThemeController({ nativeTheme, ipcMain, getWindow: () => window });
  const setSource = (source: unknown, sender: unknown = event) => handlers.get(channel)!(sender, source);
  return { nativeTheme, handlers, event, window, controller, setSource, backgrounds, overlays };
}

test("Window starts with the Windows app theme and follows live system changes", () => {
  const state = setup(true);
  assert.deepEqual(getWindowThemeOptions(state.nativeTheme), {
    backgroundColor: "#141c19",
    titleBarOverlay: { color: "#141c19", symbolColor: "#b6d3bf", height: 42 },
  });
  assert.equal(state.backgrounds.at(-1), "#141c19");
  state.nativeTheme.systemDark = false;
  state.nativeTheme.emit("updated");
  assert.equal(state.backgrounds.at(-1), "#f8f9f6");
  assert.deepEqual(state.overlays.at(-1), { color: "#f8f9f6", symbolColor: "#255648", height: 42 });
  state.nativeTheme.systemDark = true;
  state.nativeTheme.emit("updated");
  assert.equal(state.backgrounds.at(-1), "#141c19");
  state.controller.dispose();
});

test("Explicit appearance updates immediately and returning to system restores Windows theme", () => {
  const state = setup(true);
  state.setSource("light");
  assert.equal(state.nativeTheme.themeSource, "light");
  assert.equal(state.backgrounds.at(-1), "#f8f9f6");
  state.nativeTheme.emit("updated");
  assert.equal(state.backgrounds.at(-1), "#f8f9f6");
  state.setSource("dark");
  assert.equal(state.backgrounds.at(-1), "#141c19");
  state.nativeTheme.systemDark = false;
  state.setSource("system");
  assert.equal(state.backgrounds.at(-1), "#f8f9f6");
  // The ready-to-show refresh must preserve the renderer's saved selection.
  state.setSource("dark");
  state.controller.update();
  assert.equal(state.nativeTheme.themeSource, "dark");
  assert.equal(state.overlays.at(-1)?.symbolColor, "#b6d3bf");
  state.controller.dispose();
});

test("Theme IPC rejects malformed values and foreign or child-frame senders without changing theme", () => {
  const state = setup();
  const before = state.backgrounds.length;
  for (const value of [null, undefined, "Dark", "", "auto", 1, {}, ["dark"]]) {
    assert.throws(() => state.setSource(value), /Неизвестная тема/);
  }
  for (const event of [
    { ...state.event, sender: {} },
    { ...state.event, senderFrame: null },
    { ...state.event, senderFrame: { url: "oxford://app/index.html" } },
  ]) {
    assert.throws(() => state.setSource("dark", event), /Недоступный источник/);
  }
  state.event.senderFrame.url = "https://example.com/";
  assert.throws(() => state.setSource("dark"), /Недоступный источник/);
  state.event.senderFrame.url = "oxford://app/index.html";
  state.window.webContents.isDestroyed = () => true;
  assert.throws(() => state.setSource("dark"), /Недоступный источник/);
  assert.equal(state.nativeTheme.themeSource, "system");
  assert.equal(state.backgrounds.length, before);
  state.controller.dispose();
});

test("Closing a window safely stops theme updates and releases the IPC handler", () => {
  const state = setup();
  const before = state.backgrounds.length;
  state.window.isDestroyed = () => true;
  state.nativeTheme.emit("updated");
  assert.equal(state.backgrounds.length, before);
  assert.throws(() => state.setSource("dark"), /Недоступный источник/);
  state.controller.dispose();
  state.controller.dispose();
  assert.equal(state.handlers.has(channel), false);
  assert.equal(state.nativeTheme.listenerCount("updated"), 0);
  state.window.isDestroyed = () => false;
  state.controller.update();
  state.nativeTheme.emit("updated");
  assert.equal(state.backgrounds.length, before);
});
