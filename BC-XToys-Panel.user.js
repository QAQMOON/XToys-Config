// ==UserScript==
// @name         Bondage Club XToys Control Panel
// @namespace    BC-XToys-Panel
// @version      1.0.0
// @description  实时监控和控制玩具强度，带浮动控制面板和游戏机图标
// @author       QAQMOON
// @match        https://bondageprojects.elementfx.com/*
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-europe.com/*
// @match        http://localhost:*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
'use strict';

// ==================== 常量 ====================
const PANEL_VERSION = '1.0.0';
const PANEL_FULL_NAME = 'BC XToys Control Panel';
const PANEL_SHORT = 'BC-XToys-Panel';
const STORAGE_KEY = 'BC_XToys_Panel';
const IGNORE_MSG_TYPES = new Set(['Status', 'Hidden']);
const IGNORE_MSG_CONTENTS = new Set(['BCXMsg', 'BCEMsg', 'Preference', 'Wardrobe', 'ServerUpdateRoom', 'bctMsg']);
const MIN_SHOCK_INTERVAL = 500;
const SHOCK_LEVELS = ['ShockLow', 'ShockMed', 'ShockHigh'];

// ==================== 状态存储 ====================
function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; }
}
function saveState(s) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ==================== WebSocket 管理器 ====================
const WSManager = {
    sockets: new Map(),
    sendMessages: true,
    autoReconnectMap: new Map(),
    onStatusChange: null,  // callback for UI

    getSavedURLs() {
        var state = loadState();
        return Array.isArray(state.urls) ? state.urls : [];
    },

    saveURLs() {
        var state = loadState();
        var urls = Array.from(this.sockets.keys());
        state.urls = urls;
        saveState(state);
        if (this.onStatusChange) this.onStatusChange();
    },

    setAutoConnect(v) {
        var state = loadState();
        state.autoConnect = v === true;
        saveState(state);
    },

    getAutoConnect() {
        return loadState().autoConnect === true;
    },

    setAutoReconnect(v) {
        var state = loadState();
        state.autoReconnect = v === true;
        saveState(state);
    },

    getAutoReconnect() {
        return loadState().autoReconnect === true;
    },

    connect(url) {
        if (!url) return;
        if (this.hasConnection(url)) {
            log('Already connected to ' + url);
            return;
        }
        var ws = new WebSocket(url);
        this.sockets.set(url, ws);

        ws.onopen = function() {
            log('Connected: ' + url);
            if (WSManager.getAutoConnect()) WSManager.saveURLs();
            if (WSManager.getAutoReconnect()) WSManager.autoReconnectMap.set(url, 3);
            if (WSManager.onStatusChange) WSManager.onStatusChange();
        };
        ws.onmessage = function(e) {
            var d = e.data;
            if (typeof d === 'string') {
                try {
                    var obj = JSON.parse(d);
                    if (typeof obj === 'object' && obj !== null) {
                        // Forward structured data to UI for display
                        if (WSManager.onMessage) WSManager.onMessage(obj);
                    }
                } catch(ex) {}
            }
        };
        ws.onclose = function() {
            log('Disconnected: ' + url);
            WSManager.close(url);
            if (WSManager.getAutoReconnect()) {
                var att = WSManager.autoReconnectMap.get(url);
                if (att > 0) {
                    setTimeout(function() {
                        WSManager.autoReconnectMap.set(url, att - 1);
                        WSManager.connect(url);
                    }, 100);
                } else {
                    WSManager.autoReconnectMap.delete(url);
                }
            }
            if (WSManager.onStatusChange) WSManager.onStatusChange();
        };
        ws.onerror = function() {
            if (WSManager.onStatusChange) WSManager.onStatusChange();
        };
    },

    hasConnection(url) {
        var s = this.sockets.get(url);
        return s ? s.readyState === 1 : false;
    },

    hasAnyConnection() {
        for (var url of this.sockets.keys()) {
            if (this.hasConnection(url)) return true;
        }
        return false;
    },

    send(text) {
        if (this.sockets.size === 0 || !this.sendMessages) return;
        for (var s of this.sockets.values()) {
            if (s.readyState === 1) s.send(text);
        }
    },

    sendFormatted(actionName, args) {
        if (!this.hasAnyConnection()) return;

        var msg = '{"action":"' + actionName + '"';
        if (args && Array.isArray(args)) {
            for (var i = 0; i < args.length; i++) {
                if (!Array.isArray(args[i]) || args[i].length !== 2) continue;
                msg += ',"' + args[i][0] + '":';
                var val = args[i][1];
                if (val === null || val === undefined) {
                    msg += '"none"';
                } else if (typeof val === 'string') {
                    msg += '"' + val + '"';
                } else {
                    msg += val;
                }
            }
        }
        msg += '}';
        this.send(msg);

        // Notify UI of activity
        if (this.onActivity) {
            this.onActivity(actionName, args);
        }
    },

    disconnect(url) {
        this.autoReconnectMap.delete(url);
        var s = this.sockets.get(url);
        if (s && s.readyState <= 1) s.close(1000);
        this.sockets.delete(url);
        this.saveURLs();
    },

    disconnectAll() {
        for (var s of this.sockets.values()) {
            if (s.readyState <= 1) s.close(1000);
        }
        this.sockets.clear();
        this.saveURLs();
    },

    getConnections() {
        var c = [];
        for (var k of this.sockets.keys()) c.push(k);
        return c;
    },

    connectToSaved() {
        if (!this.getAutoConnect()) return;
        var urls = this.getSavedURLs();
        for (var i = 0; i < urls.length; i++) {
            this.connect(urls[i]);
        }
    }
};

// ==================== 动作历史 ====================
var actionHistory = [];  // {time, action, intensity, slot, assetName}
var currentIntensity = 0;
var toyIntensityMap = {}; // slotName -> intensity

function addActionHistory(actionName, slot, intensity, assetName) {
    var now = new Date();
    actionHistory.unshift({
        time: now.toLocaleTimeString(),
        action: actionName,
        intensity: intensity,
        slot: slot,
        asset: assetName || ''
    });
    if (actionHistory.length > 20) actionHistory.length = 20;

    // Track intensity per slot
    if (slot) {
        toyIntensityMap[slot] = intensity;
    }

    // Calculate max intensity across all slots
    var maxI = 0;
    for (var k in toyIntensityMap) {
        if (toyIntensityMap[k] > maxI) maxI = toyIntensityMap[k];
    }
    currentIntensity = maxI;

    updatePanelDisplay();
}

// ==================== 辅助函数 ====================
function searchMsgDict(msg, tag, subKey) {
    if (!msg || !Array.isArray(msg.Dictionary)) return null;
    for (var i = 0; i < msg.Dictionary.length; i++) {
        var keys = Object.keys(msg.Dictionary[i]);
        var vals = Object.values(msg.Dictionary[i]);
        if (keys[0] === tag) return vals[0];
        var idx = keys.indexOf(subKey);
        if (keys[0] === 'Tag' && vals[0] === tag && idx >= 0) return vals[idx];
    }
    return null;
}

function getShockLevel(msg) {
    switch (msg.Content) {
        case 'TriggerShock0': return 0;
        case 'TriggerShock1': return 1;
        case 'TriggerShock2': return 2;
        default: return -1;
    }
}

// ==================== 物品状态处理 ====================
const ItemState = (function() {
    var states = new Map();
    var shockHistory = [];
    var defaultShockLevel = 1;

    function initSlot(name) {
        if (!states.get(name)) states.set(name, { itemName: null, effects: new Map() });
    }
    function clearOldShocks() {
        var now = Date.now();
        while (shockHistory.length > 0 && (now - shockHistory[0][0] > MIN_SHOCK_INTERVAL)) {
            shockHistory.shift();
        }
    }
    function hasShock(slot, level) {
        for (var i = 0; i < shockHistory.length; i++) {
            if (shockHistory[i][1] === slot && shockHistory[i][2] === level) return true;
        }
        return false;
    }

    return {
        setDefaultShockLevel: function(l) { defaultShockLevel = l; },
        getDefaultShockLevel: function() { return defaultShockLevel; },

        updateProps: function(effect, tag, slot, itemName, level, offset) {
            offset = offset || 0;
            if (!slot || level === undefined || level === null || !itemName) return;

            level += offset;
            initSlot(slot);
            var s = states.get(slot);
            if (s.effects.get(effect) === level) return;

            s.itemName = itemName;
            s.effects.set(effect, level);

            WSManager.sendFormatted(tag, [
                ['assetGroupName', slot],
                ['level', level],
                ['itemName', itemName]
            ]);

            var pct = Math.round(level / 4 * 100);
            addActionHistory(effect + '(' + tag + ')', slot, pct, itemName);
        },

        updateAllProps: function(appearanceItem) {
            if (!appearanceItem) return;
            this.updateProps(
                'Vibration', 'toyEvent',
                appearanceItem.Asset && appearanceItem.Asset.DynamicGroupName,
                appearanceItem.Asset && appearanceItem.Asset.Name,
                appearanceItem.Property && appearanceItem.Property.Intensity,
                1
            );
            this.updateProps(
                'Inflation', 'inflationEvent',
                appearanceItem.Asset && appearanceItem.Asset.DynamicGroupName,
                appearanceItem.Asset && appearanceItem.Asset.Name,
                appearanceItem.Property && appearanceItem.Property.InflateLevel
            );
        },

        sendShock: function(slot, level, assetName) {
            if (level >= 0 && level <= 2 && slot) {
                clearOldShocks();
                if (!hasShock(slot, level)) {
                    WSManager.sendFormatted('activityEvent', [
                        ['assetGroupName', slot],
                        ['actionName', SHOCK_LEVELS[level]],
                        ['assetName', assetName]
                    ]);
                    shockHistory.push([Date.now(), slot, level, assetName]);
                    addActionHistory('Shock', slot, (level + 1) * 33, assetName);
                }
            }
        },

        clearSlot: function(slot) {
            var s = states.get(slot);
            if (!s) return;
            if (s.effects.get('Vibration') !== null) {
                this.updateProps('Vibration', 'toyEvent', slot, s.itemName, 0);
            }
            if (s.effects.get('Inflation') !== null) {
                this.updateProps('Inflation', 'inflationEvent', slot, s.itemName, 0);
            }
            states.delete(slot);
        },

        getItemName: function(slot) {
            var s = states.get(slot);
            return s ? s.itemName : null;
        }
    };
})();

// ==================== UI: 浮动面板 ====================
var panelVisible = false;
var panelMinimized = true; // 默认只显示游戏机图标
var panelPos = { x: -1, y: -1 }; // 默认右下角
var dragging = false;
var dragOffset = { x: 0, y: 0 };
var dragTarget = null;

function createUI() {
    // --- 游戏机图标 (最小化时显示) ---
    var icon = document.createElement('div');
    icon.id = 'bcxtoys-icon';
    icon.innerHTML = '🎮';
    icon.title = 'BC XToys 玩具控制面板';
    icon.style.cssText = [
        'position: fixed',
        'z-index: 999990',
        'width: 52px; height: 52px',
        'background: linear-gradient(135deg, #e04040 0%, #c62828 40%, #8b0000 100%)',
        'border: 3px solid #333',
        'border-radius: 14px',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.35), inset 0 2px 0 rgba(255,255,255,0.2)',
        'display: flex; align-items: center; justify-content: center',
        'font-size: 26px',
        'cursor: pointer',
        'transition: transform 0.15s, box-shadow 0.15s',
        'user-select: none',
        '-webkit-user-select: none'
    ].join(';');

    icon.addEventListener('mouseenter', function() {
        icon.style.transform = 'scale(1.1)';
        icon.style.boxShadow = '0 6px 24px rgba(0,0,0,0.45), inset 0 2px 0 rgba(255,255,255,0.2)';
    });
    icon.addEventListener('mouseleave', function() {
        icon.style.transform = 'scale(1)';
        icon.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35), inset 0 2px 0 rgba(255,255,255,0.2)';
    });
    icon.addEventListener('click', function(e) {
        if (!dragging) togglePanel();
        dragging = false;
    });

    // 拖拽图标
    icon.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        dragging = false;
        dragTarget = icon;
        dragOffset.x = e.clientX - icon.getBoundingClientRect().left;
        dragOffset.y = e.clientY - icon.getBoundingClientRect().top;
    });

    // --- 控制面板 ---
    var panel = document.createElement('div');
    panel.id = 'bcxtoys-panel';
    panel.style.cssText = [
        'position: fixed',
        'z-index: 999991',
        'width: 260px',
        'background: #1a1a2e',
        'border: 2px solid #e04040',
        'border-radius: 10px',
        'box-shadow: 0 8px 32px rgba(0,0,0,0.5)',
        'font-family: "Segoe UI", "Microsoft YaHei", sans-serif',
        'font-size: 13px',
        'color: #ddd',
        'display: none',
        'overflow: hidden',
        'user-select: none',
        '-webkit-user-select: none',
        'transition: opacity 0.2s'
    ].join(';');

    // 面板内部 HTML
    panel.innerHTML = [
        // 标题栏 (拖拽手柄)
        '<div id="bcxtoys-titlebar" style="',
            'background: linear-gradient(135deg, #1a1a2e, #2a1a1a);',
            'padding: 8px 12px;',
            'cursor: move;',
            'display: flex; align-items: center; gap: 8px;',
            'border-bottom: 1px solid #333;',
        '">',
            '<span style="font-size:18px;">🎮</span>',
            '<span style="font-weight:700; color:#ff6666;">玩具控制</span>',
            '<span id="bcxtoys-status-dot" style="',
                'margin-left:auto;',
                'width:10px; height:10px;',
                'border-radius:50%;',
                'background:#ff4444;',
                'box-shadow: 0 0 6px #ff4444;',
            '"></span>',
            '<button id="bcxtoys-minimize" style="',
                'background:none; border:1px solid #555; color:#aaa;',
                'width:24px; height:24px; border-radius:4px;',
                'cursor:pointer; font-size:14px; line-height:1;',
                'padding:0;',
            '">_</button>',
        '</div>',

        // 内容区
        '<div id="bcxtoys-content" style="padding:12px;">',

            // 连接区域
            '<div style="margin-bottom:10px;">',
                '<div style="font-size:11px; color:#999; margin-bottom:4px;">Webhook 连接</div>',
                '<div style="display:flex; gap:4px;">',
                    '<input id="bcxtoys-webhook" type="text" placeholder="输入 Webhook ID..." style="',
                        'flex:1;',
                        'padding:5px 8px;',
                        'background:#111; border:1px solid #444; border-radius:4px;',
                        'color:#ddd; font-size:12px; outline:none;',
                    '">',
                    '<button id="bcxtoys-connect-btn" style="',
                        'padding:5px 10px;',
                        'background:#c62828; border:none; border-radius:4px;',
                        'color:#fff; font-size:12px; cursor:pointer; white-space:nowrap;',
                    '">连接</button>',
                '</div>',
            '</div>',

            // 强度显示条
            '<div style="margin-bottom:10px;">',
                '<div style="display:flex; justify-content:space-between; margin-bottom:3px;">',
                    '<span style="font-size:11px; color:#999;">当前强度</span>',
                    '<span id="bcxtoys-intensity-text" style="font-size:12px; color:#ff6666; font-weight:700;">0%</span>',
                '</div>',
                '<div style="',
                    'height:8px; background:#222; border-radius:4px; overflow:hidden;',
                    'border:1px solid #333;',
                '">',
                    '<div id="bcxtoys-intensity-bar" style="',
                        'height:100%; width:0%;',
                        'background: linear-gradient(90deg, #ff4444, #ff8800, #ffdd00);',
                        'border-radius:4px; transition: width 0.3s;',
                    '"></div>',
                '</div>',
            '</div>',

            // 手动控制滑块
            '<div style="margin-bottom:10px;">',
                '<div style="display:flex; justify-content:space-between; margin-bottom:3px;">',
                    '<span style="font-size:11px; color:#999;">手动控制</span>',
                    '<span id="bcxtoys-manual-val" style="font-size:11px; color:#aaa;">50%</span>',
                '</div>',
                '<input id="bcxtoys-slider" type="range" min="0" max="100" value="50" style="',
                    'width:100%; height:6px;',
                    '-webkit-appearance:none; appearance:none;',
                    'background: #333; border-radius:3px; outline:none;',
                    'accent-color: #ff4444;',
                    'cursor:pointer;',
                '">',
                '<div style="display:flex; gap:4px; margin-top:4px;">',
                    '<button id="bcxtoys-send-btn" style="',
                        'flex:1; padding:5px;',
                        'background:#444; border:none; border-radius:4px;',
                        'color:#fff; font-size:11px; cursor:pointer;',
                    '">应用强度</button>',
                    '<button id="bcxtoys-stop-btn" style="',
                        'flex:1; padding:5px;',
                        'background:#333; border:1px solid #555; border-radius:4px;',
                        'color:#ff6666; font-size:11px; cursor:pointer;',
                    '">停止</button>',
                '</div>',
            '</div>',

            // 最近动作日志
            '<div>',
                '<div style="font-size:11px; color:#999; margin-bottom:4px;">最近动作</div>',
                '<div id="bcxtoys-log" style="',
                    'max-height:120px; overflow-y:auto;',
                    'font-size:10px; color:#aaa;',
                    'background:#0a0a14; border-radius:4px; padding:6px;',
                    'border:1px solid #222;',
                '">',
                    '<div style="color:#555;">等待游戏事件...</div>',
                '</div>',
            '</div>',

        '</div>',
    ].join('');

    document.body.appendChild(icon);
    document.body.appendChild(panel);

    // --- 事件绑定 ---
    var titlebar = document.getElementById('bcxtoys-titlebar');

    titlebar.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'BUTTON') return;
        if (e.button !== 0) return;
        dragging = true;
        dragTarget = panel;
        dragOffset.x = e.clientX - panel.getBoundingClientRect().left;
        dragOffset.y = e.clientY - panel.getBoundingClientRect().top;
    });

    document.addEventListener('mousemove', function(e) {
        if (!dragging || !dragTarget) return;
        var newX = e.clientX - dragOffset.x;
        var newY = e.clientY - dragOffset.y;

        // 限制在屏幕内
        newX = Math.max(0, Math.min(newX, window.innerWidth - dragTarget.offsetWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - dragTarget.offsetHeight));

        dragTarget.style.left = newX + 'px';
        dragTarget.style.top = newY + 'px';
        dragTarget.style.right = 'auto';
        dragTarget.style.bottom = 'auto';

        // 同步图标位置
        if (dragTarget === panel) {
            var iconEl = document.getElementById('bcxtoys-icon');
            iconEl.style.left = (newX + 5) + 'px';
            iconEl.style.top = (newY - 60) + 'px';
            iconEl.style.right = 'auto';
            iconEl.style.bottom = 'auto';
            savePanelPosition();
        }
    });

    document.addEventListener('mouseup', function() {
        if (dragging) {
            savePanelPosition();
        }
        dragging = false;
        dragTarget = null;
    });

    // 连接按钮
    document.getElementById('bcxtoys-connect-btn').addEventListener('click', function() {
        var input = document.getElementById('bcxtoys-webhook');
        var id = input.value.trim();
        if (!id) return;

        var url;
        if (/^wss?:\/\//i.test(id)) {
            url = id;
        } else {
            url = 'wss://webhook.xtoys.app/' + id;
        }

        if (WSManager.hasConnection(url)) {
            WSManager.disconnect(url);
            document.getElementById('bcxtoys-connect-btn').textContent = '连接';
            updateStatusDot();
        } else {
            WSManager.connect(url);
            document.getElementById('bcxtoys-connect-btn').textContent = '断开';
            updateStatusDot();
        }
    });

    // 手动控制滑块
    var slider = document.getElementById('bcxtoys-slider');
    slider.addEventListener('input', function() {
        document.getElementById('bcxtoys-manual-val').textContent = this.value + '%';
    });

    document.getElementById('bcxtoys-send-btn').addEventListener('click', function() {
        var val = parseInt(slider.value);
        WSManager.sendFormatted('setIntensity', [
            ['level', val],
            ['type', 'manual']
        ]);
        currentIntensity = val;
        updateIntensityDisplay();
    });

    document.getElementById('bcxtoys-stop-btn').addEventListener('click', function() {
        slider.value = 0;
        document.getElementById('bcxtoys-manual-val').textContent = '0%';
        WSManager.sendFormatted('setIntensity', [
            ['level', 0],
            ['type', 'stop']
        ]);
        currentIntensity = 0;
        updateIntensityDisplay();
    });

    // 最小化按钮
    document.getElementById('bcxtoys-minimize').addEventListener('click', function() {
        minimizePanel();
    });

    // 恢复位置
    restorePanelPosition();
}

function togglePanel() {
    panelMinimized = !panelMinimized;
    var panel = document.getElementById('bcxtoys-panel');
    var icon = document.getElementById('bcxtoys-icon');

    if (panelMinimized) {
        panel.style.display = 'none';
        icon.style.display = 'flex';
        savePanelPosition();
    } else {
        panel.style.display = 'block';
        icon.style.display = 'flex';
        // 面板出现在图标旁边
        if (panel.style.left === '' || panel.style.left === 'auto') {
            var iconRect = icon.getBoundingClientRect();
            panel.style.left = Math.max(0, iconRect.left - 260) + 'px';
            panel.style.top = Math.max(0, iconRect.top - 10) + 'px';
        }
    }
}

function minimizePanel() {
    panelMinimized = true;
    var panel = document.getElementById('bcxtoys-panel');
    var icon = document.getElementById('bcxtoys-icon');
    panel.style.display = 'none';
    icon.style.display = 'flex';
    savePanelPosition();
}

function savePanelPosition() {
    var state = loadState();
    var icon = document.getElementById('bcxtoys-icon');
    var panel = document.getElementById('bcxtoys-panel');
    if (icon) {
        state.iconX = parseInt(icon.style.left) || icon.getBoundingClientRect().left;
        state.iconY = parseInt(icon.style.top) || icon.getBoundingClientRect().top;
    }
    if (panel) {
        state.panelX = parseInt(panel.style.left) || panel.getBoundingClientRect().left;
        state.panelY = parseInt(panel.style.top) || panel.getBoundingClientRect().top;
    }
    state.minimized = panelMinimized;
    saveState(state);
}

function restorePanelPosition() {
    var state = loadState();
    var icon = document.getElementById('bcxtoys-icon');
    var panel = document.getElementById('bcxtoys-panel');

    var ix = state.iconX;
    var iy = state.iconY;

    if (ix === undefined || ix < 0 || ix > window.innerWidth) {
        ix = window.innerWidth - 70;
    }
    if (iy === undefined || iy < 0 || iy > window.innerHeight) {
        iy = window.innerHeight - 80;
    }

    icon.style.left = ix + 'px';
    icon.style.top = iy + 'px';
    icon.style.right = 'auto';
    icon.style.bottom = 'auto';

    panel.style.left = (state.panelX || ix - 260) + 'px';
    panel.style.top = (state.panelY || iy) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';

    panelMinimized = state.minimized !== false;
    if (panelMinimized) {
        panel.style.display = 'none';
        icon.style.display = 'flex';
    } else {
        panel.style.display = 'block';
        icon.style.display = 'flex';
    }
}

function updateStatusDot() {
    var dot = document.getElementById('bcxtoys-status-dot');
    if (!dot) return;
    if (WSManager.hasAnyConnection()) {
        dot.style.background = '#44ff44';
        dot.style.boxShadow = '0 0 8px #44ff44';
    } else {
        dot.style.background = '#ff4444';
        dot.style.boxShadow = '0 0 6px #ff4444';
    }
}

function updateIntensityDisplay() {
    var bar = document.getElementById('bcxtoys-intensity-bar');
    var text = document.getElementById('bcxtoys-intensity-text');
    if (!bar || !text) return;
    bar.style.width = currentIntensity + '%';
    text.textContent = currentIntensity + '%';

    // 颜色随强度变化
    if (currentIntensity < 30) {
        bar.style.background = 'linear-gradient(90deg, #4caf50, #8bc34a)';
        text.style.color = '#8bc34a';
    } else if (currentIntensity < 60) {
        bar.style.background = 'linear-gradient(90deg, #ff9800, #ffc107)';
        text.style.color = '#ffc107';
    } else {
        bar.style.background = 'linear-gradient(90deg, #f44336, #ff5722)';
        text.style.color = '#ff5722';
    }
}

function updatePanelDisplay() {
    updateIntensityDisplay();
    updateStatusDot();
    updateActionLog();
}

function updateActionLog() {
    var logDiv = document.getElementById('bcxtoys-log');
    if (!logDiv) return;
    if (actionHistory.length === 0) {
        logDiv.innerHTML = '<div style="color:#555;">等待游戏事件...</div>';
        return;
    }

    var html = '';
    for (var i = 0; i < Math.min(6, actionHistory.length); i++) {
        var a = actionHistory[i];
        var color = a.intensity < 30 ? '#8bc34a' : a.intensity < 60 ? '#ffc107' : '#ff5722';
        html += '<div style="margin-bottom:2px; display:flex; justify-content:space-between;">' +
            '<span>' + escHtml(a.action) + (a.slot ? ' @' + a.slot : '') + '</span>' +
            '<span style="color:' + color + '; font-weight:600;">' + a.intensity + '%</span>' +
        '</div>';
    }
    logDiv.innerHTML = html;
}

function escHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== 日志 ====================
function log(msg) {
    console.log('[BC-XToys-Panel] ' + msg);
}

// ==================== 主入口 ====================
async function main() {
    log('Waiting for bcModSdk...');

    while (!window.hasOwnProperty('bcModSdk')) {
        await new Promise(function(r) { setTimeout(r, 1000); });
    }

    // 等待服务器连接
    while (!(typeof ServerIsConnected !== 'undefined' && ServerIsConnected && typeof ServerSocket !== 'undefined')) {
        await new Promise(function(r) { setTimeout(r, 500); });
    }
    while (!(typeof Commands !== 'undefined')) {
        await new Promise(function(r) { setTimeout(r, 500); });
    }

    // 注册 MOD
    var modApi = bcModSdk.registerMod({
        name: PANEL_FULL_NAME,
        fullName: PANEL_SHORT,
        version: PANEL_VERSION,
        repository: 'https://github.com/QAQMOON/XToys-Config',
    });

    log('bcModSdk ready, creating UI...');

    // 创建 UI
    createUI();

    // WS 状态回调
    WSManager.onStatusChange = function() {
        updateStatusDot();
        updateActionLog();
    };

    WSManager.onActivity = function(actionName, args) {
        if (args) {
            var slot = '', intensity = 0, assetName = '';
            for (var i = 0; i < args.length; i++) {
                if (args[i][0] === 'assetGroupName') slot = args[i][1];
                if (args[i][0] === 'level') intensity = Math.round((args[i][1] || 0) / 4 * 100);
                if (args[i][0] === 'assetName' || args[i][0] === 'actionName') assetName = args[i][1];
            }
            addActionHistory(actionName, slot, intensity, assetName);
        }
    };

    // 服务器重连时自动连接
    modApi.hookFunction('ServerSetConnected', 2, function(args, next) {
        next(args);
        if (args[0] === true) {
            WSManager.connectToSaved();
        }
    });

    // ==================== 游戏事件监听 ====================

    // 聊天消息处理
    ServerSocket.on('ChatRoomMessage', function(data) {
        if (!data || !data.Content || !data.Type ||
            IGNORE_MSG_CONTENTS.has(data.Content) ||
            IGNORE_MSG_TYPES.has(data.Type)) {
            return;
        }

        // 活动处理
        if (data.Type === 'Activity') {
            var group = searchMsgDict(data, 'FocusAssetGroup', 'FocusGroupName');
            var name = searchMsgDict(data, 'ActivityName');
            var asset = searchMsgDict(data, 'ActivityAsset', 'AssetName');
            var target = searchMsgDict(data, 'TargetCharacter', 'MemberNumber');
            var source = searchMsgDict(data, 'SourceCharacter', 'MemberNumber');

            if (group && name) {
                if (target === Player.MemberNumber) {
                    WSManager.sendFormatted('activityEvent', [
                        ['assetGroupName', group],
                        ['actionName', name],
                        ['assetName', asset]
                    ]);
                    addActionHistory(name, group, 25, asset);
                } else if (source === Player.MemberNumber) {
                    WSManager.sendFormatted('activityOnOtherEvent', [
                        ['assetGroupName', group],
                        ['actionName', name],
                        ['assetName', asset]
                    ]);
                }
            }
        }

        // 玩具装备/卸下
        if (data.Type === 'Action') {
            var dest = searchMsgDict(data, 'DestinationCharacter', 'MemberNumber');
            var src = searchMsgDict(data, 'SourceCharacter', 'MemberNumber');

            if (dest === Player.MemberNumber && src !== Player.MemberNumber) {
                var slotName = searchMsgDict(data, 'FocusAssetGroup', 'FocusGroupName');
                if (!slotName) return;

                if (data.Content === 'ActionUse') {
                    var itemName = searchMsgDict(data, 'NextAsset', 'AssetName');
                    if (itemName) {
                        WSManager.sendFormatted('itemAdded', [
                            ['assetName', itemName],
                            ['assetGroupName', slotName]
                        ]);
                        addActionHistory('ItemAdded', slotName, 0, itemName);
                    }
                } else if (data.Content === 'ActionRemove') {
                    var prevName = searchMsgDict(data, 'PrevAsset', 'AssetName');
                    if (prevName) {
                        WSManager.sendFormatted('itemRemoved', [
                            ['assetName', prevName],
                            ['assetGroupName', slotName]
                        ]);
                        ItemState.clearSlot(slotName);
                    }
                }
            }

            // 震动/电击事件
            if (dest === Player.MemberNumber) {
                var assetName = searchMsgDict(data, 'AssetName', 'AssetName');
                var shockLevel = getShockLevel(data);
                if (assetName && shockLevel >= 0) {
                    ItemState.sendShock(slotName || 'unknown', shockLevel, assetName);
                }
            }
        }
    });

    // ==================== 物品/振动钩子 ====================

    // 振动模式改变
    modApi.hookFunction('VibratorModePublish', 3, function(args, next) {
        next(args);
        if (args[1] && args[1].MemberNumber === Player.MemberNumber) {
            var slot = args[2] && args[2].Asset && args[2].Asset.DynamicGroupName;
            if (slot) {
                var asset = Player.Appearance.find(function(d) {
                    return d.Asset && d.Asset.DynamicGroupName === slot;
                });
                if (asset) ItemState.updateAllProps(asset);
            }
        }
    });

    // 玩家自己操作物品
    modApi.hookFunction('ExtendedItemSetOption', 7, function(args, next) {
        next(args);
        if (args.length >= 6 && args[1] && args[1].MemberNumber === Player.MemberNumber) {
            var item = args[2];
            if (item && item.Asset && item.Asset.DynamicGroupName) {
                ItemState.updateAllProps(item);
            }
        }
    });

    // 物品装备
    modApi.hookFunction('InventoryWear', 8, function(args, next) {
        var ret = next(args);
        if (args[0] && args[0].MemberNumber === Player.MemberNumber) {
            var asset = Player.Appearance.find(function(d) {
                return d.Asset && d.Asset.Name === args[1];
            });
            if (asset) {
                WSManager.sendFormatted('itemAdded', [
                    ['assetName', asset.Asset.Name],
                    ['assetGroupName', asset.Asset.DynamicGroupName]
                ]);
                ItemState.updateAllProps(asset);
            }
        }
        return ret;
    });

    // 物品卸下
    modApi.hookFunction('InventoryRemove', 3, function(args, next) {
        if (args[0] && args[0].MemberNumber === Player.MemberNumber) {
            var slot = args[1];
            var asset = Player.Appearance.find(function(d) {
                return d.Asset && d.Asset.DynamicGroupName === slot;
            });
            if (asset) {
                WSManager.sendFormatted('itemRemoved', [
                    ['assetName', asset.Asset.Name],
                    ['assetGroupName', asset.Asset.DynamicGroupName]
                ]);
                ItemState.clearSlot(slot);
            }
        }
        next(args);
    });

    // 电击
    modApi.hookFunction('PropertyShockPublishAction', 3, function(args, next) {
        var shockItem = null;
        if (Array.isArray(args) && args[1] && args[1].Property) {
            shockItem = args[1];
        } else if (typeof DialogFocusItem !== 'undefined' && DialogFocusItem && DialogFocusItem.Property) {
            shockItem = DialogFocusItem;
        }
        if (shockItem) {
            var level = shockItem.Property.ShockLevel;
            if (level === null || level === undefined) level = ItemState.getDefaultShockLevel();
            ItemState.sendShock(
                shockItem.Asset && shockItem.Asset.DynamicGroupName,
                level,
                shockItem.Asset && shockItem.Asset.Name
            );
        }
        next(args);
    });

    log('Initialized. Use the game controller icon to open the panel.');
    updateStatusDot();
}

// 启动
main().catch(function(err) {
    console.error('[BC-XToys-Panel] Init error:', err);
});

})();
