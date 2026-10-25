const path = require("node:path");

const APP_ORIGIN = "oxford://app";
const EXTERNAL_HOSTS = new Set([
  "dictionary.cambridge.org",
  "www.oxfordlearnersdictionaries.com",
  "github.com",
]);

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      EXTERNAL_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function resolveAssetPath(root, value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "oxford:" ||
      url.hostname !== "app" ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes("\\") || decoded.includes("\0")) return null;
    const relative = decoded.replace(/^\/+/, "") || "index.html";
    const candidate = path.resolve(root, relative);
    if (!candidate.startsWith(path.resolve(root) + path.sep)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function isTrustedSpeechSender(event, contents) {
  if (!contents || contents.isDestroyed() || event.sender !== contents) return false;
  const frame = event.senderFrame;
  return !!frame && frame === contents.mainFrame &&
    (frame.url === `${APP_ORIGIN}/index.html` || frame.url === `${APP_ORIGIN}/index.html#`);
}

module.exports = { APP_ORIGIN, isAllowedExternalUrl, resolveAssetPath, isTrustedSpeechSender };
