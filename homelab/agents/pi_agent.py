#!/usr/bin/env python3
"""Raspberry Pi bridge: reads PC telemetry from PiAsA CDC serial and reports it to roshan-web."""

import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone

import serial
import websocket

WS_URL = os.environ["HOMELAB_WS_URL"]
AGENT_TOKEN = os.environ["HOMELAB_AGENT_TOKEN"]
SERIAL_PORT = os.getenv("PIASA_SERIAL_PORT", "/dev/ttyGS0")
BAUD_RATE = int(os.getenv("PIASA_BAUD", "9600"))
SERVER2_IP = os.getenv("SERVER2_IP", "192.168.1.60")
REPORT_INTERVAL = float(os.getenv("HOMELAB_REPORT_INTERVAL", "5"))
PC_STALE_SECONDS = float(os.getenv("HOMELAB_PC_STALE_SECONDS", "20"))
KVM_STATE_FILE = os.getenv("PI_KVM_STATE_FILE", "/run/piasa/pi_kvm")
WOUSB_STATE_FILE = os.getenv("PI_WOUSB_STATE_FILE", "/run/piasa/pi_wousb")

pc_state = {
    "online": False,
    "anydesk_connected": False,
    "wifi_access": False,
    "battery_percent": None,
    "last_seen_monotonic": 0.0,
}
pc_lock = threading.Lock()
auth_ready = threading.Event()
send_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def read_flag(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip().lower() in ("1", "true", "yes", "on")
    except OSError:
        return False


def command_ok(args):
    try:
        return subprocess.run(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=2, check=False,
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def ssh_available():
    if command_ok(["systemctl", "is-active", "--quiet", "ssh"]):
        return True
    return command_ok(["systemctl", "is-active", "--quiet", "sshd"])


def usb_gadget_active():
    udc = "/sys/kernel/config/usb_gadget/piasa/UDC"
    try:
        with open(udc, "r", encoding="utf-8") as handle:
            return bool(handle.read().strip())
    except OSError:
        return False


def server2_reachable():
    return command_ok(["ping", "-c", "1", "-W", "1", SERVER2_IP])


def collect_pi_status():
    return {
        "ssh_access": ssh_available(),
        "usb_gadget_setup": usb_gadget_active(),
        "server2_connection": server2_reachable(),
        "pi_kvm": read_flag(KVM_STATE_FILE),
        "pi_wousb": read_flag(WOUSB_STATE_FILE),
    }


def current_pc_status():
    with pc_lock:
        snapshot = dict(pc_state)
    fresh = snapshot["last_seen_monotonic"] > 0 and (
        time.monotonic() - snapshot["last_seen_monotonic"] <= PC_STALE_SECONDS
    )
    return {
        "online": bool(fresh and snapshot["online"]),
        "anydesk_connected": bool(snapshot["anydesk_connected"]) if fresh else False,
        "wifi_access": bool(snapshot["wifi_access"]) if fresh else False,
        "battery_percent": snapshot["battery_percent"] if fresh else None,
        "last_seen": now_iso() if fresh else None,
    }


def serial_reader():
    while True:
        try:
            with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1) as port:
                print(f"[serial] PC telemetry connected on {SERIAL_PORT}")
                while True:
                    raw = port.readline()
                    if not raw:
                        continue
                    try:
                        message = json.loads(raw.decode("utf-8").strip())
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if message.get("type") != "pc_status" or message.get("device") != "pc":
                        continue

                    battery = message.get("battery_percent")
                    if not isinstance(battery, (int, float)) or not 0 <= battery <= 100:
                        battery = None
                    with pc_lock:
                        pc_state.update({
                            "online": message.get("online") is True,
                            "anydesk_connected": message.get("anydesk_connected") is True,
                            "wifi_access": message.get("wifi_access") is True,
                            "battery_percent": battery,
                            "last_seen_monotonic": time.monotonic(),
                        })
        except (serial.SerialException, OSError) as error:
            print(f"[serial] {error}; retrying in 3 seconds")
            time.sleep(3)


def send_telemetry(ws):
    while ws.keep_running:
        if auth_ready.wait(timeout=1):
            payload = {
                "type": "telemetry",
                "device": "pi",
                "pi": collect_pi_status(),
                "pc": current_pc_status(),
                "timestamp": now_iso(),
            }
            try:
                with send_lock:
                    ws.send(json.dumps(payload, separators=(",", ":")))
            except websocket.WebSocketException:
                return
            time.sleep(REPORT_INTERVAL)


def on_open(ws):
    print("[websocket] connected; authenticating")
    ws.send(json.dumps({"type": "authenticate", "token": AGENT_TOKEN}))


def on_message(ws, raw):
    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        return
    if message.get("type") == "authenticated":
        print("[websocket] agent authenticated")
        auth_ready.set()
        threading.Thread(target=send_telemetry, args=(ws,), daemon=True).start()


def on_error(_ws, error):
    print(f"[websocket] {error}")


def on_close(_ws, code, reason):
    auth_ready.clear()
    print(f"[websocket] disconnected ({code}: {reason})")


def main():
    threading.Thread(target=serial_reader, daemon=True).start()
    while True:
        auth_ready.clear()
        app = websocket.WebSocketApp(
            WS_URL,
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        app.run_forever(ping_interval=25, ping_timeout=10)
        print("[websocket] reconnecting in 5 seconds")
        time.sleep(5)


if __name__ == "__main__":
    main()
