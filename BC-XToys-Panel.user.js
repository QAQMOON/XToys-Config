// ==UserScript==
// @name         BC XToys Control Panel
// @namespace    BC-XToys-Panel
// @version      2.8.0
// @description  Bondage Club 遥控面板：波形+配对+小游戏+剧本+自动响应+广播+白名单
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
const VER = '2.8.0';
const FULL = 'BC XToys Control Panel';
const SHORT = 'BC-XToys-Panel';
const SK = 'BC_XToys_Panel_v2';
const IG_CT = new Set(['BCXMsg','BCEMsg','Preference','Wardrobe','SlowLeaveAttempt','ServerUpdateRoom','bctMsg']);
const IG_TP = new Set(['Status','Hidden']);
const MIN_SK = 500;
const SK_NM = ['ShockLow','ShockMed','ShockHigh'];
const REMOTE_COOLDOWN = 3000;

// 波形/游戏/剧本 状态
var waveRunning=null, waveTimerId=null;       // {type,min,max,speed,step}
var scriptRunning=null, scriptTimerId=null;   // {steps:[{time,level},...],index}
var autoResponseMap={};  // {actionName: {type, intensity, duration}}
var voteBox={};          // {voterName: intensity}
var mineMap={};          // {callerName: {mines:[1,2,3], found:[]}}
var guessTarget=0;       // 猜谜目标值

// ==================== 持久化 ====================
function loadS() { try { return JSON.parse(localStorage.getItem(SK)) || {}; } catch(e) { return {}; } }
function saveS(s) { localStorage.setItem(SK, JSON.stringify(s)); }

// ==================== 全局状态 ====================
var actLog = [], curIntensity = 0, toyMap = {};
var remoteAllow = true, broadcastOn = true;
var whitelist = [];   // 允许控制的白名单玩家名
var lastRemoteTime = {};
var curControlledBy = null; // 当前谁在控制

// ==================== WebSocket Manager ====================
const WS = {
    sockets: new Map(), sendMsgs: true, autoRecMap: new Map(), uiCb: null,
    getSaved() { var u = JSON.parse(localStorage.getItem(SHORT+' Websockets')); return Array.isArray(u)?u:[]; },
    save() { var u = JSON.stringify(Array.from(this.sockets.keys())); if(u!==localStorage.getItem(SHORT+' Websockets')){ localStorage.setItem(SHORT+' Websockets',u); if(this.uiCb)this.uiCb(); } },
    setAutoC(v) { localStorage.setItem(SHORT+' AutoConnect', JSON.stringify(v===true)); },
    getAutoC() { return JSON.parse(localStorage.getItem(SHORT+' AutoConnect'))===true; },
    setAutoR(v) { localStorage.setItem(SHORT+' AutoReconnect', JSON.stringify(v===true)); },
    getAutoR() { return JSON.parse(localStorage.getItem(SHORT+' AutoReconnect'))===true; },
    connect(url) {
        if(!url)return; if(this.hasConn(url)){ log('Already connected: '+url); return; }
        var w=new WebSocket(url); this.sockets.set(url,w); var s=this;
        w.onopen=function(){ log('Connected: '+w.url); if(s.getAutoC())s.save(); if(s.getAutoR())s.autoRecMap.set(url,3); if(s.uiCb)s.uiCb(); };
        w.onmessage=function(e){ log('RX: '+e.data); };
        w.onclose=function(){ log('Disconnected: '+url); s.close(url);
            if(s.getAutoR()){ var a=s.autoRecMap.get(url); if(a>0){ setTimeout(function(){ s.autoRecMap.set(url,a-1); s.connect(url); },100); } else s.autoRecMap.delete(url); }
            if(s.uiCb)s.uiCb(); };
        w.onerror=function(){ if(s.uiCb)s.uiCb(); };
    },
    connectSaved() { if(!this.getAutoC())return; var u=this.getSaved(); for(var i=0;i<u.length;i++)this.connect(u[i]); },
    send(t) { if(this.sockets.size===0||!this.sendMsgs)return; for(var s of this.sockets.values()){ if(s.readyState!==1)continue; s.send(t); } log('TX: '+t); },
    sendFA(action, args) {
        if(!this.hasAnyConn()){ log('No connection'); return; }
        var m='{"action":"'+action+'"';
        if(args&&Array.isArray(args)){ for(var i=0;i<args.length;i++){ if(!Array.isArray(args[i])||args[i].length!==2||typeof args[i][0]!=='string')continue;
            m+=', "'+args[i][0]+'": '; var v=args[i][1];
            if(v===null){ m+='"none"'; } else if(typeof v==='string'){ m+='"'+v+'"'; } else { m+=v; } } }
        m+='}'; this.send(m);
        if(this.onGEvt)this.onGEvt(action,args);
    },
    hasConn(u){ var s=this.sockets.get(u); return s?s.readyState===1:false; },
    hasAnyConn(){ var ks=Array.from(this.sockets.keys()); for(var i=0;i<ks.length;i++){ if(this.hasConn(ks[i]))return true; } return false; },
    close(url){ this.autoRecMap.delete(url); var s=this.sockets.get(url); if(s&&s.readyState<=1)s.close(1000); this.sockets.delete(url); this.save(); },
    closeAll(){ var ks=Array.from(this.sockets.keys()); for(var i=0;i<ks.length;i++)this.close(ks[i]); },
    getConns(){ return Array.from(this.sockets.keys()); }
};

// ==================== ItemState Handler ====================
const ItemState = (function(){
    var st=new Map(), skH=[];
    function init(n){ if(!st.get(n))st.set(n,{nm:null,fx:new Map()}); }
    function clrO(){ var r=true; while(r&&skH.length>0){ if(Date.now()-skH[0][0]>MIN_SK)skH.shift(); else r=false; } }
    function hasSK(s,l){ for(var i=0;i<skH.length;i++){ if(skH[i][1]===s&&skH[i][2]===l)return true; } return false; }
    return {
        updProps(effect,tag,slot,nm,level,off){ off=off||0; if(!slot||level===undefined||level===null||!nm)return; level+=off;
            init(slot); var s=st.get(slot); if(s.fx.get(effect)===level)return; s.nm=nm; s.fx.set(effect,level);
            WS.sendFA(tag,[['assetGroupName',slot],['level',level],['itemName',nm]]);
            var pct=Math.round(level/5*100);
            if(tag==='toyEvent'){ toyMap[slot]=pct; var mx=0; var ks=Object.keys(toyMap); for(var i=0;i<ks.length;i++){ if(toyMap[ks[i]]>mx)mx=toyMap[ks[i]]; } curIntensity=mx; }
            addLog(tag,slot,pct,nm);
        },
        updAll(item){ if(!item)return;
            this.updProps('Vibration','toyEvent',item.Asset&&item.Asset.DynamicGroupName,item.Asset&&item.Asset.Name,item.Property&&item.Property.Intensity,1);
            this.updProps('Inflation','inflationEvent',item.Asset&&item.Asset.DynamicGroupName,item.Asset&&item.Asset.Name,item.Property&&item.Property.InflateLevel);
        },
        sendSK(slot,level,an){ if(level>=0&&level<=2&&slot){ clrO(); if(!hasSK(slot,level)){ WS.sendFA('activityEvent',[['assetGroupName',slot],['actionName',SK_NM[level]],['assetName',an]]); skH.push([Date.now(),slot,level,an]); addLog('Shock',slot,(level+1)*33,an); } } },
        clearAll(slot){ var s=st.get(slot); if(!s)return; if(s.fx.get('Vibration')!==null)this.updProps('Vibration','toyEvent',slot,s.nm,0); if(s.fx.get('Inflation')!==null)this.updProps('Inflation','inflationEvent',slot,s.nm,0); st.delete(slot); },
        getNm(slot){ var s=st.get(slot); return s?s.nm:null; }
    };
})();

// ==================== 动作日志 ====================
function addLog(action,slot,intensity,asset,who){
    who = who || '';
    actLog.unshift({time:new Date().toLocaleTimeString(),action:action,slot:slot||'',intensity:intensity||0,asset:asset||'',who:who});
    if(actLog.length>50)actLog.length=50;
    updUI();
}

