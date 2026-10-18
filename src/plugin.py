# /// script
# requires-python = ">=3.12"
#
# [tool.orcaslicer.plugin]
# name = "Real G-code Playback"
# description = "Real-time playback of the sliced G-code in its own tab: a motion-planned, accelerations-and-corners timeline of the print, synced to the slicer's own time estimate."
# author = "NickChung"
# version = "@@VERSION@@"
# ///
"""Real G-code Playback — watch the sliced G-code print in real time, in an OrcaSlicer tab.

Changelog
---------
@@CHANGELOG_TEXT@@

Two capabilities:

  * "Playback" (Pages) — the tab. A self-contained HTML page with a G-code parser, a motion planner
    (trapezoidal accel/decel with jerk or junction-deviation corners, lookahead) and a Three.js
    viewer. Timing is synced to the slicer's estimate using the M73 progress markers OrcaSlicer
    writes, so the playback clock matches the time OrcaSlicer shows.

  * "Playback capture" (Slicing pipeline) — optional, recommended. When it is selected under
    Process > Others > Slicing Pipeline Plugin, it copies the G-code at the post-processing step into
    this plugin's folder so the tab can load it without any permission prompt. For Bambu Lab
    printers that step runs on every slice; for other printers it runs when you export or send.
    It never changes the G-code.

Without the capture capability the tab falls back to finding OrcaSlicer's temporary G-code for
the last slice; OrcaSlicer asks once for read permission on those files.

Files this plugin writes: only inside its own folder (.captures/latest.gcode + latest.json, and
exports/ for videos and pictures when OrcaSlicer's page can't show a Save dialog).
Network: only when you connect a printer under Options > Printer. The plugin then talks to that one
address (Bambu Lab LAN MQTT, Klipper/Moonraker, OctoPrint or PrusaLink) to read its status. It never
sends commands that move or change anything. No processes started.
"""

import base64
import glob
import json
import os
import socket
import ssl
import struct
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

import orca

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
# dot-prefixed so OrcaSlicer's plugin scanner never treats it as a plugin folder
CAPTURE_DIR = os.path.join(PLUGIN_DIR, ".captures")
CAPTURE_FILE = os.path.join(CAPTURE_DIR, "latest.gcode")
CAPTURE_META = os.path.join(CAPTURE_DIR, "latest.json")
CHUNK_CHARS = 384 * 1024            # per message; each is one RunScript call into the page
CAPTURE_NAME = "Playback capture"
# videos and pictures from the Export dialog, when the page can't open the system's Save dialog
EXPORT_DIR = os.path.join(PLUGIN_DIR, "exports")
EXPORT_EXTS = {".mp4", ".webm", ".gif", ".png", ".jpg", ".jpeg", ".webp"}
EXPORT_MAX = 4 * 1024 * 1024 * 1024

DEFAULT_PREFS = {"speed": 10, "color": "feature", "travel": False, "layerOnly": False, "follow": False,
                 "motion": "auto", "lines": "fat", "timing": "aligned", "head": True, "gantry": True, "shade": "tube", "flags": {}, "pauseOnLeave": True}

PRINTER_CFG_KEYS = ("type", "host", "key", "serial", "auto")

SETUP_HINT = {
    "title": "One-time setup for automatic loading",
    "steps": [
        "Open the <b>Process</b> settings and switch to <b>Advanced</b> mode.",
        "Go to <b>Others</b> → <b>Slicing Pipeline Plugin</b> and add <b>Playback capture</b>.",
        "Slice again. Bambu Lab printers are captured on every slice; other printers when you export or send.",
    ],
}

CHANGELOG = @@CHANGELOG_JSON@@

# The live page capability, so the capture capability can tell the tab a new slice arrived.
_PAGE = None
_PAGE_HTML = None
_CAPTURE_SEEN = {"t": 0.0}          # when the capture capability last ran
SESSION_START = time.time()         # a capture older than this OrcaSlicer session is not "new"


