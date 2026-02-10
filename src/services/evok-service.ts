import {WebSocket} from "ws";
import {IEvokConfig} from "../config/evok-config";
import {EventEmitter} from "node:events"
import {EEvokDeviceType, IEvokDeviceConfig} from "../config/evok-device-config";
import {createHash} from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

export type TRelayState = 0 | 1;
export type TInputState = 0 | 1;

interface IEvokCommand extends Record<string, string | number | boolean | undefined> {
    cmd: "all" | "set"
    dev?: string,
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

export enum EEvokVersion {
    v2 = "v2",
    v3 = "v3",
}

const DEFAULT_EVOK_VERSION = EEvokVersion.v2;

type TEvokRequiredDeviceTypes = {
    [key in Exclude<keyof typeof EEvokDeviceType, "uart">]: string
} & {
    [EEvokDeviceType.uart]?: string
}
/**
 * Mapping of Evok device types for different Evok versions.
 *This allows us to support multiple versions of Evok with different device type naming conventions.
 */
const EVOK_DEVICE_TYPES: Record<EEvokVersion, TEvokRequiredDeviceTypes> = {
    [EEvokVersion.v2]: {
        relay: "relay",
        digitalInput: "input",
        digitalOutput: "output",
        modbusRegister: "unit_register",
        analogInput: "ai",
        analogOutput: "ao",
        neuron: "neuron",
        led: "led",
        owbus: "owbus",
        watchdog: "wd",
        uart: "uart"
    },
    [EEvokVersion.v3]: {
        relay: "ro",
        digitalInput: "di",
        digitalOutput: "do",
        modbusRegister: "data_point",
        analogInput: "ai",
        analogOutput: "ao",
        neuron: "board",
        led: "led",
        owbus: "owbus",
        watchdog: "wd",
    }
};

// This promise represents the running MQTT service
let evok: WebSocket | null = null;
let connected = false;
let stopping = true;
const eventEmitter = new EventEmitter();
let evokConfig: IEvokConfig | null = null;
const relayStates: Map<string, IRelayState> = new Map();
const digitalInputStates: Map<string, IDigitalInputState> = new Map();
let initialized = false;
let statePersistInterval: NodeJS.Timeout | null = null;
let lastPersistedStatesHash: string | null = null;
let devTypes: TEvokRequiredDeviceTypes | null = null;

/**
 * Starts the Evok connection and initializes device state persistence if configured.
 * @param config The Evok configuration object.
 */
export async function startEvok(config: IEvokConfig) {
    evokConfig = config;
    // Derived from validated configuration, so we are certain the value is valid.
    devTypes = EVOK_DEVICE_TYPES[evokConfig.options.version as EEvokVersion || DEFAULT_EVOK_VERSION];
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
            if (evokConfig.options.persistPulseRelayStates) {
                // On startup, load the persisted pulse relay states and apply them
                await loadPulseRelayStates(config);
                // If configured to persist pulse relay states, start an interval to save the states every 5 seconds
                statePersistInterval = setInterval(() => {
                    savePulseRelayStates(config).catch((error) => {
                        console.error("Error saving pulse relay states:", error);
                    });
                }, Math.max(1000, evokConfig.options.persistPulseRelayStatesMinIntervalMs || 5000));
            }
        }
    }
}

/**
 * Persists the states of pulse relays to disk if their state has changed.
 * @param config The Evok configuration object.
 */
async function savePulseRelayStates(config: IEvokConfig) {
    // We only persist the states of pulse relays, as non-pulse relays will report their state on startup
    const statesToPersist: Array<{ id: string, state: TRelayState, lastChanged: number }> = []
    for (const [deviceId, relayState] of relayStates.entries()) {
        if (relayState.isPulse) {
            statesToPersist.push({
                id: deviceId,
                state: relayState.state,
                lastChanged: relayState.lastChanged
            });
        }
    }
    // Sort the array with states to persist by device ID to ensure consistent order
    statesToPersist.sort((a, b) => a.id.localeCompare(b.id));
    // Calculate the sha256 hash of the states to persist, to avoid unnecessary writes if the states haven't changed
    const statesHash = createHash("sha256");
    for (const state of statesToPersist) {
        statesHash.update(state.id);
        statesHash.update(state.state.toString());
        statesHash.update(state.lastChanged.toString());
    }
    const statesHashValue = statesHash.digest("hex");
    // We save the states a JSON file in the given directory, only if the hash changed since the last save,
    if (statesHashValue !== lastPersistedStatesHash) {
        const filePath = config!.options.persistPulseRelayStatesTo || ".evok-pulse-relay-states.json";
        const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
        await fs.promises.writeFile(absoluteFilePath, JSON.stringify(statesToPersist), "utf-8");
        console.debug("Saved pulse relay states to disk");
        lastPersistedStatesHash = statesHashValue;
    }
}