// ==================== 强度表情 ====================
function intensityEmoji(pct){
    if(pct<=0)return '💤'; if(pct<20)return '🌱'; if(pct<40)return '💡'; if(pct<60)return '🔥'; if(pct<80)return '💥'; return '🚨';
}

// ==================== 聊天广播 ====================
var lastBroadcast = 0;
var lastBroadcastLevel = -1;
var BROADCAST_MIN_INTERVAL = 5000;
var BROADCAST_MIN_CHANGE = 10;

function maybeBroadcast(){
    if(!broadcastOn)return;
    var now = Date.now();
    if(now - lastBroadcast < BROADCAST_MIN_INTERVAL && Math.abs(curIntensity - lastBroadcastLevel) < BROADCAST_MIN_CHANGE) return;
    lastBroadcast = now;
    lastBroadcastLevel = curIntensity;

    var bar='', segs=10, filled=Math.round(curIntensity/10);
    for(var i=0;i<segs;i++)bar+=i<filled?'█':'░';
    var emoji = intensityEmoji(curIntensity);
    var msg = '[🎮] '+Player.Name+' 的玩具 '+emoji+' ['+bar+'] '+curIntensity+'%';
    if(typeof ChatRoomSendLocal !== 'undefined') ChatRoomSendLocal(msg, 8000);
}

// ==================== 远程控制 ====================
function handleRemoteCommand(sourceName, intensity){
    if(!remoteAllow){ ChatRoomSendLocal('[🎮] 远程控制已关闭',5000); return; }

    // 白名单检查
    if(whitelist.length>0){
        var found=false;
        for(var i=0;i<whitelist.length;i++){ if(whitelist[i].toLowerCase()===sourceName.toLowerCase()){ found=true; break; } }
        if(!found){ ChatRoomSendLocal('[🎮] '+sourceName+' 不在白名单中',5000); return; }
    }

    // 冷却检查
    var lk = sourceName.toLowerCase();
    if(lastRemoteTime[lk] && Date.now()-lastRemoteTime[lk] < REMOTE_COOLDOWN){
        ChatRoomSendLocal('[🎮] '+sourceName+' 请等待 '+(Math.round((REMOTE_COOLDOWN-(Date.now()-lastRemoteTime[lk]))/100)/10)+'秒',5000);
        return;
    }
    lastRemoteTime[lk]=Date.now();

    intensity = Math.max(0,Math.min(100,intensity));
    curControlledBy = sourceName;

    // 发送到XToys
    WS.sendFA('toyEvent',[
        ['assetGroupName','ItemVulva'],
        ['level',Math.round(intensity/20)],
        ['itemName','RemoteControl']
    ]);

    curIntensity = intensity;
    toyMap['remote'] = intensity;
    addLog('Remote', 'remote', intensity, sourceName, sourceName);

    // 广播
    var emoji = intensityEmoji(intensity);
    ChatRoomSendLocal('[🎮] '+sourceName+' 设置 '+Player.Name+' 的玩具为 '+intensity+'% '+emoji, 10000);

    // 自动反应
    var reacts = ['啊...','嗯~','感受到了...','好强烈...','玩具在震...','唔...'];
    if(intensity>80) reacts = ['啊啊啊!!!','太强了!!','要坏掉了...','不行了...','天啊...'];
    else if(intensity>50) reacts = ['嗯嗯~','好舒服...','就是这样...','再强一点...'];
    else if(intensity>20) reacts = ['嗯...','轻轻的...','感觉到了...'];

    var react = reacts[Math.floor(Math.random()*reacts.length)];
    if(typeof ChatRoomSendLocal !== 'undefined'){
        setTimeout(function(){ ChatRoomSendLocal(react, 5000); }, 1000);
    }
}

// ==================== 配对控制系统 ====================
var pairSessions = {};   // {code: {wsUrl, expires, creator, limit, timer, timerId}}
var pairedPartner = null; // {name, wsUrl, limit, timerId}
var pairLimitMax = 100;   // paired partner max intensity

