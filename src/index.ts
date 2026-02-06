import {IConfig} from "./config/config";
import {parse as parseYaml} from "yaml";
import * as fs from "node:fs";
import path from "node:path";
import {
    addMQTTConnectedListener,
    addMQTTMessageListener, removeMQTTConnectedListener,
    removeMQTTMessageListener, sendMQTTMessage,
    startMQTT,
    stopMQTT
} from "./services/mqtt-service";
import {
    addEvokDeviceListener,
    IEvokDeviceEvent, listDevices,
    removeEvokDeviceListener, setEvokRelayState,
    startEvok,
    stopEvok
} from "./services/evok-service";
import {IEvokInputDeviceConfig, IEvokRelayDeviceConfig} from "./config/evok-device-config";

let config: IConfig | null;

/**
 * This function exits the application with the provided error code.
 * It is used to handle uncaught exceptions and ensure that the application exits gracefully.
 * @param errorCode The error code to exit the application with. A non-zero error code indicates an error occurred.
 */
async function exitApplication(errorCode: number) {
    console.info(`Exiting the application with error code ${errorCode}`);
    // Attempt to perform any necessary cleanup here before exiting
    await stopApplication();
    process.exit(errorCode);
}

/**
 * Handle uncaught exceptions by logging the error, and exiting the application with a non-zero error code.
 */
process.on("unhandledRejection", async (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    await exitApplication(2);
});

/**
 * Handle uncaught exceptions by logging the error, and exiting the application with a non-zero error code.
 */
process.on("uncaughtException", async (error) => {
    console.error("Uncaught Exception:", error);
    await exitApplication(1);
});

/**
 * Handle SIGINT signal (e.g., Ctrl+C) to allow for graceful shutdown of the application.
 */
process.on("SIGINT", async () => {
    console.info(`Received SIGINT. Terminating the process...`);
    await stopApplication();
    await exitApplication(0);
});

/**
 * Perform any necessary cleanup before exiting the application.
 */
async function stopApplication() {
    console.info("Stopping application...");
    await announceMQTTAvailability(false);
    // Remove listeners
    removeMQTTMessageListener(onMQTTMessage);
    removeEvokDeviceListener("button", onButtonUpdate);
    removeEvokDeviceListener("input", onInputUpdate);
    removeEvokDeviceListener("relay", onRelayUpdate);
    // Stop MQTT
    await stopMQTT();
    // Stop Evok
    await stopEvok();
    removeMQTTConnectedListener(onMQTTConnected);
}

async function startApplication() {
    config = await loadConfig();
    console.info("Starting application...");
    // Start MQTT
    await startEvok(config.evok);
    addMQTTConnectedListener(onMQTTConnected);
    await startMQTT(config.mqtt, config.evok.id);
    // Register listeners
    addEvokDeviceListener("relay", onRelayUpdate);
    addEvokDeviceListener("input", onInputUpdate);
    addEvokDeviceListener("button", onButtonUpdate);
    addMQTTMessageListener(onMQTTMessage);
    await announceMQTTAvailability(true);
}

function resolveConfigFileLocation(): string {
    if (process.argv.length === 3) {
        const filePath = process.argv[2];
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        return path.join(process.cwd(), filePath);
    }
    return path.join(process.cwd(), "config/config.yaml");
}

async function loadConfig(): Promise<IConfig> {
    const configFile = fs.promises.readFile(resolveConfigFileLocation(), "utf-8");
    const parsedConfig = parseYaml(await configFile) as IConfig;
    console.info("Configuration loaded:", parsedConfig);
    return parsedConfig;
}


startApplication()
    .catch((err: Error) => {
        console.error("Unable to start the application", err, err.stack);
        return exitApplication(3);
    });


function onRelayUpdate(relayUpdate: IEvokDeviceEvent) {
    console.info(`Relay update received: Id: ${relayUpdate.id}, State=${relayUpdate.state}`);
    const topicName = `evok/${config!.evok.id}/relay/${relayUpdate.id}/state`;
    sendMQTTMessage(topicName, relayUpdate.state, true)
        .then(() => {
            console.info(`Relay state published to MQTT: Topic=${topicName}, State=${relayUpdate.state}`);
        })
        .catch((err: Error) => {
            console.error(`Unable to publish relay state to MQTT: Topic=${topicName}`, err, err.stack);
        });
}

function onInputUpdate(inputUpdate: IEvokDeviceEvent) {
    console.info(`Input update received: Id=${inputUpdate.id}, State=${inputUpdate.state}`);
}

function onButtonUpdate(buttonUpdate: IEvokDeviceEvent) {
    console.info(`Button update received: Id=${buttonUpdate.id}, State=${buttonUpdate.state}, Press: ${buttonUpdate.press}`);
}

function onMQTTConnected() {
    // Broadcast configured devices to MQTT for discovery by Home Assistant
    // Ensure we send the messages as 'retained'.
    console.info(`ON MQTT Connected`);
    announceMQTTDeviceDiscovery();
}

const AVAILABILITY_ONLINE = "online";

const AVAILABILITY_OFFLINE = "offline";