/**
 * Loads persisted pulse relay states from disk and restores them.
 * @param config The Evok configuration object.
 */
async function loadPulseRelayStates(config: IEvokConfig) {
    const filePath = config.options.persistPulseRelayStatesTo || ".evok-pulse-relay-states.json";
    const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    try {
        const data = await fs.promises.readFile(absoluteFilePath, "utf-8");
        const states: Array<{ id: string, state: TRelayState, lastChanged: number }> = JSON.parse(data);
        for (const {id, state, lastChanged} of states) {
            // We set the state of the relay to the persisted state. This will cause evok to report the new state back, which will update our internal state and notify listeners.
            const relayState = relayStates.get(id);
            if (relayState) {
                // We'll update the relay state without raising events.
                // This is because we are restoring the last known state, not applying a new state.
                relayState.state = state;
                relayState.lastChanged = lastChanged;
            }
        }
        console.info("Loaded pulse relay states from disk");
        // Recalculate the hash of the loaded states to avoid unnecessary saves on startup
        const statesHash = createHash("sha256");
        for (const {id, state, lastChanged} of states) {
            statesHash.update(id);
            statesHash.update(state.toString());
            statesHash.update(lastChanged.toString());
        }
        lastPersistedStatesHash = statesHash.digest("hex");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            console.info("No persisted pulse relay states found, starting with empty states");
        } else {
            console.error("Error loading pulse relay states:", error);
        }
    }
}

/**
 * Stops the Evok connection and persists relay states if enabled.
 * @param config The Evok configuration object.
 */
