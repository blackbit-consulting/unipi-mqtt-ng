import {ELogEvel, IConfig} from "./config/config";
import {parse as parseYaml} from "yaml";
import * as fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import ajvFormats from "ajv-formats";

import {
    addMQTTConnectedListener,
    addMQTTMessageListener,
    removeMQTTConnectedListener,
    removeMQTTMessageListener,
    sendMQTTMessage,
    startMQTT,
    stopMQTT
} from "./services/mqtt-service";
import {
    addEvokDeviceListener,
    IEvokDeviceEvent,
    listDevices,
    removeEvokDeviceListener,
    setEvokRelayState,
    startEvok,
    stopEvok
} from "./services/evok-service";
import {IEvokInputDeviceConfig, IEvokRelayDeviceConfig} from "./config/evok-device-config";
import {logIf} from "./config/log";

let config: IConfig | null;
let running = false;
let maintenanceMode = false;

/**
 * Exits the application with the provided error code, performing cleanup.
 * @param errorCode The error code to exit with.
 */
async function exitApplication(errorCode: number) {
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info(`Exiting the application with error code ${errorCode}`);
    });
    // Attempt to perform any necessary cleanup here before exiting
    await stopApplication();
    process.exit(errorCode);
}

/**
 * Handles uncaught promise rejections by logging and exiting.
 */
process.on("unhandledRejection", async (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    await exitApplication(2);
});

/**
 * Handles uncaught exceptions by logging and exiting.
 */
process.on("uncaughtException", async (error) => {
    console.error("Uncaught Exception:", error);
    await exitApplication(1);
});

/**
 * Handle SIGINT signal (e.g., Ctrl+C) to allow for graceful shutdown of the application.
 */
process.on("SIGINT", async () => {
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info(`Received SIGINT. Terminating the process...`);
    });
    await stopApplication();
    await exitApplication(0);
});

/**
 * Perform any necessary cleanup before exiting the application.
 */
async function stopApplication() {
    if (!running) {
        // No need to stop at all!
        return;
    }
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info("Stopping application...");
    });
    await announceMQTTAvailability(false);
    // Remove listeners
    removeMQTTMessageListener(onMQTTMessage);
    removeEvokDeviceListener("button", onButtonUpdate);
    removeEvokDeviceListener("input", onInputUpdate);
    removeEvokDeviceListener("relay", onRelayUpdate);
    // Stop MQTT
    await stopMQTT();
    // Stop Evok
    await stopEvok(config!.evok);
    removeMQTTConnectedListener(onMQTTConnected);
}

/**
 * The main function to start the application, loading configuration,
 * starting services, and registering event listeners.
 */
async function startApplication() {
    config = await loadConfig();
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info("Starting application...");
    });
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

/**
 * Resolves the configuration file location from command line arguments or defaults.
 * @returns The resolved configuration file path.
 */
function resolveConfigFileLocation(): string {
    const params = process.argv.slice(2);
    // The first parameter that does not start with a '-' is considered the config file location
    const filePath = params.find(param => !param.startsWith("-"));
    if (!filePath) {
        throw new Error("Configuration file path should be provided as a parameter without any leading dashes.");
    }
    if (filePath) {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        return path.join(process.cwd(), filePath);
    }
    return path.join(process.cwd(), "config/config.yaml");
}

/**
 * Loads and validates the configuration from the configuration file.
 * @returns The loaded configuration object.
 * @throws Error if the configuration is invalid.
 */
async function loadConfig(): Promise<IConfig> {
    const configFile = await fs.promises.readFile(resolveConfigFileLocation(), "utf-8");
    const parsedConfig = parseYaml(configFile) as IConfig;
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info("Configuration loaded:", parsedConfig);
    });

    // Load the schema for validation
    const schemaFile = await fs.promises.readFile(path.join(__dirname, "..", "config", "config-schema-v1.yaml"), "utf-8");
    const schema = parseYaml(schemaFile);
    // Create new ajv instance
    const ajv = new Ajv();

    // Add formats
    ajvFormats(ajv);
    const validator = ajv.compile(schema);
    const valid = validator(parsedConfig);
    if (!valid) {
        console.error("Configuration validation errors:", validator.errors);
        throw new Error("Configuration is invalid");
    }
    // Validate the configuration against the schema using ajv:

    return parsedConfig;
}

/**
 * Handles updates to relay devices, logging the update and publishing the new state to MQTT.
 * @param relayUpdate The relay update event data.
 */