# --------------------------------------------------------------------------- #
# page
# --------------------------------------------------------------------------- #
PAGE_TEMPLATE = r'''@@PAGE_TEMPLATE@@'''

VENDOR_B64 = """
@@VENDOR_B64@@
"""


# MP4/WebM encoders (WebAssembly), sent to the page on request: they would push the page past the
# 2 MB that WebView2's NavigateToString accepts
ENCODERS_B64 = """
@@ENCODERS_B64@@
"""


def page_html():
    """Three.js ships compressed in this file; the page template and app code stay readable."""
    global _PAGE_HTML
    if _PAGE_HTML is None:
        vendor = zlib.decompress(base64.b64decode("".join(VENDOR_B64.split()))).decode("utf-8")
        _PAGE_HTML = PAGE_TEMPLATE.replace("/*@@VENDOR@@*/", vendor, 1)
    return _PAGE_HTML


# --------------------------------------------------------------------------- #
# finding the G-code of the last slice
# --------------------------------------------------------------------------- #
def read_capture_meta():
    try:
        with open(CAPTURE_META, "r", encoding="utf-8") as handle:
            meta = json.load(handle)
        if os.path.isfile(CAPTURE_FILE):
            meta["mtime"] = os.path.getmtime(CAPTURE_FILE)
            meta["size"] = os.path.getsize(CAPTURE_FILE)
            return meta
    except Exception:
        pass
    return None


def temp_roots():
    base = tempfile.gettempdir()
    roots = [base]
    if hasattr(os, "getuid"):
        roots.insert(0, os.path.join(base, f"orcaslicer_{os.getuid()}"))
    return roots


def find_temp_gcode():
    """OrcaSlicer keeps each plate's sliced G-code at
    <temp>/orcaslicer_model/<day>/<time>#<pid>#<model>/Metadata/.<pid>.<n>.gcode
    (see PartPlate::get_tmp_gcode_path). The plugin runs inside that same process, so the pid
    narrows it to this session. Reading there makes OrcaSlicer ask once for permission."""
    pid = os.getpid()
    best = None
    for root in temp_roots():
        pattern = os.path.join(root, "orcaslicer_model", "*", f"*#{pid}#*", "Metadata", f".{pid}.*.gcode")
        for path in glob.glob(pattern):
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if best is None or mtime > best[1]:
                best = (path, mtime)
    return best


def stable(path, wait=4.0):
    """Wait until a file stops growing (the slicer may still be writing it)."""
    deadline = time.time() + wait
    last = -1
    while time.time() < deadline:
        try:
            size = os.path.getsize(path)
        except OSError:
            return False
        if size == last and size > 0:
            return True
        last = size
        time.sleep(0.25)
    return last > 0


def when_text(mtime):
    age = max(0, time.time() - mtime)
    if age < 90:
        return "sliced just now"
    if age < 3600:
        return f"sliced {int(age // 60)} min ago"
    return "sliced " + time.strftime("%H:%M", time.localtime(mtime))


# --------------------------------------------------------------------------- #
# the printer: ask it what it is doing, about once a second (Live mode)
# --------------------------------------------------------------------------- #
PRINTER_TYPES = ("bambu", "moonraker", "octoprint", "prusalink")
POLL_SECONDS = 1.0


def _norm_state(raw):
    s = str(raw or "").strip().lower()
    if s.startswith("printing") or s in ("running", "prepare", "busy"):
        return "printing"
    if s in ("paused", "pause", "pausing"):
        return "paused"
    if s in ("complete", "completed", "finish", "finished"):
        return "done"
    if s in ("error", "failed", "cancelled", "canceled", "cancelling", "stopped", "attention"):
        return "error"
    return "idle"


