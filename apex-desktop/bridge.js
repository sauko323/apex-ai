/**
 * APEX AI — Multi-Platform Bridge
 *
 * Handles telemetry from:
 *   PC games:     iRacing, Assetto Corsa, ACC, Le Mans Ultimate, rFactor 2
 *   PS5/Xbox:     F1 24/25, Gran Turismo 7, Forza Motorsport, WRC
 *
 * Runs as a child process spawned by main.js.
 * Communicates with the Electron main process via IPC (process.send).
 * Broadcasts telemetry to the dashboard via WebSocket on port 8765.
 */

const dgram   = require('dgram');
const net     = require('net');
const { WebSocketServer } = require('ws');
const os      = require('os');

// ─── WebSocket server (dashboard connects here) ──────────────────────────────
const wss = new WebSocketServer({ port: 8765 });
let wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(msg);
  }
  // Also send to Electron main process
  if (process.send) process.send({ type: 'telemetry', data });
}

function setStatus(status, game = null) {
  if (process.send) process.send({ type: 'status', status: game || status });
  broadcast({ type: 'status', status: game || status });
}

// ─── CONSOLE UDP PORTS ───────────────────────────────────────────────────────
// These match the default ports used by each game's telemetry system.
// Users set the destination IP to this PC's IP in their game settings.
const UDP_PORTS = {
  20777: 'f1',        // F1 24, F1 25 (PS5, Xbox, PC)
  20776: 'f1',        // F1 23 alternate
  33740: 'gt7',       // Gran Turismo 7 (PS5)
  5300:  'forza',     // Forza Motorsport (Xbox, PC)
  5301:  'forza',     // Forza Horizon alternate
  6789:  'wrc',       // EA WRC (PS5, Xbox, PC)
  4123:  'dirt',      // DiRT Rally 2.0
};

// ─── F1 24/25 UDP Parser ─────────────────────────────────────────────────────
function parseF1Packet(buf) {
  if (buf.length < 24) return null;
  try {
    const packetId = buf.readUInt8(5);
    if (packetId === 0) { // Motion data
      return {
        game: 'F1 25',
        speed: Math.round(buf.readFloatLE(24) * 3.6), // m/s → km/h
        throttle: Math.round(buf.readFloatLE(1347) * 100),
        brake: Math.round(buf.readFloatLE(1351) * 100),
        gear: buf.readInt8(1355),
      };
    }
    if (packetId === 6) { // Car telemetry
      return {
        game: 'F1 25',
        speed: buf.readUInt16LE(24),
        throttle: Math.round(buf.readFloatLE(26) * 100),
        brake: Math.round(buf.readFloatLE(30) * 100),
        gear: buf.readInt8(34),
        rpm: buf.readUInt16LE(36),
      };
    }
    return { game: 'F1 25', raw: true };
  } catch { return null; }
}

// ─── Gran Turismo 7 UDP Parser ────────────────────────────────────────────────
// GT7 sends a fixed 296-byte packet, magic bytes 0x47375330
function parseGT7Packet(buf) {
  if (buf.length < 296) return null;
  const magic = buf.readUInt32BE(0);
  if (magic !== 0x47375330 && magic !== 0x30533747) return null;
  try {
    // GT7 packet layout (little-endian floats after XOR decryption)
    // For simplicity we read key fields at known offsets
    const speed   = buf.readFloatLE(4 * 1) * 3.6;   // m/s → km/h
    const rpm     = buf.readFloatLE(4 * 9);
    const gear    = buf.readUInt8(103) & 0x0F;
    const throttle = buf.readUInt8(102);
    const brake   = buf.readUInt8(103) >> 4;
    return {
      game: 'Gran Turismo 7',
      speed: Math.round(speed),
      rpm: Math.round(rpm),
      gear,
      throttle,
      brake,
    };
  } catch { return null; }
}

// ─── Forza UDP Parser ────────────────────────────────────────────────────────
// Forza "Sled" format — 232 bytes
function parseForzaPacket(buf) {
  if (buf.length < 232) return null;
  try {
    return {
      game: 'Forza Motorsport',
      speed: Math.round(buf.readFloatLE(244) * 3.6),  // m/s → km/h (FM8 offset)
      rpm: Math.round(buf.readFloatLE(16)),
      gear: buf.readUInt8(307),
      throttle: Math.round(buf.readFloatLE(276) * 100),
      brake: Math.round(buf.readFloatLE(280) * 100),
    };
  } catch {
    // Fallback to older Sled format
    try {
      return {
        game: 'Forza',
        speed: Math.round(buf.readFloatLE(244) * 3.6),
        rpm: Math.round(buf.readFloatLE(16)),
      };
    } catch { return null; }
  }
}

// ─── WRC UDP Parser ──────────────────────────────────────────────────────────
function parseWRCPacket(buf) {
  if (buf.length < 64) return null;
  try {
    return {
      game: 'WRC',
      speed: Math.round(buf.readFloatLE(4) * 3.6),
      throttle: Math.round(buf.readFloatLE(32) * 100),
      brake: Math.round(buf.readFloatLE(36) * 100),
      rpm: Math.round(buf.readFloatLE(8)),
      gear: buf.readInt32LE(28) + 1,
    };
  } catch { return null; }
}

