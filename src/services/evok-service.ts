import {WebSocket} from "ws";
import {IEvokConfig} from "../config/evok-config";
import {EventEmitter} from "node:events"
import {EEvokDeviceType, IEvokDeviceConfig} from "../config/evok-device-config";

export type TRelayState = 0 | 1;
export type TInputState = 0 | 1;

interface IEvokCommand extends Record<string, string | number | boolean | undefined> {
    cmd: "all" | "set"
    dev?: EEvokDeviceType,
    circuit?: string,
    value?: TRelayState | TInputState
}

export interface IEvokDeviceEvent extends Record<string, string | number | boolean | undefined> {
    id: string;
    state: TRelayState | TInputState;
    lastChanged: number;
}

export interface IRelayState {
    isPulse: boolean;
    state: TRelayState;
    pulseState: TRelayState;
    lastPulsed: number;
    lastChanged: number;
}

export interface IDigitalInputState {
    state: 0 | 1;
    lastChanged: number;
    buttonEventTimer: NodeJS.Timeout | null;
    buttonEventCount: number;
}

// This promise represents the running MQTT service
let evok: WebSocket | null = null;
let connected = false;
let stopping = true;
const eventEmitter = new EventEmitter();
let evokConfig: IEvokConfig | null = null;
const relayStates: Map<string, IRelayState> = new Map();
const digitalInputStates: Map<string, IDigitalInputState> = new Map();
let initialized = false;

/**
 * Starts the Evok connection
 */
export async function startEvok(config: IEvokConfig) {
    evokConfig = config;
    console.info("Starting Evok service...");
    if (!evok) {
        stopping = false;
        evok = new WebSocket(config.websocketUrl || "ws://localhost:8080/ws");
        if (evok) {
            evok.on("open", () => {
                connected = true;
                console.info("Evok connected");
                // Request all device states on connect
                sendEvokMessage({cmd: "all"});
                // Notify connection
                eventEmitter.emit("device", {dev: "neuron", circuit: "1", value: 1});
            });
            evok.on("close", () => {
                // Notify disconnection
                eventEmitter.emit("device", {dev: "neuron", circuit: "1", value: 0});
                connected = false;
                initialized = false;
                evok = null;
                console.info("Evok disconnected");
                // Attempt to reconnect after a delay, unless we are stopping the service!
                if (!stopping) {
                    setTimeout(() => {
                        startEvok(config);
                    }, 5000);
                }
            });
            evok.on("message", onEvokMessage);
            evok.on("error", (error) => {
                console.error("Evok error:", error);
            });
        }
    }
}

/**
 * Stops the MQTT connection
 */
export async function stopEvok() {
    console.info("Stopping Evok service...");
    if (evok) {
        stopping = true;
        const oldEvok = evok;
        evok = null;
        oldEvok.close();
    }
}

/**
 * Function that will handle incoming messages.
 * The messages will be broadcast to listeners interested in the topic.
 * @param message The message payload
 */
async function onEvokMessage(message: Buffer) {
    const updates = JSON.parse(message.toString("utf-8"));
    // console.debug(`Received Evok message ${JSON.stringify(updates)}`);
    // Process each update
    if (!Array.isArray(updates)) {
        console.warn("Received non-array Evok message", updates);
        return;
    }
    const isNeuronUpdate = updates.find((update => update.dev === "neuron"));

    for (const update of updates) {
        eventEmitter.emit("device", update);
        // If the device is a relay, call the handle relay update function
        switch (update.dev) {
            case "relay":
                await handleRelayUpdate(update as IEvokRelayUpdate);
                break;
            case "input":
                await handleDigitalInputUpdate(update as IEvokDigitalInputUpdate);
                break;
        }
    }

    if (isNeuronUpdate && !initialized) {
        // On first neuron update, request all device states
        initialized = true;
        console.info(`Evok ${evokConfig!.id} initialized`);
    }
}

/**
 * Function used to send messages to MQTT broker
 * @param message The message to send
 * @returns True if the message was sent, false otherwise
 */
