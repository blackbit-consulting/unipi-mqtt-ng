import {IMQTTConfig} from "./mqtt-config";
import {IEvokConfig} from "./evok-config";

export enum ELogEvel {
    ERROR = "error",
    WARN = "warn",
    INFO = "info",
    DEBUG = "debug"
}

export interface IConfig {
    loglevel?: ELogEvel,
    mqtt: IMQTTConfig,
    evok: IEvokConfig
}