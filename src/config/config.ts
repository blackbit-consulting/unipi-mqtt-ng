import {IMQTTConfig} from "./mqtt-config";
import {IEvokConfig} from "./evok-config";

/**
 * Enum representing log levels for the application.
 */
export enum ELogEvel {
    ERROR = "error",
    WARN = "warn",
    INFO = "info",
    DEBUG = "debug"
}

/**
 * Interface representing the main application configuration.
 */
export interface IConfig {
    loglevel?: ELogEvel,
    mqtt: IMQTTConfig,
    evok: IEvokConfig
}