function onRelayUpdate(relayUpdate: IEvokDeviceEvent) {
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info(`Relay update received: Id: ${relayUpdate.id}, State=${relayUpdate.state}`);
    });
    const topicName = `evok/${config!.evok.id}/relay/${relayUpdate.id}/state`;
    sendMQTTMessage(topicName, relayUpdate.state, true)
        .then(() => {
            logIf(config?.loglevel, ELogEvel.INFO, () => {
                console.info(`Relay state published to MQTT: Topic=${topicName}, State=${relayUpdate.state}`);
            });
        })
        .catch((err: Error) => {
            console.error(`Unable to publish relay state to MQTT: Topic=${topicName}`, err, err.stack);
        });
}

/**
 * Handles updates to input devices, logging the update.
 * @param inputUpdate The input update event data.
 */
function onInputUpdate(inputUpdate: IEvokDeviceEvent) {
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info(`Input update received: Id=${inputUpdate.id}, State=${inputUpdate.state}`);
    });
    // TODO: Regular input events (up and down)
}

/**
 * Handles updates to button devices, logging the update and publishing the event to MQTT.
 * @param buttonUpdate The button update event data.
 */
function onButtonUpdate(buttonUpdate: IEvokDeviceEvent) {
    logIf(config?.loglevel, ELogEvel.INFO, () => {
        console.info(`Button update received: Id=${buttonUpdate.id}, State=${buttonUpdate.state}, Press: ${buttonUpdate.press}`);
    });
    // We need to broadcast the button event as a separate MQTT message,
    // as Home Assistant expects button events to be sent as state changes with an "event" type.
    const topicName = `evok/${config!.evok.id}/input/${buttonUpdate.id}/event`;
    const eventType = buttonUpdate.press ? buttonUpdate.press as string: (buttonUpdate.state === 1 ? "down" : "up");
    // Note that these messages MUST NOT be retained!
    const eventTypes = ["single_press", "double_press", "triple_press", "long_press", "repeat","down", "up"];
    // Ensure that the event type we send is one of the supported event types for Home Assistant,
    // otherwise Home Assistant will ignore the message.
    const eventTypeToSend = eventTypes.find((type:string) => type.startsWith(eventType));
    // For button events, we should not retain the message, as they represent a momentary event rather than a state.
    // However for "up" and "down" events, we should retain the message, as they represent the current state of the button (pressed or not pressed).
    sendMQTTMessage(topicName, {event_type: eventTypeToSend}, !eventTypeToSend?.endsWith("_press"))
        .then(() => {
            logIf(config?.loglevel, ELogEvel.INFO, () => {
                console.info(`Button event published to MQTT: Topic=${topicName}, Event=${eventType}`);
            });
        })
        .catch((err: Error) => {
            console.error(`Unable to publish button event to MQTT: Topic=${topicName}`, err, err.stack);
        });
}

/**
 * Handles the MQTT connection event, triggering device discovery announcement.
 */
function onMQTTConnected() {
    // Broadcast configured devices to MQTT for discovery by Home Assistant
    // Ensure we send the messages as 'retained'.
    logIf(config?.loglevel, ELogEvel.DEBUG, () => {
        console.debug(`MQTT Connected`);
    });
    announceMQTTDeviceDiscovery();
}

const AVAILABILITY_ONLINE = "online";

const AVAILABILITY_OFFLINE = "offline";