def _base_url(host, default_port):
    host = (host or "").strip()
    if "://" not in host:
        host = "http://" + host
    parts = urllib.parse.urlsplit(host)
    netloc = parts.netloc
    if parts.port is None and default_port:
        netloc += f":{default_port}"
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path.rstrip("/"), "", ""))


def _http_json(url, headers=None, timeout=3):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def fetch_moonraker(cfg):
    headers = {"X-Api-Key": cfg["key"]} if cfg.get("key") else {}
    query = "/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed"
    s = _http_json(_base_url(cfg["host"], 7125) + query, headers)["result"]["status"]
    ps, info = s["print_stats"], s["print_stats"].get("info") or {}
    return {"state": _norm_state(ps.get("state")), "raw_state": ps.get("state"), "file": ps.get("filename"),
            "progress": _num(s["virtual_sdcard"].get("progress")),
            "layer": _num(info.get("current_layer")), "total_layers": _num(info.get("total_layer")),
            "nozzle": _num(s["extruder"].get("temperature")), "bed": _num(s["heater_bed"].get("temperature"))}


def fetch_octoprint(cfg):
    base, headers = _base_url(cfg["host"], None), {"X-Api-Key": cfg.get("key", "")}
    job = _http_json(base + "/api/job", headers)
    done = _num((job.get("progress") or {}).get("completion"))
    out = {"state": _norm_state(job.get("state")), "raw_state": job.get("state"),
           "file": ((job.get("job") or {}).get("file") or {}).get("name"),
           "progress": done / 100 if done is not None else None,
           "remaining_s": _num((job.get("progress") or {}).get("printTimeLeft"))}
    try:
        temps = _http_json(base + "/api/printer", headers)["temperature"]
        out["nozzle"], out["bed"] = _num(temps["tool0"]["actual"]), _num(temps["bed"]["actual"])
    except Exception:
        pass            # /api/printer answers 409 while the printer is not operational
    return out


def fetch_prusalink(cfg):
    s = _http_json(_base_url(cfg["host"], None) + "/api/v1/status", {"X-Api-Key": cfg.get("key", "")})
    pr, job = s.get("printer") or {}, s.get("job") or {}
    pct = _num(job.get("progress"))
    return {"state": _norm_state(pr.get("state")), "raw_state": pr.get("state"), "file": None,
            "progress": pct / 100 if pct is not None else None, "remaining_s": _num(job.get("time_remaining")),
            "nozzle": _num(pr.get("temp_nozzle")), "bed": _num(pr.get("temp_bed"))}


def _bambu_status(r):
    pct, mins = _num(r.get("mc_percent")), _num(r.get("mc_remaining_time"))
    return {"state": _norm_state(r.get("gcode_state")), "raw_state": r.get("gcode_state"),
            "file": r.get("subtask_name") or r.get("gcode_file"),
            "progress": pct / 100 if pct is not None else None,
            "layer": _num(r.get("layer_num")), "total_layers": _num(r.get("total_layer_num")),
            "remaining_s": mins * 60 if mins is not None else None,
            "nozzle": _num(r.get("nozzle_temper")), "bed": _num(r.get("bed_temper"))}


