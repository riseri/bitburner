// Shared planning estimates; purchase actors obtain a live quote before spending.
const PROGRAMS = Object.freeze([
    { name: "BruteSSH.exe", cost: 500_000 },
    { name: "FTPCrack.exe", cost: 1_500_000 },
    { name: "relaySMTP.exe", cost: 5_000_000 },
    { name: "HTTPWorm.exe", cost: 30_000_000 },
    { name: "SQLInject.exe", cost: 250_000_000 },
    { name: "DarkscapeNavigator.exe", cost: 50_000_000, category: "darknet" },
]);

export function progressionPrograms({ darknet = true } = {}) {
    return PROGRAMS.filter(program => program.category !== "darknet" || darknet)
        .map(program => ({ ...program }));
}

export function isProgressionProgram(name) {
    return PROGRAMS.some(program => program.name === name);
}
