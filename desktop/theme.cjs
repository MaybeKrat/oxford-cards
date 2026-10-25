const { isTrustedSpeechSender } = require("./security.cjs");

const THEME_CHANNEL = "oxford:theme:set-source";
const THEME_SOURCES = new Set(["system", "light", "dark"]);

function getWindowThemeOptions(nativeTheme) {
  const backgroundColor = nativeTheme.shouldUseDarkColors ? "#141c19" : "#f8f9f6";
  return {
    backgroundColor,
    titleBarOverlay: {
      color: backgroundColor,
      symbolColor: nativeTheme.shouldUseDarkColors ? "#b6d3bf" : "#255648",
      height: 42,
    },
  };
}

function createWindowThemeController({ nativeTheme, ipcMain, getWindow }) {
  let disposed = false;

  function update() {
    const window = getWindow();
    if (disposed || !window || window.isDestroyed()) return;
    const { backgroundColor, titleBarOverlay } = getWindowThemeOptions(nativeTheme);
    window.setBackgroundColor(backgroundColor);
    window.setTitleBarOverlay(titleBarOverlay);
  }

  ipcMain.handle(THEME_CHANNEL, (event, source) => {
    const window = getWindow();
    if (disposed || !window || window.isDestroyed() ||
      !isTrustedSpeechSender(event, window.webContents)) {
      throw new Error("Недоступный источник запроса темы.");
    }
    if (!THEME_SOURCES.has(source)) throw new Error("Неизвестная тема оформления.");
    nativeTheme.themeSource = source;
    // Apply immediately even when setting the same source emits no update event.
    update();
  });
  nativeTheme.on("updated", update);
  update();

  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      nativeTheme.removeListener("updated", update);
      ipcMain.removeHandler(THEME_CHANNEL);
    },
  };
}

module.exports = { getWindowThemeOptions, createWindowThemeController };
