const test = require('node:test');
const fs = require('node:fs');
const { Clock, loadScript, root } = require('./helpers.cjs');
const path = require('node:path');

test('all entry points resolve their actual named imports and exported constants', () => {
    for (const file of fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(file => file.endsWith('.js'))) {
        loadScript(file.replaceAll('\\', '/'), new Clock());
    }
});
