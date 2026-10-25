const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("oxfordAudio", Object.freeze({
  prepare: (text) => ipcRenderer.invoke("oxford:speech:prepare", text),
}));
