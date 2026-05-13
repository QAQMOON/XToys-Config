// ==UserScript==
// @name         BC XToys Control Panel
// @namespace    BC-XToys-Panel
// @version      1.1.0
// @description  Bondage Club 玩具控制面板 — 游戏事件联动 + 手动控制 + 浮动UI
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
const VERSION = '1.1.0';
const FULL_NAME = 'Bondage Club XToys Control Panel';
const SHORT_NAME = 'BC-XToys-Panel';
const STORAGE_KEY = 'BC_XToys_Panel_v1';
const IGNORE_CONTENTS = new Set(['BCXMsg', 'BCEMsg', 'Preference', 'Wardrobe', 'SlowLeaveAttempt', 'ServerUpdateRoom', 'bctMsg']);
const IGNORE_TYPES = new Set(['Status', 'Hidden']);
const MIN_SHOCK_MS = 500;
const SHOCK_NAMES = ['ShockLow', 'ShockMed', 'ShockHigh'];

var defaultShockLevel = 1;
var actionHistory = [];
var currentMaxIntensity = 0;
var toyIntensityMap = {};

// ==================== 持久化 ====================
function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; }
}
function saveState(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

// ==================== WebSocket 管理器 (精确复刻参考实现) ====================
const WS = {
    sockets: new Map(),
    sendMessages: true,
    autoReconnectMap: new Map(),
    uiCallback: null,

    getSaved() {
        var urls = JSON.parse(localStorage.getItem(SHORT_NAME + ' Websockets'));
        return Array.isArray(urls) ? urls : [];
    },
    save() {
        var urls = JSON.stringify(Array.from(this.sockets.keys()));
        if (urls !== localStorage.getItem(SHORT_NAME + ' Websockets')) {
            console.log(SHORT_NAME + ': Saving urls:', urls);
            localStorage.setItem(SHORT_NAME + ' Websockets', urls);
            if (this.uiCallback) this.uiCallback();
        }
    },

    setAutoConnect(v) { localStorage.setItem(SHORT_NAME + ' AutoConnect', JSON.stringify(v === true)); },
    getAutoConnect() { var s = JSON.parse(localStorage.getItem(SHORT_NAME + ' AutoConnect')); return s === true; },

    setAutoReconnect(v) { localStorage.setItem(SHORT_NAME + ' AutoReconnect', JSON.stringify(v === true)); },
    getAutoReconnect() { var s = JSON.parse(localStorage.getItem(SHORT_NAME + ' AutoReconnect')); return s === true; },

    connect: function(url) {
        if (!url) return;
        if (this.hasConnection(url)) {
            console.log(SHORT_NAME + ': Already connected to', url);
            return;
        }
        var ws = new WebSocket(url);
        this.sockets.set(url, ws);
        var self = this;

        ws.onopen = function() {
            console.log(SHORT_NAME + ': Connected to', ws.url);
            if (self.getAutoConnect()) self.save();
            if (self.getAutoReconnect()) self.autoReconnectMap.set(url, 3);
            if (self.uiCallback) self.uiCallback();
        };
        ws.onmessage = function(e) {
            console.log(SHORT_NAME + ': RX:', e.data);
        };
        ws.onclose = function() {
            console.log(SHORT_NAME + ': Disconnected from', url);
            self.close(url);
            if (self.getAutoReconnect()) {
                var att = self.autoReconnectMap.get(url);
                if (att > 0) {
                    setTimeout(function() { self.autoReconnectMap.set(url, att - 1); self.connect(url); }, 100);
                } else {
                    self.autoReconnectMap.delete(url);
                }
            }
            if (self.uiCallback) self.uiCallback();
        };
        ws.onerror = function() {
            if (self.uiCallback) self.uiCallback();
        };
    },

    connectSaved: function() {
        if (!this.getAutoConnect()) return;
        console.log(SHORT_NAME + ': Auto-connecting saved URLs...');
        var urls = this.getSaved();
        for (var i = 0; i < urls.length; i++) this.connect(urls[i]);
    },

    send: function(text) {
        if (this.sockets.size === 0 || !this.sendMessages) return;
        for (var s of this.sockets.values()) {
            if (s.readyState !== 1) continue;
            s.send(text);
        }
        console.log(SHORT_NAME + ': TX:', text);
    },

    sendFormattedArgs: function(actionName, args) {
        if (!this.hasAnyConnection()) { console.log(SHORT_NAME + ': No connection, cannot send'); return; }
        var msg = '{"action": "' + actionName + '"';
        if (args !== null && Array.isArray(args)) {
            for (var i = 0; i < args.length; i++) {
                if (!Array.isArray(args[i]) || args[i].length !== 2 || typeof args[i][0] !== 'string') continue;
                msg += ', "' + args[i][0] + '": ';
                if (args[i][1] === null) { msg += '"none"'; }
                else if (typeof args[i][1] === 'string') { msg += '"' + args[i][1] + '"'; }
                else { msg += args[i][1]; }
            }
        }
        msg += '}';
        this.send(msg);
        // UI notification
        if (this.onGameEvent) this.onGameEvent(actionName, args);
    },

    hasConnection: function(url) { var s = this.sockets.get(url); return s ? s.readyState === 1 : false; },
    hasAnyConnection: function() {
        var ks = Array.from(this.sockets.keys());
        for (var i = 0; i < ks.length; i++) { if (this.hasConnection(ks[i])) return true; }
        return false;
    },

    close: function(url) {
        this.autoReconnectMap.delete(url);
        var s = this.sockets.get(url);
        if (s && s.readyState <= 1) s.close(1000);
        this.sockets.delete(url);
        this.save();
    },
    closeAll: function() {
        var ks = Array.from(this.sockets.keys());
        for (var i = 0; i < ks.length; i++) this.close(ks[i]);
    },
    getConnections: function() { return Array.from(this.sockets.keys()); }
};

// ==================== 物品状态处理器 (精确复刻参考实现) ====================
const ItemState = (function() {
    var states = new Map();
    var shockHistory = [];

    function initSlot(name) { if (!states.get(name)) states.set(name, { itemName: null, effects: new Map() }); }

    function clearOld() {
        var r = true;
        while (r && shockHistory.length > 0) {
            if (Date.now() - shockHistory[0][0] > MIN_SHOCK_MS) { shockHistory.shift(); }
            else { r = false; }
        }
    }

    function hasShockInHistory(slot, level) {
        for (var i = 0; i < shockHistory.length; i++) {
            if (shockHistory[i][1] === slot && shockHistory[i][2] === level) return true;
        }
        return false;
    }

    return {
        log: function() { console.log(states); },

        updateItemProperties: function(effect, tag, slot, itemName, level, offset) {
            offset = offset || 0;
            if (!slot || level === undefined || level === null || !itemName) return;
            level += offset;
            initSlot(slot);
            var s = states.get(slot);
            if (s.effects.get(effect) === level) return;
            s.itemName = itemName;
            s.effects.set(effect, level);

            WS.sendFormattedArgs(tag, [
                ['assetGroupName', slot],
                ['level', level],
                ['itemName', itemName]
            ]);

            // 记录到UI历史
            var pct = Math.round((level / 5) * 100);
            if (tag === 'toyEvent') {
                toyIntensityMap[slot] = pct;
                var maxI = 0;
                var keys = Object.keys(toyIntensityMap);
                for (var i = 0; i < keys.length; i++) { if (toyIntensityMap[keys[i]] > maxI) maxI = toyIntensityMap[keys[i]]; }
                currentMaxIntensity = maxI;
            }
            addAction(tag + '/' + effect, slot, pct, itemName);
        },

        updateAllProps: function(item) {
            if (!item) return;
            this.updateItemProperties('Vibration', 'toyEvent',
                item.Asset && item.Asset.DynamicGroupName,
                item.Asset && item.Asset.Name,
                item.Property && item.Property.Intensity, 1);
            this.updateItemProperties('Inflation', 'inflationEvent',
                item.Asset && item.Asset.DynamicGroupName,
                item.Asset && item.Asset.Name,
                item.Property && item.Property.InflateLevel);
        },

        sendShockEvent: function(slot, level, assetName) {
            if (level >= 0 && level <= 2 && slot) {
                clearOld();
                if (!hasShockInHistory(slot, level)) {
                    WS.sendFormattedArgs('activityEvent', [
                        ['assetGroupName', slot],
                        ['actionName', SHOCK_NAMES[level]],
                        ['assetName', assetName]
                    ]);
                    shockHistory.push([Date.now(), slot, level, assetName]);
                    addAction('Shock', slot, (level + 1) * 33, assetName);
                }
            }
        },

        clearAll: function(slot) {
            var s = states.get(slot);
            if (!s) return;
            if (s.effects.get('Vibration') !== null)
                this.updateItemProperties('Vibration', 'toyEvent', slot, s.itemName, 0);
            if (s.effects.get('Inflation') !== null)
                this.updateItemProperties('Inflation', 'inflationEvent', slot, s.itemName, 0);
            states.delete(slot);
        },

        getItemName: function(slot) { var s = states.get(slot); return s ? s.itemName : null; }
    };
})();

// ==================== 动作历史 (UI用) ====================
function addAction(action, slot, intensity, asset) {
    actionHistory.unshift({
        time: new Date().toLocaleTimeString(),
        action: action, slot: slot || '', intensity: intensity || 0, asset: asset || ''
    });
    if (actionHistory.length > 30) actionHistory.length = 30;
    updateUI();
}

// ==================== 辅助函数 ====================
function searchDict(msg, tag, subKey) {
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
function getPlayerAssetByName(n) { return Player.Appearance.find(function(d) { return d.Asset.Name === n; }); }
function getPlayerAssetBySlot(n) { return Player.Appearance.find(function(d) { return d.Asset.DynamicGroupName === n; }); }
function getShockLevel(d) { switch (d.Content) { case 'TriggerShock0': return 0; case 'TriggerShock1': return 1; case 'TriggerShock2': return 2; default: return -1; } }
function esc(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ==================== UI 面板 ====================
var panelVisible = true;
var dragging = false, dragTarget = null, dragOX = 0, dragOY = 0;

function createUI() {
    // — 游戏机图标 —
    var icon = document.createElement('div');
    icon.id = 'bcp-icon';
    icon.innerHTML = '🎮';
    icon.title = 'XToys 控制面板';
    icon.style.cssText = 'position:fixed;z-index:999990;width:48px;height:48px;background:linear-gradient(135deg,#d32f2f,#b71c1c);border:3px solid #4a0000;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.4),inset 0 2px 0 rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;transition:transform .15s;user-select:none;-webkit-user-select:none;';
    icon.onmouseenter = function() { this.style.transform = 'scale(1.12)'; };
    icon.onmouseleave = function() { this.style.transform = 'scale(1)'; };
    icon.onmousedown = function(e) { if (e.button===0) { dragOX = e.clientX - icon.getBoundingClientRect().left; dragOY = e.clientY - icon.getBoundingClientRect().top; dragTarget = icon; } };
    icon.onclick = function(e) { if (!dragging) togglePanel(); dragging = false; };

    // — 面板 —
    var p = document.createElement('div');
    p.id = 'bcp-panel';
    p.style.cssText = 'position:fixed;z-index:999991;width:260px;background:#18181e;border:2px solid #c62828;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.55);font:13px "Segoe UI","Microsoft YaHei",sans-serif;color:#ccc;overflow:hidden;user-select:none;-webkit-user-select:none;';

    p.innerHTML =
    '<div id="bcp-title" style="background:#1a1a22;padding:8px 10px;cursor:move;display:flex;align-items:center;gap:8px;border-bottom:1px solid #333;">'+
        '<span style="font-size:16px;">🎮</span>'+
        '<b style="color:#ff5252;font-size:13px;">XToys 控制</b>'+
        '<span id="bcp-dot" style="margin-left:auto;width:8px;height:8px;border-radius:50%;background:#f44336;box-shadow:0 0 6px #f44336;"></span>'+
        '<button id="bcp-min" style="background:none;border:1px solid #555;color:#999;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:14px;line-height:1;padding:0;">_</button>'+
    '</div>'+
    '<div id="bcp-body" style="padding:10px;">'+
        '<div style="margin-bottom:8px;"><div style="font-size:10px;color:#888;margin-bottom:3px;">Webhook</div>'+
            '<div style="display:flex;gap:4px;">'+
                '<input id="bcp-input" placeholder="输入 ID 或 ws://..." style="flex:1;padding:5px 7px;background:#111;border:1px solid #444;border-radius:4px;color:#ddd;font-size:11px;outline:none;">'+
                '<button id="bcp-conn" style="padding:5px 10px;background:#c62828;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer;white-space:nowrap;">连接</button>'+
            '</div></div>'+
        '<div style="margin-bottom:8px;">'+
            '<div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span style="font-size:10px;color:#888;">当前强度</span><span id="bcp-intval" style="font-size:12px;color:#4caf50;font-weight:700;">0%</span></div>'+
            '<div style="height:6px;background:#222;border-radius:3px;overflow:hidden;border:1px solid #333;"><div id="bcp-bar" style="height:100%;width:0%;background:#4caf50;border-radius:3px;transition:width .3s;"></div></div>'+
        '</div>'+
        '<div style="margin-bottom:8px;">'+
            '<div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span style="font-size:10px;color:#888;">手动强度</span><span id="bcp-manval" style="font-size:10px;color:#aaa;">50%</span></div>'+
            '<input id="bcp-slider" type="range" min="0" max="100" value="50" style="width:100%;height:4px;-webkit-appearance:none;appearance:none;background:#333;border-radius:2px;outline:none;accent-color:#ff5252;cursor:pointer;">'+
            '<div style="display:flex;gap:4px;margin-top:3px;"><button id="bcp-apply" style="flex:1;padding:4px;background:#2e7d32;border:none;border-radius:4px;color:#fff;font-size:10px;cursor:pointer;">应用</button><button id="bcp-zero" style="flex:1;padding:4px;background:#333;border:1px solid #555;border-radius:4px;color:#ff5252;font-size:10px;cursor:pointer;">归零</button></div>'+
        '</div>'+
        '<div><div style="font-size:10px;color:#888;margin-bottom:3px;">最近事件</div>'+
            '<div id="bcp-log" style="height:100px;overflow-y:auto;font-size:10px;color:#999;background:#0c0c14;border-radius:4px;padding:5px;border:1px solid #222;">等待游戏事件...</div>'+
        '</div>'+
    '</div>';

    document.body.appendChild(icon);
    document.body.appendChild(p);

    // — 拖拽 —
    document.getElementById('bcp-title').onmousedown = function(e) {
        if (e.target.tagName === 'BUTTON') return;
        if (e.button !== 0) return;
        dragTarget = p;
        dragOX = e.clientX - p.getBoundingClientRect().left;
        dragOY = e.clientY - p.getBoundingClientRect().top;
    };
    document.addEventListener('mousemove', function(e) {
        if (!dragTarget) return;
        dragging = true;
        var nx = Math.max(0, Math.min(e.clientX - dragOX, window.innerWidth - dragTarget.offsetWidth));
        var ny = Math.max(0, Math.min(e.clientY - dragOY, window.innerHeight - dragTarget.offsetHeight));
        dragTarget.style.left = nx + 'px';
        dragTarget.style.top = ny + 'px';
        dragTarget.style.right = 'auto';
        dragTarget.style.bottom = 'auto';
        if (dragTarget === p) {
            icon.style.left = (nx + 5) + 'px';
            icon.style.top = (ny - 55) + 'px';
            icon.style.right = 'auto';
            icon.style.bottom = 'auto';
        }
    });
    document.addEventListener('mouseup', function() {
        if (dragging) savePos();
        dragTarget = null;
        dragging = false;
    });

    // — 按钮事件 —
    document.getElementById('bcp-conn').onclick = function() {
        var val = document.getElementById('bcp-input').value.trim();
        if (!val) return;
        var url = /^wss?:\/\//i.test(val) ? val : 'wss://webhook.xtoys.app/' + val;
        if (WS.hasConnection(url)) { WS.close(url); this.textContent = '连接'; refreshDot(); }
        else { WS.connect(url); this.textContent = '断开'; refreshDot(); }
    };
    document.getElementById('bcp-min').onclick = function() { togglePanel(); };
    document.getElementById('bcp-slider').oninput = function() { document.getElementById('bcp-manval').textContent = this.value + '%'; };
    document.getElementById('bcp-apply').onclick = function() {
        var v = parseInt(document.getElementById('bcp-slider').value);
        // 发送手动强度（使用 toyEvent 格式，匹配用户DGLab配置ItemVulva）
        WS.sendFormattedArgs('toyEvent', [
            ['assetGroupName', 'ItemVulva'],
            ['level', Math.round(v / 20)],  // 0-100 → 0-5 scale
            ['itemName', 'ManualOverride']
        ]);
        addAction('Manual', 'ItemVulva', v, 'Override');
    };
    document.getElementById('bcp-zero').onclick = function() {
        document.getElementById('bcp-slider').value = 0;
        document.getElementById('bcp-manval').textContent = '0%';
        WS.sendFormattedArgs('toyEvent', [
            ['assetGroupName', 'ItemVulva'],
            ['level', 0],
            ['itemName', 'ManualOverride']
        ]);
        addAction('Stop', 'all', 0, 'Override');
    };

    restorePos();
}

function togglePanel() {
    var p = document.getElementById('bcp-panel');
    var i = document.getElementById('bcp-icon');
    if (!p || !i) return;
    panelVisible = !panelVisible;
    p.style.display = panelVisible ? 'block' : 'none';
    savePos();
}

function savePos() {
    var s = loadState();
    var i = document.getElementById('bcp-icon');
    var p = document.getElementById('bcp-panel');
    if (i) { s.ix = parseInt(i.style.left) || i.getBoundingClientRect().left; s.iy = parseInt(i.style.top) || i.getBoundingClientRect().top; }
    if (p) { s.px = parseInt(p.style.left) || p.getBoundingClientRect().left; s.py = parseInt(p.style.top) || p.getBoundingClientRect().top; }
    s.vis = panelVisible;
    saveState(s);
}

function restorePos() {
    var s = loadState();
    var i = document.getElementById('bcp-icon');
    var p = document.getElementById('bcp-panel');
    var ix = (s.ix >= 0 && s.ix < window.innerWidth) ? s.ix : window.innerWidth - 65;
    var iy = (s.iy >= 0 && s.iy < window.innerHeight) ? s.iy : window.innerHeight - 80;
    i.style.left = ix + 'px'; i.style.top = iy + 'px'; i.style.right = 'auto'; i.style.bottom = 'auto';
    p.style.left = ((s.px >= 0) ? s.px : ix - 260) + 'px';
    p.style.top = ((s.py >= 0) ? s.py : iy - 5) + 'px';
    p.style.right = 'auto'; p.style.bottom = 'auto';
    panelVisible = s.vis !== false;
    p.style.display = panelVisible ? 'block' : 'none';
}

function refreshDot() {
    var d = document.getElementById('bcp-dot');
    if (!d) return;
    if (WS.hasAnyConnection()) { d.style.background = '#4caf50'; d.style.boxShadow = '0 0 8px #4caf50'; }
    else { d.style.background = '#f44336'; d.style.boxShadow = '0 0 6px #f44336'; }
}

function updateUI() {
    var bar = document.getElementById('bcp-bar');
    var val = document.getElementById('bcp-intval');
    if (bar && val) {
        bar.style.width = currentMaxIntensity + '%';
        val.textContent = currentMaxIntensity + '%';
        var c = currentMaxIntensity < 30 ? '#4caf50' : currentMaxIntensity < 60 ? '#ff9800' : '#f44336';
        bar.style.background = c;
        val.style.color = c;
    }
    refreshDot();
    var log = document.getElementById('bcp-log');
    if (!log) return;
    if (actionHistory.length === 0) { log.innerHTML = '<span style="color:#555;">等待游戏事件...</span>'; return; }
    var h = '';
    for (var i = 0; i < Math.min(8, actionHistory.length); i++) {
        var a = actionHistory[i];
        var cl = a.intensity < 30 ? '#8bc34a' : a.intensity < 60 ? '#ffc107' : '#ff5722';
        h += '<div style="display:flex;justify-content:space-between;margin-bottom:1px;">'+
            '<span>' + esc(a.action) + (a.slot?' @'+a.slot:'') + '</span>'+
            '<span style="color:'+cl+';font-weight:600;">' + a.intensity + '%</span></div>';
    }
    log.innerHTML = h;
}

// ==================== 主逻辑 ====================
async function main() {
    console.log(SHORT_NAME + ' v' + VERSION + ' starting...');

    // 等待 bcModSdk
    while (!window.hasOwnProperty('bcModSdk')) {
        await new Promise(function(r) { setTimeout(r, 1000); });
        console.log(SHORT_NAME + ': waiting for bcModSdk...');
    }
    await new Promise(function(r) {
        var check = function() {
            if (typeof ServerIsConnected !== 'undefined' && ServerIsConnected &&
                typeof ServerSocket !== 'undefined' && typeof Commands !== 'undefined') {
                r();
            } else { setTimeout(check, 500); }
        };
        check();
    });

    console.log(SHORT_NAME + ': SDK ready, registering mod...');

    var modApi = bcModSdk.registerMod({
        name: FULL_NAME,
        fullName: SHORT_NAME,
        version: VERSION,
        repository: 'https://github.com/QAQMOON/XToys-Config'
    });

    // UI
    createUI();
    WS.uiCallback = refreshDot;
    WS.onGameEvent = function() { /* handled in ItemState */ };

    // ===== 服务器重连自动连接 =====
    modApi.hookFunction('ServerSetConnected', 2, function(args, next) {
        next(args);
        if (args[0] === true) WS.connectSaved();
    });

    // ===== 聊天消息处理 (核心链路) =====
    function handleActivities(data) {
        if (data.Type !== 'Activity') return;
        var group = searchDict(data, 'FocusAssetGroup', 'FocusGroupName');
        var name = searchDict(data, 'ActivityName');
        var asset = searchDict(data, 'ActivityAsset', 'AssetName');
        var target = searchDict(data, 'TargetCharacter', 'MemberNumber');
        var source = searchDict(data, 'SourceCharacter', 'MemberNumber');
        if (!group || !name) return;

        if (target === Player.MemberNumber) {
            WS.sendFormattedArgs('activityEvent', [
                ['assetGroupName', group], ['actionName', name], ['assetName', asset]
            ]);
            addAction(name, group, 30, asset);
        } else if (source === Player.MemberNumber) {
            WS.sendFormattedArgs('activityOnOtherEvent', [
                ['assetGroupName', group], ['actionName', name], ['assetName', asset]
            ]);
        }
    }

    function handleItemEquip(data) {
        if (data.Type !== 'Action' ||
            searchDict(data, 'DestinationCharacter', 'MemberNumber') !== Player.MemberNumber ||
            searchDict(data, 'SourceCharacter', 'MemberNumber') === Player.MemberNumber) return;

        var slot = searchDict(data, 'FocusAssetGroup', 'FocusGroupName');
        if (!slot) return;

        if (data.Content === 'ActionUse') {
            var name = searchDict(data, 'NextAsset', 'AssetName');
            if (!name) return;
            WS.sendFormattedArgs('itemAdded', [['assetName', name], ['assetGroupName', slot]]);
            addAction('ItemAdded', slot, 0, name);
            var asset = getPlayerAssetByName(name);
            if (asset) ItemState.updateAllProps(asset);
        } else if (data.Content === 'ActionRemove') {
            var pn = searchDict(data, 'PrevAsset', 'AssetName');
            if (!pn) return;
            WS.sendFormattedArgs('itemRemoved', [['assetName', pn], ['assetGroupName', slot]]);
            ItemState.clearAll(slot);
        }
    }

    function handleToyEvents(data) {
        if (data.Type !== 'Action' ||
            !(searchDict(data, 'DestinationCharacter', 'MemberNumber') === Player.MemberNumber ||
              searchDict(data, 'DestinationCharacterName', 'MemberNumber') === Player.MemberNumber ||
              searchDict(data, 'TargetCharacterName', 'MemberNumber') === Player.MemberNumber)) return;

        var assetName = searchDict(data, 'AssetName', 'AssetName');
        var asset = getPlayerAssetByName(assetName);
        var group = asset && asset.Asset && asset.Asset.Group && asset.Asset.Group.Name;
        if (!group || !asset || !assetName) return;

        ItemState.updateAllProps(asset);
        ItemState.sendShockEvent(group, getShockLevel(data), assetName);
    }

    ServerSocket.on('ChatRoomMessage', async function(data) {
        if (!data || !data.Content || !data.Type ||
            IGNORE_CONTENTS.has(data.Content) || IGNORE_TYPES.has(data.Type)) return;

        handleActivities(data);
        handleItemEquip(data);
        handleToyEvents(data);
    });

    // ===== 振动/物品 钩子 =====
    modApi.hookFunction('VibratorModePublish', 3, function(args, next) {
        next(args);
        if (args[1] && args[1].MemberNumber === Player.MemberNumber) {
            var slot = args[2] && args[2].Asset && args[2].Asset.DynamicGroupName;
            if (slot) {
                var asset = getPlayerAssetBySlot(slot);
                if (asset) ItemState.updateAllProps(asset);
            }
        }
    });

    modApi.hookFunction('ExtendedItemSetOption', 7, function(args, next) {
        next(args);
        if (args.length >= 6 && args[1] && args[1].MemberNumber === Player.MemberNumber) {
            var item = args[2];
            if (item && item.Asset && item.Asset.DynamicGroupName) {
                ItemState.updateAllProps(item);
            }
        }
    });

    modApi.hookFunction('InventoryWear', 8, function(args, next) {
        var ret = next(args);
        if (args[0] && args[0].MemberNumber === Player.MemberNumber) {
            var asset = getPlayerAssetByName(args[1]);
            if (asset) {
                WS.sendFormattedArgs('itemAdded', [
                    ['assetName', asset.Asset.Name],
                    ['assetGroupName', asset.Asset.DynamicGroupName]
                ]);
                ItemState.updateAllProps(asset);
            }
        }
        return ret;
    });

    modApi.hookFunction('InventoryRemove', 3, function(args, next) {
        if (args[0] && args[0].MemberNumber === Player.MemberNumber) {
            var asset = getPlayerAssetBySlot(args[1]);
            if (asset) {
                WS.sendFormattedArgs('itemRemoved', [
                    ['assetName', asset.Asset.Name],
                    ['assetGroupName', asset.Asset.DynamicGroupName]
                ]);
                ItemState.clearAll(args[1]);
            }
        }
        next(args);
    });

    modApi.hookFunction('PropertyShockPublishAction', 3, function(args, next) {
        var shockItem = null;
        if (Array.isArray(args) && args[1] && args[1].Property) shockItem = args[1];
        else if (typeof DialogFocusItem !== 'undefined' && DialogFocusItem && DialogFocusItem.Property) shockItem = DialogFocusItem;

        if (shockItem) {
            var level = shockItem.Property.ShockLevel;
            if (level === null || level === undefined) level = defaultShockLevel;
            ItemState.sendShockEvent(
                shockItem.Asset && shockItem.Asset.DynamicGroupName,
                level,
                shockItem.Asset && shockItem.Asset.Name
            );
        }
        next(args);
    });

    // 初始化完成
    console.log(SHORT_NAME + ' v' + VERSION + ' 已就绪 ✅');
    console.log(SHORT_NAME + ': WebSocket 消息 → 浏览器控制台查看');
    console.log(SHORT_NAME + ': 使用 🎮 图标展开/隐藏面板');
    refreshDot();
}

main().catch(function(e) { console.error(SHORT_NAME + ': init error', e); });

})();
