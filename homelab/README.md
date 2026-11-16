# Homelab telemetry

This directory contains the two agents used by the private Homelab dashboard in `public/homelab`.

## Architecture

- Server 2 runs `agents/pc_agent.py` and reports laptop telemetry over the PiAsA USB CDC-ACM serial function.
- Server 1 runs `agents/pi_agent.py`. It reads the PC serial messages from `/dev/ttyGS0`, collects Raspberry Pi health, then sends both devices' telemetry to the website over an authenticated WebSocket.
- The website exposes `/ws/homelab` for the Pi agent and a password-protected dashboard at `/homelab`.

The serial link is separate from the HID interface in the PiAsA composite gadget. The Pi agent opens the CDC-ACM serial TTY only; it does not reconfigure configfs or take over the HID keyboard function. Keep the PiAsA gadget active and ensure the composite configuration contains both your HID function(s) and one serial function.

## Website environment variables

Set these in the hosting provider's environment settings:

- `HOMELAB_ACCESS_PASSWORD`: password required to unlock the dashboard.
- `HOMELAB_AGENT_TOKEN`: long random secret shared only with the Raspberry Pi agent.

The website must be deployed with both variables. Do not put either secret in frontend JavaScript or commit them to this repository.

## Raspberry Pi setup

Install dependencies:

```sh
python3 -m pip install -r homelab/requirements.txt
```

Configure the agent:

```sh
export HOMELAB_WS_URL="wss://YOUR-WEBSITE-DOMAIN/ws/homelab"
export HOMELAB_AGENT_TOKEN="same-secret-as-HOMELAB_AGENT_TOKEN"
export PIASA_SERIAL_PORT="/dev/ttyGS0"
export PIASA_BAUD="9600"
export SERVER2_IP="192.168.1.60"
```

Optional state indicators:

- `PI_KVM_STATE_FILE` defaults to `/run/piasa/pi_kvm`.
- `PI_WOUSB_STATE_FILE` defaults to `/run/piasa/pi_wousb`.

Write `true` or `false` to those files when your existing KVM/WoUSB control scripts change state. The agent does not guess these states from the presence of the USB gadget.

Run:

```sh
python3 homelab/agents/pi_agent.py
```

The Pi user needs read access to the serial gadget TTY and permission to run the SSH, ping and configfs status checks. If required, grant access to the relevant device/group rather than running the entire agent as root.

### PiAsA serial function

If your current PiAsA composite does not already include a serial function, add one to the existing composite configuration (do not remove your HID devices):

```sh
piasa composite add device homelab_serial --type serial
piasa composite homelab_serial template=serial
piasa composite homelab_serial bandwidth=9600
```

Then apply the updated composite using your normal PiAsA procedure. The first CDC-ACM serial function is normally exposed on the Pi as `/dev/ttyGS0`. On the connected PC it commonly appears as `/dev/ttyACM0` on Linux or a COM port on Windows.

The homelab agent reserves this serial channel for telemetry. Avoid running another process that reads from the same serial TTY at the same time.

## Server 2 setup

Install dependencies:

```sh
python -m pip install -r homelab/requirements.txt
```

Set the serial port to the port created by the PiAsA CDC-ACM function:

Linux:

```sh
export PIASA_SERIAL_PORT="/dev/ttyACM0"
```

Windows PowerShell:

```powershell
$env:PIASA_SERIAL_PORT = "COM3"
```

Run:

```sh
python homelab/agents/pc_agent.py
```

The PC agent sends online state, AnyDesk client online state, Wi-Fi connectivity and battery percentage every five seconds. Battery percentage is `null` on devices without a battery sensor.

AnyDesk status is determined from the AnyDesk process and its `--get-status` CLI response. It represents client online availability, not proof that a remote-control session is actively in progress.

## Startup

Run the Pi agent as a systemd service after the PiAsA composite gadget has been applied. Run the PC agent at user login (Windows Task Scheduler or the Linux desktop's autostart). The scripts reconnect to serial/WebSocket after transient failures.

## Dashboard status semantics

- Raspberry Pi online: the authenticated Pi WebSocket agent is reporting.
- Server 2 online: fresh PC telemetry has arrived over the serial link.
- SSH access: the `ssh` or `sshd` systemd service is active.
- USB Gadget setup: the PiAsA configfs gadget has a bound UDC.
- Server 2 connection: the Pi can ping `192.168.1.60`.
- Pi KVM and Pi WoUSB: state files maintained by the existing control scripts.
- AnyDesk and Wi-Fi: reported by the PC agent.
- Battery: reported by psutil, or unavailable when no battery sensor exists.

The web server marks telemetry offline when it has not been refreshed for 20 seconds.