/**
 * Announces the device discovery information to MQTT for Home Assistant integration.
 */
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
                        event_types: inputConfig.button ? ["single_press", "double_press", "triple_press", "long_press", "repeat","down", "up"] : ["high", "low"],
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
        }, {
            "switchMaintenanceMode": {
                p: "switch",
                name: `Evok maintenance mode`,
                unique_id: `evok_${config!.evok.id}_switch_maintenance_mode`,
                cmd_t: `evok/${config!.evok.id}/switch/switchMaintenanceMode/set`,
                stat_t: `evok/${config!.evok.id}/switch/switchMaintenanceMode/state`,
                avty_t: `evok/${config!.evok.id}/availability`,
                pl_on: "1",
                pl_off: "0",
            }
        })
    }

    sendMQTTMessage(topicName, messagePayload, true)
        .then((msg) => {
            if (!msg) {
                logIf(config?.loglevel, ELogEvel.WARN, () => {
                    console.warn("Failed to send device configuration sent to MQTT for Home Assistant discovery");
                });
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

    // Send the current maintenance mode state as well
    const maintenanceModeState = maintenanceMode ? "1" : "0";
    sendMQTTMessage(`evok/${config!.evok.id}/switch/switchMaintenanceMode/state`, maintenanceModeState, true)
        .then(() => {
            logIf(config?.loglevel, ELogEvel.INFO, () => {
                console.info(`Maintenance mode state published to MQTT: State=${maintenanceModeState}`);
            });
        })
        .catch((err: Error) => {
            console.error(`Unable to publish maintenance mode state to MQTT`, err, err.stack);
        });
}

/**
 * Handles incoming MQTT messages, routing them to the appropriate handler
 * based on the topic and message content.
 * @param param0 The object containing topic and message.
 */
function onMQTTMessage({topic, message}: { topic: string, message: string }) {
    logIf(config?.loglevel, ELogEvel.DEBUG, () => {
        console.debug(`MQTT message received: Topic=${topic}, Message=${message}`);
    });
    // Determine if the message is for a relay command
    const topicParts = topic.split("/");
    const evokId = topicParts[1];
    if (evokId !== config!.evok.id) {
        logIf(config?.loglevel, ELogEvel.WARN, () => {
            console.warn(`Received MQTT message for unknown Evok ID: ${evokId}`);
        });
        return;
    }
    // Check if this is the maintenance mode switch
    if (topic === `evok/${config!.evok.id}/switch/switchMaintenanceMode/set`) {
        let newState: 0 | 1;
        if (message === "1" || message.toLowerCase() === "on" || message.toLowerCase() === "true") {
            newState = 1;
        } else if (message === "0" || message.toLowerCase() === "off" || message.toLowerCase() === "false") {
            newState = 0;
        } else {
            logIf(config?.loglevel, ELogEvel.WARN, () => {
                console.warn(`Invalid maintenance mode command message: ${message}`);
            });
            return;
        }
        if (newState === 1) {
            logIf(config?.loglevel, ELogEvel.INFO, () => {
                console.info("Enabling maintenance mode...");
            });
            maintenanceMode = true;
            // Send maintenance mode state to MQTT
            sendMQTTMessage(`evok/${config!.evok.id}/switch/switchMaintenanceMode/state`, "1", true)
                .catch((err: Error) => {
                    console.error("Unable to publish maintenance mode state to MQTT", err, err.stack);
                });
        } else {
            logIf(config?.loglevel, ELogEvel.INFO, () => {
                console.info("Disabling maintenance mode...");
            });
            maintenanceMode = false;
            // Send maintenance mode state to MQTT
            sendMQTTMessage(`evok/${config!.evok.id}/switch/switchMaintenanceMode/state`, "0", true)
                .catch((err: Error) => {
                    console.error("Unable to publish maintenance mode state to MQTT", err, err.stack);
                });
        }
    }
    // Use a regexp to determine if the topic matches the pattern for relay commands: evok/{evokId}/relay/{relayId}/set
    if (/^evok\/([^/]+)\/relay\/([^/]+)\/set$/.test(topic)) {
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
        setEvokRelayState(relayId, newState, maintenanceMode)
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
        logIf(config?.loglevel, ELogEvel.DEBUG, () => {
            console.debug(`Announcing MQTT unavailability for Evok ${config!.evok.id}`);
        });
        await sendMQTTMessage(`evok/${config!.evok.id}/availability`, AVAILABILITY_OFFLINE, true);
    } else {
        logIf(config?.loglevel, ELogEvel.DEBUG, () => {
            console.debug(`Announcing MQTT availability for Evok ${config!.evok.id}`);
        });
        await sendMQTTMessage(`evok/${config!.evok.id}/availability`, AVAILABILITY_ONLINE, true);
    }
}

if (process.argv.includes("--validate")) {
    loadConfig()
        .then(config => {
            logIf(config?.loglevel, ELogEvel.INFO, () => {
                console.info("Configuration is valid:", config);
            })
        })
        .catch((err: Error) => {
            console.error("Configuration is invalid:", err, err.stack);
            process.exit(1);
        });
} else {
    startApplication()
        .then(() => {
            running = true;
            logIf(config?.loglevel, ELogEvel.INFO, () => {
                console.info("Application started successfully");
            });
        })
        .catch((err: Error) => {
            console.error("Unable to start the application", err, err.stack);
            return exitApplication(3);
        });
}