function genPairCode(){ var c=''; var ch='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for(var i=0;i<6;i++)c+=ch[Math.floor(Math.random()*ch.length)]; return c; }

function sharePairCode(){
    if(!WS.hasAnyConn()){ ChatRoomSendLocal('[🎮] 请先连接 XToys 再分享配对',5000); return; }
    var code=genPairCode();
    var urls=WS.getConns();
    pairSessions[code]={wsUrl:urls[0], expires:Date.now()+60000, creator:Player.Name, limit:pairLimitMax};
    // 清理过期
    setTimeout(function(){ delete pairSessions[code]; }, 60000);
    ChatRoomSendLocal('[🎮] '+Player.Name+' 分享玩具配对码: '+code+' (60秒有效)\n对方输入 /toy pair '+code+' 即可连接控制',15000);
    addLog('PairShared','system',0,code);
    updUI();
}

function acceptPairCode(code, sourceName){
    var session=pairSessions[code];
    if(!session){ ChatRoomSendLocal('[🎮] 配对码无效或已过期',5000); return; }
    if(Date.now()>session.expires){ delete pairSessions[code]; ChatRoomSendLocal('[🎮] 配对码已过期',5000); return; }

    // 断开旧配对
    if(pairedPartner){ unpairPartner(); }

    // 连接对方的 WS
    var url=session.wsUrl;
    pairedPartner={name:sourceName, wsUrl:url, limit:session.limit||100, timerId:null, timerEnd:null};

    // 如果有限时
    if(session.timer){
        pairedPartner.timerEnd=Date.now()+session.timer;
        pairedPartner.timerId=setTimeout(function(){ unpairPartner(true); }, session.timer);
    }

    WS.connect(url);
    delete pairSessions[code];
    ChatRoomSendLocal('[🎮] '+sourceName+' 已配对连接 '+Player.Name+' 的玩具! '+
        (pairedPartner.limit<100?'限幅 '+pairedPartner.limit+'% ':'')+
        (pairedPartner.timerEnd?'自动断开: '+new Date(pairedPartner.timerEnd).toLocaleTimeString():''),15000);
    addLog('Paired','system',0,sourceName);
    updUI();
    saveS(loadS());
}

function unpairPartner(silent){
    if(!pairedPartner)return;
    if(pairedPartner.timerId)clearTimeout(pairedPartner.timerId);
    var name=pairedPartner.name;
    WS.close(pairedPartner.wsUrl);
    pairedPartner=null;
    if(!silent) ChatRoomSendLocal('[🎮] 配对已断开，'+name+' 不再控制你的玩具',8000);
    addLog('Unpaired','system',0,name);
    updUI();
    saveS(loadS());
}

function sendPairedIntensity(intensity){
    if(!pairedPartner)return false;
    // 检查限幅
    var capped=Math.min(intensity, pairedPartner.limit);
    WS.sendFA('toyEvent',[
        ['assetGroupName','ItemVulva'],
        ['level',Math.round(capped/20)],
        ['itemName','PairedControl']
    ]);
    curIntensity=capped;
    toyMap['paired']=capped;
    addLog('Partner', 'paired', capped, pairedPartner.name);
    updUI();
    maybeBroadcast();
    return true;
}
function sDict(msg,tag,sub){ if(!msg||!Array.isArray(msg.Dictionary))return null; for(var i=0;i<msg.Dictionary.length;i++){ var k=Object.keys(msg.Dictionary[i]),v=Object.values(msg.Dictionary[i]); if(k[0]===tag)return v[0]; var ix=k.indexOf(sub); if(k[0]==='Tag'&&v[0]===tag&&ix>=0)return v[ix]; } return null; }
function pByName(n){ return Player.Appearance.find(function(d){ return d.Asset.Name===n; }); }
function pBySlot(n){ return Player.Appearance.find(function(d){ return d.Asset.DynamicGroupName===n; }); }
function getSKL(d){ switch(d.Content){ case 'TriggerShock0':return 0;case 'TriggerShock1':return 1;case 'TriggerShock2':return 2;default:return -1; } }
function esc(s){ if(!s)return''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function log(m){ console.log('['+SHORT+'] '+m); }

// ==================== UI ====================
var panelVis=true, dragging=false, dgT=null, dgOX=0, dgOY=0;

function createUI(){
    // icon
    var ic=document.createElement('div'); ic.id='bcp-icon'; ic.innerHTML='🎮';
    ic.title='XToys 遥控面板';
    ic.style.cssText='position:fixed;z-index:999990;width:48px;height:48px;background:linear-gradient(135deg,#d32f2f,#b71c1c);border:3px solid #4a0000;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.4),inset 0 2px 0 rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;transition:transform .15s;user-select:none;-webkit-user-select:none;';
    ic.onmouseenter=function(){ this.style.transform='scale(1.12)'; };
    ic.onmouseleave=function(){ this.style.transform='scale(1)'; };
    ic.onmousedown=function(e){ if(e.button===0){ dgOX=e.clientX-ic.getBoundingClientRect().left; dgOY=e.clientY-ic.getBoundingClientRect().top; dgT=ic; } };
    ic.onclick=function(e){ if(!dragging)tgPanel(); dragging=false; };
    document.body.appendChild(ic);

    // panel
    var p=document.createElement('div'); p.id='bcp-panel';
    p.style.cssText='position:fixed;z-index:999991;width:270px;background:#18181e;border:2px solid #c62828;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.55);font:12px "Segoe UI","Microsoft YaHei",sans-serif;color:#ccc;overflow:hidden;user-select:none;-webkit-user-select:none;';
    p.innerHTML =
    '<div id="bcp-title" style="background:#1a1a22;padding:8px 10px;cursor:move;display:flex;align-items:center;gap:8px;border-bottom:1px solid #333;">'+
        '<span style="font-size:16px;">🎮</span><b style="color:#ff5252;">XToys 遥控</b>'+
        '<span id="bcp-dot" style="margin-left:auto;width:8px;height:8px;border-radius:50%;background:#f44336;box-shadow:0 0 6px #f44336;"></span>'+
        '<button id="bcp-min" style="background:none;border:1px solid #555;color:#999;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:14px;line-height:1;padding:0;">_</button></div>'+
    '<div id="bcp-body" style="padding:10px;">'+
        // Webhook
        '<div style="margin-bottom:8px;"><div style="font-size:10px;color:#888;margin-bottom:3px;">Webhook</div>'+
            '<div style="display:flex;gap:4px;"><input id="bcp-input" placeholder="输入 ID 或 ws://..." style="flex:1;padding:5px 7px;background:#111;border:1px solid #444;border-radius:4px;color:#ddd;font-size:11px;outline:none;"><button id="bcp-conn" style="padding:5px 10px;background:#c62828;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer;white-space:nowrap;">连接</button></div></div>'+
        // 强度条
        '<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span style="font-size:10px;color:#888;">实时强度</span><span id="bcp-intval" style="font-size:12px;color:#4caf50;font-weight:700;">0%</span></div>'+
            '<div style="height:8px;background:#222;border-radius:4px;overflow:hidden;border:1px solid #333;"><div id="bcp-bar" style="height:100%;width:0%;background:#4caf50;border-radius:4px;transition:width .3s;"></div></div></div>'+
        // 快捷预设
        '<div style="margin-bottom:8px;"><div style="font-size:10px;color:#888;margin-bottom:3px;">快捷预设</div>'+
            '<div style="display:flex;gap:4px;">'+
                '<button class="bcp-preset" data-v="0" style="flex:1;padding:4px 0;background:#333;border:1px solid #555;border-radius:4px;color:#aaa;font-size:9px;cursor:pointer;">💤 停</button>'+
                '<button class="bcp-preset" data-v="25" style="flex:1;padding:4px 0;background:#1b3a1b;border:1px solid #2e7d32;border-radius:4px;color:#8bc34a;font-size:9px;cursor:pointer;">🌱 弱</button>'+
                '<button class="bcp-preset" data-v="50" style="flex:1;padding:4px 0;background:#2a2a10;border:1px solid #f57f17;border-radius:4px;color:#ffc107;font-size:9px;cursor:pointer;">🔥 中</button>'+
                '<button class="bcp-preset" data-v="80" style="flex:1;padding:4px 0;background:#2a1010;border:1px solid #c62828;border-radius:4px;color:#ff5252;font-size:9px;cursor:pointer;">💥 强</button>'+
                '<button class="bcp-preset" data-v="100" style="flex:1;padding:4px 0;background:#3a0000;border:1px solid #d50000;border-radius:4px;color:#ff1744;font-size:9px;cursor:pointer;">🚨 满</button>'+
            '</div></div>'+
        // 手动滑块
        '<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span style="font-size:10px;color:#888;">手动调节</span><span id="bcp-manval" style="font-size:10px;color:#aaa;">50%</span></div>'+
            '<input id="bcp-slider" type="range" min="0" max="100" value="50" style="width:100%;height:4px;-webkit-appearance:none;appearance:none;background:#333;border-radius:2px;outline:none;accent-color:#ff5252;cursor:pointer;">'+
            '<div style="display:flex;gap:4px;margin-top:3px;"><button id="bcp-apply" style="flex:1;padding:4px;background:#2e7d32;border:none;border-radius:4px;color:#fff;font-size:10px;cursor:pointer;">应用</button><button id="bcp-zero" style="flex:1;padding:4px;background:#333;border:1px solid #555;border-radius:4px;color:#ff5252;font-size:10px;cursor:pointer;">归零</button></div></div>'+
        // 开关行
        '<div style="margin-bottom:8px;display:flex;gap:8px;">'+
            '<div style="flex:1;display:flex;align-items:center;gap:4px;"><span style="font-size:10px;color:#888;">远程控制</span><button id="bcp-remote" style="padding:2px 8px;background:#2e7d32;border:none;border-radius:3px;color:#fff;font-size:9px;cursor:pointer;">开</button></div>'+
            '<div style="flex:1;display:flex;align-items:center;gap:4px;"><span style="font-size:10px;color:#888;">状态广播</span><button id="bcp-bcast" style="padding:2px 8px;background:#2e7d32;border:none;border-radius:3px;color:#fff;font-size:9px;cursor:pointer;">开</button></div>'+
        '</div>'+
        // 配对控制
        '<div style="margin-bottom:8px;background:#111;border-radius:6px;padding:8px;border:1px solid #333;">'+
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'+
                '<span style="font-size:10px;color:#ff9800;">🔗 配对控制</span>'+
                '<span id="bcp-pair-status" style="font-size:9px;color:#888;">未配对</span></div>'+
            '<div style="display:flex;gap:4px;margin-bottom:4px;">'+
                '<button id="bcp-pair-share" style="flex:1;padding:4px;background:#e65100;border:none;border-radius:4px;color:#fff;font-size:9px;cursor:pointer;">分享配对码</button>'+
                '<button id="bcp-pair-stop" style="flex:1;padding:4px;background:#333;border:1px solid #555;border-radius:4px;color:#ff5252;font-size:9px;cursor:pointer;">断开配对</button></div>'+
            '<div style="display:flex;align-items:center;gap:4px;">'+
                '<span style="font-size:9px;color:#888;">限幅:</span>'+
                '<input id="bcp-pair-limit" type="range" min="10" max="100" value="100" style="flex:1;height:4px;-webkit-appearance:none;appearance:none;background:#333;border-radius:2px;outline:none;accent-color:#ff9800;cursor:pointer;">'+
                '<span id="bcp-pair-limit-val" style="font-size:9px;color:#ff9800;">100%</span></div>'+
        '</div>'+
        // 波形控制
        '<div style="margin-bottom:8px;background:#111;border-radius:6px;padding:8px;border:1px solid #333;">'+
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'+
                '<span style="font-size:10px;color:#4fc3f7;">🌊 波形</span>'+
                '<span id="bcp-wave-status" style="font-size:9px;color:#888;">停止</span></div>'+
            '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-bottom:4px;">'+
                '<button class="bcp-wave-btn" data-w="sine" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">正弦</button>'+
                '<button class="bcp-wave-btn" data-w="square" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">方波</button>'+
                '<button class="bcp-wave-btn" data-w="heartbeat" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">心跳</button>'+
                '<button class="bcp-wave-btn" data-w="tease" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">挑逗</button>'+
                '<button class="bcp-wave-btn" data-w="crescendo" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">渐强</button>'+
                '<button class="bcp-wave-btn" data-w="turbulence" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">湍流</button>'+
                '<button id="bcp-wave-stop" style="padding:3px 6px;background:#333;border:1px solid #c62828;border-radius:3px;color:#ff5252;font-size:8px;cursor:pointer;">停止</button></div>'+
            '<div style="display:flex;gap:4px;align-items:center;">'+
                '<span style="font-size:8px;color:#888;">范围</span>'+
                '<input id="bcp-wave-min" type="number" min="0" max="90" value="10" style="width:38px;padding:2px 4px;background:#111;border:1px solid #444;border-radius:3px;color:#ddd;font-size:9px;">'+
                '<span style="font-size:8px;color:#888;">-</span>'+
                '<input id="bcp-wave-max" type="number" min="10" max="100" value="80" style="width:38px;padding:2px 4px;background:#111;border:1px solid #444;border-radius:3px;color:#ddd;font-size:9px;">'+
                '<span style="font-size:8px;color:#888;">%</span>'+
                '<span style="font-size:8px;color:#888;">速度</span>'+
                '<select id="bcp-wave-spd" style="padding:2px;background:#111;border:1px solid #444;border-radius:3px;color:#ddd;font-size:8px;">'+
                    '<option value="1000">快</option><option value="2000" selected>中</option><option value="4000">慢</option><option value="8000">缓</option></select></div>'+
        '</div>'+
        // 游戏按钮
        '<div style="margin-bottom:8px;background:#111;border-radius:6px;padding:8px;border:1px solid #333;">'+
            '<div style="font-size:10px;color:#ffd54f;margin-bottom:4px;">🎲 聊天游戏</div>'+
            '<div style="display:flex;gap:3px;flex-wrap:wrap;">'+
                '<button class="bcp-game-btn" data-g="roulette" style="padding:3px 6px;background:#2a1010;border:1px solid #c62828;border-radius:3px;color:#ff5252;font-size:8px;cursor:pointer;">🎰 轮盘</button>'+
                '<button class="bcp-game-btn" data-g="dice" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">🎲 骰子</button>'+
                '<button class="bcp-game-btn" data-g="guess" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">❓ 猜谜</button>'+
                '<button class="bcp-game-btn" data-g="mine" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">💣 地雷</button>'+
                '<button class="bcp-game-btn" data-g="vote" style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">🗳️ 投票</button></div>'+
        '</div>'+
        // 剧本控制
        '<div style="margin-bottom:8px;background:#111;border-radius:6px;padding:8px;border:1px solid #333;">'+
            '<div style="font-size:10px;color:#ce93d8;margin-bottom:4px;">📜 剧本/定时</div>'+
            '<div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">'+
                '<span style="font-size:8px;color:#888;">目标</span>'+
                '<input id="bcp-script-target" type="number" min="0" max="100" value="80" style="width:40px;padding:2px 4px;background:#111;border:1px solid #444;border-radius:3px;color:#ddd;font-size:9px;">'+
                '<span style="font-size:8px;color:#888;">% 时长</span>'+
                '<input id="bcp-script-sec" type="number" min="5" max="300" value="30" style="width:38px;padding:2px 4px;background:#111;border:1px solid #444;border-radius:3px;color:#ddd;font-size:9px;">'+
                '<span style="font-size:8px;color:#888;">秒</span></div>'+
            '<div style="display:flex;gap:4px;">'+
                '<button id="bcp-ramp-go" style="flex:1;padding:4px;background:#6a1b9a;border:none;border-radius:4px;color:#fff;font-size:9px;cursor:pointer;">▶ 渐强</button>'+
                '<button id="bcp-timer-go" style="flex:1;padding:4px;background:#4527a0;border:none;border-radius:4px;color:#fff;font-size:9px;cursor:pointer;">⏱ 定时器</button>'+
                '<button id="bcp-script-stop" style="flex:1;padding:4px;background:#333;border:1px solid #555;border-radius:4px;color:#ff5252;font-size:9px;cursor:pointer;">停止</button></div>'+
        '</div>'+
        // 最近事件
        '<div><div style="font-size:10px;color:#888;margin-bottom:3px;">事件记录</div>'+
            '<div id="bcp-log" style="height:100px;overflow-y:auto;font-size:9px;color:#999;background:#0c0c14;border-radius:4px;padding:5px;border:1px solid #222;">等待游戏事件...</div></div>'+
    '</div>';
    document.body.appendChild(p);

    // drag
    document.getElementById('bcp-title').onmousedown=function(e){ if(e.target.tagName==='BUTTON')return; if(e.button!==0)return; dgT=p; dgOX=e.clientX-p.getBoundingClientRect().left; dgOY=e.clientY-p.getBoundingClientRect().top; };
    document.addEventListener('mousemove',function(e){ if(!dgT)return; dragging=true;
        var nx=Math.max(0,Math.min(e.clientX-dgOX,window.innerWidth-dgT.offsetWidth)),ny=Math.max(0,Math.min(e.clientY-dgOY,window.innerHeight-dgT.offsetHeight));
        dgT.style.left=nx+'px'; dgT.style.top=ny+'px'; dgT.style.right='auto'; dgT.style.bottom='auto';
        if(dgT===p){ ic.style.left=(nx+5)+'px'; ic.style.top=(ny-55)+'px'; ic.style.right='auto'; ic.style.bottom='auto'; }
    });
    document.addEventListener('mouseup',function(){ if(dragging)savePos(); dgT=null; dragging=false; });

    // events
    document.getElementById('bcp-conn').onclick=function(){
        var val=document.getElementById('bcp-input').value.trim(); if(!val)return;
        var url=/^wss?:\/\//i.test(val)?val:'wss://webhook.xtoys.app/'+val;
        if(WS.hasConn(url)){ WS.close(url); this.textContent='连接'; refDot(); }
        else { WS.connect(url); this.textContent='断开'; refDot(); }
    };
    document.getElementById('bcp-min').onclick=function(){ tgPanel(); };
    document.getElementById('bcp-slider').oninput=function(){ document.getElementById('bcp-manval').textContent=this.value+'%'; };
    document.getElementById('bcp-apply').onclick=function(){
        var v=parseInt(document.getElementById('bcp-slider').value);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(v/20)],['itemName','ManualControl']]);
        curIntensity=v; toyMap['manual']=v; addLog('Manual','ItemVulva',v,'Self'); updUI(); maybeBroadcast();
    };
    document.getElementById('bcp-zero').onclick=function(){
        document.getElementById('bcp-slider').value=0; document.getElementById('bcp-manval').textContent='0%';
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',0],['itemName','ManualControl']]);
        curIntensity=0; toyMap={}; addLog('Stop','all',0,'Self'); updUI();
    };
    document.getElementById('bcp-remote').onclick=function(){
        remoteAllow=!remoteAllow;
        this.textContent=remoteAllow?'开':'关';
        this.style.background=remoteAllow?'#2e7d32':'#555';
        var s=loadS(); s.remoteAllow=remoteAllow; saveS(s);
    };
    document.getElementById('bcp-bcast').onclick=function(){
        broadcastOn=!broadcastOn;
        this.textContent=broadcastOn?'开':'关';
        this.style.background=broadcastOn?'#2e7d32':'#555';
        var s=loadS(); s.broadcastOn=broadcastOn; saveS(s);
    };

    // 配对按钮
    document.getElementById('bcp-pair-share').onclick=function(){ sharePairCode(); };
    document.getElementById('bcp-pair-stop').onclick=function(){ unpairPartner(); };
    var pairLimitSlider=document.getElementById('bcp-pair-limit');
    pairLimitSlider.oninput=function(){ document.getElementById('bcp-pair-limit-val').textContent=this.value+'%'; pairLimitMax=parseInt(this.value); };
    // 输入配对码：双击配对码区域弹出输入框
    document.getElementById('bcp-pair-status').ondblclick=function(){
        var code=prompt('输入对方分享的配对码 (6位):');
        if(code&&code.length===6){
            var msg={Content:'/toy pair '+code.trim().toUpperCase(), Type:'Chat', SenderName:Player.Name};
            handleChatCommands(msg);
        }
    };

    // 波形按钮
    var wbs=document.getElementsByClassName('bcp-wave-btn');
    for(var i=0;i<wbs.length;i++){ wbs[i].onclick=function(){
        var wt=this.getAttribute('data-w'), mn=parseInt(document.getElementById('bcp-wave-min').value)||10, mx=parseInt(document.getElementById('bcp-wave-max').value)||80, sp=parseInt(document.getElementById('bcp-wave-spd').value)||2000;
        startWave(wt,mn,mx,sp);
        var ws=document.getElementById('bcp-wave-status'); if(ws){ ws.textContent=WAVES[wt]?WAVES[wt].name:'运行中'; ws.style.color='#4fc3f7'; }
    }; }
    document.getElementById('bcp-wave-stop').onclick=function(){ stopWave(); var ws=document.getElementById('bcp-wave-status'); if(ws){ ws.textContent='停止'; ws.style.color='#888'; } };

    // 游戏按钮
    var gbs=document.getElementsByClassName('bcp-game-btn');
    for(var i=0;i<gbs.length;i++){ gbs[i].onclick=function(){
        var gt=this.getAttribute('data-g');
        if(gt==='roulette'){ gameRoulette(Player.Name); }
        else if(gt==='dice'){ gameDice(Player.Name,2); }
        else if(gt==='guess'){ var g=parseInt(prompt('猜 1-100 的数字:')); if(g>=1&&g<=100)gameGuess(Player.Name,g); }
        else if(gt==='mine'){ var m=parseInt(prompt('选格子 1-10:')); if(m>=1&&m<=10)gameMine(Player.Name,m); }
        else if(gt==='vote'){ var v=parseInt(prompt('投票强度 0-100:')); if(v>=0&&v<=100)gameVote(Player.Name,v); }
    }; }

    // 剧本按钮
    document.getElementById('bcp-ramp-go').onclick=function(){ var t=parseInt(document.getElementById('bcp-script-target').value)||80, s=parseInt(document.getElementById('bcp-script-sec').value)||30; scriptRamp(t,s); };
    document.getElementById('bcp-timer-go').onclick=function(){ var t=parseInt(document.getElementById('bcp-script-target').value)||80, s=parseInt(document.getElementById('bcp-script-sec').value)||30; scriptTimer(Math.ceil(s/60)||1,t); };
    document.getElementById('bcp-script-stop').onclick=function(){ if(scriptTimerId)clearInterval(scriptTimerId); scriptTimerId=null; ChatRoomSendLocal('[📜] 剧本已停止',5000); };

    // preset buttons
    var pbs=document.getElementsByClassName('bcp-preset');
    for(var i=0;i<pbs.length;i++){ pbs[i].onclick=function(){
        var v=parseInt(this.getAttribute('data-v'));
        document.getElementById('bcp-slider').value=v; document.getElementById('bcp-manval').textContent=v+'%';
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(v/20)],['itemName','PresetControl']]);
        curIntensity=v; toyMap['preset']=v; addLog('Preset','ItemVulva',v,'Self'); updUI(); maybeBroadcast();
    }; }

    restorePos();
    // restore saved settings
    var s=loadS();
    remoteAllow = s.remoteAllow !== false;
    broadcastOn = s.broadcastOn !== false;
    whitelist = Array.isArray(s.whitelist) ? s.whitelist : [];
    var rb=document.getElementById('bcp-remote'), bb=document.getElementById('bcp-bcast');
    if(rb){ rb.textContent=remoteAllow?'开':'关'; rb.style.background=remoteAllow?'#2e7d32':'#555'; }
    if(bb){ bb.textContent=broadcastOn?'开':'关'; bb.style.background=broadcastOn?'#2e7d32':'#555'; }
}

