# Unipi Evok to MQTT bridge for Home Assistant

This application bridges a Unipi device running Evok to an MQTT broker,
enabling smart home automation and monitoring via Home Assistant.
It is written in TypeScript and uses a YAML configuration file for setup.

It needs to connect to the Unipi Evok WebSocket API to receive
real-time updates on device states and events.
It will then publish this information to specified MQTT topics.
The application also allows for controlling relays
and monitoring inputs based on the configuration.

## Features

- Connects to Unipi Evok via WebSocket
- Publishes device states and events to MQTT topics
- Allows direct discovery by Home Assistant via MQTT
- Supports relays and inputs configuration
- Easy YAML-based configuration
- Optional persistence of Pulse relay states across restarts or upon power loss
    - Optimized to minimize write operations to the Unipi device, ensuring longevity of the hardware
- Maintenance mode switch for correcting pulse relay states without affecting the actual relay.

## Requirements

1. Node.JS 20 or higher installed

## Installation

### Prepare Home Assistant

Install the MQTT integration in Home Assistant.
Doing this should create a new MQTT broker, running as an app (add-on).

### Install the Unipi Evok MQTT Bridge

Install the package on your Unipi Device (preferred) or on a separate machine that can access the Unipi device and the
MQTT broker.

> Note: Installing on Unipi will allow you to use the localhost interface for communication with Evok.
> This is both more efficient and more secure.

```bash
npm install -g @blackbit.be/unipi-evok-mqtt
```

Upon installation, a shell script link (`unipi-evok-mqtt`) is created.
You can directly invoke this script to run the application:

```bash
unipi-evok-mqtt [/some/dir/config.yaml]
```

The application can be stopped with a simple `CTRL+C` in the terminal.
If you want to run it as a background service, you can use tools like `pm2` or `systemd` to manage the process.

> Note: Systemd is recommended!

### Sample systemd Service File

```
[Unit]
Description=Unipi Evok MQTT Bridge
After=network.target
[Service]
ExecStart=/usr/bin/unipi-evok-mqtt /path/to/config.yaml
KillSignal=SIGINT
Restart=always
# User/group must have access to config file and optional persistence file
User=your_non_root_user
Group=your_non_root_group

[Install]
WantedBy=multi-user.target
```

### Enabling (for boot time)

```bash
sudo systemctl enable unipi-evok-mqtt.service
```

### Starting

```bash
sudo systemctl start unipi-evok-mqtt.service
```

### Stopping

```bash
sudo systemctl stop unipi-evok-mqtt.service
```

### Logs

```bash
sudo journalctl -u unipi-evok-mqtt.service -f
```

### Restarting

```bash
sudo systemctl restart unipi-evok-mqtt.service
```

## Configuration

All settings are managed via the `config/config.yaml` file. This file defines MQTT connection details, Evok device
options, and the list of relays and inputs to manage.

### Example `config.yaml`

See `config/config.yaml` for a full example. Key sections:

- `mqtt`: MQTT broker connection details (URL, credentials, topic names)
- `evok`: Evok device ID, WebSocket URL, device options, and device lists (relays, inputs)

### Schema Validation

The configuration file is validated against a JSON schema (see `$schema` field in the YAML). Ensure your config matches
the schema for correct operation.

You can test the configuration file like this:

```bash
unipi-evok-mqtt /path/to/config.yaml --validate
```

## License

MIT

