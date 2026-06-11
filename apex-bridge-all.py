"""
APEX AI — Master Telemetry Bridge  v1.0
=========================================
Supports: iRacing · ACC · F1 26 · Le Mans Ultimate · rFactor 2 · Gran Turismo 7

Run this ONE file. It auto-detects which game is running and switches automatically.
For GT7 (PS5), set your PlayStation's IP address below.

INSTALL:  pip install irsdk websockets psutil pyaccsharedmemory
RUN:      python apex-bridge-all.py
"""

import asyncio, json, socket, struct, sys, time, threading
import psutil, websockets
from websockets.server import serve

# ── CONFIG ──────────────────────────────────────────────────────────────────
GT7_PS5_IP   = "192.168.1.XXX"   # <-- Set your PS5 IP here (Settings > Network > View Connection Status)
GT7_PORT     = 33740
F1_UDP_PORT  = 20777              # Must match your F1 26 game setting (Settings > Telemetry > UDP Port)
WS_PORT      = 8765               # Dashboard connects here

# ── Shared state ─────────────────────────────────────────────────────────────
state = {
    "connected": False, "game": "None", "track": "", "car": "",
    "speed": 0, "rpm": 0, "gear": 0,
    "throttle": 0, "brake": 0, "steer": 0,
    "lapTime": 0, "lastLap": 0, "bestLap": 0, "lapNum": 0, "lapPct": 0, "delta": 0,
    "tireTempFL": 0, "tireTempFR": 0, "tireTempRL": 0, "tireTempRR": 0,
    "fuel": 0, "position": 0,
}

clients: set = set()
active_game = None

# ═══════════════════════════════════════════════════════════════════════════
# GAME DETECTION
# ═══════════════════════════════════════════════════════════════════════════
def detect_game():
    try:
        procs = {p.name().lower() for p in psutil.process_iter(["name"])}
    except Exception:
        return None
    if any(n in procs for n in ["iracing.exe", "iracingui.exe", "iracingservice.exe"]):
        return "iRacing"
    if any(n in procs for n in ["ac2.exe", "accserver.exe"]):
        return "ACC"
    if any(n in procs for n in ["f1_25.exe", "f1_26.exe", "f12025.exe", "f12026.exe", "f1 25.exe", "f1 26.exe"]):
        return "F1 26"
    if any(n in procs for n in ["rrre.exe"]):
        return "LMU"
    if any(n in procs for n in ["rfactor2.exe", "rfactor2_64.exe"]):
        return "rFactor 2"
    # GT7 always active if IP is configured
    if GT7_PS5_IP and "XXX" not in GT7_PS5_IP:
        return "GT7"
    return None


# ═══════════════════════════════════════════════════════════════════════════
# iRACING READER
# ═══════════════════════════════════════════════════════════════════════════
def read_iracing():
    try:
        import irsdk
        ir = getattr(read_iracing, "_ir", None)
        if ir is None:
            ir = irsdk.IRSDK()
            read_iracing._ir = ir
        ir.startup()
        if not ir.is_initialized or not ir.is_connected:
            ir.shutdown()
            state["connected"] = False
            return
        state.update({
            "connected": True, "game": "iRacing",
            "speed":    round((ir["Speed"] or 0) * 3.6, 1),
            "rpm":      round(ir["RPM"] or 0),
            "gear":     ir["Gear"] or 0,
            "throttle": round((ir["Throttle"] or 0) * 100, 1),
            "brake":    round((ir["Brake"] or 0) * 100, 1),
            "steer":    round(ir["SteeringWheelAngle"] or 0, 3),
            "lapTime":  round(ir["LapCurrentLapTime"] or 0, 3),
            "lastLap":  round(ir["LapLastLapTime"] or 0, 3),
            "bestLap":  round(ir["LapBestLapTime"] or 0, 3),
            "lapNum":   ir["Lap"] or 0,
            "lapPct":   round(ir["LapDistPct"] or 0, 4),
            "delta":    round(ir["LapDeltaToBestLap"] or 0, 3),
            "tireTempFL": round(ir["LFtempCM"] or 0, 1),
            "tireTempFR": round(ir["RFtempCM"] or 0, 1),
            "tireTempRL": round(ir["LRtempCM"] or 0, 1),
            "tireTempRR": round(ir["RRtempCM"] or 0, 1),
            "fuel":     round(ir["FuelLevel"] or 0, 2),
            "position": ir["PlayerCarPosition"] or 0,
        })
        try:
            wi = ir["WeekendInfo"]
            if wi: state["track"] = wi.get("TrackDisplayName", wi.get("TrackName",""))
            di = ir["DriverInfo"]
            if di:
                idx = ir["PlayerCarIdx"] or 0
                d = di.get("Drivers", [])
                if idx < len(d): state["car"] = d[idx].get("CarScreenName","")
        except Exception:
            pass
    except ImportError:
        state["connected"] = False