function tgPanel(){ panelVis=!panelVis; var p=document.getElementById('bcp-panel'); if(p)p.style.display=panelVis?'block':'none'; savePos(); }
function savePos(){ var s=loadS(); var ic=document.getElementById('bcp-icon'),p=document.getElementById('bcp-panel');
    if(ic){ s.ix=parseInt(ic.style.left)||ic.getBoundingClientRect().left; s.iy=parseInt(ic.style.top)||ic.getBoundingClientRect().top; }
    if(p){ s.px=parseInt(p.style.left)||p.getBoundingClientRect().left; s.py=parseInt(p.style.top)||p.getBoundingClientRect().top; }
    s.vis=panelVis; s.remoteAllow=remoteAllow; s.broadcastOn=broadcastOn; s.whitelist=whitelist; saveS(s); }
function restorePos(){ var s=loadS(); var ic=document.getElementById('bcp-icon'),p=document.getElementById('bcp-panel');
    var ix=(s.ix>=0&&s.ix<window.innerWidth)?s.ix:window.innerWidth-65,iy=(s.iy>=0&&s.iy<window.innerHeight)?s.iy:window.innerHeight-80;
    ic.style.left=ix+'px'; ic.style.top=iy+'px'; ic.style.right='auto'; ic.style.bottom='auto';
    p.style.left=((s.px>=0)?s.px:ix-270)+'px'; p.style.top=((s.py>=0)?s.py:iy-5)+'px'; p.style.right='auto'; p.style.bottom='auto';
    panelVis=s.vis!==false; p.style.display=panelVis?'block':'none'; }
