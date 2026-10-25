const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const {
  APP_ORIGIN,
  isAllowedExternalUrl,
  isTrustedSpeechSender,
  resolveAssetPath,
} = require("./security.cjs");
const { getInitialWindowLayout } = require("./window-options.cjs");
const { createNativeSpeechService } = require("./native-speech.cjs");
const { getWindowThemeOptions, createWindowThemeController } = require("./theme.cjs");

app.setName("Oxford Cards");
// Portable launchers unpack into a new temporary directory. Keep progress elsewhere.
const userDataPath = path.join(app.getPath("appData"), "Oxford Cards");
fs.mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);
app.setAppUserModelId("local.oxfordcards.desktop");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "oxford",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);
app.enableSandbox();

let mainWindow;
let nativeSpeech;
let windowTheme;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(async () => {
      const root = path.join(app.getAppPath(), "dist");
      if (!fs.existsSync(path.join(root, "index.html")))
        throw new Error(
          "Сборка приложения не найдена. Выполните npm run build.",
        );
      nativeTheme.themeSource = "system";
      Menu.setApplicationMenu(null);
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      nativeSpeech = createNativeSpeechService({
        workerPath: app.isPackaged
          ? path.join(process.resourcesPath, "speech-worker.ps1")
          : path.join(__dirname, "speech-worker.ps1"),
        allowedTexts: new Set(require("../src/data/oxford3000.json").map((entry) => entry.word)),
        cacheDir: path.join(userDataPath, "speech-cache"),
      });
      ipcMain.handle("oxford:speech:prepare", (event, text) => {
        if (!isTrustedSpeechSender(event, mainWindow?.webContents))
          throw new Error("Недоступный источник запроса озвучивания.");
        return nativeSpeech.prepare(text);
      });

      protocol.handle("oxford", async (request) => {
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405 });
        const asset = resolveAssetPath(root, request.url);
        if (!asset) return new Response("Not found", { status: 404 });
        try {
          const response = await net.fetch(pathToFileURL(asset).href);
          const headers = new Headers(response.headers);
          headers.set(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
          );
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });

      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const initialLayout = getInitialWindowLayout(display.workArea);
      mainWindow = new BrowserWindow({
        ...initialLayout.options,
        title: "Oxford Cards",
        ...getWindowThemeOptions(nativeTheme),
        titleBarStyle: "hidden",
        icon: path.join(app.getAppPath(), "desktop", "resources", "icon.ico"),
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          spellcheck: false,
        },
      });

      windowTheme = createWindowThemeController({
        nativeTheme,
        ipcMain,
        getWindow: () => mainWindow,
      });

      const openDictionary = (url) => {
        if (isAllowedExternalUrl(url))
          shell.openExternal(url).catch(() => {
            dialog.showErrorBox(
              "Не удалось открыть ссылку",
              "Откройте словарь в браузере вручную.",
            );
          });
      };
      mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openDictionary(url);
        return { action: "deny" };
      });
      mainWindow.webContents.on("will-navigate", (event, url) => {
        if (
          url !== `${APP_ORIGIN}/index.html` &&
          url !== `${APP_ORIGIN}/index.html#`
        ) {
          event.preventDefault();
          openDictionary(url);
        }
      });
      mainWindow.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      mainWindow.once("ready-to-show", () => {
        windowTheme.update();
        if (initialLayout.maximize) mainWindow.maximize();
        mainWindow.show();
      });
      mainWindow.on("closed", () => {
        windowTheme.dispose();
        mainWindow = undefined;
      });
      await mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
    })
    .catch((error) => {
      dialog.showErrorBox("Oxford Cards — не удалось запустить", error.message);
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    windowTheme?.dispose();
    nativeSpeech?.dispose();
  });
}
