import {IEvokDevicesConfig} from "./evok-device-config";

/**
 * Configuration options for connecting to the Evok server.
 */
export interface IEvokConfig {
    /**
     * Unique identifier for this Evok instance, used to distinguish between multiple Evok servers if needed.
     */
    id: string;
    /**
     * The WebSocket URL of the Evok server.
     */
    websocketUrl?: string
    /**
     * Configuration for the Evok devices.
     */
    devices: IEvokDevicesConfig
    /**
     * Additional options for Evok behavior.
     */
    options: IEvokOptionsConfig
}

/**
 * Configuration options for Evok device behavior and persistence.
 */
export interface IEvokOptionsConfig {
    /**
     * The duration in milliseconds for which to pulse a pulse relay when triggered.
     */
    pulseDurationMs?: number
    /**
     * The max delay in milliseconds to consider between presses for multi-press detection (double, triple).
     */
    maxNextPressDelayMs?: number
    /**
     * The max delay in milliseconds between repeated button presses to consider them as a single,
     * vs double vs triple press.
     */
    maxRepeatedPressDelayMs?: number
    /**
     * The minimum duration in milliseconds to consider a button press as a long press.
     */
    minLongPressDelayMs?: number
    /**
     * If true, the states of pulse relays will be persisted to a file to allow state restoration on restart.
     */
    persistPulseRelayStates?: boolean
    /**
     * The minimum interval in milliseconds between persisting pulse relay states to avoid excessive file writes.
     */
    persistPulseRelayStatesMinIntervalMs?: number
    /**
     * The file path where pulse relay states will be persisted.
     */
    persistPulseRelayStatesTo?: string
    /**
     * The Evok major API version
     */
    version: string
}