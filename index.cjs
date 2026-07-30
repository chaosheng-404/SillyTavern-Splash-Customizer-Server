const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const PLUGIN_ID = 'splash-customizer';
const STYLE_URL = `/api/plugins/${PLUGIN_ID}/style.css`;
const IMPORT_MARKER = 'SPLASH-CUSTOMIZER-FIRST-FRAME';
const MAX_FONT_SIZE = 8 * 1024 * 1024;
const MAX_STYLESHEET_CSS_LENGTH = 1000000;
const MAX_FONT_FACES = 1024;
const STYLESHEET_CACHE_VERSION = 2;

const DEFAULT_CONFIG = Object.freeze({
    background: { mode: 'default', url: '' },
    logo: { mode: 'default', url: '', size: 100, x: 0, y: 0, flip: 'none', rotation: 0, animation: 'none' },
    spinner: { mode: 'default', url: '', size: 100, x: 0, y: 0, flip: 'none', rotation: 0, animation: 'spin-cw' },
    content: {
        mode: 'default',
        text: '',
        imageUrl: '',
        size: 100,
        x: 0,
        y: 0,
        align: 'center',
        color: '#f0f0f0',
        animation: 'none',
        font: { mode: 'default', url: '', uploadId: '', family: 'Splash Custom Font' },
    },
});

const DEFAULT_STATE = Object.freeze({
    version: 1,
    active: DEFAULT_CONFIG,
    presets: [],
});

const allowed = {
    backgroundMode: new Set(['default', 'image', 'color']),
    elementMode: new Set(['default', 'image', 'hidden']),
    contentMode: new Set(['default', 'text', 'image', 'hidden']),
    flip: new Set(['none', 'horizontal', 'vertical']),
    animation: new Set(['none', 'spin-cw', 'spin-ccw', 'swing', 'float', 'bounce', 'pulse', 'shake', 'flip-3d', 'spin-float']),
    align: new Set(['left', 'center', 'right']),
    fontMode: new Set(['default', 'url', 'stylesheet', 'upload']),
};

let dataDirectory;
let statePath;
let fontsDirectory;