# ═══════════════════════════════════════════════════════════════════════════
# ACC READER
# ═══════════════════════════════════════════════════════════════════════════
def read_acc():
    try:
        from pyaccsharedmemory import accSharedMemory
        asm = getattr(read_acc, "_asm", None)
        if asm is None:
            asm = accSharedMemory()
            read_acc._asm = asm
        d = asm.read_data()
        if d is None or d.graphics.status == 0:   # 0 = AC_OFF
            state["connected"] = False
            return
        ph = d.physics
        gr = d.graphics
        si = d.static
        state.update({
            "connected": True, "game": "ACC",
            "speed":    round(ph.speedKmh, 1),
            "rpm":      round(ph.rpms),
            "gear":     ph.gear,
            "throttle": round(ph.gas * 100, 1),
            "brake":    round(ph.brake * 100, 1),
            "steer":    round(ph.steerAngle, 3),
            "lapTime":  round(gr.iCurrentTime / 1000, 3),
            "lastLap":  round(gr.iLastTime / 1000, 3),
            "bestLap":  round(gr.iBestTime / 1000, 3),
            "lapNum":   gr.completedLaps,
            "lapPct":   round(gr.normalizedCarPosition, 4),
            "tireTempFL": round(ph.tyreTemp[0], 1),
            "tireTempFR": round(ph.tyreTemp[1], 1),
            "tireTempRL": round(ph.tyreTemp[2], 1),
            "tireTempRR": round(ph.tyreTemp[3], 1),
            "fuel":     round(ph.fuel, 2),
            "position": gr.position,
            "track":    si.track or "",
            "car":      si.carModel or "",
        })
    except ImportError:
        state["connected"] = False
        print("[APEX] ACC: install pyaccsharedmemory →  pip install pyaccsharedmemory")
    except Exception:
        state["connected"] = False


# ═══════════════════════════════════════════════════════════════════════════
# F1 26 UDP READER  (runs in background thread)
# ═══════════════════════════════════════════════════════════════════════════
# F1 25/26 UDP spec — packet IDs we care about:
#   ID 1  = Session (track name)
#   ID 2  = Lap data (lap times, position on track)
#   ID 6  = Car telemetry (speed, throttle, brake, gear, RPM, steer)
#   ID 9  = Car status (tire temps, fuel)
#
# Header: <HBBBBBBQfIB  (little-endian)
# Packet IDs are at byte offset 5 in header

F1_HEADER_FMT  = "<HBBBBBBQfIB"
F1_HEADER_SIZE = struct.calcsize(F1_HEADER_FMT)

_f1_sock  = None
_f1_data  = {}   # staging dict updated by UDP thread

def _f1_parse_session(payload):
    # Track index at offset 7 (uint8) in session packet
    try:
        track_id = struct.unpack_from("<B", payload, 7)[0]
        tracks = [
            "Melbourne","Paul Ricard","Shanghai","Bahrain","Catalunya","Monaco",
            "Montreal","Silverstone","Hockenheim","Hungaroring","Spa","Monza",
            "Singapore","Suzuka","Abu Dhabi","Texas","Brazil","Austria","Sochi",
            "Mexico","Baku","Sakhir","Portimao","Zandvoort","Imola","Jeddah",
            "Miami","Las Vegas","Losail","Barcelona","Interlagos","Nurburgring",
        ]
        _f1_data["track"] = tracks[track_id] if track_id < len(tracks) else f"Track {track_id}"
    except Exception:
        pass

def _f1_parse_lapdata(payload, player_idx):
    # Each lap entry is 43 bytes in F1 25/26
    try:
        offset = player_idx * 43
        fmt = "<IIIfffBBBBBBBBBBBBBfhB"
        if offset + struct.calcsize(fmt) > len(payload): return
        vals = struct.unpack_from(fmt, payload, offset)
        _f1_data["lastLap"]  = round(vals[0] / 1000, 3)
        _f1_data["bestLap"]  = round(vals[1] / 1000, 3)
        _f1_data["lapTime"]  = round(vals[2] / 1000, 3)
        _f1_data["lapPct"]   = round(vals[3], 4)
        _f1_data["lapNum"]   = vals[8]
        _f1_data["position"] = vals[9]
    except Exception:
        pass

