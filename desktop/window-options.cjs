const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 920;
const WINDOW_MARGIN = 24;

function getInitialWindowLayout(workArea) {
  // Electron supplies work areas in DIP, already adjusted for display scaling
  // and the taskbar. Keep the restored window entirely on the chosen display.
  const availableWidth = Math.max(1, workArea.width - WINDOW_MARGIN * 2);
  const availableHeight = Math.max(1, workArea.height - WINDOW_MARGIN * 2);
  const width = Math.min(DEFAULT_WIDTH, availableWidth);
  const height = Math.min(DEFAULT_HEIGHT, availableHeight);

  return {
    options: {
      x: workArea.x + Math.floor((workArea.width - width) / 2),
      y: workArea.y + Math.floor((workArea.height - height) / 2),
      width,
      height,
      minWidth: Math.min(900, availableWidth),
      minHeight: Math.min(640, availableHeight),
    },
    // A maximized window gives smaller / scaled screens all available space.
    maximize: availableWidth < DEFAULT_WIDTH || availableHeight < DEFAULT_HEIGHT,
  };
}

module.exports = { getInitialWindowLayout };