function cloneDefaultConfig() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function string(value, max = 2048) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function number(value, min, max, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function enumValue(value, values, fallback) {
    return values.has(value) ? value : fallback;
}

function safeUrl(value) {
    const candidate = string(value, 4096).trim();
    if (!candidate) return '';
    try {
        const parsed = new URL(candidate, 'http://localhost');
        return ['http:', 'https:'].includes(parsed.protocol) ? candidate : '';
    } catch {
        return '';
    }
}

function safeStylesheetUrl(value) {
    const candidate = string(value, 8192).trim();
    const importMatch = candidate.match(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/i);
    return safeUrl(importMatch?.[1] || candidate);
}

function looksLikeStylesheet(value) {
    const candidate = string(value, 8192).trim();
    return /@import\b/i.test(candidate) || /\.css(?:[?#]|$)/i.test(candidate);
}

function findClosingBrace(css, openingIndex) {
    let depth = 0;
    let quote = '';
    let comment = false;
    for (let index = openingIndex; index < css.length; index++) {
        const current = css[index];
        const next = css[index + 1];
        if (comment) {
            if (current === '*' && next === '/') {
                comment = false;
                index++;
            }
            continue;
        }
        if (!quote && current === '/' && next === '*') {
            comment = true;
            index++;
            continue;
        }
        if (quote) {
            if (current === '\\') {
                index++;
            } else if (current === quote) {
                quote = '';
            }
            continue;
        }
        if (current === '"' || current === "'") {
            quote = current;
            continue;
        }
        if (current === '{') depth++;
        if (current === '}' && --depth === 0) return index;
    }
    return -1;
}

function extractFontFaces(css, stylesheetUrl) {
    const source = string(css, MAX_STYLESHEET_CSS_LENGTH);
    const faces = [];
    const pattern = /@font-face\b/ig;
    let match;
    while ((match = pattern.exec(source)) && faces.length < MAX_FONT_FACES) {
        const openingIndex = source.indexOf('{', match.index + match[0].length);
        if (openingIndex < 0) break;
        const closingIndex = findClosingBrace(source, openingIndex);
        if (closingIndex < 0) break;
        let face = source.slice(match.index, closingIndex + 1);
        face = face.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/ig, (_full, _quote, rawUrl) => {
            const trimmed = rawUrl.trim();
            if (/^(?:data:|https?:|\/)/i.test(trimmed) || !stylesheetUrl) return `url(${cssString(trimmed)})`;
            try {
                return `url(${cssString(new URL(trimmed, stylesheetUrl).href)})`;
            } catch {
                return 'url("")';
            }
        });
        faces.push(face);
        pattern.lastIndex = closingIndex + 1;
    }
    return faces.join('\n');
}

function detectFontFamily(css) {
    const match = string(css, MAX_STYLESHEET_CSS_LENGTH).match(/font-family\s*:\s*(["']?)([^;"'}]+)\1\s*;/i);
    return string(match?.[2], 80).trim();
}

function sanitizeElement(source, fallback, modeValues = allowed.elementMode) {
    const input = source && typeof source === 'object' ? source : {};
    return {
        mode: enumValue(input.mode, modeValues, fallback.mode),
        url: safeUrl(input.url),
        size: number(input.size, 1, 1000, fallback.size),
        x: number(input.x, -45, 45, fallback.x),
        y: number(input.y, -45, 45, fallback.y),
        flip: enumValue(input.flip, allowed.flip, fallback.flip),
        rotation: number(input.rotation, -3600, 3600, fallback.rotation),
        animation: enumValue(input.animation, allowed.animation, fallback.animation),
    };
}

function sanitizeConfig(source) {
    const input = source && typeof source === 'object' ? source : {};
    const fallback = cloneDefaultConfig();
    const background = input.background && typeof input.background === 'object' ? input.background : {};
    const content = input.content && typeof input.content === 'object' ? input.content : {};
    const font = content.font && typeof content.font === 'object' ? content.font : {};
    let fontMode = enumValue(font.mode, allowed.fontMode, fallback.content.font.mode);
    if (fontMode === 'url' && looksLikeStylesheet(font.url)) fontMode = 'stylesheet';
    const config = {
        background: {
            mode: enumValue(background.mode, allowed.backgroundMode, fallback.background.mode),
            url: safeUrl(background.url),
        },
        logo: sanitizeElement(input.logo, fallback.logo),
        spinner: {
            ...sanitizeElement(input.spinner, fallback.spinner),
        },
        content: {
            mode: enumValue(content.mode, allowed.contentMode, fallback.content.mode),
            text: string(content.text, 160),
            imageUrl: safeUrl(content.imageUrl),
            size: number(content.size, 1, 1000, fallback.content.size),
            x: number(content.x, -45, 45, fallback.content.x),
            y: number(content.y, -45, 45, fallback.content.y),
            align: enumValue(content.align, allowed.align, fallback.content.align),
            color: /^#[0-9a-f]{6}$/i.test(content.color) ? content.color : fallback.content.color,
            animation: enumValue(content.animation, allowed.animation, fallback.content.animation),
            font: {
                mode: fontMode,
                url: fontMode === 'stylesheet'
                    ? safeStylesheetUrl(font.url)
                    : safeUrl(font.url),
                uploadId: string(font.uploadId, 100).replace(/[^a-zA-Z0-9._-]/g, ''),
                family: string(font.family, 80) || fallback.content.font.family,
                cachedCss: extractFontFaces(font.cachedCss, safeStylesheetUrl(font.url)),
                cachedForUrl: safeStylesheetUrl(font.cachedForUrl),
                cacheVersion: Number(font.cacheVersion) === STYLESHEET_CACHE_VERSION ? STYLESHEET_CACHE_VERSION : 0,
            },
        },
    };
    return config;
}

function sanitizeState(source) {
    const input = source && typeof source === 'object' ? source : {};
    const presets = Array.isArray(input.presets) ? input.presets.slice(0, 100).map((preset) => {
        const config = sanitizeConfig(preset?.config);
        config.content.font.cachedCss = '';
        config.content.font.cachedForUrl = '';
        config.content.font.cacheVersion = 0;
        return {
            id: string(preset?.id, 80).replace(/[^a-zA-Z0-9_-]/g, '') || crypto.randomUUID(),
            name: string(preset?.name, 60).trim() || '未命名预设',
            updatedAt: string(preset?.updatedAt, 40) || new Date().toISOString(),
            config,
        };
    }) : [];
    return { version: 1, active: sanitizeConfig(input.active), presets };
}

function readState() {
    try {
        return sanitizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
    } catch {
        return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
}

function writeState(state) {
    const sanitized = sanitizeState(state);
    fs.mkdirSync(dataDirectory, { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(sanitized, null, 2), 'utf8');
    fs.renameSync(temporaryPath, statePath);
    return sanitized;
}

function ensureFirstFrameImport() {
    const cssDirectory = path.resolve(globalThis.DATA_ROOT, '_css');
    const userCssPath = path.join(cssDirectory, 'user.css');
    fs.mkdirSync(cssDirectory, { recursive: true });
    const existing = fs.existsSync(userCssPath) ? fs.readFileSync(userCssPath, 'utf8') : '';
    if (existing.includes(IMPORT_MARKER)) return;
    // CSS @import rules must come before ordinary style rules to be valid.
    const separator = existing && !existing.startsWith('\n') ? '\n' : '';
    const managedImport = `/* ${IMPORT_MARKER} */\n@import url("${STYLE_URL}");\n${separator}`;
    fs.writeFileSync(userCssPath, `${managedImport}${existing}`, 'utf8');
}

function cssString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\A ')}"`;
}

function cssUrl(value) {
    return `url(${cssString(value)})`;
}

function transformRules(item) {
    const scaleX = item.flip === 'horizontal' ? -1 : 1;
    const scaleY = item.flip === 'vertical' ? -1 : 1;
    return `translate: ${item.x}vw ${item.y}vh; rotate: ${item.rotation}deg; scale: ${scaleX} ${scaleY};`;
}

function animationName(value) {
    return {
        none: 'none',
        'spin-cw': 'sc-spin-cw 2s linear infinite',
        'spin-ccw': 'sc-spin-ccw 2s linear infinite',
        swing: 'sc-swing 1.8s ease-in-out infinite',
        float: 'sc-float 2.2s ease-in-out infinite',
        bounce: 'sc-bounce 1.2s ease-in-out infinite',
        pulse: 'sc-pulse 1.5s ease-in-out infinite',
        shake: 'sc-shake .65s ease-in-out infinite',
        'flip-3d': 'sc-flip-3d 2.2s ease-in-out infinite',
        'spin-float': 'sc-spin-float 2.4s linear infinite',
    }[value] || 'none';
}

async function hydrateStylesheetFont(config) {
    const font = config.content.font;
    if (font.mode !== 'stylesheet' || !font.url) {
        font.cachedCss = '';
        font.cachedForUrl = '';
        font.cacheVersion = 0;
        return;
    }
    if (font.cacheVersion === STYLESHEET_CACHE_VERSION && font.cachedForUrl === font.url && font.cachedCss) {
        const detectedFamily = detectFontFamily(font.cachedCss);
        if (detectedFamily) font.family = detectedFamily;
        return;
    }
    let response;
    try {
        response = await fetch(font.url, {
            headers: { 'User-Agent': 'SillyTavern-Splash-Customizer/1.1' },
            signal: AbortSignal.timeout(8000),
        });
    } catch (error) {
        throw new Error(`无法下载字体 CSS：${error.message}`);
    }
    if (!response.ok) throw new Error(`无法下载字体 CSS（HTTP ${response.status}）。`);
    const css = await response.text();
    if (css.length > MAX_STYLESHEET_CSS_LENGTH) {
        throw new Error(`字体 CSS 过大（最多 ${Math.round(MAX_STYLESHEET_CSS_LENGTH / 1000)} KB）。`);
    }
    const extracted = extractFontFaces(css, font.url);
    if (!extracted) throw new Error('字体 CSS 中没有找到有效的 @font-face 规则。');
    font.cachedCss = extracted;
    font.cachedForUrl = font.url;
    font.cacheVersion = STYLESHEET_CACHE_VERSION;
    const detectedFamily = detectFontFamily(extracted);
    if (detectedFamily) font.family = detectedFamily;
}

async function hydrateStateFonts(state) {
    await hydrateStylesheetFont(state.active);
}

function generateCss(config) {
    const rules = [];
    const keyframes = `
@keyframes sc-spin-cw { to { transform: rotate(360deg); } }
@keyframes sc-spin-ccw { to { transform: rotate(-360deg); } }
@keyframes sc-swing { 0%,100% { transform: rotate(-16deg); } 50% { transform: rotate(16deg); } }
@keyframes sc-float { 0%,100% { transform: translateY(-10%); } 50% { transform: translateY(10%); } }
@keyframes sc-bounce { 0%,100% { transform: translateY(0) scaleY(1); } 45% { transform: translateY(-28%) scaleY(1.04); } 75% { transform: translateY(0) scaleY(.88); } }
@keyframes sc-pulse { 0%,100% { transform: scale(.88); } 50% { transform: scale(1.1); } }
@keyframes sc-shake { 0%,100% { transform: translate(0,0) rotate(0); } 25% { transform: translate(-5%,2%) rotate(-5deg); } 75% { transform: translate(5%,-2%) rotate(5deg); } }
@keyframes sc-flip-3d { 0%,100% { transform: perspective(500px) rotateY(0); } 50% { transform: perspective(500px) rotateY(180deg); } }
@keyframes sc-spin-float { 0% { transform: translateY(-9%) rotate(0); } 50% { transform: translateY(9%) rotate(180deg); } 100% { transform: translateY(-9%) rotate(360deg); } }`;

    if (config.background.mode === 'image' && config.background.url) {
        rules.push(`#loader.splash-screen { background-image: ${cssUrl(config.background.url)} !important; background-position: center !important; background-size: cover !important; background-repeat: no-repeat !important; }`);
    } else if (config.background.mode === 'color') {
        rules.push('#loader.splash-screen { background-image: none !important; }');
    }

    if (config.logo.mode === 'hidden') {
        rules.push('#loader.splash-screen .splash-logo { display: none !important; }');
    } else if (config.logo.mode === 'image' && config.logo.url) {
        rules.push(`#loader.splash-screen .splash-logo { content: ${cssUrl(config.logo.url)} !important; }`);
    }
    if (config.logo.mode !== 'default' || config.logo.size !== 100 || config.logo.x || config.logo.y || config.logo.flip !== 'none' || config.logo.rotation) {
        rules.push(`#loader.splash-screen .splash-logo { width: min(${Math.round(150 * config.logo.size / 100)}px, 70vw) !important; height: auto !important; ${transformRules(config.logo)} }`);
    }
    if (config.logo.mode !== 'hidden' && config.logo.animation !== 'none') {
        rules.push(`#loader.splash-screen .splash-logo { animation: ${animationName(config.logo.animation)} !important; }`);
    }

    const spinnerCustomized = config.spinner.mode !== 'default'
        || config.spinner.size !== 100
        || config.spinner.x !== 0
        || config.spinner.y !== 0
        || config.spinner.flip !== 'none'
        || config.spinner.rotation !== 0
        || config.spinner.animation !== 'spin-cw';

    if (config.spinner.mode === 'hidden') {
        rules.push('#loader.splash-screen #load-spinner { display: none !important; }');
    } else if (spinnerCustomized) {
        const spinnerSize = Math.round(96 * config.spinner.size / 100);
        if (config.spinner.mode === 'image' && config.spinner.url) {
            rules.push(`#loader.splash-screen #load-spinner { font-size: 0 !important; width: ${spinnerSize}px !important; height: ${spinnerSize}px !important; background: ${cssUrl(config.spinner.url)} center / contain no-repeat !important; }`);
            rules.push('#loader.splash-screen #load-spinner::before { content: none !important; }');
        } else if (config.spinner.size !== 100) {
            rules.push(`#loader.splash-screen #load-spinner { font-size: ${config.spinner.size / 100 * 3}em !important; }`);
        }
        rules.push(`#loader.splash-screen #load-spinner { ${transformRules(config.spinner)} animation: ${animationName(config.spinner.animation)} !important; }`);
    }

    const content = config.content;
    let fontFamily = 'inherit';
    if (content.font.mode === 'url' && content.font.url) {
        fontFamily = cssString(content.font.family);
        rules.unshift(`@font-face { font-family: ${cssString(content.font.family)}; src: ${cssUrl(content.font.url)}; font-display: block; }`);
    } else if (content.font.mode === 'stylesheet' && content.font.cachedCss) {
        fontFamily = cssString(content.font.family);
        rules.unshift(content.font.cachedCss);
    } else if (content.font.mode === 'upload' && content.font.uploadId) {
        fontFamily = cssString(content.font.family);
        rules.unshift(`@font-face { font-family: ${cssString(content.font.family)}; src: url("/api/plugins/${PLUGIN_ID}/fonts/${encodeURIComponent(content.font.uploadId)}"); font-display: block; }`);
    }

    if (content.mode === 'hidden') {
        rules.push('#loader.splash-screen .splash-message { display: none !important; }');
    } else if (content.mode === 'text') {
        rules.push(`#loader.splash-screen .splash-message { font-size: 0 !important; translate: ${content.x}vw ${content.y}vh; text-align: ${content.align} !important; }`);
        rules.push(`#loader.splash-screen .splash-message::after { content: ${cssString(content.text)}; white-space: pre-wrap; display: block; color: ${content.color}; font-family: ${fontFamily}; font-size: ${1.25 * content.size / 100}rem; line-height: 1.35; }`);
    } else if (content.mode === 'image' && content.imageUrl) {
        const imageWidth = Math.round(260 * content.size / 100);
        rules.push(`#loader.splash-screen .splash-message { font-size: 0 !important; width: min(${imageWidth}px, 80vw); height: min(${Math.round(imageWidth * 0.4)}px, 32vw); translate: ${content.x}vw ${content.y}vh; background: ${cssUrl(content.imageUrl)} center / contain no-repeat !important; }`);
    } else if (content.mode === 'default' && (content.size !== 100 || content.x || content.y || content.align !== 'center' || content.color !== '#f0f0f0' || content.font.mode !== 'default')) {
        rules.push(`#loader.splash-screen .splash-message { translate: ${content.x}vw ${content.y}vh; text-align: ${content.align}; color: ${content.color}; font-family: ${fontFamily}; font-size: ${1.25 * content.size / 100}rem; }`);
    }
    if (content.mode !== 'hidden' && content.animation !== 'none') {
        rules.push(`#loader.splash-screen .splash-message { animation: ${animationName(content.animation)} !important; }`);
    }

    return `${keyframes}\n${rules.join('\n')}\n`;
}

function detectFont(buffer) {
    if (buffer.length < 4) return null;
    const signature = buffer.subarray(0, 4).toString('latin1');
    if (signature === 'wOF2') return { extension: 'woff2', mime: 'font/woff2' };
    if (signature === 'wOFF') return { extension: 'woff', mime: 'font/woff' };
    if (signature === 'OTTO') return { extension: 'otf', mime: 'font/otf' };
    if (buffer[0] === 0 && buffer[1] === 1 && buffer[2] === 0 && buffer[3] === 0) return { extension: 'ttf', mime: 'font/ttf' };
    return null;
}

exports.info = {
    id: PLUGIN_ID,
    name: 'Splash Customizer Server',
    description: 'Serves first-frame splash styles and uploaded fonts for the Splash Customizer extension.',
};

exports.init = async function init(router) {
    dataDirectory = path.resolve(globalThis.DATA_ROOT, '_splash-customizer');
    statePath = path.join(dataDirectory, 'state.json');
    fontsDirectory = path.join(dataDirectory, 'fonts');
    fs.mkdirSync(fontsDirectory, { recursive: true });
    if (!fs.existsSync(statePath)) writeState(DEFAULT_STATE);
    try {
        const initialState = readState();
        await hydrateStateFonts(initialState);
        writeState(initialState);
    } catch (error) {
        console.warn('[Splash Customizer] Could not refresh stylesheet fonts during startup:', error.message);
    }
    ensureFirstFrameImport();

    router.get('/status', (_request, response) => {
        response.json({ ok: true, version: 1 });
    });

    router.get('/state', (_request, response) => {
        response.json(readState());
    });

    router.put('/state', express.json({ limit: '1mb' }), async (request, response) => {
        try {
            const state = sanitizeState(request.body);
            await hydrateStateFonts(state);
            response.json(writeState(state));
        } catch (error) {
            console.error('[Splash Customizer] Failed to save state:', error);
            response.status(500).json({ error: error.message || 'Failed to save state.' });
        }
    });

    router.get('/style.css', (_request, response) => {
        response.type('text/css').set('Cache-Control', 'no-store').send(generateCss(readState().active));
    });

    router.post('/preview.css', express.json({ limit: '1mb' }), async (request, response) => {
        try {
            const config = sanitizeConfig(request.body);
            await hydrateStylesheetFont(config);
            response.type('text/css')
                .set('Cache-Control', 'no-store')
                .set('X-Splash-Font-Family', encodeURIComponent(config.content.font.family))
                .send(generateCss(config));
        } catch (error) {
            response.status(400).type('text/plain').send(error.message || 'Failed to generate preview CSS.');
        }
    });

    router.post('/font', express.raw({ type: 'application/octet-stream', limit: MAX_FONT_SIZE }), (request, response) => {
        const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const detected = detectFont(buffer);
        if (!detected) {
            response.status(400).json({ error: '仅支持有效的 WOFF2、WOFF、TTF 或 OTF 字体文件。' });
            return;
        }
        const id = `${crypto.randomUUID()}.${detected.extension}`;
        fs.writeFileSync(path.join(fontsDirectory, id), buffer);
        response.json({ id, url: `/api/plugins/${PLUGIN_ID}/fonts/${id}` });
    });

    router.get('/fonts/:id', (request, response) => {
        const id = string(request.params.id, 100).replace(/[^a-zA-Z0-9._-]/g, '');
        const filePath = path.join(fontsDirectory, id);
        if (!id || !fs.existsSync(filePath)) {
            response.sendStatus(404);
            return;
        }
        const extension = path.extname(id).slice(1);
        const mime = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' }[extension] || 'application/octet-stream';
        response.type(mime).set('Cache-Control', 'public, max-age=31536000, immutable').sendFile(filePath);
    });
};
