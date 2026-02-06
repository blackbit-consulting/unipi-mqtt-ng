import {IMQTTConfig} from "./mqtt-config";
import {IEvokConfig} from "./evok-config";

export interface IConfig {
    mqtt: IMQTTConfig,
    evok: IEvokConfig
}