export async function sendEvokMessage(message: IEvokCommand): Promise<boolean> {
    if (evok && connected) {
        evok.send(Buffer.from(JSON.stringify(message), "utf-8"));
        console.debug(`Sent Evok command: ${JSON.stringify(message)}`);
        return true;
    } else {
        console.warn("Evok is not connected. Cannot send message.");
        return false;
    }
}

interface IEvokUpdate {
    dev: string;
    circuit: string;
    value: string | number | boolean;
}

interface IEvokRelayUpdate extends IEvokUpdate {
    dev: "relay";
    value: TRelayState;
}

interface IEvokDigitalInputUpdate {
    dev: "input";
    circuit: string;
    value: TInputState;
}

async function handleRelayUpdate(update: IEvokRelayUpdate) {
    if (!evokConfig) {
        return console.warn("No evok configured. Ignoring message.");
    }
    // Lookup the device in the config
    const configuredDevice = evokConfig
        .devices
        .relays.find((device => {
            // Match by dev and circuit
            return device.dev === update.dev && device.circuit === update.circuit;
        }));
    if (!configuredDevice) {
        // console.debug(`Received update for unconfigured relay device: ${update.circuit}`);
        return;
    }
    let relayState = relayStates.get(configuredDevice.id);
    if (!relayState) {
        relayState = {
            isPulse: configuredDevice.pulse || false,
            state: 0,
            pulseState: 0,
            lastPulsed: -1,
            lastChanged: -1
        }
        relayStates.set(configuredDevice.id, relayState);
    }

    if (configuredDevice.pulse) {
        // If the relay is configured as a pulse relay, every "on" command should be followed by an "off" command after the pulse duration
        // It is the "off" after an "on" that will trigger the state. The on and off will trigger pulseState.
        if (update.value === 1) { // State "on" received
            if (relayState.pulseState === 0) { // If current pulse state is "off", toggle the pulse state
                relayState.pulseState = 1; // Set pulse state to "on"
                relayState.lastPulsed = Date.now(); // Record pule timestamp
            }
        } else { // State "off" received
            if (relayState.pulseState === 1) { // If current pulse state is "on", toggle the pulse state
                relayState.state = relayState.state === 0 ? 1 : 0; // Toggle device state
                relayState.lastChanged = relayState.lastPulsed = Date.now(); // Record pulse timestamp
                if (initialized) {
                    eventEmitter.emit("relay", {
                        id: configuredDevice.id,
                        state: relayState.state,
                        lastChanged: relayState.lastChanged
                    });
                }
            }
        }
    } else {
        // For non-pulse relays, just update the state
        relayState.state = update.value
        relayState.lastChanged = relayState.lastPulsed = Date.now();
    }
}

async function handleDigitalInputUpdate(update: IEvokDigitalInputUpdate) {
    console.debug(`Received digital input update: ${JSON.stringify(update)}`);
    if (!evokConfig) {
        return console.warn("No evok configured. Ignoring message.");
    }
    // Lookup the device in the config
    const configuredDevice = evokConfig
        .devices
        .inputs.find((device => {
            // Match by dev and circuit
            return device.circuit === update.circuit;
        }));
    if (!configuredDevice) {
        console.debug(`Received update for unconfigured input device: ${update.circuit}`);
        return;
    }
    const now = Date.now();
    let inputState = digitalInputStates.get(configuredDevice.id);
    if (!inputState) {
        inputState = {
            state: 0,
            lastChanged: -1,
            buttonEventCount: 0,
            buttonEventTimer: null
        }
        digitalInputStates.set(configuredDevice.id, inputState);
    }

    if (update.value !== inputState?.state) {
        if (configuredDevice.button && inputState.buttonEventTimer) {
            // Immediately clear any pending button event timer
            if (inputState.buttonEventTimer) {
                clearTimeout(inputState.buttonEventTimer);
                inputState.buttonEventTimer = null;
            }
        }
        const previousStateChange = inputState.lastChanged;
        const previousState = inputState.state;
        inputState.state = update.value;
        inputState.lastChanged = now;
        if (initialized) {
            eventEmitter.emit("input", {
                id: configuredDevice.id,
                state: inputState.state,
                lastChanged: inputState.lastChanged
            });
            // If the input is configured as a button, also emit button press
            if (configuredDevice.button) { // If configured as a button
                if (inputState.state === 0 && previousState === 1) { // And after release
                    // Emit button press with the duration of the press
                    if (now - previousStateChange > 500 && !configuredDevice.disableLongPress) { // Long press
                        eventEmitter.emit("button", {
                            id: configuredDevice.id,
                            state: inputState.state,
                            press: "long"
                        });
                    } else { // Single press
                        inputState.buttonEventCount += 1; // Increase the event count
                        // Start a timer to wait for further presses
                        inputState.buttonEventTimer = setTimeout(() => {
                            // Clear the timer
                            inputState.buttonEventTimer = null;
                            const count = inputState!.buttonEventCount;
                            inputState.buttonEventCount = 0;
                            // Timer expired, emit the button event based on the count
                            eventEmitter.emit("button", {
                                id: configuredDevice.id,
                                state: inputState.state,
                                press: ["single", "double", "triple"][Math.min(3, count) - 1]
                            });
                        }, evokConfig?.options?.maxNextPressDelayMs || 200);

                    }
                }
            }
        }
    }
}