def _f1_parse_telemetry(payload, player_idx):
    # Each car telemetry entry is 60 bytes in F1 25/26
    try:
        offset = player_idx * 60
        # speed(u16) throttle(f) steer(f) brake(f) clutch(u8) gear(i8) rpm(u16) ...
        fmt = "<HfffBbH"
        if offset + struct.calcsize(fmt) > len(payload): return
        vals = struct.unpack_from(fmt, payload, offset)
        _f1_data["speed"]    = round(vals[0], 1)
        _f1_data["throttle"] = round(vals[1] * 100, 1)
        _f1_data["steer"]    = round(vals[2], 3)
        _f1_data["brake"]    = round(vals[3] * 100, 1)
        _f1_data["gear"]     = vals[5]
        _f1_data["rpm"]      = vals[6]
    except Exception:
        pass

def _f1_parse_carstatus(payload, player_idx):
    try:
        offset = player_idx * 60  # approximate — varies by F1 version
        fmt = "<BBBBBBBBBBBBBBff"
        if offset + struct.calcsize(fmt) > len(payload): return
        vals = struct.unpack_from(fmt, payload, offset)
        _f1_data["fuel"] = round(vals[15] if len(vals) > 15 else 0, 2)
    except Exception:
        pass

def _f1_udp_thread():
    global _f1_sock
    try:
        _f1_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        _f1_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        _f1_sock.settimeout(1.0)
        _f1_sock.bind(("", F1_UDP_PORT))
        print(f"[APEX] F1 26 UDP listening on port {F1_UDP_PORT}")
        player_idx = 0
        while True:
            try:
                data, _ = _f1_sock.recvfrom(4096)
                if len(data) < F1_HEADER_SIZE: continue
                hdr = struct.unpack_from(F1_HEADER_FMT, data)
                packet_id = hdr[5]
                player_idx = hdr[10]
                payload = data[F1_HEADER_SIZE:]
                if packet_id == 1:  _f1_parse_session(payload)
                if packet_id == 2:  _f1_parse_lapdata(payload, player_idx)
                if packet_id == 6:  _f1_parse_telemetry(payload, player_idx)
                if packet_id == 9:  _f1_parse_carstatus(payload, player_idx)
                _f1_data["connected"] = True
                _f1_data["game"] = "F1 26"
                _f1_data.setdefault("car", "F1 Car")
            except socket.timeout:
                _f1_data["connected"] = False
    except Exception as e:
        print(f"[APEX] F1 UDP error: {e}")

def read_f1():
    if not _f1_data.get("connected"):
        state["connected"] = False
        return
    state.update({k: _f1_data[k] for k in _f1_data if k in state})
    state["connected"] = True

def start_f1_thread():
    t = threading.Thread(target=_f1_udp_thread, daemon=True)
    t.start()


# ═══════════════════════════════════════════════════════════════════════════
# GRAN TURISMO 7  (PS5 — UDP over WiFi)
# ═══════════════════════════════════════════════════════════════════════════
# GT7 encrypts packets with Salsa20. Community-reverse-engineered.
# Requires: pip install pycryptodome

GT7_KEY   = b"Simulator Interface Packet GT7 ver 0.0"
_gt7_sock = None
_gt7_data = {}

def _gt7_decrypt(data: bytes) -> bytes:
    try:
        from Crypto.Cipher import Salsa20
        nonce = data[0x40:0x48]
        cipher = Salsa20.new(key=GT7_KEY[:32], nonce=nonce)
        decrypted = bytearray(cipher.decrypt(data))
        decrypted[0x40:0x44] = b"\x00\x00\x00\x00"
        return bytes(decrypted)
    except ImportError:
        return data  # return raw if pycryptodome not installed

def _gt7_send_heartbeat(sock):
    if GT7_PS5_IP and "XXX" not in GT7_PS5_IP:
        try:
            sock.sendto(b"A", (GT7_PS5_IP, 33739))
        except Exception:
            pass

