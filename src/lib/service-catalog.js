import { PORTS } from "lib/ports.js";
import { readArgument } from "lib/service-lifecycle.js";

// In admission priority order. Capability names are data, not expensive API calls.
export const SERVICES = Object.freeze([
    { name: "daemon.js", core: true, type: "", port: 0 },
    { name: "fleet-manager.js", core: true, type: "fleet-status", port: PORTS.FLEET_STATUS },
    { name: "progression-manager.js", option: "progression", flag: "progression", defaultEnabled: true, type: "progression-status", port: PORTS.PROGRESSION_STATUS },
    { name: "contract-manager.js", option: "contracts", flag: "contracts", defaultEnabled: true, type: "contract-status", port: PORTS.CONTRACT_STATUS },
    { name: "augmentation-manager.js", option: "augmentationActions", flag: "augmentation-actions", defaultEnabled: true, capability: "singularity", type: "augmentation-status", port: PORTS.AUGMENTATION_STATUS },
    { name: "stock-trader.js", option: "stocks", flag: "stocks", defaultEnabled: true, capability: "stocks", type: "stock-status", port: PORTS.STOCK_STATUS },
    { name: "go-bot.js", option: "go", flag: "go", defaultEnabled: true, type: "go-status", port: PORTS.GO_STATUS, heartbeatRequired: false },
    { name: "darknet-manager.js", option: "darknet", flag: "darknet", defaultEnabled: true, capability: "darknet", type: "darknet-status", port: PORTS.DARKNET_STATUS },
].map(service => Object.freeze(service)));

export const ACTION_DEFAULTS = Object.freeze({
    "progression-actions": true, "augmentation-actions": true,
});

export function serviceDefinition(name) {
    const definition = SERVICES.find(service => service.name === name);
    if (!definition) throw new Error(`Unknown service: ${name}`);
    return definition;
}

export function selectedServices(cfg, capabilities = null) {
    return SERVICES.filter(service => (service.core || cfg[service.option]) &&
        (!capabilities || !service.capability || capabilities[service.capability]));
}

// Diagnostics reads the same defaults and explicit overrides as the supervisor.
export function supervisorServiceConfig(args = []) {
    const cfg = {};
    for (const service of SERVICES.filter(service => service.option)) {
        cfg[service.option] = enabled(readArgument(args, `--${service.flag}`, service.defaultEnabled));
    }
    for (const [option, flag, fallback] of [["progressionActions", "progression-actions", ACTION_DEFAULTS["progression-actions"]],
        ["augmentations", "augmentations", true], ["diagnostics", "diagnostics", true], ["shareEnabled", "share", true]]) {
        cfg[option] = enabled(readArgument(args, `--${flag}`, fallback));
    }
    return cfg;
}

export function supervisorFiles(cfg, capabilities = null) {
    const singularity = !capabilities || capabilities.singularity;
    const darknet = !capabilities || capabilities.darknet;
    const files = [...selectedServices(cfg, capabilities).map(service => service.name), "starter-worker.js",
        "jit-hack.js", "jit-grow.js", "jit-weaken.js", "lib/formulas.js"];
    if (cfg.shareEnabled) files.push("share-worker.js");
    if (cfg.diagnostics) files.push("doctor.js");
    if (singularity && cfg.augmentations) files.push("augmentation-planner.js");
    if (singularity && cfg.augmentationActions) files.push("bootstrap.js");
    if ((!capabilities || capabilities.route) && cfg.augmentationActions && cfg.progression && cfg.progressionActions)
        files.push("home-upgrade.js", "node-complete.js", "intelligence-handoff.js", "intelligence-farm.js");
    if (singularity && cfg.progression && cfg.progressionActions) files.push("progression-purchase.js", "progression-backdoor.js");
    if (darknet && cfg.darknet) files.push("darknet-bootstrap.js", "darknet-agent.js", "darknet-phish.js", "darknet-stasis.js",
        "darknet-migrate.js", "darknet-freeze.js", "darknet-stock.js", "darknet-storm.js", "lib/darknet-solvers.js", "lib/darknet-formulas.js");
    return files;
}

// Only query costs of usable helpers: locked Singularity calls can be very expensive.
export function supervisorRamBudget(ns, cfg, capabilities) {
    const cost = file => Math.max(0, Number(ns.getScriptRam(file, "home")) || 0);
    const actorRam = capabilities.singularity && cfg.progression && cfg.progressionActions
        ? Math.max(cost("progression-purchase.js"), cost("progression-backdoor.js")) : 0;
    const utilityRam = Math.max(actorRam, capabilities.route && cfg.augmentationActions && cfg.progression && cfg.progressionActions ? Math.max(cost("node-complete.js"), cost("intelligence-handoff.js")) : 0, cfg.diagnostics ? cost("doctor.js") : 0,
        capabilities.singularity && cfg.augmentations ? cost("augmentation-planner.js") : 0);
    const optionalRam = (capabilities.singularity && cfg.augmentationActions ? cost("augmentation-manager.js") : 0) +
        (capabilities.darknet && cfg.darknet ? cost("darknet-manager.js") + cost("darknet-agent.js") : 0);
    return { actorRam, utilityRam, optionalRam };
}

function enabled(value) {
    return !["false", "0", "no", "off"].includes(String(value).trim().toLowerCase());
}
