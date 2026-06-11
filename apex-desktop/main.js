const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const os = require('os');

let mainWindow = null;
let tray = null;
let bridge = null;
let bridgeStatus = 'starting';

// ─── Single instance lock ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ─── Get local IP for console setup ─────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ─── Start bridge process ────────────────────────────────────────────────────
function startBridge() {
  if (bridge) { bridge.kill(); bridge = null; }

  bridge = fork(path.join(__dirname, 'bridge.js'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });

  bridge.on('message', (msg) => {
    if (msg.type === 'status') {
      bridgeStatus = msg.status;
      updateTray();
      if (mainWindow) mainWindow.webContents.send('bridge-status', msg);
    }
    if (msg.type === 'telemetry' && mainWindow) {
      mainWindow.webContents.send('telemetry', msg.data);
    }
  });

  bridge.on('exit', (code) => {
    console.log('Bridge exited with code', code);
    bridgeStatus = 'disconnected';
    updateTray();
    // Auto-restart after 3 seconds
    setTimeout(startBridge, 3000);
  });

  bridge.on('error', (err) => console.error('Bridge error:', err));
}

// ─── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  // Use a simple 16x16 blank icon — replace assets/icon.png with your real icon
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  updateTray();

  tray.on('click', () => {
    if (mainWindow) { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); }
  });
}

function updateTray() {
  if (!tray) return;

  const statusLabel = {
    'starting':     'Starting bridge...',
    'connected':    'Connected',
    'disconnected': 'No game detected',
    'iracing':      'iRacing connected',
    'acc':          'ACC connected',
    'ac':           'AC connected',
    'lmu':          'LMU connected',
    'rf2':          'rFactor 2 connected',
    'f1':           'F1 game connected',
    'gt7':          'Gran Turismo 7 connected',
    'forza':        'Forza connected',
    'wrc':          'WRC connected',
  }[bridgeStatus] || bridgeStatus;

  const contextMenu = Menu.buildFromTemplate([
    { label: 'APEX AI', enabled: false },
    { label: `Status: ${statusLabel}`, enabled: false },
    { label: `Your IP: ${getLocalIP()}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Restart Bridge', click: startBridge },
    { type: 'separator' },
    { label: 'Quit APEX AI', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(`APEX AI — ${statusLabel}`);
}

// ─── Main Window ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'APEX AI',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  // Load the app — either bundled HTML or the live site
  const appFile = path.join(__dirname, 'apex-ai.html');
  const fs = require('fs');
  if (fs.existsSync(appFile)) {
    mainWindow.loadFile(appFile);
  } else {
    mainWindow.loadURL('https://apex-sim-ai.netlify.app/apex-ai.html');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Send initial status and IP
    mainWindow.webContents.send('bridge-status', { type: 'status', status: bridgeStatus });
    mainWindow.webContents.send('local-ip', getLocalIP());
  });

  // Hide instead of close (stays in tray)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createTray();
  createWindow();
  startBridge();

  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => { app.isQuitting = true; });

app.on('quit', () => {
  if (bridge) bridge.kill();
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
});

// ─── IPC: renderer → main ────────────────────────────────────────────────────
ipcMain.handle('get-local-ip', () => getLocalIP());
ipcMain.handle('get-bridge-status', () => bridgeStatus);
ipcMain.handle('restart-bridge', () => startBridge());
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