def _gt7_udp_thread():
    global _gt7_sock
    try:
        _gt7_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        _gt7_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        _gt7_sock.settimeout(2.0)
        _gt7_sock.bind(("", GT7_PORT))
        _gt7_send_heartbeat(_gt7_sock)
        last_hb = time.time()
        print(f"[APEX] GT7 UDP listening — PS5 at {GT7_PS5_IP}")
        while True:
            if time.time() - last_hb > 8:
                _gt7_send_heartbeat(_gt7_sock)
                last_hb = time.time()
            try:
                raw, _ = _gt7_sock.recvfrom(4096)
                data = _gt7_decrypt(raw)
                magic = struct.unpack_from("<I", data, 0)[0]
                if magic != 0x47375330:  # 'G750' — valid packet
                    continue
                # GT7 packet layout (all little-endian floats unless noted)
                pos_x, pos_y, pos_z = struct.unpack_from("<fff", data, 0x04)
                vx, vy, vz         = struct.unpack_from("<fff", data, 0x10)
                speed = (vx**2 + vy**2 + vz**2)**0.5 * 3.6   # m/s → km/h
                rpm   = struct.unpack_from("<f", data, 0x3C)[0]
                gear_byte = struct.unpack_from("<B", data, 0x91)[0]
                gear  = gear_byte & 0x0F
                throttle = struct.unpack_from("<B", data, 0x8E)[0]  # 0-255
                brake    = struct.unpack_from("<B", data, 0x8F)[0]  # 0-255
                fl_temp, fr_temp, rl_temp, rr_temp = struct.unpack_from("<ffff", data, 0x60)
                fuel_level  = struct.unpack_from("<f", data, 0x44)[0]
                fuel_cap    = struct.unpack_from("<f", data, 0x48)[0]
                lap_count   = struct.unpack_from("<H", data, 0x74)[0]
                lap_pct     = struct.unpack_from("<f", data, 0xDC)[0]
                cur_lap_ms  = struct.unpack_from("<i", data, 0x78)[0]
                last_lap_ms = struct.unpack_from("<i", data, 0x7C)[0]
                best_lap_ms = struct.unpack_from("<i", data, 0x80)[0]
                _gt7_data.update({
                    "connected": True, "game": "GT7", "car": "GT7 Car",
                    "track": "Gran Turismo 7",
                    "speed":    round(speed, 1),
                    "rpm":      round(rpm),
                    "gear":     gear,
                    "throttle": round(throttle / 255 * 100, 1),
                    "brake":    round(brake    / 255 * 100, 1),
                    "steer":    0,
                    "lapTime":  max(0, round(cur_lap_ms  / 1000, 3)),
                    "lastLap":  max(0, round(last_lap_ms / 1000, 3)),
                    "bestLap":  max(0, round(best_lap_ms / 1000, 3)),
                    "lapNum":   lap_count,
                    "lapPct":   round(max(0, min(1, lap_pct)), 4),
                    "tireTempFL": round(fl_temp, 1),
                    "tireTempFR": round(fr_temp, 1),
                    "tireTempRL": round(rl_temp, 1),
                    "tireTempRR": round(rr_temp, 1),
                    "fuel":     round(fuel_level, 2),
                    "position": 0,
                })
            except socket.timeout:
                _gt7_data["connected"] = False
    except Exception as e:
        print(f"[APEX] GT7 error: {e}")

def read_gt7():
    if not _gt7_data.get("connected"):
        state["connected"] = False
        return
    state.update({k: _gt7_data[k] for k in _gt7_data if k in state})
    state["connected"] = True

def start_gt7_thread():
    if "XXX" in GT7_PS5_IP:
        print("[APEX] GT7: Set your PS5 IP at the top of this file to enable GT7 support.")
        return
    t = threading.Thread(target=_gt7_udp_thread, daemon=True)
    t.start()