function refDot(){ var d=document.getElementById('bcp-dot'); if(!d)return; if(WS.hasAnyConn()){ d.style.background='#4caf50'; d.style.boxShadow='0 0 8px #4caf50'; } else { d.style.background='#f44336'; d.style.boxShadow='0 0 6px #f44336'; } }
function updUI(){
    var bar=document.getElementById('bcp-bar'),val=document.getElementById('bcp-intval');
    if(bar&&val){ bar.style.width=curIntensity+'%'; val.textContent=curIntensity+'%';
        var c=curIntensity<30?'#4caf50':curIntensity<60?'#ff9800':'#f44336'; bar.style.background=c; val.style.color=c; }
    refDot();
    // 配对状态
    var ps=document.getElementById('bcp-pair-status');
    if(ps){
        if(pairedPartner){
            var limitTxt=pairedPartner.limit<100?' [限'+pairedPartner.limit+'%]':'';
            ps.textContent='已配对: '+pairedPartner.name+limitTxt;
            ps.style.color='#ff9800';
        } else {
            ps.textContent='未配对';
            ps.style.color='#888';
        }
    }
    var log=document.getElementById('bcp-log'); if(!log)return;
    if(actLog.length===0){ log.innerHTML='<span style="color:#555;">等待游戏事件...</span>'; return; }
    var h='';
    for(var i=0;i<Math.min(8,actLog.length);i++){
        var a=actLog[i],cl=a.intensity<30?'#8bc34a':a.intensity<60?'#ffc107':'#ff5722';
        h+='<div style="display:flex;justify-content:space-between;margin-bottom:1px;">'+
            '<span>'+esc(a.action)+(a.slot?' @'+esc(a.slot):'')+(a.who?' by '+esc(a.who):'')+'</span>'+
            '<span style="color:'+cl+';font-weight:600;">'+a.intensity+'%</span></div>';
    }
    log.innerHTML=h;
}

// ==================== 波形引擎 ====================
const WAVES = {
    sine: {name:'正弦波 🌊', desc:'平滑呼吸式起伏', fn:function(t,min,max,spd){ var p=Math.sin(t*spd/1000*Math.PI*2); return min+(max-min)*(p+1)/2; }},
    square: {name:'方波 ⏹️', desc:'开关交替脉冲', fn:function(t,min,max,spd){ return (Math.floor(t/spd*1000)%2===0)?max:min; }},
    triangle: {name:'三角波 📐', desc:'直线升降', fn:function(t,min,max,spd){ var p=(t/spd*1000)%2000/1000; return min+(max-min)*(p<1?p:2-p); }},
    sawtooth: {name:'锯齿波 🪚', desc:'慢升瞬降', fn:function(t,min,max,spd){ return min+(max-min)*((t/spd*1000)%1000/1000); }},
    heartbeat: {name:'心跳 💓', desc:'咚咚双脉冲', fn:function(t,min,max,spd){ var p=t/spd*1000%2000; if(p<200)return max; if(p<400)return min; if(p<600)return max; return min; }},
    tease: {name:'挑逗 😈', desc:'反复边缘', fn:function(t,min,max,spd){ var p=Math.sin(t*spd/500*Math.PI*2); var v=min+(max-min)*(p+1)/2; return v>max*0.8?min+Math.random()*20:v; }},
    turbulence: {name:'湍流 🌪️', desc:'随机漫步', fn:function(t,min,max,spd){ var r=Math.random(); var mid=(max+min)/2; return mid+(r-0.5)*(max-min); }},
    crescendo: {name:'渐强 🎵', desc:'阶梯增强', fn:function(t,min,max,spd){ var cyc=t/spd*1000%1000/1000; return min+(max-min)*Math.pow(cyc,2); }}
};

