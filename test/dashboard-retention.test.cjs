const test = require('node:test'), assert = require('node:assert/strict');
const { Clock, loadScript } = require('./helpers.cjs');

function tail() {
    const entries = [];
    return { entries, clearLog: () => { entries.length = 0; }, print: entry => {
        if (entries.length > 50) entries.shift(); entries.push(String(entry));
    } };
}

test('a detailed dashboard exceeding the game log cap retains its title and every section', () => {
    const ui = loadScript('lib/dashboard.js', new Clock()), ns = tail();
    for (let refresh = 0; refresh < 3; refresh++) ui.dashboardFrame(ns, frame => {
        frame.clearLog(); ui.dashboardTitle(frame, 'COMPLETE DASHBOARD');
        for (let section = 0; section < 12; section++) {
            ui.dashboardSection(frame, 'Section ' + section);
            for (let row = 0; row < 10; row++) ui.dashboardRow(frame, 'Value ' + row, 'long detail '.repeat(12));
        }
    });
    assert.equal(ns.entries.length, 1);
    assert.match(ns.entries[0], /^╔═ COMPLETE DASHBOARD/);
    for (let section = 0; section < 12; section++) assert.ok(ns.entries[0].includes('SECTION ' + section));
    assert.ok(ns.entries[0].split('\n').every(line => line.length <= 78));
});

test('supervisor detailed view prints one complete frame with resource and utility headings', () => {
    const api = loadScript('supervisor.js', new Clock()), ns = { ...tail(), ps: () => [],
        getResetInfo: () => ({ currentNode: 4, lastNodeReset: 1, lastAugReset: 2 }), read: () => '',
        getPortHandle: () => ({ peek: () => null }) };
    api.render(ns, { cfg: { dashboardDetails: true, utilityJobs: Array.from({ length: 30 }, () =>
        ({ type: 'diagnostics', state: 'READY', message: 'Completed utility' })) }, services: [] });
    assert.equal(ns.entries.length, 1);
    assert.match(ns.entries[0], /^╔═ BITBURNER AUTOMATION/);
    for (const heading of ['RESOURCES AND SERVICES', 'UTILITY DIAGNOSTICS', 'PROGRESSION', 'AUGMENTATION LOOP', 'SERVICES'])
        assert.ok(ns.entries[0].includes(heading), heading);
});

test('daemon log reader accepts a complete multiline refresh and legacy separate entries', () => {
    const api = loadScript('supervisor.js', new Clock());
    const lines = ['JIT DAEMON :: money :: hacking 731', '  Income 60s     $100/s', '  State          LIVE'];
    for (const logs of [lines, [lines.join('\n')]]) {
        const snapshot = api.readDaemonDashboard({ ps: () => [{ filename: 'daemon.js', pid: 1 }], getScriptLogs: () => logs });
        assert.equal(snapshot.target, 'money'); assert.equal(snapshot.income60, '$100/s');
    }
});
