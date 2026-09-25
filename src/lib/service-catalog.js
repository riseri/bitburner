import { PORTS } from "lib/ports.js";
import { readArgument } from "lib/service-lifecycle.js";

// In admission priority order. Capability names are data, not expensive API calls.
export const SERVICES = Object.freeze([
    { name: "daemon.js", core: true, type: "", port: 0 },
    { name: "fleet-manager.js", core: true, type: "fleet-status", port: PORTS.FLEET_STATUS },
    { name: "progression-manager.js", option: "progression", flag: "progression", defaultEnabled: true, type: "progression-status", port: PORTS.PROGRESSION_STATUS },
    { name: "contract-manager.js", option: "contracts", flag: "contracts", defaultEnabled: true, type: "contract-status", port: PORTS.CONTRACT_STATUS },
    { name: "augmentation-manager.js", option: "augmentationActions", flag: "augmentation-actions", defaultEnabled: false, capability: "singularity", type: "augmentation-status", port: PORTS.AUGMENTATION_STATUS },
    { name: "stock-trader.js", option: "stocks", flag: "stocks", defaultEnabled: true, capability: "stocks", type: "stock-status", port: PORTS.STOCK_STATUS },
    { name: "go-bot.js", option: "go", flag: "go", defaultEnabled: true, type: "go-status", port: PORTS.GO_STATUS, heartbeatRequired: false },
    { name: "darknet-manager.js", option: "darknet", flag: "darknet", defaultEnabled: true, capability: "darknet", type: "darknet-status", port: PORTS.DARKNET_STATUS },
].map(service => Object.freeze(service)));

export const PROFILE_DEFAULTS = Object.freeze({
    observe: {},
    assist: { "progression-actions": true, "augmentation-actions": true, "auto-install": false },
    "hands-off": { "progression-actions": true, "augmentation-actions": true, "auto-install": true },
});

export function serviceDefinition(name) {
    const definition = SERVICES.find(service => service.name === name);
    if (!definition) throw new Error(`Unknown service: ${name}`);
    return definition;
}

export function selectedServices(cfg) {
    return SERVICES.filter(service => service.core || cfg[service.option]);
}

// Diagnostics reads the live supervisor arguments; explicit flags win over profiles.
export function supervisorServiceConfig(args = []) {
    const profile = PROFILE_DEFAULTS[String(readArgument(args, "--profile", "observe"))] || {};
    const cfg = {};
    for (const service of SERVICES.filter(service => service.option)) {
        cfg[service.option] = enabled(readArgument(args, `--${service.flag}`, profile[service.flag] ?? service.defaultEnabled));
    }
    for (const [option, flag, fallback] of [["progressionActions", "progression-actions", false],
        ["augmentations", "augmentations", true], ["diagnostics", "diagnostics", true], ["share", "share", true]]) {
        cfg[option] = enabled(readArgument(args, `--${flag}`, profile[flag] ?? fallback));
    }
    return cfg;
}

export function supervisorFiles(cfg) {
    const files = [...selectedServices(cfg).map(service => service.name), "starter-worker.js",
        "jit-hack.js", "jit-grow.js", "jit-weaken.js", "lib/formulas.js"];
    if (cfg.share) files.push("share-worker.js");
    if (cfg.diagnostics) files.push("doctor.js");
    if (cfg.augmentations) files.push("augmentation-planner.js");
    if (cfg.augmentationActions) files.push("bootstrap.js");
    if (cfg.progression && cfg.progressionActions) files.push("progression-purchase.js", "progression-backdoor.js");
    if (cfg.darknet) files.push("darknet-bootstrap.js", "darknet-agent.js", "darknet-phish.js", "darknet-stasis.js",
        "darknet-migrate.js", "darknet-freeze.js", "darknet-stock.js", "darknet-storm.js", "lib/darknet-solvers.js", "lib/darknet-formulas.js");
    return files;
}

function enabled(value) {
    return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}