function startWave(type,min,max,speed){
    stopWave();
    var w=WAVES[type]; if(!w)return;
    var t0=Date.now();
    waveRunning={type:type,min:min,max:max,speed:speed||2000,start:t0};
    waveTimerId=setInterval(function(){
        if(!waveRunning)return;
        var elapsed=Date.now()-waveRunning.start;
        var v=Math.round(w.fn(elapsed,waveRunning.min,waveRunning.max,waveRunning.speed));
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(v/20)],['itemName','Wave_'+type]]);
        curIntensity=v; toyMap['wave']=v;
        updUI(); maybeBroadcast();
    },200);
    ChatRoomSendLocal('[🌊] 启动波形: '+w.name+' 范围 '+min+'%-'+max+'%',8000);
    addLog('Wave:'+w.name,'wave',(max+min)/2,'');
}

function stopWave(){
    if(waveTimerId)clearInterval(waveTimerId); waveTimerId=null;
    if(waveRunning){ ChatRoomSendLocal('[🌊] 波形已停止',5000); }
    waveRunning=null;
}

function sendWaveIntensity(v){
    WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(v/20)],['itemName','WaveManual']]);
    curIntensity=v; toyMap['wave']=v; updUI(); maybeBroadcast();
}

// ==================== 聊天小游戏 ====================
function gameRoulette(sourceName){
    var slots=[10,20,30,50,70,100]; var r=Math.floor(Math.random()*slots.length);
    var v=slots[r]; var msgs=['转...','转...','转...'];
    ChatRoomSendLocal('[🎰] '+sourceName+' 玩俄罗斯轮盘!',5000);
    var idx=0;
    var tid=setInterval(function(){
        if(idx<msgs.length){ ChatRoomSendLocal('[🎰] '+msgs[idx],2000); idx++; }
        else { clearInterval(tid); ChatRoomSendLocal('[🎰] 💥 中了! '+v+'%!',8000);
            WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(v/20)],['itemName','Roulette']]);
            curIntensity=v; toyMap['game']=v; addLog('Roulette','game',v,sourceName); updUI(); maybeBroadcast(); }
    },800);
}

function gameDice(sourceName, count){
    count=Math.max(1,Math.min(5,count||1));
    var total=0, rolls=[];
    for(var i=0;i<count;i++){ var r=Math.floor(Math.random()*6)+1; total+=r; rolls.push(r); }
    var v=Math.min(100,total*(100/(count*6/2))); v=Math.round(v/5)*5;
    ChatRoomSendLocal('[🎲] '+sourceName+' 掷 '+count+' 个骰子: '+rolls.join('+')+'='+total+' → '+v+'%',10000);
    WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(v/20)],['itemName','Dice']]);
    curIntensity=v; toyMap['game']=v; addLog('Dice','game',v,sourceName); updUI(); maybeBroadcast();
}

function gameGuess(sourceName, guess){
    if(guessTarget===0) guessTarget=Math.floor(Math.random()*90)+10;
    if(guess===guessTarget){
        ChatRoomSendLocal('[❓] '+sourceName+' 猜中了! '+guessTarget+'% → 归零!',8000);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',0],['itemName','GuessWin']]);
        curIntensity=0; toyMap={}; addLog('GuessWin','game',0,sourceName); guessTarget=0;
    } else {
        var hint=guess>guessTarget?'高了':'低了';
        curIntensity=Math.min(100,curIntensity+10);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(curIntensity/20)],['itemName','GuessFail']]);
        ChatRoomSendLocal('[❓] '+sourceName+' 猜 '+guess+' → '+hint+'! 强度 +10% → '+curIntensity+'%',8000);
        addLog('Guess:'+guess,'game',curIntensity,sourceName);
    }
    updUI(); maybeBroadcast();
}

function gameMine(sourceName, pick){
    var key=sourceName.toLowerCase();
    if(!mineMap[key]) mineMap[key]={mines:[],found:[]};
    var m=mineMap[key];
    if(m.mines.length===0){
        var pool=[]; for(var i=1;i<=10;i++)pool.push(i);
        for(var i=0;i<3;i++){ var ri=Math.floor(Math.random()*pool.length); m.mines.push(pool.splice(ri,1)[0]); }
        m.found=[];
    }
    pick=Math.max(1,Math.min(10,pick));
    var already=m.found.indexOf(pick)>=0;
    if(!already)m.found.push(pick);
    if(m.mines.indexOf(pick)>=0){
        ChatRoomSendLocal('[💣] '+sourceName+' 踩雷! 💥 100%!',8000);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',5],['itemName','MineExplode']]);
        curIntensity=100; toyMap['game']=100; addLog('MineBoom','game',100,sourceName);
        delete mineMap[key];
    } else {
        var safe=10-m.found.length;
        ChatRoomSendLocal('[💣] '+sourceName+' 格子 '+pick+' 安全 ('+safe+'个剩余)',5000);
        addLog('MineSafe:'+pick,'game',curIntensity,sourceName);
    }
    updUI(); maybeBroadcast();
}

function gameVote(sourceName, intensity){
    voteBox[sourceName]=Math.max(0,Math.min(100,intensity));
    var sum=0,cnt=0; var ks=Object.keys(voteBox);
    for(var i=0;i<ks.length;i++){ sum+=voteBox[ks[i]]; cnt++; }
    if(cnt>=2){ var avg=Math.round(sum/cnt);
        ChatRoomSendLocal('[🗳️] 投票: '+cnt+'人 平均 '+avg+'%',5000);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(avg/20)],['itemName','Vote']]);
        curIntensity=avg; toyMap['game']=avg; addLog('Vote avg','game',avg,'');
        updUI(); maybeBroadcast();
    }
    // 30秒后重置
    setTimeout(function(){ voteBox={}; },30000);
}

// ==================== 定时/剧本模式 ====================
function scriptRamp(targetPct, durationSec){
    if(scriptTimerId)clearInterval(scriptTimerId);
    var startPct=curIntensity, steps=Math.round(durationSec*5), step=0;
    ChatRoomSendLocal('[📜] 剧本: '+startPct+'% → '+targetPct+'% 用时 '+durationSec+'秒',8000);
    scriptTimerId=setInterval(function(){
        step++; var p=Math.min(1,step/steps);
        var v=Math.round(startPct+(targetPct-startPct)*p);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(v/20)],['itemName','Script']]);
        curIntensity=v; toyMap['script']=v; updUI(); maybeBroadcast();
        if(step>=steps){ clearInterval(scriptTimerId); scriptTimerId=null; ChatRoomSendLocal('[📜] 剧本完成: '+targetPct+'%',5000); }
    },200);
}

function scriptTimer(minutes, targetPct){
    ChatRoomSendLocal('[⏱️] 定时器: '+minutes+'分钟后 → '+targetPct+'%',10000);
    setTimeout(function(){
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(targetPct/20)],['itemName','Timer']]);
        curIntensity=targetPct; toyMap['timer']=targetPct;
        addLog('Timer','timer',targetPct,''); updUI(); maybeBroadcast();
        ChatRoomSendLocal('[⏱️] 时间到! 强度 → '+targetPct+'%',8000);
    },minutes*60000);
}