class MiniMQTT:
    """Just enough MQTT 3.1.1 (TLS, QoS 0) to listen to a Bambu Lab printer in LAN mode."""

    def __init__(self, host, port, user, password, client_id):
        self.host, self.port, self.user, self.password, self.client_id = host, port, user, password, client_id
        self.sock, self.pid, self.last_tx = None, 0, 0.0

    @staticmethod
    def _str(text):
        raw = text.encode("utf-8")
        return struct.pack(">H", len(raw)) + raw

    def _send(self, first, body):
        n, enc = len(body), b""
        while True:
            byte, n = n % 128, n // 128
            enc += bytes([byte | (128 if n else 0)])
            if not n:
                break
        self.sock.sendall(bytes([first]) + enc + body)
        self.last_tx = time.time()

    def _read_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("printer closed the connection")
            buf += chunk
        return buf

    def _read_packet(self, timeout):
        self.sock.settimeout(timeout)
        try:
            first = self._read_exact(1)[0]
        except (TimeoutError, ssl.SSLWantReadError):
            return None, b""
        self.sock.settimeout(10)
        length, mult = 0, 1
        while True:
            byte = self._read_exact(1)[0]
            length += (byte & 127) * mult
            mult *= 128
            if not byte & 128:
                break
        return first, self._read_exact(length) if length else b""

    def connect(self):
        raw = socket.create_connection((self.host, self.port), timeout=8)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE          # the printer's certificate is self-signed
        self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
        body = self._str("MQTT") + bytes([4, 0xC2]) + struct.pack(">H", 60) + \
            self._str(self.client_id) + self._str(self.user) + self._str(self.password)
        self._send(0x10, body)
        kind, ack = self._read_packet(8.0)
        if kind != 0x20 or len(ack) < 2 or ack[1] != 0:
            raise ConnectionError("the printer refused the login (check the LAN access code)")

    def subscribe(self, topic):
        self.pid += 1
        self._send(0x82, struct.pack(">H", self.pid) + self._str(topic) + b"\x00")

    def publish(self, topic, text):
        self._send(0x30, self._str(topic) + text.encode("utf-8"))

    def poll(self, timeout):
        """Wait up to `timeout` s for a message: (topic, payload) or None. Also keeps the link alive."""
        if time.time() - self.last_tx > 30:
            self._send(0xC0, b"")
        kind, body = self._read_packet(timeout)
        if kind is None or kind & 0xF0 != 0x30:
            return None
        tlen = struct.unpack(">H", body[:2])[0]
        offset = 2 + tlen + (2 if (kind >> 1) & 3 else 0)
        return body[2:2 + tlen].decode("utf-8", "replace"), body[offset:]

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


def _err_text(exc):
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code}" + (" (check the API key)" if exc.code in (401, 403) else "")
    reason = getattr(exc, "reason", None) or exc
    return str(reason)[:160]


class PrinterLink:
    """Background thread: polls (or listens to) the printer and hands every reading to on_status.
    A thread the plugin starts itself runs outside OrcaSlicer's per-call audit scope."""

    def __init__(self, cfg, on_status):
        self.cfg, self.on_status = cfg, on_status
        self.status = {"connected": False}
        self.stop_event = threading.Event()
        self.thread = None

    def running(self):
        return bool(self.thread and self.thread.is_alive() and not self.stop_event.is_set())

    def start(self):
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, daemon=True, name="playback-printer")
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def _emit(self, status):
        self.status = status
        try:
            self.on_status(status)
        except Exception:
            pass

    def _run(self):
        try:
            if self.cfg["type"] == "bambu":
                self._run_bambu()
            else:
                self._run_http()
        except Exception as exc:
            self._emit({"connected": False, "error": _err_text(exc)})

    def _run_http(self):
        fetch = {"moonraker": fetch_moonraker, "octoprint": fetch_octoprint, "prusalink": fetch_prusalink}[self.cfg["type"]]
        while not self.stop_event.is_set():
            try:
                status = fetch(self.cfg)
                status["connected"], status["ts"] = True, time.time()
            except Exception as exc:
                status = {"connected": False, "error": _err_text(exc)}
            self._emit(status)
            self.stop_event.wait(POLL_SECONDS)

    def _run_bambu(self):
        cfg, report = self.cfg, {}
        serial = cfg["serial"].strip()
        while not self.stop_event.is_set():
            mq = MiniMQTT(cfg["host"].strip(), 8883, "bblp", cfg["key"].strip(), f"playback-{int(time.time())}")
            try:
                mq.connect()
                mq.subscribe(f"device/{serial}/report")
                last_push = last_emit = 0.0
                while not self.stop_event.is_set():
                    now = time.time()
                    if now - last_push > 30:          # ask for the full state now and then; reports are deltas
                        mq.publish(f"device/{serial}/request",
                                   json.dumps({"pushing": {"sequence_id": "1", "command": "pushall"}}))
                        last_push = now
                    packet = mq.poll(1.0)
                    if packet:
                        try:
                            data = json.loads(packet[1])
                        except ValueError:
                            data = None
                        if isinstance(data, dict) and isinstance(data.get("print"), dict):
                            report.update(data["print"])
                    if report and time.time() - last_emit >= POLL_SECONDS:
                        status = _bambu_status(report)
                        status["connected"], status["ts"] = True, time.time()
                        self._emit(status)
                        last_emit = time.time()
            except Exception as exc:
                self._emit({"connected": False, "error": _err_text(exc)})
            finally:
                mq.close()
            self.stop_event.wait(3.0)