# ═══════════════════════════════════════════════════════════════════════════
# LE MANS ULTIMATE / rFACTOR 2  (shared memory via rF2SharedMemoryMap)
# ═══════════════════════════════════════════════════════════════════════════
# Requires: pip install pyRfactor2SharedMemory
def read_lmu():
    try:
        from pyRfactor2SharedMemory.sharedMemoryAPI import Rf2Telemetry
        api = getattr(read_lmu, "_api", None)
        if api is None:
            api = Rf2Telemetry()
            read_lmu._api = api
        tel = api.GetTelemetry()
        if tel is None:
            state["connected"] = False
            return
        v = tel.mVehicles[0] if len(tel.mVehicles) > 0 else None
        if v is None:
            state["connected"] = False
            return
        speed = (v.mLocalVel.x**2 + v.mLocalVel.y**2 + v.mLocalVel.z**2)**0.5 * 3.6
        game_name = "LMU" if detect_game() == "LMU" else "rFactor 2"
        state.update({
            "connected": True, "game": game_name,
            "speed":    round(speed, 1),
            "rpm":      round(v.mEngineRPM),
            "gear":     v.mGear,
            "throttle": round(v.mUnfilteredThrottle * 100, 1),
            "brake":    round(v.mUnfilteredBrake * 100, 1),
            "steer":    round(v.mUnfilteredSteering, 3),
            "lapTime":  round(v.mCurrentET, 3),
            "lastLap":  round(v.mLastLapTime, 3),
            "bestLap":  round(v.mBestLapTime, 3),
            "lapNum":   v.mTotalLaps,
            "lapPct":   round(v.mLapDist / max(1, v.mPathLateral), 4),
            "tireTempFL": round(v.mTireTemp[0] if len(v.mTireTemp) > 0 else 0, 1),
            "tireTempFR": round(v.mTireTemp[1] if len(v.mTireTemp) > 1 else 0, 1),
            "tireTempRL": round(v.mTireTemp[2] if len(v.mTireTemp) > 2 else 0, 1),
            "tireTempRR": round(v.mTireTemp[3] if len(v.mTireTemp) > 3 else 0, 1),
            "fuel":     round(v.mFuel, 2),
            "position": v.mPlace,
            "car":      v.mVehicleName.decode(errors="ignore"),
        })
        try:
            sc = api.GetScoring()
            if sc: state["track"] = sc.mScoringInfo.mTrackName.decode(errors="ignore")
        except Exception:
            pass
    except ImportError:
        state["connected"] = False
        print("[APEX] LMU/rF2: install pyRfactor2SharedMemory →  pip install pyRfactor2SharedMemory")
    except Exception:
        state["connected"] = False


# ═══════════════════════════════════════════════════════════════════════════
# GAME READER DISPATCH
# ═══════════════════════════════════════════════════════════════════════════
READERS = {
    "iRacing":  read_iracing,
    "ACC":      read_acc,
    "F1 26":    read_f1,
    "GT7":      read_gt7,
    "LMU":      read_lmu,
    "rFactor 2":read_lmu,
}

def tick():
    game = detect_game()
    if game and game in READERS:
        READERS[game]()
    else:
        state["connected"] = False
        state["game"] = "None"


# ═══════════════════════════════════════════════════════════════════════════
# WEBSOCKET SERVER
# ═══════════════════════════════════════════════════════════════════════════
async def broadcast(data):
    if not clients: return
    msg = json.dumps(data)
    dead = set()
    for ws in clients:
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)

async def on_connect(ws):
    clients.add(ws)
    print(f"[APEX] Dashboard connected  ({len(clients)} client)")
    try:
        await ws.send(json.dumps(state))
        await ws.wait_closed()
    except Exception:
        pass
    finally:
        clients.discard(ws)
        print(f"[APEX] Dashboard disconnected ({len(clients)} client(s))")

async def main_loop():
    last_game = None
    while True:
        tick()
        if state.get("game") != last_game:
            last_game = state.get("game")
            status = f"✓ {last_game}" if state["connected"] else "Waiting for game…"
            print(f"[APEX] {status}")
        await broadcast(state)
        await asyncio.sleep(0.08)

async def main():
    print()
    print("╔═══════════════════════════════════════════════╗")
    print("║   APEX AI — Master Bridge  v1.0               ║")
    print("║   Supports: iRacing · ACC · F1 26             ║")
    print("║             LMU · rFactor 2 · GT7 (PS5)       ║")
    print(f"║   Dashboard: ws://localhost:{WS_PORT}              ║")
    print("╚═══════════════════════════════════════════════╝")
    print()
    print("[APEX] Open apex-overlay.html in your browser.")
    print("[APEX] Launch any supported game — APEX AI connects automatically.")
    print("[APEX] Press Ctrl+C to stop.\n")

    # Start background threads for UDP-based games
    start_f1_thread()
    start_gt7_thread()

    async with serve(on_connect, "localhost", WS_PORT):
        await main_loop()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[APEX] Bridge stopped.")
        sys.exit(0)
