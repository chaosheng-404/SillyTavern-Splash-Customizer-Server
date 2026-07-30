#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const SETTINGS = [
    'enableServerPlugins',
    'enableServerPluginsAutoUpdate',
];

function fail(message) {
    console.error(`[Splash Customizer] ${message}`);
    process.exit(1);
}

function getSillyTavernRoot() {
    const rootArgumentIndex = process.argv.indexOf('--root');
    if (rootArgumentIndex !== -1) {
        const value = process.argv[rootArgumentIndex + 1];
        if (!value) fail('Missing path after --root.');
        return path.resolve(value);
    }
    return path.resolve(__dirname, '..', '..');
}

function setBooleanSetting(source, key, lineEnding) {
    const pattern = new RegExp(`^([ \\t]*)${key}[ \\t]*:[ \\t]*[^#\\r\\n]*([ \\t]*#.*)?$`, 'm');
    if (pattern.test(source)) {
        return source.replace(pattern, (_match, indent, comment = '') => {
            const suffix = comment.trim() ? ` ${comment.trim()}` : '';
            return `${indent}${key}: true${suffix}`;
        });
    }

    const separator = source.length > 0 && !source.endsWith('\n') ? lineEnding : '';
    return `${source}${separator}${key}: true${lineEnding}`;
}

const sillyTavernRoot = getSillyTavernRoot();
const packagePath = path.join(sillyTavernRoot, 'package.json');
const configPath = path.join(sillyTavernRoot, 'config.yaml');

if (!fs.existsSync(packagePath) || !fs.existsSync(configPath)) {
    fail(`Could not find a SillyTavern installation at: ${sillyTavernRoot}`);
}

try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (packageJson.name !== 'sillytavern') {
        fail(`The selected directory is not a SillyTavern installation: ${sillyTavernRoot}`);
    }
} catch (error) {
    fail(`Could not validate SillyTavern's package.json: ${error.message}`);
}

const original = fs.readFileSync(configPath, 'utf8');
const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
let updated = original;

for (const setting of SETTINGS) {
    updated = setBooleanSetting(updated, setting, lineEnding);
}

if (updated === original) {
    console.log('[Splash Customizer] Server plugins and automatic updates are already enabled.');
    console.log('[Splash Customizer] Restart SillyTavern to load the plugin.');
    process.exit(0);
}

const backupPath = `${configPath}.splash-customizer.bak`;
if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(configPath, backupPath);
    console.log(`[Splash Customizer] Configuration backup created: ${backupPath}`);
}

const temporaryPath = `${configPath}.splash-customizer.tmp`;
try {
    fs.writeFileSync(temporaryPath, updated, 'utf8');
    fs.renameSync(temporaryPath, configPath);
} catch (error) {
    try {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    } catch {
        // Ignore cleanup failures and report the original error.
    }
    fail(`Could not update config.yaml: ${error.message}`);
}

console.log('[Splash Customizer] Enabled enableServerPlugins.');
console.log('[Splash Customizer] Enabled enableServerPluginsAutoUpdate.');
console.log('[Splash Customizer] Restart SillyTavern to load the plugin.');