# --------------------------------------------------------------------------- #
# the tab
# --------------------------------------------------------------------------- #
class PlaybackPage(orca.pages.PagesPluginCapabilityBase):
    def __init__(self):
        super().__init__()
        self.lock = threading.Lock()
        self.transfer_id = 0
        self.slice_done_at = 0.0
        self.loading = False
        self.link = None
        global _PAGE
        _PAGE = self

    def get_name(self):
        return "Playback"

    def get_icon(self):
        return "tab_preview_active"      # resources/images/tab_preview_active.svg, ships with OrcaSlicer

    def get_ui(self):
        return page_html()

    def on_load(self):
        global _PAGE
        _PAGE = self

    def on_unload(self):
        self.stop_printer()
        global _PAGE
        if _PAGE is self:
            _PAGE = None

    def get_default_config(self):
        return {"prefs": dict(DEFAULT_PREFS)}

    # ---- helpers ------------------------------------------------------------
    def post(self, payload):
        try:
            self.post_message(payload)
        except Exception:
            pass

    def prefs(self):
        try:
            cfg = json.loads(self.get_config() or "{}")
        except Exception:
            cfg = {}
        out = dict(DEFAULT_PREFS)
        stored = cfg.get("prefs") if isinstance(cfg, dict) else None
        if isinstance(stored, dict):
            for key, value in stored.items():
                if key in DEFAULT_PREFS and isinstance(value, type(DEFAULT_PREFS[key])):
                    out[key] = value
                elif key == "speed" and isinstance(value, (int, float)) and not isinstance(value, bool):
                    out[key] = value
        return out

    # ---- printer (Live mode) -------------------------------------------------
    def cfg(self):
        try:
            cfg = json.loads(self.get_config() or "{}")
        except Exception:
            cfg = {}
        return cfg if isinstance(cfg, dict) else {}

    def stop_printer(self):
        link, self.link = self.link, None
        if link:
            link.stop()

    def start_printer(self, pcfg):
        self.stop_printer()
        self.link = PrinterLink(pcfg, lambda st: self.post({"cmd": "printer", "status": st}))
        self.link.start()

    def connect_printer(self, msg):
        pcfg = {"type": str(msg.get("type") or ""), "host": str(msg.get("host") or "").strip()[:200],
                "key": str(msg.get("key") or "").strip()[:200], "serial": str(msg.get("serial") or "").strip()[:60],
                "auto": True}
        problem = None
        if pcfg["type"] not in PRINTER_TYPES:
            problem = "Choose a printer type."
        elif not pcfg["host"]:
            problem = "Enter the printer's IP address."
        elif pcfg["type"] == "bambu" and not (pcfg["serial"] and pcfg["key"]):
            problem = "A Bambu Lab printer needs its serial number and LAN access code."
        if problem:
            self.post({"cmd": "printer", "status": {"connected": False, "error": problem}, "stopped": True})
            return
        cfg = self.cfg()
        cfg["printer"] = pcfg
        self.save_config(json.dumps(cfg))
        self.start_printer(pcfg)

    def disconnect_printer(self):
        self.stop_printer()
        cfg = self.cfg()
        if isinstance(cfg.get("printer"), dict):
            cfg["printer"]["auto"] = False
            self.save_config(json.dumps(cfg))

    def printer_payload(self):
        saved = self.cfg().get("printer")
        if not isinstance(saved, dict):
            return None
        if saved.get("auto") and saved.get("type") in PRINTER_TYPES and not (self.link and self.link.running()):
            self.start_printer({k: saved.get(k) for k in PRINTER_CFG_KEYS})
        return {"cfg": {k: saved.get(k) for k in PRINTER_CFG_KEYS},
                "status": self.link.status if self.link else None}

    def latest(self):
        """Identify the newest slice of this session without reading it.
        The stamp is what the page compares with the G-code it shows."""
        meta = read_capture_meta()
        fresh_capture = meta and meta["mtime"] >= SESSION_START - 5 and \
            (not self.slice_done_at or meta["mtime"] >= self.slice_done_at - 30)
        if fresh_capture:
            return {"stamp": f"c{meta['mtime']:.3f}", "name": meta.get("name", ""), "when": when_text(meta["mtime"])}
        if self.slice_done_at:
            return {"stamp": f"s{self.slice_done_at:.3f}", "name": "", "when": when_text(self.slice_done_at)}
        return None

    def status(self, cmd="status"):
        meta = read_capture_meta()
        payload = {"cmd": cmd, "capture_enabled": bool(meta) or _CAPTURE_SEEN["t"] > 0, "hint": SETUP_HINT,
                   "latest": self.latest()}
        if cmd == "status":
            payload["prefs"] = self.prefs()
            payload["about"] = CHANGELOG
            payload["printer"] = self.printer_payload()
        return payload

    # ---- page messages (UI thread: keep quick) ------------------------------
    def on_message(self, msg):
        if not isinstance(msg, dict):
            return
        cmd = msg.get("cmd")
        try:
            if cmd == "hello":
                self.post(self.status())
            elif cmd == "printer_connect":
                self.connect_printer(msg)
            elif cmd == "printer_disconnect":
                self.disconnect_printer()
            elif cmd == "check_latest":
                self.post(self.status("latest_info"))
            elif cmd == "load_latest":
                if not self.loading:
                    self.loading = True
                    threading.Thread(target=self.send_latest, args=(bool(msg.get("quiet")),), daemon=True).start()
            elif cmd == "load_encoders":
                threading.Thread(target=self.send_encoders, args=(str(msg.get("id", ""))[:40],), daemon=True).start()
            elif cmd in ("save_begin", "save_chunk", "save_end"):
                self.on_save(cmd, msg)
            elif cmd == "save_prefs":
                prefs = msg.get("prefs")
                if isinstance(prefs, dict):
                    clean = {k: prefs[k] for k in DEFAULT_PREFS if k in prefs}
                    cfg = self.cfg()
                    cfg["prefs"] = clean
                    self.save_config(json.dumps(cfg))
        except Exception as exc:
            self.post({"cmd": "error", "message": str(exc)[:300]})

    # ---- export: the video encoders, in parts (they are too big for the page itself)
    def send_encoders(self, rid):
        try:
            text = zlib.decompress(base64.b64decode("".join(ENCODERS_B64.split()))).decode("utf-8")
            parts = [text[i:i + CHUNK_CHARS] for i in range(0, len(text), CHUNK_CHARS)] or [""]
            self.post({"cmd": "lib_begin", "id": rid, "chunks": len(parts)})
            for index, part in enumerate(parts):
                self.post({"cmd": "lib_chunk", "id": rid, "i": index, "data": part})
            self.post({"cmd": "lib_end", "id": rid})
        except Exception as exc:
            self.post({"cmd": "lib_end", "id": rid, "error": str(exc)[:300]})

    # ---- export: the page sends a finished file in base64 chunks -------------
    def on_save(self, cmd, msg):
        saves = self.__dict__.setdefault("saves", {})
        sid = str(msg.get("id", ""))[:40]
        if cmd == "save_begin":
            name = os.path.basename(str(msg.get("name") or "export"))
            name = "".join(ch if ch.isalnum() or ch in "-_. ()" else "_" for ch in name).strip(" .") or "export"
            stem, ext = os.path.splitext(name)
            if ext.lower() not in EXPORT_EXTS:
                self.post({"cmd": "saved", "id": sid, "ok": False, "error": "Unsupported file type"})
                return
            if int(msg.get("size") or 0) > EXPORT_MAX:
                self.post({"cmd": "saved", "id": sid, "ok": False, "error": "File too large"})
                return
            os.makedirs(EXPORT_DIR, exist_ok=True)
            path, n = os.path.join(EXPORT_DIR, stem + ext), 2
            while os.path.exists(path):
                path = os.path.join(EXPORT_DIR, f"{stem} ({n}){ext}"); n += 1
            saves[sid] = {"path": path, "f": open(path, "wb"), "next": 0}
        elif cmd == "save_chunk":
            sv = saves.get(sid)
            if not sv:
                return
            if int(msg.get("i", -1)) != sv["next"]:
                sv["f"].close(); saves.pop(sid, None)
                self.post({"cmd": "saved", "id": sid, "ok": False, "error": "Parts arrived out of order"})
                return
            sv["f"].write(base64.b64decode(msg.get("data") or ""))
            sv["next"] += 1
        else:
            sv = saves.pop(sid, None)
            if not sv:
                self.post({"cmd": "saved", "id": sid, "ok": False, "error": "Unknown export"})
                return
            sv["f"].close()
            self.post({"cmd": "saved", "id": sid, "ok": True, "path": sv["path"]})

    # ---- lifecycle: a slice finished somewhere in OrcaSlicer ----------------
    def on_lifecycle_event(self, event, ctx):
        try:
            if event == orca.LifecycleEvent.SlicingJobComplete and ctx.code == orca.LifecycleEvtCode.Ok:
                self.slice_done_at = time.time()
                threading.Thread(target=self.announce_slice, daemon=True).start()
        except Exception:
            pass

    def announce_slice(self):
        # give the capture step a moment to finish copying (it runs on the slicing thread)
        deadline = time.time() + 3.0
        while time.time() < deadline:
            meta = read_capture_meta()
            if meta and meta.get("mtime", 0) >= self.slice_done_at - 30:
                break
            time.sleep(0.25)
        self.post(self.status("slice_ready"))

    # ---- sending G-code to the page (worker thread) --------------------------
    def pick_source(self, allow_temp=True):  # -> (path, mtime, name, how, stamp)
        """Return (path, mtime, name, how) for the newest G-code of the current session.
        The temp-folder fallback can raise OrcaSlicer's permission prompt, so it only runs when the
        user pressed the button, never for an automatic reload."""
        meta = read_capture_meta()
        fresh_capture = meta and (not self.slice_done_at or meta["mtime"] >= self.slice_done_at - 30)
        if fresh_capture:
            return CAPTURE_FILE, meta["mtime"], meta.get("name") or "Latest slice", "capture", f"c{meta['mtime']:.3f}"
        temp = None
        try:
            temp = find_temp_gcode() if allow_temp else None
        except Exception:
            temp = None          # permission declined or nothing there
        if temp and (not meta or temp[1] > meta["mtime"]):
            stamp = f"s{self.slice_done_at:.3f}" if self.slice_done_at else f"t{temp[1]:.3f}"
            return temp[0], temp[1], "Latest slice", "temp", stamp
        if meta:
            return CAPTURE_FILE, meta["mtime"], meta.get("name") or "Latest slice", "capture", f"c{meta['mtime']:.3f}"
        return None

    def send_latest(self, quiet):
        try:
            # every load is a direct result of the user opening the tab or pressing the button,
            # so the temp-folder fallback (which may show OrcaSlicer's permission prompt) is fine
            src = self.pick_source(allow_temp=True)
            if not src:
                self.post({"cmd": "error", "quiet": quiet, "setup": True, "capture_enabled": False, "hint": SETUP_HINT,
                           "message": "No sliced G-code found yet. Slice a plate first"
                                      " (or set up Playback capture, see the tab)."})
                return
            path, mtime, name, how, stamp = src
            stable(path)
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
            with self.lock:
                self.transfer_id += 1
                tid = self.transfer_id
            chunks = [text[i:i + CHUNK_CHARS] for i in range(0, len(text), CHUNK_CHARS)] or [""]
            self.post({"cmd": "gcode_begin", "id": tid, "name": name, "size": len(text),
                       "chunks": len(chunks), "when": when_text(mtime), "source": how, "stamp": stamp})
            for index, part in enumerate(chunks):
                with self.lock:
                    if tid != self.transfer_id:
                        return            # a newer request superseded this one
                self.post({"cmd": "gcode_chunk", "id": tid, "i": index, "data": part})
            self.post({"cmd": "gcode_end", "id": tid, "reload": quiet})
        except PermissionError:
            latest = self.latest() or {}
            self.post({"cmd": "error", "quiet": False, "setup": True, "capture_enabled": False, "hint": SETUP_HINT,
                       "stamp": latest.get("stamp"),
                       "message": "OrcaSlicer did not allow reading the temporary G-code."
                                  " Set up Playback capture to load slices without asking."})
        except Exception as exc:
            self.post({"cmd": "error", "quiet": quiet, "message": f"Could not load the slice: {str(exc)[:240]}"})
        finally:
            self.loading = False


