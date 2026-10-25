const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oxfordAudio", Object.freeze({
  prepare: (text) => ipcRenderer.invoke("oxford:speech:prepare", text),
}));

contextBridge.exposeInMainWorld("oxfordTheme", Object.freeze({
  setSource: (source) => ipcRenderer.invoke("oxford:theme:set-source", source),
}));
