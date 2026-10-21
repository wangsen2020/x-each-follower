import manifest from '../manifest.json' with {type:'json'};
export const APP_VERSION = manifest.version;
export const BACKGROUND_RELOAD_KEY = `x_bg_reloaded_${APP_VERSION}`;