# --------------------------------------------------------------------------- #
# the capture step
# --------------------------------------------------------------------------- #
class PlaybackCapture(orca.slicing.SlicingPipelineCapabilityBase):
    """Copies the finished G-code into this plugin's folder. Read-only on the G-code itself."""

    def get_name(self):
        return CAPTURE_NAME

    def execute(self, ctx):
        if ctx.step != orca.slicing.Step.psGCodePostProcess:
            return orca.ExecutionResult.success()
        try:
            src = ctx.gcode_path
            if not src or not os.path.isfile(src):
                return orca.ExecutionResult.success("no G-code to capture")
            os.makedirs(CAPTURE_DIR, exist_ok=True)
            part = CAPTURE_FILE + ".part"
            with open(src, "rb") as reader, open(part, "wb") as writer:
                while True:
                    block = reader.read(1024 * 1024)
                    if not block:
                        break
                    writer.write(block)
            os.replace(part, CAPTURE_FILE)
            name = ctx.output_name or os.path.basename(src)
            for suffix in (".gcode.3mf", ".3mf", ".gcode"):
                if name.lower().endswith(suffix):
                    name = name[: -len(suffix)]
                    break
            with open(CAPTURE_META + ".part", "w", encoding="utf-8") as handle:
                json.dump({"name": name, "host": ctx.host, "time": time.time()}, handle)
            os.replace(CAPTURE_META + ".part", CAPTURE_META)
            _CAPTURE_SEEN["t"] = time.time()
            page = _PAGE
            if page is not None:
                # post_message is thread-safe; never call orca.host.ui from this slicing thread
                payload = page.status("slice_ready")
                page.post(payload)
            return orca.ExecutionResult.success("captured for Playback")
        except Exception as exc:
            # never fail the slice because of playback
            return orca.ExecutionResult.success(f"Playback capture skipped: {str(exc)[:200]}")


@orca.plugin
class PlaybackPlugin(orca.base):
    def register_capabilities(self):
        orca.register_capability(PlaybackPage)
        orca.register_capability(PlaybackCapture)