// ==================== 自动强度响应 ====================
function checkAutoResponse(actionName, bodyPart){
    var keys=Object.keys(autoResponseMap);
    for(var i=0;i<keys.length;i++){
        var rule=autoResponseMap[keys[i]];
        if(rule.actions.indexOf(actionName)>=0 && (rule.parts.indexOf(bodyPart)>=0 || rule.parts.indexOf('*')>=0)){
            if(rule.wave) startWave(rule.wave, rule.min||10, rule.max||curIntensity, rule.speed||2000);
            else { WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',Math.round(rule.intensity/20)],['itemName','AutoResp']]);
                curIntensity=rule.intensity; toyMap['autoResp']=rule.intensity; } updUI(); maybeBroadcast(); addLog('AutoResp:'+actionName,bodyPart,rule.intensity||curIntensity,'');
            return;
        }
    }
}

// 预设自动响应规则
autoResponseMap['orgasm']={actions:['Orgasm','RuinedOrgasm','EdgeExplode'],parts:['*'],wave:'turbulence',min:60,max:100,speed:3000};
autoResponseMap['spankHard']={actions:['Spank','SpankItem','Slap','Kick'],parts:['ItemButt','ItemVulva'],intensity:70};
autoResponseMap['kissDeep']={actions:['FrenchKiss','Kiss','Lick','Nibble','Bite'],parts:['ItemMouth','ItemEar'],intensity:40};

// ==================== 聊天命令解析 ====================
function handleChatCommands(data){
    if(!data||!data.Content||data.Type!=='Chat')return false;
    var msg = data.Content.trim();
    if(!msg||msg.indexOf('/toy')!==0)return false;

    var sourceName = data.SenderName || sDict(data,'SourceCharacter','Name') || 'Unknown';
    var parts = msg.split(/\s+/); // ['/toy', 'subcommand', ...]

    if(parts.length<2){
        // /toy alone → show help
        ChatRoomSendLocal('[🎮] /toy <0-100> 设置强度 | /toy info | /toy pair 配对 | /toy allow|block <名> | /toy remote on|off | /toy broadcast on|off',15000);
        return true;
    }

    var sub = parts[1].toLowerCase();

    // /toy <number> — 远程控制强度
    if(/^\d+$/.test(sub)){
        var intensity = parseInt(sub);
        handleRemoteCommand(sourceName, intensity);
        return true;
    }

    // /toy info — 显示当前状态
    if(sub==='info'){
        var s=loadS();
        var wl=s.whitelist||[];
        ChatRoomSendLocal('[🎮] '+Player.Name+' 的玩具状态:\n强度: '+curIntensity+'% '+intensityEmoji(curIntensity)+
            '\nWebSocket: '+(WS.hasAnyConn()?'已连接 ('+WS.getConns().length+')':'未连接')+
            '\n远程控制: '+(remoteAllow?'开启':'关闭')+
            '\n广播: '+(broadcastOn?'开启':'关闭')+
            '\n白名单: '+(wl.length>0?wl.join(', '):'无 (所有人可控制)'),20000);
        return true;
    }

    // /toy allow <name> — 添加白名单
    if(sub==='allow'&&parts.length>=3){
        var nm=parts.slice(2).join(' ');
        var found=false;
        for(var i=0;i<whitelist.length;i++){ if(whitelist[i].toLowerCase()===nm.toLowerCase()){ found=true; break; } }
        if(!found){ whitelist.push(nm); savePos(); }
        ChatRoomSendLocal('[🎮] 白名单已更新: '+(whitelist.length>0?whitelist.join(', '):'无 (所有人可控制)'),10000);
        return true;
    }

    // /toy block <name> — 移除白名单
    if(sub==='block'&&parts.length>=3){
        var nm=parts.slice(2).join(' ').toLowerCase();
        whitelist = whitelist.filter(function(n){ return n.toLowerCase()!==nm; });
        savePos();
        ChatRoomSendLocal('[🎮] 白名单已更新: '+(whitelist.length>0?whitelist.join(', '):'无 (所有人可控制)'),10000);
        return true;
    }

    // /toy whitelist — 显示白名单
    if(sub==='whitelist'||sub==='list'||sub==='wl'){
        ChatRoomSendLocal('[🎮] 白名单: '+(whitelist.length>0?whitelist.join(', '):'无 (所有人可控制)'),10000);
        return true;
    }

    // /toy remote on/off
    if(sub==='remote'&&parts.length>=3){
        remoteAllow = parts[2].toLowerCase()==='on';
        var rb=document.getElementById('bcp-remote');
        if(rb){ rb.textContent=remoteAllow?'开':'关'; rb.style.background=remoteAllow?'#2e7d32':'#555'; }
        savePos();
        ChatRoomSendLocal('[🎮] 远程控制已'+(remoteAllow?'开启':'关闭'),10000);
        return true;
    }

    // /toy pair — 配对控制
    if(sub==='pair'){
        if(parts.length<3){
            ChatRoomSendLocal('[🎮] 配对命令:\n/toy pair share - 分享配对码\n/toy pair <code> - 输入配对码连接\n/toy pair stop - 断开配对\n/toy pair limit <10-100> - 限幅',15000);
            return true;
        }
        var act=parts[2].toLowerCase();
        if(act==='share'){ sharePairCode(); return true; }
        if(act==='stop'){ unpairPartner(); return true; }
        if(act==='limit'&&parts.length>=4){ var l=parseInt(parts[3]); pairLimitMax=Math.max(10,Math.min(100,l)); var pl=document.getElementById('bcp-pair-limit'); if(pl){ pl.value=pairLimitMax; document.getElementById('bcp-pair-limit-val').textContent=pairLimitMax+'%'; } ChatRoomSendLocal('[🎮] 配对限幅已设为 '+pairLimitMax+'%',8000); saveS(loadS()); return true; }
        // /toy pair <code> — 输入配对码
        if(/^[A-Z2-9]{6}$/i.test(act)){ acceptPairCode(act.toUpperCase(), sourceName); return true; }
        return true;
    }

    // /toy wave — 波形控制
    if(sub==='wave'){
        if(parts.length<3){ var wl=Object.keys(WAVES).map(function(k){ return WAVES[k].name+' (/toy wave '+k+')'; }).join(', ');
            ChatRoomSendLocal('[🌊] 波形: '+wl+'\n用法: /toy wave <类型> <最小> <最大> [速度ms]\n/toy wave stop 停止',15000); return true; }
        var wact=parts[2].toLowerCase();
        if(wact==='stop'){ stopWave(); return true; }
        if(WAVES[wact]){ var mn=parseInt(parts[3])||10, mx=parseInt(parts[4])||80, sp=parseInt(parts[5])||2000; startWave(wact,Math.max(0,mn),Math.min(100,mx),sp); return true; }
        return true;
    }

    // /toy roulette — 轮盘
    if(sub==='roulette'){ gameRoulette(sourceName); return true; }

    // /toy dice [N] — 骰子
    if(sub==='dice'){ var dc=parseInt(parts[2])||1; gameDice(sourceName,dc); return true; }

    // /toy guess <number> — 猜谜
    if(sub==='guess'&&parts.length>=3){ var gs=parseInt(parts[2]); if(gs>=1&&gs<=100)gameGuess(sourceName,gs); return true; }

    // /toy mine <1-10> — 地雷
    if(sub==='mine'&&parts.length>=3){ var pk=parseInt(parts[2]); if(pk>=1&&pk<=10)gameMine(sourceName,pk); return true; }

    // /toy vote <0-100> — 投票
    if(sub==='vote'&&parts.length>=3){ var vt=parseInt(parts[2]); gameVote(sourceName,vt); return true; }

    // /toy ramp <目标> [秒数] — 渐强剧本
    if(sub==='ramp'&&parts.length>=3){ var tp=parseInt(parts[2]), ds=parseInt(parts[3])||30; scriptRamp(Math.max(0,Math.min(100,tp)),ds); return true; }

    // /toy timer <分钟> [强度] — 定时器
    if(sub==='timer'&&parts.length>=3){ var tm=parseInt(parts[2]), ti=parseInt(parts[3])||80; scriptTimer(Math.max(1,tm),Math.max(0,Math.min(100,ti))); return true; }

    // /toy auto — 自动响应规则管理
    if(sub==='auto'){
        if(parts.length<3){ var ar=Object.keys(autoResponseMap).join(', ');
            ChatRoomSendLocal('[🤖] 自动响应规则: '+ar+'\n/toy auto add <名> <强度> <动作1,动作2> <部位1,部位2>\n/toy auto del <名>\n/toy auto off 关闭',15000); return true; }
        if(parts[2]==='off'){ autoResponseMap={}; ChatRoomSendLocal('[🤖] 自动响应已全部关闭',5000); return true; }
        if(parts[2]==='del'&&parts.length>=4){ delete autoResponseMap[parts[3].toLowerCase()]; ChatRoomSendLocal('[🤖] 已删除规则: '+parts[3],5000); return true; }
        if(parts[2]==='add'&&parts.length>=6){ var rn=parts[3].toLowerCase(), ri=parseInt(parts[4]), ra=parts[5].split(','), rp=parts.length>=7?parts[6].split(','):['*'];
            autoResponseMap[rn]={actions:ra,parts:rp,intensity:Math.max(0,Math.min(100,ri))}; ChatRoomSendLocal('[🤖] 已添加规则: '+rn+' 强度'+ri+'% 动作:'+ra.join(',')+' 部位:'+rp.join(','),8000); return true; }
        return true;
    }

    // /toy broadcast on/off
    if(sub==='broadcast'&&parts.length>=3){
        broadcastOn = parts[2].toLowerCase()==='on';
        var bb=document.getElementById('bcp-bcast');
        if(bb){ bb.textContent=broadcastOn?'开':'关'; bb.style.background=broadcastOn?'#2e7d32':'#555'; }
        savePos();
        ChatRoomSendLocal('[🎮] 状态广播已'+(broadcastOn?'开启':'关闭'),10000);
        return true;
    }

    // /toy help
    ChatRoomSendLocal('[🎮] 命令:\n/toy <0-100> 强度 | /toy info 状态\n/toy pair share 分享配对 | /toy pair <码> 连接\n/toy pair limit <10-100> 限幅 | /toy pair stop 断开\n/toy allow|block <名> 白名单 | /toy whitelist\n/toy remote on|off | /toy broadcast on|off',20000);
    return true;
}