const DEFAULT_PULSE_DELAY_MS = 200;

/**
 * Sets the state of a relay. This means either switching it to the desired state, or pulsing it.
 * @param configuredDeviceId The configured device ID
 * @param value The value to set (0 or 1)
 */
export async function setEvokRelayState(configuredDeviceId: string, value: TRelayState) {
    const configuredDevice = evokConfig?.devices.relays.find((device) => {
        return device.id === configuredDeviceId;
    });

    if (!configuredDevice) {
        throw Object.assign(new Error("No such relay device configured"), {
            deviceId: configuredDeviceId
        });
    }

    if (configuredDevice.pulse) {
        // Pulse on, regardless of the current state
        await sendEvokMessage({cmd: "set", dev: EEvokDeviceType.relay, circuit: configuredDevice.circuit, value: 1});
        // Schedule the off command after the pulse duration
        setTimeout(async () => {
            // After the pulse duration, send the off command
            await sendEvokMessage({
                cmd: "set",
                dev: EEvokDeviceType.relay,
                circuit: configuredDevice.circuit,
                value: 0
            });
        }, evokConfig?.options?.pulseDurationMs || DEFAULT_PULSE_DELAY_MS);
    } else {
        // Only send the value, the relay will handle the rest and evok will report the new state back
        await sendEvokMessage({cmd: "set", dev: EEvokDeviceType.relay, circuit: configuredDevice.circuit, value});
    }
}

/**
 * Adds an Evok device listener
 * @param event
 * @param listener
 */
export function addEvokDeviceListener(event: "device" | "relay" | "input" | "button", listener: (data: IEvokDeviceEvent) => void) {
    eventEmitter.on(event, listener);
}

/**
 * Removes an Evok device listener
 * @param event
 * @param listener
 */
export function removeEvokDeviceListener(event: "device" | "relay" | "input" | "button", listener: (data: IEvokDeviceEvent) => void) {
    eventEmitter.off(event, listener);
}

export function listDevices() {
    // We return an array of all configured devices,
    // with their current state if available
    const devices: Array<{
        id: string,
        device: IEvokDeviceConfig,
        state: TRelayState | TInputState
        lastChanged: number
    }> = [];
    for (const device of evokConfig?.devices.relays || []) {
        devices.push({
            id: device.id,
            device: device,
            state: relayStates.get(device.id)?.state || 0,
            lastChanged: relayStates.get(device.id)?.lastChanged || -1
        });
    }
    for (const device of evokConfig?.devices.inputs || []) {
        devices.push({
            id: device.id,
            device: device,
            state: digitalInputStates.get(device.id)?.state || 0,
            lastChanged: digitalInputStates.get(device.id)?.lastChanged || -1
        });
    }
    return devices;
}