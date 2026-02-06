/**
 * Interface representing the configuration settings for an MQTT client.
 */
export interface IMQTTConfig {
    /**
     * The URL of the MQTT broker to connect to.
     */
    brokerUrl: string,
    /**
     * The optional username for authenticating with the MQTT broker.
     */
    username?: string,
    /**
     * The optional password for authenticating with the MQTT broker.
     */
    password?: string,
    /**
     * The optional client identifier to use when connecting to the MQTT broker.
     */
    clientId?: string,

    /**
     * The optional topic name to use for debugging purposes.
     * If provided, the MQTT client will log all received messages on this topic.
     */
    debugTopicName?: string
}