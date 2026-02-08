import {AsyncMqttClient, connect} from "async-mqtt"
import {IMQTTConfig} from "../config/mqtt-config";
import {EventEmitter} from "node:events";

// This promise represents the running MQTT service
let mqtt: AsyncMqttClient | null = null;
let connected = false;
const eventEmitter = new EventEmitter();

/**
 * Starts the MQTT connection and subscribes to all topics.
 * @param mqttConfig The MQTT configuration object.
 * @param evokId The unique Evok instance identifier.
 */
export async function startMQTT(mqttConfig: IMQTTConfig, evokId: string) {
    console.info("Starting MQTT service...");

    if (!mqtt) {
        mqtt = connect(mqttConfig.brokerUrl, {
            username: mqttConfig.username,
            password: mqttConfig.password,
            clientId: mqttConfig.clientId,
            will: {
                topic: `evok/${evokId}/availability`,
                payload: "offline",
                qos: 1,
                retain: true
            }
        });
        mqtt.on("connect", () => {
            connected = true;
            console.info("MQTT connected");
            eventEmitter.emit("connected");
        });
        mqtt.on("disconnect", () => {
            connected = false;
            console.info("MQTT disconnected");
            eventEmitter.emit("disconnected");
        });
        mqtt.on("error", (err) => {
            connected = false;
            console.error("MQTT error:", err);
            eventEmitter.emit("error", err);
        });
        await mqtt.subscribe("#");
        mqtt.on("message", onMQTTMessage);
    }
}

/**
 * Stops the MQTT connection and cleans up resources.
 */
export async function stopMQTT() {
    console.info("Stopping MQTT service...");
    if (mqtt) {
        const oldMqtt = mqtt;
        mqtt = null;
        await oldMqtt.end();
    }
}

/**
 * Function that will handle incoming messages.
 * The messages will be broadcast to listeners interested in the topic.
 * @param topic The topic the message was received on
 * @param message The message payload
 */
function onMQTTMessage(topic: string, message: Buffer) {
    const payload = message.toString("utf-8");
    console.debug(`Received MQTT message on topic ${topic}: ${payload}`);
    eventEmitter.emit("message", {topic, message: payload});
}

function isText(val: unknown): boolean {
    return typeof val === "string";
}

/**
 * Function used to send messages to MQTT broker
 * @param topic The topic to send the message to
 * @param message The message to send
 * @param retain Whether the message should be retained by the broker (default: false)
 * @returns True if the message was sent, false otherwise
 */
export async function sendMQTTMessage(topic: string, message: unknown, retain: boolean = false): Promise<boolean> {
    if (mqtt && connected) {
        try {
            await mqtt.publish(topic, !isText(message) ? JSON.stringify(message) : message as string, {retain});
            console.debug(`Sent MQTT message on topic ${topic}: ${message}`);
            return true;
        } catch (err: unknown) {
            console.error(`Failed to send MQTT message on topic ${topic}: ${message}`, err);
            return false;
        }
    } else {
        console.warn("MQTT is not connected. Cannot send message.");
        return false;
    }
}

export function addMQTTMessageListener(listener: (message: { topic: string, message: string }) => void) {
    eventEmitter.on("message", listener);
}

export function removeMQTTMessageListener(listener: (message: { topic: string, message: string }) => void) {
    eventEmitter.off("message", listener);
}

export function addMQTTConnectedListener(listener: () => void) {
    eventEmitter.on("connected", listener);
}

export function removeMQTTConnectedListener(listener: () => void) {
    eventEmitter.off("connected", listener);
}