import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  resolveAssetPath,
  isAllowedExternalUrl,
  isTrustedSpeechSender,
} = require("../desktop/security.cjs");

test("Native speech is restricted to the current app main frame", () => {
  const frame = { url: "oxford://app/index.html" };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(isTrustedSpeechSender(event, contents), true);
  frame.url += "#";
  assert.equal(isTrustedSpeechSender(event, contents), true);
  assert.equal(isTrustedSpeechSender(event, undefined), false);
  assert.equal(isTrustedSpeechSender({ ...event, sender: {} }, contents), false);
  assert.equal(isTrustedSpeechSender({ ...event, senderFrame: { url: frame.url } }, contents), false);
  assert.equal(isTrustedSpeechSender({ ...event, senderFrame: null }, contents), false);
  for (const url of ["https://app/index.html", "oxford://other/index.html", "oxford://app/assets/app.js", "oxford://app/index.html?test=1"]) {
    frame.url = url;
    assert.equal(isTrustedSpeechSender(event, contents), false);
  }
  frame.url = "oxford://app/index.html";
  contents.isDestroyed = () => true;
  assert.equal(isTrustedSpeechSender(event, contents), false);
});

test("Desktop permits only HTTPS dictionary and source hosts", () => {
  assert.equal(
    isAllowedExternalUrl(
      "https://dictionary.cambridge.org/dictionary/english-russian/bank",
    ),
    true,
  );
  assert.equal(
    isAllowedExternalUrl("https://github.com/ascat41/Oxford3000_en-ru"),
    true,
  );
  for (const url of [
    "file:///C:/Windows/system32/cmd.exe",
    "javascript:alert(1)",
    "http://github.com/",
    "https://github.com.evil.test/",
    "https://github.com@evil.test/",
    "https://evil.test@github.com/",
    "https://github.com:8443/",
    "not a url",
  ]) {
    assert.equal(isAllowedExternalUrl(url), false, url);
  }
});

test("Desktop assets remain within the packaged dist directory", () => {
  const root = path.resolve("test-dist");
  assert.equal(
    resolveAssetPath(root, "oxford://app/"),
    path.join(root, "index.html"),
  );
  assert.equal(
    resolveAssetPath(root, "oxford://app/assets/app.js"),
    path.join(root, "assets", "app.js"),
  );
  for (const url of [
    "https://app/index.html",
    "oxford://other/index.html",
    "oxford://app/%2e%2e%2fsecret",
    "oxford://app/C:%5cWindows%5cwin.ini",
    "oxford://app/file%00",
    "oxford://app/%ZZ",
    "oxford://user@app/index.html",
  ]) {
    assert.equal(resolveAssetPath(root, url), null, url);
  }
});