export async function stopEvok(config: IEvokConfig) {
    console.info("Stopping Evok service...");
    if (evok) {
        stopping = true;
        if (statePersistInterval) { // Persistence enabled
            // Stop the state persist interval if it is running
            clearInterval(statePersistInterval);
            statePersistInterval = null;
            // Finally, save the pulse relay states one last time on shutdown
            await savePulseRelayStates(config);
        }
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
    const isNeuronUpdate = updates.find((update) => {
        return update.dev === devTypes!.neuron;
    }) !== undefined;

    for (const update of updates) {
        eventEmitter.emit("device", update);
        // If the device is a relay, call the handle relay update function
        switch (update.dev) {
            case devTypes!.relay:
                await handleRelayUpdate(update as IEvokRelayUpdate, isNeuronUpdate);
                break;
            case devTypes!.digitalInput:
                await handleDigitalInputUpdate(update as IEvokDigitalInputUpdate, isNeuronUpdate);
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

async function handleRelayUpdate(update: IEvokRelayUpdate, statusOnly: boolean) {
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

    if (configuredDevice.pulse && !statusOnly) {
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

async function handleDigitalInputUpdate(update: IEvokDigitalInputUpdate, statusOnly: boolean) {
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

    if (update.value !== inputState?.state && !statusOnly) {
        if (configuredDevice.button) {
            // Button input
            eventEmitter.emit("button", {
                id: configuredDevice.id,
                state: inputState.state,
                press: inputState.state === 1 ? "down" : "up"
            });
        } else {
            // Regular input
            eventEmitter.emit("input", {
                id: configuredDevice.id,
                state: inputState.state,
                press: inputState.state === 1 ? "high" : "low"
            });
        }
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
                // UPON DOWN
                if (inputState.state === 1 && previousState === 0) {
                    // Upon DOWN, we'll use the button timer to detect long and then repeated presses.
                    inputState.buttonEventTimer = setTimeout(() => {
                        inputState.buttonEventTimer = null;
                        // UPON interval expiry, if the button is still pressed, we consider it a long press
                        if (inputState?.state === 1) {
                            eventEmitter.emit("button", {
                                id: configuredDevice.id,
                                state: inputState.state,
                                press: "long"
                            });
                            // We reset the event count, as we consider a long press as a separate event from single/double/triple presses
                            inputState.buttonEventCount = 0;
                        }
                        // We now set the interval which is faster, for detecting repeated presses for dimming.
                        inputState.buttonEventTimer = setInterval(() => {
                            // When the interval expires, if the button is still pressed,
                            // we consider it a repeated press and emit the event.
                            // We keep doing this until the button is released, to allow for continuous dimming while holding the button.
                            if (inputState?.state === 1) {
                                eventEmitter.emit("button", {
                                    id: configuredDevice.id,
                                    state: inputState.state,
                                    press: "repeat"
                                });
                                eventEmitter.emit("button", {
                                    id: configuredDevice.id,
                                    state: inputState.state,
                                    press: "down"
                                });
                            }
                        }, evokConfig?.options?.maxRepeatedPressDelayMs || 500);

                    }, evokConfig?.options?.minLongPressDelayMs || 800);
                }
                // AFTER RELEASE
                if (inputState.state === 0 && previousState === 1) {
                    // Emit button press with the duration of the press
                    if (now - previousStateChange > 500 && !configuredDevice.disableLongPress) { // Long press
                        // Ignore, as the button press will already have been emitted upon expiry of the interval
                        // timer.
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
                            // Ensure the button returns
                            eventEmitter.emit("button", {
                                id: configuredDevice.id,
                                state: inputState.state,
                                press: inputState?.state === 1 ? "down" : "up"
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
 * @param maintenanceMode If true and the relay is a pulse relay, the state will change without pulsing. This is useful for switching the initial state on startup without triggering pulses. Default is false.
 */
export async function setEvokRelayState(configuredDeviceId: string, value: TRelayState, maintenanceMode = false) {
    const configuredDevice = evokConfig?.devices.relays.find((device) => {
        return device.id === configuredDeviceId;
    });

    if (!configuredDevice) {
        throw Object.assign(new Error("No such relay device configured"), {
            deviceId: configuredDeviceId
        });
    }

    let relayState = relayStates.get(configuredDevice.id);
    if (!relayState) {
        relayState = {
            isPulse: true,
            state: value,
            pulseState: 0,
            lastPulsed: -1,
            lastChanged: Date.now()
        }
        relayStates.set(configuredDevice.id, relayState);
    }

    if (relayState.state === value) {
        // No state change, do nothing
        console.warn("Ignoring request to set relay state to the same value", {deviceId: configuredDeviceId, value});
        return;
    }

    if (configuredDevice.pulse) {
        if (!maintenanceMode) {
            // Pulse on, regardless of the current state
            await sendEvokMessage({
                cmd: "set",
                dev: devTypes!.relay,
                circuit: configuredDevice.circuit,
                value: 1
            });
            // Schedule the off command after the pulse duration
            setTimeout(async () => {
                // After the pulse duration, send the off command
                await sendEvokMessage({
                    cmd: "set",
                    dev: devTypes!.relay,
                    circuit: configuredDevice.circuit,
                    value: 0
                });
            }, evokConfig?.options?.pulseDurationMs || DEFAULT_PULSE_DELAY_MS);
        } else {
            // Let's directly update the state
            relayState.state = value;
            relayState.lastChanged = Date.now();

            // Emit the state change event to update listeners and persist the new state if needed
            eventEmitter.emit("relay", {
                id: configuredDevice.id,
                state: relayState.state,
                lastChanged: relayState.lastChanged
            });
        }
    } else {
        // Only send the value, the relay will handle the rest and evok will report the new state back
        await sendEvokMessage({cmd: "set", dev: EEvokDeviceType.relay, circuit: configuredDevice.circuit, value});
    }
}

/**
 * Adds a listener for Evok device events.
 * @param event The event type ("device", "relay", "input", "button").
 * @param listener The listener callback function.
 */
export function addEvokDeviceListener(event: "device" | "relay" | "input" | "button", listener: (data: IEvokDeviceEvent) => void) {
    eventEmitter.on(event, listener);
}

/**
 * Removes a listener for Evok device events.
 * @param event The event type ("device", "relay", "input", "button").
 * @param listener The listener callback function.
 */
export function removeEvokDeviceListener(event: "device" | "relay" | "input" | "button", listener: (data: IEvokDeviceEvent) => void) {
    eventEmitter.off(event, listener);
}

/**
 * Lists all configured devices with their current state and last changed timestamp.
 * @returns Array of device state objects.
 */
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