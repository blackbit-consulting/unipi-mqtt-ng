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

export enum EEvokRelayType {
    physical = "physical",
    digital = "digital"
}

export interface IEvokDeviceConfig {
    id: string
    name?: string
    dev: EEvokDeviceType
    circuit: string
}

export interface IEvokRelayDeviceConfig extends IEvokDeviceConfig {
    pulse?: boolean
    dev: EEvokDeviceType.relay
    relayType: EEvokRelayType
    name?: string // Optional name for the relay (for MQTT discovery)
    as?: "switch" | "light" | "fan" // Treat as (default: "switch")
}

export interface IEvokInputDeviceConfig extends IEvokDeviceConfig {
    button?: boolean // Treat as a button (false by default)
    disableDoublePress?: boolean
    disableTriplePress?: boolean
    disableLongPress?: boolean
    disableRepeatedLongPress?: boolean
}

export interface IEvokDevicesConfig {
    relays: IEvokRelayDeviceConfig[]
    inputs: IEvokInputDeviceConfig[]
}