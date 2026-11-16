#!/usr/bin/env python3
"""Server 2 telemetry agent. Sends newline-delimited JSON over the PiAsA CDC serial port."""

import json
import os
import platform
import subprocess
import time
from datetime import datetime, timezone

import psutil
import serial

SERIAL_PORT = os.getenv("PIASA_SERIAL_PORT", "COM3" if os.name == "nt" else "/dev/ttyACM0")
BAUD_RATE = int(os.getenv("PIASA_BAUD", "9600"))
REPORT_INTERVAL = float(os.getenv("HOMELAB_REPORT_INTERVAL", "5"))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def wifi_connected():
    system = platform.system()
    try:
        if system == "Windows":
            result = subprocess.run(
                ["netsh", "wlan", "show", "interfaces"],
                capture_output=True, text=True, timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            text = result.stdout.lower()
            return result.returncode == 0 and "state" in text and "connected" in text
        if system == "Linux":
            result = subprocess.run(
                ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device"],
                capture_output=True, text=True, timeout=3,
            )
            for line in result.stdout.splitlines():
                fields = line.split(":")
                if len(fields) >= 3 and fields[1] == "wifi" and fields[2] == "connected":
                    return True
            # Fallback for systems without NetworkManager.
            for name, stats in psutil.net_if_stats().items():
                if name.lower().startswith(("wlan", "wl")) and stats.isup:
                    return True
            return False
        # On macOS, an active Wi-Fi interface is usually en0/en1.
        for name, stats in psutil.net_if_stats().items():
            if name.lower() in ("en0", "en1") and stats.isup:
                return True
    except (OSError, subprocess.SubprocessError):
        pass
    return False


def anydesk_online():
    process_found = False
    try:
        for proc in psutil.process_iter(["name"]):
            name = (proc.info.get("name") or "").lower()
            if "anydesk" in name:
                process_found = True
                break
    except (psutil.Error, OSError):
        pass

    if not process_found:
        return False

    # AnyDesk's CLI reports whether its client is online. This does not claim
    # that a remote-control session is currently active.
    candidates = ["anydesk"]
    if os.name == "nt":
        candidates = [
            os.path.join(os.getenv("ProgramFiles", r"C:\Program Files"), "AnyDesk", "AnyDesk.exe"),
            "AnyDesk.exe",
        ]
    for executable in candidates:
        try:
            result = subprocess.run(
                [executable, "--get-status"],
                capture_output=True, text=True, timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            status = (result.stdout + " " + result.stderr).strip().lower()
            if "online" in status:
                return True
            if "offline" in status:
                return False
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def battery_percent():
    try:
        battery = psutil.sensors_battery()
        return round(float(battery.percent), 1) if battery is not None else None
    except (AttributeError, OSError, psutil.Error):
        return None


def collect_status():
    return {
        "type": "pc_status",
        "device": "pc",
        "server2_on": True,
        "online": True,
        "anydesk_connected": anydesk_online(),
        "wifi_access": wifi_connected(),
        "battery_percent": battery_percent(),
        "timestamp": now_iso(),
    }


def main():
    print(f"PIASA homelab PC agent starting on {SERIAL_PORT} at {BAUD_RATE} baud")
    connection = None

    while True:
        try:
            if connection is None or not connection.is_open:
                connection = serial.Serial(
                    SERIAL_PORT, BAUD_RATE, timeout=1, write_timeout=3
                )
                time.sleep(1)
                print(f"Serial connected: {SERIAL_PORT}")

            payload = json.dumps(collect_status(), separators=(",", ":")) + "\n"
            connection.write(payload.encode("utf-8"))
            connection.flush()
            time.sleep(REPORT_INTERVAL)

        except (serial.SerialException, OSError) as error:
            print(f"Serial unavailable ({error}); retrying in 3 seconds")
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
                connection = None
            time.sleep(3)


if __name__ == "__main__":
    main()