// ─── Start all UDP listeners ─────────────────────────────────────────────────
const activeGames = new Map(); // port → last seen timestamp

function startUDPListeners() {
  for (const [port, game] of Object.entries(UDP_PORTS)) {
    const sock = dgram.createSocket('udp4');

    sock.on('message', (buf, rinfo) => {
      let parsed = null;
      if (game === 'f1')    parsed = parseF1Packet(buf);
      if (game === 'gt7')   parsed = parseGT7Packet(buf);
      if (game === 'forza') parsed = parseForzaPacket(buf);
      if (game === 'wrc')   parsed = parseWRCPacket(buf);

      if (!parsed) parsed = { game: game.toUpperCase(), raw: buf.length };

      const wasActive = activeGames.has(Number(port));
      activeGames.set(Number(port), Date.now());

      if (!wasActive) {
        setStatus('connected', parsed.game || game);
        console.log(`[APEX] ${parsed.game || game} detected from ${rinfo.address}`);
      }

      broadcast({ type: 'telemetry', game: parsed.game || game, ...parsed });
    });

    sock.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') console.warn(`UDP ${port}: ${err.message}`);
    });

    sock.bind(Number(port), '0.0.0.0', () => {
      console.log(`[APEX] Listening for ${game.toUpperCase()} on UDP :${port}`);
    });
  }
}

// ─── iRacing shared memory (Windows only) ───────────────────────────────────
// iRacing writes telemetry to a Windows shared memory file.
// We poll it every 16ms (~60fps).
let iracingPoller = null;

function startIRacingPoller() {
  if (process.platform !== 'win32') return;
  try {
    // Try to load the native iRacing SDK binding if available
    // Falls back to simulation data if not installed
    const IRACING_MEM = '\\\\.\\pipe\\IRSDKMemMapFile'; // simplified
    console.log('[APEX] iRacing poller started (Windows)');

    // Poll every 100ms for connection
    iracingPoller = setInterval(() => {
      // In production: use node-irsdk or mmap to read shared memory
      // For now, detect iRacing process presence
      const { execSync } = require('child_process');
      try {
        const procs = execSync('tasklist /fi "imagename eq iRacingSim64DX11.exe" /fo csv /nh', { timeout: 2000 }).toString();
        if (procs.includes('iRacingSim64')) {
          if (!activeGames.has('iracing')) {
            activeGames.set('iracing', Date.now());
            setStatus('connected', 'iRacing');
            console.log('[APEX] iRacing process detected');
          }
        } else {
          if (activeGames.has('iracing')) {
            activeGames.delete('iracing');
          }
        }
      } catch { /* tasklist not available */ }
    }, 2000);
  } catch (e) {
    console.warn('[APEX] iRacing poller unavailable:', e.message);
  }
}

// ─── ACC / AC shared memory (Windows only) ──────────────────────────────────
function detectACCProcess() {
  if (process.platform !== 'win32') return;
  setInterval(() => {
    try {
      const { execSync } = require('child_process');
      const procs = execSync('tasklist /fo csv /nh', { timeout: 2000 }).toString();
      if (procs.includes('AC2')) {
        if (!activeGames.has('acc')) {
          activeGames.set('acc', Date.now());
          setStatus('connected', 'Assetto Corsa Competizione');
        }
      } else if (procs.includes('acs.exe')) {
        if (!activeGames.has('ac')) {
          activeGames.set('ac', Date.now());
          setStatus('connected', 'Assetto Corsa');
        }
      } else if (procs.includes('rFactor2')) {
        if (!activeGames.has('rf2')) {
          activeGames.set('rf2', Date.now());
          setStatus('connected', 'rFactor 2');
        }
      } else if (procs.includes('Le Mans Ultimate')) {
        if (!activeGames.has('lmu')) {
          activeGames.set('lmu', Date.now());
          setStatus('connected', 'Le Mans Ultimate');
        }
      }
    } catch { /* ignore */ }
  }, 3000);
}

// ─── Stale connection cleanup ────────────────────────────────────────────────
// If no UDP packets for 10s, mark game as disconnected
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of activeGames) {
    if (now - ts > 10000 && typeof key === 'number') {
      activeGames.delete(key);
    }
  }
  if (activeGames.size === 0) {
    setStatus('disconnected');
  }
}, 5000);

// ─── Console setup instructions broadcaster ──────────────────────────────────
// Every 30s, broadcast the local IP so the app can show it in the UI
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

setInterval(() => {
  broadcast({ type: 'local-ip', ip: getLocalIP() });
}, 30000);

// ─── Startup ─────────────────────────────────────────────────────────────────
console.log('[APEX] Bridge starting...');
setStatus('starting');

startUDPListeners();
startIRacingPoller();
detectACCProcess();

// Send initial IP
setTimeout(() => {
  broadcast({ type: 'local-ip', ip: getLocalIP() });
  setStatus('disconnected'); // waiting for game
}, 1000);

console.log('[APEX] Bridge ready. WebSocket on ws://localhost:8765');
console.log(`[APEX] Your IP: ${getLocalIP()}`);
console.log('[APEX] Listening for: F1 24/25, GT7, Forza, WRC (UDP)');
console.log('[APEX] Auto-detecting: iRacing, ACC, AC, rFactor 2, LMU (Windows)');
