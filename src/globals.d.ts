/** Replaced at build time by Vite `define`. */
declare const __BEACON_URL__: string;
declare const __VERSION__: string;
/** `true` only in builds made for development and the mock server (`BEACON_SERVER_FIELD=1`): the sign-in asks for an address. */
declare const __SERVER_FIELD__: boolean;
/** `direct` (Beacon download, in-app updater) or `store` (Microsoft Store build). */
declare const __CHANNEL__: 'direct' | 'store';
/** Store listing (`https://apps.microsoft.com/detail/<product id>`) or empty. */
declare const __STORE_URL__: string;