// ==================== 主逻辑 ====================
async function main(){
    log('v'+VER+' starting...');

    while(!window.hasOwnProperty('bcModSdk')){ await new Promise(function(r){ setTimeout(r,1000); }); log('waiting for bcModSdk...'); }
    await new Promise(function(r){ var c=function(){ if(typeof ServerIsConnected!=='undefined'&&ServerIsConnected&&typeof ServerSocket!=='undefined'&&typeof Commands!=='undefined')r(); else setTimeout(c,500); }; c(); });

    log('SDK ready');
    var modApi = bcModSdk.registerMod({ name:FULL, fullName:SHORT, version:VER, repository:'https://github.com/QAQMOON/XToys-Config' });

    createUI();
    WS.uiCb=refDot;

    // 服务器重连
    modApi.hookFunction('ServerSetConnected',2,function(args,next){ next(args); if(args[0]===true)WS.connectSaved(); });

    // ===== ChatRoomMessage =====
    function hActivities(data){
        if(data.Type!=='Activity')return;
        var g=sDict(data,'FocusAssetGroup','FocusGroupName'),n=sDict(data,'ActivityName'),a=sDict(data,'ActivityAsset','AssetName');
        var t=sDict(data,'TargetCharacter','MemberNumber'),s=sDict(data,'SourceCharacter','MemberNumber');
        if(!g||!n)return;
        if(t===Player.MemberNumber){ WS.sendFA('activityEvent',[['assetGroupName',g],['actionName',n],['assetName',a]]); addLog(n,g,30,a); checkAutoResponse(n,g); }
        else if(s===Player.MemberNumber){ WS.sendFA('activityOnOtherEvent',[['assetGroupName',g],['actionName',n],['assetName',a]]); }
    }

    function hItemEquip(data){
        if(data.Type!=='Action'||sDict(data,'DestinationCharacter','MemberNumber')!==Player.MemberNumber||sDict(data,'SourceCharacter','MemberNumber')===Player.MemberNumber)return;
        var slot=sDict(data,'FocusAssetGroup','FocusGroupName'); if(!slot)return;
        if(data.Content==='ActionUse'){
            var nm=sDict(data,'NextAsset','AssetName'); if(!nm)return;
            WS.sendFA('itemAdded',[['assetName',nm],['assetGroupName',slot]]);
            var asset=pByName(nm); if(asset)ItemState.updAll(asset);
            addLog('ItemAdded',slot,0,nm);
        } else if(data.Content==='ActionRemove'){
            var pn=sDict(data,'PrevAsset','AssetName'); if(!pn)return;
            WS.sendFA('itemRemoved',[['assetName',pn],['assetGroupName',slot]]);
            ItemState.clearAll(slot);
        }
    }

    function hToyEvents(data){
        if(data.Type!=='Action'||!(sDict(data,'DestinationCharacter','MemberNumber')===Player.MemberNumber||sDict(data,'DestinationCharacterName','MemberNumber')===Player.MemberNumber||sDict(data,'TargetCharacterName','MemberNumber')===Player.MemberNumber))return;
        var an=sDict(data,'AssetName','AssetName'),asset=pByName(an),g=asset&&asset.Asset&&asset.Asset.Group&&asset.Asset.Group.Name;
        if(!g||!asset||!an)return;
        ItemState.updAll(asset); ItemState.sendSK(g,getSKL(data),an);
    }

    ServerSocket.on('ChatRoomMessage',async function(data){
        if(!data||!data.Content||!data.Type||IG_CT.has(data.Content)||IG_TP.has(data.Type))return;
        if(handleChatCommands(data))return; // chat commands take priority
        hActivities(data);
        hItemEquip(data);
        hToyEvents(data);
    });

    // ===== 游戏钩子 =====
    modApi.hookFunction('VibratorModePublish',3,function(args,next){ next(args); if(args[1]&&args[1].MemberNumber===Player.MemberNumber){ var slot=args[2]&&args[2].Asset&&args[2].Asset.DynamicGroupName; if(slot){ var asset=pBySlot(slot); if(asset)ItemState.updAll(asset); } } });
    modApi.hookFunction('ExtendedItemSetOption',7,function(args,next){ next(args); if(args.length>=6&&args[1]&&args[1].MemberNumber===Player.MemberNumber){ var item=args[2]; if(item&&item.Asset&&item.Asset.DynamicGroupName)ItemState.updAll(item); } });
    modApi.hookFunction('InventoryWear',8,function(args,next){ var ret=next(args); if(args[0]&&args[0].MemberNumber===Player.MemberNumber){ var asset=pByName(args[1]); if(asset){ WS.sendFA('itemAdded',[['assetName',asset.Asset.Name],['assetGroupName',asset.Asset.DynamicGroupName]]); ItemState.updAll(asset); } } return ret; });
    modApi.hookFunction('InventoryRemove',3,function(args,next){ if(args[0]&&args[0].MemberNumber===Player.MemberNumber){ var asset=pBySlot(args[1]); if(asset){ WS.sendFA('itemRemoved',[['assetName',asset.Asset.Name],['assetGroupName',asset.Asset.DynamicGroupName]]); ItemState.clearAll(args[1]); } } next(args); });
    modApi.hookFunction('PropertyShockPublishAction',3,function(args,next){ var si=null; if(Array.isArray(args)&&args[1]&&args[1].Property)si=args[1]; else if(typeof DialogFocusItem!=='undefined'&&DialogFocusItem&&DialogFocusItem.Property)si=DialogFocusItem; if(si){ var l=si.Property.ShockLevel; if(l===null||l===undefined)l=1; ItemState.sendSK(si.Asset&&si.Asset.DynamicGroupName,l,si.Asset&&si.Asset.Name); } next(args); });

    // 定时广播
    setInterval(function(){ maybeBroadcast(); }, 8000);

    log('v'+VER+' 已就绪 ✅');
    log('命令: /toy <0-100> | /toy pair share | /toy info | /toy allow|block <名>');
    refDot();
}

main().catch(function(e){ console.error('['+SHORT+'] init error',e); });

})();
