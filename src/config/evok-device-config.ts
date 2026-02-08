/**
 * Enum representing the available device types for Evok.
 */
export enum EEvokDeviceType {
    relay = "relay", // Relay module
    input = "input", // Digital input
    led = "led", // LED module
    neuron = "neuron", // Neuron module
    ai = "ai", // Analog input
    ao = "ao", // Analog output
    owbus = "owbus", // 1-Wire bus
    uar = "uart", // UART
    wd = "wd", // WatchDog

}

/**
 * Enum representing relay types for Evok relays.
 */
export enum EEvokRelayType {
    physical = "physical",
    digital = "digital"
}

/**
 * Interface representing a generic Evok device configuration.
 */
export interface IEvokDeviceConfig {
    id: string
    name?: string
    dev: EEvokDeviceType
    circuit: string
}

/**
 * Interface representing a relay device configuration for Evok.
 */
export interface IEvokRelayDeviceConfig extends IEvokDeviceConfig {
    pulse?: boolean
    dev: EEvokDeviceType.relay
    relayType: EEvokRelayType
    name?: string // Optional name for the relay (for MQTT discovery)
    as?: "switch" | "light" | "fan" // Treat as (default: "switch")
}

/**
 * Interface representing a digital input device configuration for Evok.
 */
export interface IEvokInputDeviceConfig extends IEvokDeviceConfig {
    button?: boolean // Treat as a button (false by default)
    disableDoublePress?: boolean
    disableTriplePress?: boolean
    disableLongPress?: boolean
    disableRepeatedLongPress?: boolean
}

/**
 * Interface representing the collection of devices for Evok.
 */
export interface IEvokDevicesConfig {
    relays: IEvokRelayDeviceConfig[]
    inputs: IEvokInputDeviceConfig[]
}