// agent-notify tray: a tray icon plus a global hotkey that shows and hides the board as a frameless popup.
// Run it with `npx agent-notify tray`. It starts the dashboard itself if nothing is listening yet.
const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.AGENT_NOTIFY_PORT ?? 7878);
const URL = `http://localhost:${PORT}`;
const HOTKEY = process.env.AGENT_NOTIFY_HOTKEY ?? 'ScrollLock';
// Scales the board's text up; AGENT_NOTIFY_ZOOM overrides it (1 is the original size).
const ZOOM = Number(process.env.AGENT_NOTIFY_ZOOM ?? 1.4);
const BOUNDS_FILE = path.join(app.getPath('userData'), 'window-bounds.json');
const NOTIFY = path.join(__dirname, '..', 'notify.mjs');

let win;
let tray;
let dashboard;

if (!app.requestSingleInstanceLock()) app.quit();

/** A 16x16 PNG, drawn here so the tray needs no image file: a green dot on a dark rounded square. */
function icon() {
  const n = 16;
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    for (let x = 0; x < n; x++) {
      const dot = (x - 7.5) ** 2 + (y - 7.5) ** 2 < 15;
      const px = dot ? [74, 222, 128, 255] : [30, 32, 40, 255];
      raw.set(px, y * (n * 4 + 1) + 1 + x * 4);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(n, 0);
  head.writeUInt32BE(n, 4);
  head.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return nativeImage.createFromBuffer(png);
}

const listening = () =>
  new Promise((resolve) => {
    const req = http.get(URL, (res) => (res.resume(), resolve(true)));
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => (req.destroy(), resolve(false)));
  });

async function ensureDashboard() {
  if (await listening()) return;
  dashboard = spawn(process.env.AGENT_NOTIFY_NODE ?? 'node', [NOTIFY, 'dashboard'], { stdio: 'ignore', windowsHide: true });
  dashboard.on('error', () => {});
  for (let i = 0; i < 20 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 250));
}

/** The bounds the user last left the window at, if any. */
function savedBounds() {
  try {
    const { x, y, width, height } = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    if (width >= 300 && height >= 300) return { x, y, width, height };
  } catch {}
  return null;
}

function place() {
  const saved = savedBounds();
  // reuse the saved spot only if it is still on a connected screen (a monitor may have been unplugged)
  const display = saved && screen.getAllDisplays().find((d) => {
    const a = d.workArea;
    return Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.x < a.x + a.width - 60 && saved.x + saved.width > a.x + 60 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 60;
  });
  const { workArea } = display ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const want = saved ?? { width: Math.round(1000 * ZOOM), height: Math.round(900 * ZOOM) };
  const w = Math.min(want.width, workArea.width - 40);
  const h = Math.min(want.height, workArea.height - 40);
  const x = display ? Math.min(Math.max(saved.x, workArea.x), workArea.x + workArea.width - w) : workArea.x + Math.round((workArea.width - w) / 2);
  const y = display ? Math.min(Math.max(saved.y, workArea.y), workArea.y + workArea.height - h) : workArea.y + Math.round((workArea.height - h) / 2);
  win.setBounds({ x, y, width: w, height: h });
}

function show() {
  place();
  win.show();
  win.focus();
}

function toggle() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else show();
}

app.whenReady().then(async () => {
  await ensureDashboard();
  win = new BrowserWindow({ show: false, frame: false, skipTaskbar: true, alwaysOnTop: true, resizable: true, backgroundColor: '#14161c', webPreferences: { contextIsolation: true } });
  win.webContents.setZoomFactor(ZOOM);
  // the page caps its content at 820px; in this popup the window sets the width, so let the rows fill it
  win.webContents.on('did-finish-load', () => win.webContents.insertCSS('main { max-width: none !important; padding-left: 56px; padding-right: 56px; } body::before { content: ""; position: fixed; top: 0; left: 0; right: 0; height: 14px; z-index: 9999; -webkit-app-region: drag; }'));
  win.loadURL(URL);
  // 'moved' and 'resized' fire only after the user lets go, never for our own setBounds
  const remember = () => {
    try {
      fs.writeFileSync(BOUNDS_FILE, JSON.stringify(win.getBounds()));
    } catch {}
  };
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('blur', () => win.hide());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') (e.preventDefault(), win.hide());
  });
  win.webContents.on('did-fail-load', () => setTimeout(() => win.loadURL(URL), 2000));

  tray = new Tray(icon());
  tray.setToolTip(`agent-notify board (${HOTKEY})`);
  tray.on('click', toggle);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show board', click: show },
      { label: 'Reload', click: () => win.loadURL(URL) },
      { label: 'Start at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );

  if (!globalShortcut.register(HOTKEY.replace(/^ctrl\+/i, 'CommandOrControl+'), toggle)) {
    console.error(`could not register ${HOTKEY}; another program has it`);
  }
  show();
});

app.on('second-instance', () => win && show());
app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  dashboard?.kill();
});