function announceMQTTDeviceDiscovery() {
    // First, enumerate the configured devices from the evok service
    const devices = listDevices();
    const topicName = `homeassistant/device/${config!.evok.id}/config`;
    const messagePayload = {
        dev: {
            ids: [config!.evok.id],
            name: "Evok MQTT Bridge",
            mf: "Unipi",
            sn: "140",
            mdl: "Neuron 203",
            sw: "1.0"
        },
        o: {
            name: "unipi-mqtt-ng",
            sw: "1.0",
            url: "https://blackbit.be/unipi-mqtt-ng"
        },
        // Add components
        cmps: devices.reduce((map: Record<string, object>, next) => {
            if (next.device.dev == "relay") {
                const relayConfig = next.device as IEvokRelayDeviceConfig;
                map[next.device.id] = {
                    p: relayConfig.as || "switch",
                    name: next.device.name || `Evok ${relayConfig.pulse ? "pulse " : ""}Relay ${next.device.id}`,
                    unique_id: `evok_${config!.evok.id}_relay_${next.device.id}`,
                    cmd_t: `evok/${config!.evok.id}/relay/${next.device.id}/set`,
                    stat_t: `evok/${config!.evok.id}/relay/${next.device.id}/state`,
                    avty_t: `evok/${config!.evok.id}/availability`,
                    pl_on: "1",
                    pl_off: "0"
                };
            } else if (next.device.dev == "input") {
                const inputConfig = next.device as IEvokInputDeviceConfig;
                if (inputConfig.button) { // Buttons need a separate device message for now.
                    const eventTopicName = `homeassistant/event/${config!.evok.id}/${next.device.id}/config`;
                    // TODO: Change when supported as part of device discovery in HA
                    const eventPayload = {
                        device: {identifiers: [config?.evok.id]},
                        name: next.device.name || `Evok ${inputConfig.button ? "button" : "input"} ${next.device.id}`,
                        device_class: inputConfig.button ? "button" : "motion",
                        unique_id: `evok_${config!.evok.id}_input_${next.device.id}`,
                        state_topic: `evok/${config!.evok.id}/input/${next.device.id}/event`,
                        event_types: inputConfig.button ? ["short_press", "double_press", "long_press", "down", "up"] : ["high", "low"],
                        availability_topic: `evok/${config!.evok.id}/availability`,
                        payload_available: AVAILABILITY_ONLINE,
                        payload_not_available: AVAILABILITY_OFFLINE
                    };
                    sendMQTTMessage(eventTopicName, eventPayload, true)
                        .catch((err => {
                            console.error("Unable to publish event discovery", err, err.stack);
                        }))
                } else if (!inputConfig.button) {
                    map[next.device.id] = {
                        p: "event", // No matter if we are a button or input, we send events
                        name: next.device.name || `Evok ${inputConfig.button ? "button" : "input"} ${next.device.id}`,
                        dev_cla: "motion",
                        unique_id: `evok_${config!.evok.id}_input_${next.device.id}`,
                        stat_t: `evok/${config!.evok.id}/input/${next.device.id}/event`,
                        etp: ["high", "low"],
                        avty_t: `evok/${config!.evok.id}/availability`,
                        payload_available: AVAILABILITY_ONLINE,
                        payload_not_available: AVAILABILITY_OFFLINE
                    }
                }
            }
            return map;
        }, {})
    }
    sendMQTTMessage(topicName, messagePayload, true)
        .then((msg) => {
            if (!msg) {
                console.warn("Failed to send device configuration sent to MQTT for Home Assistant discovery");
            }
        })
        .catch((err: Error) => {
            console.error("Error while sending device configuration to MQTT", err, err.stack);
        });

    // FOr all devicess, send their current state
    devices.forEach((device) => {
        if (device.device.dev === "relay") {
            onRelayUpdate({id: device.device.id, state: device.state, lastChanged: device.lastChanged});
        }
    });
}

function onMQTTMessage({topic, message}: { topic: string, message: string }) {
    console.info(`MQTT message received: Topic=${topic}, Message=${message}`);
    // Determine if the message is for a relay command
    const topicParts = topic.split("/");
    if (topicParts.length === 5 &&
        topicParts[0] === "evok" &&
        topicParts[2] === "relay" &&
        topicParts[4] === "set") {
        const evokId = topicParts[1];
        if (evokId !== config!.evok.id) {
            console.warn(`Received MQTT message for unknown Evok ID: ${evokId}`);
            return;
        }
        const relayId = topicParts[3];
        let newState: 0 | 1;
        if (message === "1" || message.toLowerCase() === "on" || message.toLowerCase() === "true") {
            newState = 1;
        } else if (message === "0" || message.toLowerCase() === "off" || message.toLowerCase() === "false") {
            newState = 0;
        } else {
            console.warn(`Invalid relay command message: ${message}`);
            return;
        }
        setEvokRelayState(relayId, newState)
            .catch((err: Error) => {
                console.error(`Unable to set relay state for relay ${relayId}`, err, err.stack);
            });
    }
}

/**
 * We'll send unavailability messages for all devices on MQTT to allow Home Assistant to mark them as unavailable.
 * This is sent to the same topic as the LWT message.
 * As the broker supports LWT, the offline message will be sent automatically upon disconnection.
 */
async function announceMQTTAvailability(available: boolean) {
    if (!available) {
        console.debug(`Announcing MQTT unavailability for Evok ${config!.evok.id}`);
        await sendMQTTMessage(`evok/${config!.evok.id}/availability`, AVAILABILITY_OFFLINE, true);
    } else {
        console.debug(`Announcing MQTT availability for Evok ${config!.evok.id}`);
        await sendMQTTMessage(`evok/${config!.evok.id}/availability`, AVAILABILITY_ONLINE, true);
    }
}