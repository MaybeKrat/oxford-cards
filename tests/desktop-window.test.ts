import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getInitialWindowLayout } = require("../desktop/window-options.cjs");

test("Desktop starts centered at its comfortable size on a large display", () => {
  const layout = getInitialWindowLayout({ x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(layout, {
    options: { x: 260, y: 60, width: 1400, height: 920, minWidth: 900, minHeight: 640 },
    maximize: false,
  });
});

test("Desktop uses the full work area on scaled or small screens", () => {
  for (const area of [
    { x: 0, y: 0, width: 1536, height: 824 },
    { x: 0, y: 0, width: 1366, height: 728 },
    { x: 0, y: 40, width: 800, height: 560 },
  ]) {
    const { options, maximize } = getInitialWindowLayout(area);
    assert.equal(maximize, true);
    assert.ok(options.x >= area.x + 24);
    assert.ok(options.y >= area.y + 24);
    assert.ok(options.x + options.width <= area.x + area.width - 24);
    assert.ok(options.y + options.height <= area.y + area.height - 24);
    assert.ok(options.minWidth <= options.width);
    assert.ok(options.minHeight <= options.height);
  }
});

test("Desktop respects another monitor's negative origin and taskbar offset", () => {
  const { options, maximize } = getInitialWindowLayout({
    x: -1920, y: -120, width: 1920, height: 1040,
  });
  assert.equal(options.x, -1660);
  assert.equal(options.y, -60);
  assert.equal(maximize, false);
});
