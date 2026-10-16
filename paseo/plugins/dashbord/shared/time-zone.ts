/**
 * An IANA zone name as `Intl` reports it (`US/Pacific`, `Etc/GMT+8`), the form every RPC here accepts (grok-F2). On its own,
 * without zod: the resident badge checks the device's zone with it before reporting it.
 */
export const TIME_ZONE = /^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/;
