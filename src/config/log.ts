import {ELogEvel} from "./config";

const LOG_LEVEL_DEFAULT = ELogEvel.INFO;
const LOG_LEVEL_ORDER = [ELogEvel.ERROR, ELogEvel.WARN, ELogEvel.INFO, ELogEvel.DEBUG];

export function logIf(configuredLevel: ELogEvel | null | undefined, logLevel: ELogEvel, logFunction: () => void) {
    // Compare by order of the configured loglevel and the effective log level.
    if (LOG_LEVEL_ORDER.indexOf(configuredLevel || LOG_LEVEL_DEFAULT) >= LOG_LEVEL_ORDER.indexOf(logLevel)) {
        try {
            logFunction();
        } catch (error) {
            console.error("Error while logging:", error);
        }
    }

}