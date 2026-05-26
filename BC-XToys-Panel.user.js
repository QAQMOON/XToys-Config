// ==UserScript==
// @name         BC XToys Control Panel
// @namespace    BC-XToys-Panel
// @version      3.2.1
// @description  BC XToys v3.2: 身体反馈+波形+配对+剧本+自动响应+广播+白名单+游戏内设置面板
// @author       QAQMOON
// @match        https://bondageprojects.elementfx.com/*
// @match        https://www.bondageprojects.elementfx.com/*
// @match        https://bondage-europe.com/*
// @match        https://www.bondage-europe.com/*
// @match        http://localhost:*/*
// @require      https://github.com/Jomshir98/bondage-club-mod-sdk/releases/latest/download/bcmodsdk.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function() {
'use strict';

// ==================== 常量 ====================
const VER = '3.2.1';
const FULL = 'BC XToys Control Panel';
const SHORT = 'BC-XToys-Panel';
const SK = 'BC_XToys_Panel_v2';
const IG_CT = new Set(['BCXMsg','BCEMsg','Preference','Wardrobe','SlowLeaveAttempt','ServerUpdateRoom','bctMsg']);
const IG_TP = new Set(['Status','Hidden']);
const MIN_SK = 500;
const SK_NM = ['ShockLow','ShockMed','ShockHigh'];
const REMOTE_COOLDOWN = 3000;

// 波形/剧本 状态
var waveRunning=null, waveTimerId=null;
var scriptTimerId=null;

// 自动响应规则
var autoResponseMap={};

// ==================== 身体敏感度区域系统 ====================
const BODY_ZONES = {
    'ItemMouth':         {sens:85,  label:'口👄', color:'#ff6b9d'},
    'ItemEar':           {sens:90,  label:'耳👂', color:'#ff8a80'},
    'ItemVulva':         {sens:100, label:'私🌸', color:'#f06292'},
    'ItemVulvaPiercings':{sens:95,  label:'环💍', color:'#ec407a'},
    'ItemBreast':        {sens:75,  label:'胸💜', color:'#ce93d8'},
    'ItemNipples':       {sens:80,  label:'头🎀', color:'#ba68c8'},
    'ItemButt':          {sens:65,  label:'臀🍑', color:'#ffab91'},
    'ItemLegs':          {sens:50,  label:'腿🦵', color:'#ffe082'},
    'ItemTorso':         {sens:45,  label:'身👤', color:'#b0bec5'},
    'ItemPelvis':        {sens:60,  label:'腰🩷', color:'#ef9a9a'},
    'ItemArms':          {sens:40,  label:'臂💪', color:'#a5d6a7'},
    'ItemFeet':          {sens:35,  label:'脚🦶', color:'#ffcc80'},
    'ItemBoots':         {sens:30,  label:'靴👢', color:'#bcaaa4'},
    'ItemHands':         {sens:30,  label:'手🤲', color:'#80cbc4'},
    'ItemHead':          {sens:55,  label:'头🧠', color:'#90caf9'},
    'ItemNeck':          {sens:70,  label:'颈💋', color:'#f48fb1'},
};
var activeZones  = {};
var zoneStackMode  = 'max';
var zoneStackTotal = 0;

function getZoneSens(slot){ var z=BODY_ZONES[slot]; return z?z.sens:50; }
function getZoneColor(slot){ var z=BODY_ZONES[slot]; return z?z.color:'#888'; }
function getZoneLabel(slot){ var z=BODY_ZONES[slot]; return z?z.label:slot; }

function updateActiveZone(slot, action, intensity, source){
    if(!slot) return;
    activeZones[slot]={intensity:intensity, action:action, time:Date.now(), source:source||''};
    var ks=Object.keys(activeZones), now=Date.now();
    for(var i=0;i<ks.length;i++){ if(now-activeZones[ks[i]].time>5000) delete activeZones[ks[i]]; }
    recalcZoneStack();
}

function recalcZoneStack(){
    var ks=Object.keys(activeZones);
    if(ks.length===0){ zoneStackTotal=0; return; }
    if(zoneStackMode==='max'){
        var mx=0; for(var i=0;i<ks.length;i++){ var v=activeZones[ks[i]].intensity; if(v>mx)mx=v; } zoneStackTotal=mx;
    } else if(zoneStackMode==='add'){
        var sum=0; for(var i=0;i<ks.length;i++) sum+=activeZones[ks[i]].intensity; zoneStackTotal=Math.min(100,sum);
    } else {
        var sum=0; for(var i=0;i<ks.length;i++) sum+=activeZones[ks[i]].intensity; zoneStackTotal=Math.round(sum/ks.length);
    }
}

function calcZoneIntensity(slot, actionName){
    var base=getZoneSens(slot);
    var actBonus=0;
    if(/Shock|Orgasm/i.test(actionName))             actBonus=20;
    else if(/Spank|Kick|Slap|Bite|Masturbate/i.test(actionName)) actBonus=10;
    else if(/Caress|Pet|Cuddle|Massage/i.test(actionName))       actBonus=-5;
    var pct=Math.max(5,Math.min(100,base+actBonus));
    return {pct:pct, level:pctToLevel(pct)};
}

// ==================== 持久化 ====================
function loadS(){ try{ return JSON.parse(localStorage.getItem(SK))||{}; }catch(e){ return {}; } }
function saveS(s){ localStorage.setItem(SK,JSON.stringify(s)); }

// ==================== 全局状态 ====================
var actLog=[], curIntensity=0, toyMap={};
var remoteAllow=true, broadcastOn=true;
var whitelist=[];
var lastRemoteTime={};
var curControlledBy=null;

// ==================== WebSocket Manager ====================
const WS = {
    sockets: new Map(), sendMsgs: true, autoRecMap: new Map(), uiCb: null,
    getSaved(){ var u=JSON.parse(localStorage.getItem(SHORT+' Websockets')); return Array.isArray(u)?u:[]; },
    save(){ var u=JSON.stringify(Array.from(this.sockets.keys())); if(u!==localStorage.getItem(SHORT+' Websockets')){ localStorage.setItem(SHORT+' Websockets',u); if(this.uiCb)this.uiCb(); } },
    setAutoC(v){ localStorage.setItem(SHORT+' AutoConnect',JSON.stringify(v===true)); },
    getAutoC(){ return JSON.parse(localStorage.getItem(SHORT+' AutoConnect'))===true; },
    setAutoR(v){ localStorage.setItem(SHORT+' AutoReconnect',JSON.stringify(v===true)); },
    getAutoR(){ return JSON.parse(localStorage.getItem(SHORT+' AutoReconnect'))===true; },
    connect(url){
        if(!url) return; if(this.hasConn(url)){ log('Already connected: '+url); return; }
        var w=new WebSocket(url); this.sockets.set(url,w); var s=this;
        w.onopen=function(){ log('Connected: '+w.url); if(s.getAutoC()) s.save(); if(s.getAutoR()) s.autoRecMap.set(url,3); if(s.uiCb) s.uiCb(); };
        w.onmessage=function(e){ log('RX: '+e.data); };
        w.onclose=function(){ log('Disconnected: '+url); s.close(url);
            if(s.getAutoR()){ var a=s.autoRecMap.get(url); if(a>0){ setTimeout(function(){ s.autoRecMap.set(url,a-1); s.connect(url); },100); } else s.autoRecMap.delete(url); }
            if(s.uiCb) s.uiCb(); };
        w.onerror=function(){ if(s.uiCb) s.uiCb(); };
    },
    connectSaved(){ if(!this.getAutoC()) return; var u=this.getSaved(); for(var i=0;i<u.length;i++) this.connect(u[i]); },
    send(t){ if(this.sockets.size===0||!this.sendMsgs) return; for(var s of this.sockets.values()){ if(s.readyState!==1) continue; s.send(t); } log('TX: '+t); },
    sendFA(action, args){
        if(!this.hasAnyConn()){ log('No connection'); return; }
        var m='{"action":"'+action+'"';
        if(args&&Array.isArray(args)){ for(var i=0;i<args.length;i++){ if(!Array.isArray(args[i])||args[i].length!==2||typeof args[i][0]!=='string') continue;
            m+=', "'+args[i][0]+'": '; var v=args[i][1];
            if(v===null){ m+='"none"'; } else if(typeof v==='string'){ m+='"'+v+'"'; } else { m+=v; } } }
        m+='}'; this.send(m);
    },
    hasConn(u){ var s=this.sockets.get(u); return s?s.readyState===1:false; },
    hasAnyConn(){ var ks=Array.from(this.sockets.keys()); for(var i=0;i<ks.length;i++){ if(this.hasConn(ks[i])) return true; } return false; },
    close(url){ this.autoRecMap.delete(url); var s=this.sockets.get(url); if(s&&s.readyState<=1) s.close(1000); this.sockets.delete(url); this.save(); },
    closeAll(){ var ks=Array.from(this.sockets.keys()); for(var i=0;i<ks.length;i++) this.close(ks[i]); },
    getConns(){ return Array.from(this.sockets.keys()); }
};

// ==================== ItemState Handler ====================
const ItemState = (function(){
    var st=new Map(), skH=[];
    function init(n){ if(!st.get(n)) st.set(n,{nm:null,fx:new Map()}); }
    function clrO(){ var r=true; while(r&&skH.length>0){ if(Date.now()-skH[0][0]>MIN_SK) skH.shift(); else r=false; } }
    function hasSK(s,l){ for(var i=0;i<skH.length;i++){ if(skH[i][1]===s&&skH[i][2]===l) return true; } return false; }
    return {
        updProps(effect,tag,slot,nm,level,off){ off=off||0; if(!slot||level===undefined||level===null||!nm) return; level+=off;
            init(slot); var s=st.get(slot); if(s.fx.get(effect)===level) return; s.nm=nm; s.fx.set(effect,level);
            WS.sendFA(tag,[['assetGroupName',slot],['level',level],['itemName',nm]]);
            var pct=Math.round(level/5*100);
            if(tag==='toyEvent'){ toyMap[slot]=pct; var mx=0; var ks=Object.keys(toyMap); for(var i=0;i<ks.length;i++){ if(toyMap[ks[i]]>mx) mx=toyMap[ks[i]]; } curIntensity=mx; }
            addLog(tag,slot,pct,nm);
        },
        updAll(item){ if(!item) return;
            this.updProps('Vibration','toyEvent',item.Asset&&item.Asset.DynamicGroupName,item.Asset&&item.Asset.Name,item.Property&&item.Property.Intensity,1);
            this.updProps('Inflation','inflationEvent',item.Asset&&item.Asset.DynamicGroupName,item.Asset&&item.Asset.Name,item.Property&&item.Property.InflateLevel);
        },
        sendSK(slot,level,an){ if(level>=0&&level<=2&&slot){ clrO(); if(!hasSK(slot,level)){ WS.sendFA('activityEvent',[['assetGroupName',slot],['actionName',SK_NM[level]],['assetName',an]]); skH.push([Date.now(),slot,level,an]); addLog('Shock',slot,(level+1)*33,an); } } },
        clearAll(slot){ var s=st.get(slot); if(!s) return; if(s.fx.get('Vibration')!==null) this.updProps('Vibration','toyEvent',slot,s.nm,0); if(s.fx.get('Inflation')!==null) this.updProps('Inflation','inflationEvent',slot,s.nm,0); st.delete(slot); },
        getNm(slot){ var s=st.get(slot); return s?s.nm:null; }
    };
})();

// ==================== 动作日志 ====================
function addLog(action,slot,intensity,asset,who){
    who=who||'';
    actLog.unshift({time:new Date().toLocaleTimeString(),action:action,slot:slot||'',intensity:intensity||0,asset:asset||'',who:who});
    if(actLog.length>50) actLog.length=50;
    updUI();
}

// ==================== 强度表情 ====================
function intensityEmoji(pct){
    if(pct<=0) return '💤'; if(pct<20) return '🌱'; if(pct<40) return '💡'; if(pct<60) return '🔥'; if(pct<80) return '💥'; return '🚨';
}

// ==================== 聊天广播 ====================
var lastBroadcast=0, lastBroadcastLevel=-1;
var BROADCAST_MIN_INTERVAL=5000, BROADCAST_MIN_CHANGE=10;

function maybeBroadcast(){
    if(!broadcastOn) return;
    var now=Date.now();
    if(now-lastBroadcast<BROADCAST_MIN_INTERVAL && Math.abs(curIntensity-lastBroadcastLevel)<BROADCAST_MIN_CHANGE) return;
    lastBroadcast=now; lastBroadcastLevel=curIntensity;
    var bar='', filled=Math.round(curIntensity/10);
    for(var i=0;i<10;i++) bar+=i<filled?'█':'░';
    var msg='[🎮] '+Player.Name+' 的玩具 '+intensityEmoji(curIntensity)+' ['+bar+'] '+curIntensity+'%';
    if(typeof ChatRoomSendLocal!=='undefined') ChatRoomSendLocal(msg,8000);
}

// ==================== 远程控制 ====================
function handleRemoteCommand(sourceName, intensity){
    if(!remoteAllow){ ChatRoomSendLocal('[🎮] 远程控制已关闭',5000); return; }
    if(whitelist.length>0){
        var found=false;
        for(var i=0;i<whitelist.length;i++){ if(whitelist[i].toLowerCase()===sourceName.toLowerCase()){ found=true; break; } }
        if(!found){ ChatRoomSendLocal('[🎮] '+sourceName+' 不在白名单中',5000); return; }
    }
    var lk=sourceName.toLowerCase();
    if(lastRemoteTime[lk]&&Date.now()-lastRemoteTime[lk]<REMOTE_COOLDOWN){
        ChatRoomSendLocal('[🎮] '+sourceName+' 请等待 '+(Math.round((REMOTE_COOLDOWN-(Date.now()-lastRemoteTime[lk]))/100)/10)+'秒',5000);
        return;
    }
    lastRemoteTime[lk]=Date.now();
    intensity=Math.max(0,Math.min(100,intensity));
    curControlledBy=sourceName;
    WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(intensity)],['itemName','RemoteControl']]);
    curIntensity=intensity; toyMap['remote']=intensity;
    addLog('Remote','remote',intensity,sourceName,sourceName);
    var emoji=intensityEmoji(intensity);
    ChatRoomSendLocal('[🎮] '+sourceName+' 设置 '+Player.Name+' 的玩具为 '+intensity+'% '+emoji,10000);
    var reacts=['啊...','嗯~','感受到了...','好强烈...','玩具在震...','唔...'];
    if(intensity>80) reacts=['啊啊啊!!!','太强了!!','要坏掉了...','不行了...','天啊...'];
    else if(intensity>50) reacts=['嗯嗯~','好舒服...','就是这样...','再强一点...'];
    else if(intensity>20) reacts=['嗯...','轻轻的...','感觉到了...'];
    var react=reacts[Math.floor(Math.random()*reacts.length)];
    if(typeof ChatRoomSendLocal!=='undefined') setTimeout(function(){ ChatRoomSendLocal(react,5000); },1000);
}

// ==================== 配对控制系统 ====================
var pairSessions={};
var pairedPartner=null;
var pairLimitMax=100;

function genPairCode(){ var c='',ch='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for(var i=0;i<6;i++) c+=ch[Math.floor(Math.random()*ch.length)]; return c; }

function sharePairCode(){
    if(!WS.hasAnyConn()){ ChatRoomSendLocal('[🎮] 请先连接 XToys 再分享配对',5000); return; }
    var code=genPairCode(), urls=WS.getConns();
    pairSessions[code]={wsUrl:urls[0],expires:Date.now()+60000,creator:Player.Name,limit:pairLimitMax};
    setTimeout(function(){ delete pairSessions[code]; },60000);
    ChatRoomSendLocal('[🎮] '+Player.Name+' 分享玩具配对码: '+code+' (60秒有效)\n对方输入 /toy pair '+code+' 即可连接控制',15000);
    addLog('PairShared','system',0,code);
    updUI();
}

function acceptPairCode(code, sourceName){
    var session=pairSessions[code];
    if(!session){ ChatRoomSendLocal('[🎮] 配对码无效或已过期',5000); return; }
    if(Date.now()>session.expires){ delete pairSessions[code]; ChatRoomSendLocal('[🎮] 配对码已过期',5000); return; }
    if(pairedPartner) unpairPartner();
    var url=session.wsUrl;
    pairedPartner={name:sourceName,wsUrl:url,limit:session.limit||100,timerId:null,timerEnd:null};
    if(session.timer){ pairedPartner.timerEnd=Date.now()+session.timer; pairedPartner.timerId=setTimeout(function(){ unpairPartner(true); },session.timer); }
    WS.connect(url);
    delete pairSessions[code];
    ChatRoomSendLocal('[🎮] '+sourceName+' 已配对连接 '+Player.Name+' 的玩具! '+
        (pairedPartner.limit<100?'限幅 '+pairedPartner.limit+'% ':'')+
        (pairedPartner.timerEnd?'自动断开: '+new Date(pairedPartner.timerEnd).toLocaleTimeString():''),15000);
    addLog('Paired','system',0,sourceName);
    updUI();
}

function unpairPartner(silent){
    if(!pairedPartner) return;
    if(pairedPartner.timerId) clearTimeout(pairedPartner.timerId);
    var name=pairedPartner.name;
    WS.close(pairedPartner.wsUrl);
    pairedPartner=null;
    if(!silent) ChatRoomSendLocal('[🎮] 配对已断开，'+name+' 不再控制你的玩具',8000);
    addLog('Unpaired','system',0,name);
    updUI();
}

// ==================== 工具函数 ====================
function sDict(msg,tag,sub){ if(!msg||!Array.isArray(msg.Dictionary)) return null; for(var i=0;i<msg.Dictionary.length;i++){ var k=Object.keys(msg.Dictionary[i]),v=Object.values(msg.Dictionary[i]); if(k[0]===tag) return v[0]; var ix=k.indexOf(sub); if(k[0]==='Tag'&&v[0]===tag&&ix>=0) return v[ix]; } return null; }
function pByName(n){ return Player.Appearance.find(function(d){ return d.Asset.Name===n; }); }
function pBySlot(n){ return Player.Appearance.find(function(d){ return d.Asset.DynamicGroupName===n; }); }
function getSKL(d){ switch(d.Content){ case 'TriggerShock0':return 0;case 'TriggerShock1':return 1;case 'TriggerShock2':return 2;default:return -1; } }
function esc(s){ if(!s) return''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function log(m){ console.log('['+SHORT+'] '+m); }
// XToys 端 schema 校验 level<0 或 level>4 直接丢弃，所以 100%=4 而不是 5
function pctToLevel(v){ return Math.max(0, Math.min(4, Math.round(v/25))); }

// ==================== 悬浮面板 UI ====================
var panelVis=true, dragging=false, dgT=null, dgOX=0, dgOY=0;

function createUI(){
    var ic=document.createElement('div'); ic.id='bcp-icon'; ic.innerHTML='🎮';
    ic.title='XToys 遥控面板';
    ic.style.cssText='position:fixed;z-index:999990;width:48px;height:48px;background:linear-gradient(135deg,#d32f2f,#b71c1c);border:3px solid #4a0000;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.4),inset 0 2px 0 rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;transition:transform .15s;user-select:none;-webkit-user-select:none;';
    ic.onmouseenter=function(){ this.style.transform='scale(1.12)'; };
    ic.onmouseleave=function(){ this.style.transform='scale(1)'; };
    ic.onmousedown=function(e){ if(e.button===0){ dgOX=e.clientX-ic.getBoundingClientRect().left; dgOY=e.clientY-ic.getBoundingClientRect().top; dgT=ic; } };
    ic.onclick=function(e){ if(!dragging) tgPanel(); dragging=false; };
    document.body.appendChild(ic);

    var p=document.createElement('div'); p.id='bcp-panel';
    p.style.cssText='position:fixed;z-index:999991;width:270px;background:#18181e;border:2px solid #c62828;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.55);font:12px "Segoe UI","Microsoft YaHei",sans-serif;color:#ccc;overflow:hidden;user-select:none;-webkit-user-select:none;';
    p.innerHTML =
    '<div id="bcp-title" style="background:#1a1a22;padding:8px 10px;cursor:move;display:flex;align-items:center;gap:8px;border-bottom:1px solid #333;">'+
        '<span style="font-size:16px;">🎮</span><b style="color:#ff5252;">XToys 遥控</b>'+
        '<span style="font-size:9px;color:#666;margin-left:2px;">v'+VER+'</span>'+
        '<span id="bcp-dot" style="margin-left:auto;width:8px;height:8px;border-radius:50%;background:#f44336;box-shadow:0 0 6px #f44336;"></span>'+
        '<button id="bcp-min" style="background:none;border:1px solid #555;color:#999;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:14px;line-height:1;padding:0;">_</button></div>'+
    '<div id="bcp-body" style="padding:10px;">'+
        // Webhook
        '<div style="margin-bottom:8px;"><div style="font-size:10px;color:#888;margin-bottom:3px;">WebSocket / Webhook ID</div>'+
            '<div style="display:flex;gap:4px;"><input id="bcp-input" placeholder="ID 或 wss://..." style="flex:1;padding:5px 7px;background:#111;border:1px solid #444;border-radius:4px;color:#ddd;font-size:11px;outline:none;"><button id="bcp-conn" style="padding:5px 10px;background:#c62828;border:none;border-radius:4px;color:#fff;font-size:11px;cursor:pointer;white-space:nowrap;">连接</button></div></div>'+
        // 强度条
        '<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;margin-bottom:2px;"><span style="font-size:10px;color:#888;">实时强度</span><span id="bcp-intval" style="font-size:12px;color:#4caf50;font-weight:700;">0%</span></div>'+
            '<div style="height:8px;background:#222;border-radius:4px;overflow:hidden;border:1px solid #333;"><div id="bcp-bar" style="height:100%;width:0%;background:#4caf50;border-radius:4px;transition:width .3s;"></div></div></div>'+
        // 快捷预设
        '<div style="margin-bottom:8px;"><div style="font-size:10px;color:#888;margin-bottom:3px;">快捷预设</div>'+
            '<div style="display:flex;gap:4px;">'+
                '<button class="bcp-preset" data-v="0"   style="flex:1;padding:4px 0;background:#333;border:1px solid #555;border-radius:4px;color:#aaa;font-size:9px;cursor:pointer;">💤 停</button>'+
                '<button class="bcp-preset" data-v="25"  style="flex:1;padding:4px 0;background:#1b3a1b;border:1px solid #2e7d32;border-radius:4px;color:#8bc34a;font-size:9px;cursor:pointer;">🌱 弱</button>'+
                '<button class="bcp-preset" data-v="50"  style="flex:1;padding:4px 0;background:#2a2a10;border:1px solid #f57f17;border-radius:4px;color:#ffc107;font-size:9px;cursor:pointer;">🔥 中</button>'+
                '<button class="bcp-preset" data-v="80"  style="flex:1;padding:4px 0;background:#2a1010;border:1px solid #c62828;border-radius:4px;color:#ff5252;font-size:9px;cursor:pointer;">💥 强</button>'+
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
                '<button id="bcp-pair-stop"  style="flex:1;padding:4px;background:#333;border:1px solid #555;border-radius:4px;color:#ff5252;font-size:9px;cursor:pointer;">断开配对</button></div>'+
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
                '<button class="bcp-wave-btn" data-w="sine"       style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">正弦</button>'+
                '<button class="bcp-wave-btn" data-w="square"     style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">方波</button>'+
                '<button class="bcp-wave-btn" data-w="heartbeat"  style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">心跳</button>'+
                '<button class="bcp-wave-btn" data-w="tease"      style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">挑逗</button>'+
                '<button class="bcp-wave-btn" data-w="crescendo"  style="padding:3px 6px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#aaa;font-size:8px;cursor:pointer;">渐强</button>'+
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
                '<button id="bcp-ramp-go"    style="flex:1;padding:4px;background:#6a1b9a;border:none;border-radius:4px;color:#fff;font-size:9px;cursor:pointer;">▶ 渐强</button>'+
                '<button id="bcp-timer-go"   style="flex:1;padding:4px;background:#4527a0;border:none;border-radius:4px;color:#fff;font-size:9px;cursor:pointer;">⏱ 定时</button>'+
                '<button id="bcp-script-stop" style="flex:1;padding:4px;background:#333;border:1px solid #555;border-radius:4px;color:#ff5252;font-size:9px;cursor:pointer;">停止</button></div>'+
        '</div>'+
        // 身体热力图
        '<div style="margin-bottom:8px;background:#111;border-radius:6px;padding:8px;border:1px solid #333;">'+
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'+
                '<span style="font-size:10px;color:#f06292;">🔥 身体活跃区</span>'+
                '<span style="font-size:8px;color:#888;">模式:</span>'+
                '<select id="bcp-zone-mode" style="padding:1px;background:#111;border:1px solid #444;border-radius:3px;color:#ddd;font-size:8px;">'+
                    '<option value="max">最高</option><option value="add">叠加</option><option value="avg">平均</option></select></div>'+
            '<div id="bcp-heatmap" style="display:flex;flex-wrap:wrap;gap:3px;min-height:20px;"><span style="font-size:9px;color:#555;">等待活动...</span></div>'+
            '<div style="display:flex;justify-content:space-between;margin-top:3px;">'+
                '<span style="font-size:8px;color:#888;">叠加强度</span>'+
                '<span id="bcp-stack-val" style="font-size:10px;color:#f06292;font-weight:700;">0%</span></div>'+
        '</div>'+
        // 事件记录
        '<div><div style="font-size:10px;color:#888;margin-bottom:3px;">事件记录</div>'+
            '<div id="bcp-log" style="height:100px;overflow-y:auto;font-size:9px;color:#999;background:#0c0c14;border-radius:4px;padding:5px;border:1px solid #222;">等待游戏事件...</div></div>'+
    '</div>';
    document.body.appendChild(p);

    // 拖拽
    document.getElementById('bcp-title').onmousedown=function(e){ if(e.target.tagName==='BUTTON') return; if(e.button!==0) return; dgT=p; dgOX=e.clientX-p.getBoundingClientRect().left; dgOY=e.clientY-p.getBoundingClientRect().top; };
    document.addEventListener('mousemove',function(e){ if(!dgT) return; dragging=true;
        var nx=Math.max(0,Math.min(e.clientX-dgOX,window.innerWidth-dgT.offsetWidth)),ny=Math.max(0,Math.min(e.clientY-dgOY,window.innerHeight-dgT.offsetHeight));
        dgT.style.left=nx+'px'; dgT.style.top=ny+'px'; dgT.style.right='auto'; dgT.style.bottom='auto';
        if(dgT===p){ ic.style.left=(nx+5)+'px'; ic.style.top=(ny-55)+'px'; ic.style.right='auto'; ic.style.bottom='auto'; }
    });
    document.addEventListener('mouseup',function(){ if(dragging) savePos(); dgT=null; dragging=false; });

    // 事件绑定
    document.getElementById('bcp-conn').onclick=function(){
        var val=document.getElementById('bcp-input').value.trim(); if(!val) return;
        var url=/^wss?:\/\//i.test(val)?val:'wss://webhook.xtoys.app/'+val;
        if(WS.hasConn(url)){ WS.close(url); }
        else { WS.connect(url); }
        refDot();
    };
    document.getElementById('bcp-min').onclick=function(){ tgPanel(); };
    document.getElementById('bcp-slider').oninput=function(){ document.getElementById('bcp-manval').textContent=this.value+'%'; };
    document.getElementById('bcp-apply').onclick=function(){
        var v=parseInt(document.getElementById('bcp-slider').value);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(v)],['itemName','ManualControl']]);
        curIntensity=v; toyMap['manual']=v; addLog('Manual','ItemVulva',v,'Self'); updUI(); maybeBroadcast();
    };
    document.getElementById('bcp-zero').onclick=function(){
        document.getElementById('bcp-slider').value=0; document.getElementById('bcp-manval').textContent='0%';
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',0],['itemName','ManualControl']]);
        curIntensity=0; toyMap={}; addLog('Stop','all',0,'Self'); updUI();
    };
    document.getElementById('bcp-remote').onclick=function(){
        remoteAllow=!remoteAllow; this.textContent=remoteAllow?'开':'关'; this.style.background=remoteAllow?'#2e7d32':'#555';
        var s=loadS(); s.remoteAllow=remoteAllow; saveS(s);
    };
    document.getElementById('bcp-bcast').onclick=function(){
        broadcastOn=!broadcastOn; this.textContent=broadcastOn?'开':'关'; this.style.background=broadcastOn?'#2e7d32':'#555';
        var s=loadS(); s.broadcastOn=broadcastOn; saveS(s);
    };
    document.getElementById('bcp-zone-mode').onchange=function(){ zoneStackMode=this.value; recalcZoneStack(); var s=loadS(); s.zoneStackMode=zoneStackMode; saveS(s); };
    document.getElementById('bcp-pair-share').onclick=function(){ sharePairCode(); };
    document.getElementById('bcp-pair-stop').onclick=function(){ unpairPartner(); };
    document.getElementById('bcp-pair-limit').oninput=function(){ document.getElementById('bcp-pair-limit-val').textContent=this.value+'%'; pairLimitMax=parseInt(this.value); };
    document.getElementById('bcp-pair-status').ondblclick=function(){
        var code=prompt('输入对方配对码 (6位):');
        if(code&&code.length===6) handleChatCommands({Content:'/toy pair '+code.trim().toUpperCase(),Type:'Chat',SenderName:Player.Name});
    };
    var wbs=document.getElementsByClassName('bcp-wave-btn');
    for(var i=0;i<wbs.length;i++){ wbs[i].onclick=function(){
        var wt=this.getAttribute('data-w'),mn=parseInt(document.getElementById('bcp-wave-min').value)||10,mx=parseInt(document.getElementById('bcp-wave-max').value)||80,sp=parseInt(document.getElementById('bcp-wave-spd').value)||2000;
        startWave(wt,mn,mx,sp);
        var ws=document.getElementById('bcp-wave-status'); if(ws){ ws.textContent=WAVES[wt]?WAVES[wt].name:'运行'; ws.style.color='#4fc3f7'; }
    }; }
    document.getElementById('bcp-wave-stop').onclick=function(){ stopWave(); var ws=document.getElementById('bcp-wave-status'); if(ws){ ws.textContent='停止'; ws.style.color='#888'; } };
    document.getElementById('bcp-ramp-go').onclick=function(){   var t=parseInt(document.getElementById('bcp-script-target').value)||80,s=parseInt(document.getElementById('bcp-script-sec').value)||30; scriptRamp(t,s); };
    document.getElementById('bcp-timer-go').onclick=function(){  var t=parseInt(document.getElementById('bcp-script-target').value)||80,s=parseInt(document.getElementById('bcp-script-sec').value)||30; scriptTimer(Math.ceil(s/60)||1,t); };
    document.getElementById('bcp-script-stop').onclick=function(){ if(scriptTimerId) clearInterval(scriptTimerId); scriptTimerId=null; ChatRoomSendLocal('[📜] 剧本已停止',5000); };
    var pbs=document.getElementsByClassName('bcp-preset');
    for(var i=0;i<pbs.length;i++){ pbs[i].onclick=function(){
        var v=parseInt(this.getAttribute('data-v'));
        document.getElementById('bcp-slider').value=v; document.getElementById('bcp-manval').textContent=v+'%';
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(v)],['itemName','PresetControl']]);
        curIntensity=v; toyMap['preset']=v; addLog('Preset','ItemVulva',v,'Self'); updUI(); maybeBroadcast();
    }; }

    restorePos();
    var s=loadS();
    remoteAllow=s.remoteAllow!==false; broadcastOn=s.broadcastOn!==false;
    whitelist=Array.isArray(s.whitelist)?s.whitelist:[];
    zoneStackMode=s.zoneStackMode||'max';
    var rb=document.getElementById('bcp-remote'),bb=document.getElementById('bcp-bcast'),zm=document.getElementById('bcp-zone-mode');
    if(rb){ rb.textContent=remoteAllow?'开':'关'; rb.style.background=remoteAllow?'#2e7d32':'#555'; }
    if(bb){ bb.textContent=broadcastOn?'开':'关'; bb.style.background=broadcastOn?'#2e7d32':'#555'; }
    if(zm) zm.value=zoneStackMode;
}

function tgPanel(){ panelVis=!panelVis; var p=document.getElementById('bcp-panel'); if(p) p.style.display=panelVis?'block':'none'; savePos(); }
function savePos(){
    var s=loadS(); var ic=document.getElementById('bcp-icon'),p=document.getElementById('bcp-panel');
    if(ic){ s.ix=parseInt(ic.style.left)||ic.getBoundingClientRect().left; s.iy=parseInt(ic.style.top)||ic.getBoundingClientRect().top; }
    if(p){ s.px=parseInt(p.style.left)||p.getBoundingClientRect().left; s.py=parseInt(p.style.top)||p.getBoundingClientRect().top; }
    s.vis=panelVis; s.remoteAllow=remoteAllow; s.broadcastOn=broadcastOn; s.whitelist=whitelist; saveS(s);
}
function restorePos(){
    var s=loadS(); var ic=document.getElementById('bcp-icon'),p=document.getElementById('bcp-panel');
    var ix=(s.ix>=0&&s.ix<window.innerWidth)?s.ix:window.innerWidth-65, iy=(s.iy>=0&&s.iy<window.innerHeight)?s.iy:window.innerHeight-80;
    ic.style.left=ix+'px'; ic.style.top=iy+'px'; ic.style.right='auto'; ic.style.bottom='auto';
    p.style.left=((s.px>=0)?s.px:ix-270)+'px'; p.style.top=((s.py>=0)?s.py:iy-5)+'px'; p.style.right='auto'; p.style.bottom='auto';
    panelVis=s.vis!==false; p.style.display=panelVis?'block':'none';
}
function refDot(){
    var d=document.getElementById('bcp-dot'); if(d){
        if(WS.hasAnyConn()){ d.style.background='#4caf50'; d.style.boxShadow='0 0 8px #4caf50'; }
        else { d.style.background='#f44336'; d.style.boxShadow='0 0 6px #f44336'; }
    }
    var cb=document.getElementById('bcp-conn'); if(cb) cb.textContent=WS.hasAnyConn()?'断开':'连接';
}
function updUI(){
    var bar=document.getElementById('bcp-bar'),val=document.getElementById('bcp-intval');
    if(bar&&val){ bar.style.width=curIntensity+'%'; val.textContent=curIntensity+'%';
        var c=curIntensity<30?'#4caf50':curIntensity<60?'#ff9800':'#f44336'; bar.style.background=c; val.style.color=c; }
    refDot();
    var hm=document.getElementById('bcp-heatmap'),sv=document.getElementById('bcp-stack-val');
    if(hm){
        var azs=Object.keys(activeZones);
        if(azs.length===0){ hm.innerHTML='<span style="font-size:9px;color:#555;">等待活动...</span>'; }
        else {
            var h='';
            for(var i=0;i<azs.length;i++){ var z=activeZones[azs[i]],c=getZoneColor(azs[i]),lb=getZoneLabel(azs[i]);
                h+='<span style="padding:1px 5px;background:'+c+'22;border:1px solid '+c+';border-radius:3px;font-size:8px;color:'+c+';">'+lb+' '+z.intensity+'%</span>'; }
            hm.innerHTML=h;
        }
        if(sv) sv.textContent=zoneStackTotal+'%';
    }
    var ps=document.getElementById('bcp-pair-status');
    if(ps){
        if(pairedPartner){ ps.textContent='已配对: '+pairedPartner.name+(pairedPartner.limit<100?' [限'+pairedPartner.limit+'%]':''); ps.style.color='#ff9800'; }
        else { ps.textContent='未配对'; ps.style.color='#888'; }
    }
    var logEl=document.getElementById('bcp-log'); if(!logEl) return;
    if(actLog.length===0){ logEl.innerHTML='<span style="color:#555;">等待游戏事件...</span>'; return; }
    var h='';
    for(var i=0;i<Math.min(8,actLog.length);i++){
        var a=actLog[i],cl=a.intensity<30?'#8bc34a':a.intensity<60?'#ffc107':'#ff5722';
        h+='<div style="display:flex;justify-content:space-between;margin-bottom:1px;">'+
            '<span>'+esc(a.action)+(a.slot?' @'+esc(a.slot):'')+(a.who?' by '+esc(a.who):'')+'</span>'+
            '<span style="color:'+cl+';font-weight:600;">'+a.intensity+'%</span></div>';
    }
    logEl.innerHTML=h;
}

// ==================== 游戏内设置面板 (新增) ====================
// 通过 PreferenceRegisterExtensionSetting 集成到 游戏 → 设置 → 扩展插件
var igScreen = {
    open: false,
    inputActive: false,   // 当前哪个输入框激活
    activeInput: null,    // 'webhook' | 'whitelist'
    wlInput: '',          // 白名单输入缓存
    feedback: '',         // 操作反馈文字
    feedbackTimer: null,
};

function igLoad(){
    igScreen.open = true;
    igScreen.inputActive = false;
    igScreen.activeInput = null;
    igScreen.feedback = '';
}

// 文字渲染辅助 (参考 Liko 插件 _lbl 模式)
function _lbl(text, x, y, maxW, color, size){
    var prev = MainCanvas.font;
    MainCanvas.font = MainCanvas.font.replace(/\d+px/, Math.round(size*1.2)+'px');
    DrawTextFit(text, x, y, maxW, color);
    MainCanvas.font = prev;
}

function igRun(){
    var s = igScreen;
    var W='White', T='Black', S='#444', P='#888', BG='#f5f5f5', BTN='#e8e8e8', BTNA='#ccc';
    // 左栏标签起始 X, 右栏标签起始 X
    var LX=280, RX=1050;
    var BTN_H = 50, ROW_H = 70;

    // ── 背景 ────────────────────────────────────────
    DrawRect(150, 45, 1700, 920, W);
    DrawEmptyRect(150, 45, 1700, 920, '#ccc', 1);

    // ── 标题 ────────────────────────────────────────
    _lbl('XToys Panel  v'+VER, 250, 100, 500, T, 26);

    // 返回按钮 (右上角, 参考插件风格)
    DrawButton(1760, 60, 70, 70, '', 'White', 'Icons/Exit.png', '返回');

    // ═══════════════ 左栏 ═══════════════════════════

    // ── 分组标题: 连接 ──
    DrawText('── 连接 ──', LX+100, 170, T, 'Gray');

    // 连接状态 (Y=220)
    var connected = WS.hasAnyConn();
    _lbl('状态', LX, 230, 120, S, 22);
    _lbl(connected ? '● 已连接 ('+WS.getConns().length+')' : '○ 未连接', 400, 230, 300, T, 22);

    // Webhook 输入 (Y=290)
    _lbl('Webhook', LX, 295, 150, S, 22);
    var inBg = (s.activeInput==='webhook') ? W : BG;
    var inBd = (s.activeInput==='webhook') ? T : '#ccc';
    DrawRect(LX, 320, 500, BTN_H, inBg);
    DrawEmptyRect(LX, 320, 500, BTN_H, inBd, s.activeInput==='webhook'?2:1);
    if(s.activeInput!=='webhook'){
        var curUrl = WS.getConns()[0] || '输入 ID 或 wss:// 地址';
        _lbl(curUrl, LX+10, 347, 480, WS.getConns()[0]?T:P, 18);
    }
    DrawButton(LX+520, 320, 120, BTN_H, connected?'断开':'连接', connected?BTNA:BTN);
    DrawButton(LX+660, 320, 100, BTN_H, '重置', BTN);

    // ── 分组标题: 白名单 ──
    DrawText('── 白名单 ──', LX+70, 420, T, 'Gray');

    // 白名单 (Y=470)
    _lbl('名单', LX, 475, 100, S, 22);
    if(whitelist.length>0){
        _lbl(whitelist.join('  ·  '), 380, 475, 560, T, 20);
    } else {
        _lbl('空 — 所有人可控制', 380, 475, 400, P, 20);
    }

    // 白名单输入 (Y=530)
    var wlInBg = (s.activeInput==='whitelist') ? W : BG;
    var wlInBd = (s.activeInput==='whitelist') ? T : '#ccc';
    DrawRect(LX, 530, 420, BTN_H, wlInBg);
    DrawEmptyRect(LX, 530, 420, BTN_H, wlInBd, s.activeInput==='whitelist'?2:1);
    if(s.activeInput!=='whitelist') _lbl(s.wlInput||'输入玩家名', LX+10, 557, 400, s.wlInput?T:P, 18);
    DrawButton(LX+440, 530, 90, BTN_H, '添加', BTN);
    DrawButton(LX+545, 530, 90, BTN_H, '移除', BTN);
    DrawButton(LX+650, 530, 90, BTN_H, '清空', BTN);

    // ═══════════════ 右栏 ═══════════════════════════

    // ── 分组标题: 设置 ──
    DrawText('── 设置 ──', RX+100, 170, T, 'Gray');

    // 远程控制 (Y=220)
    _lbl('远程控制', RX, 230, 200, S, 22);
    DrawButton(RX+400, 220, 130, BTN_H, remoteAllow?'开启':'关闭', remoteAllow?BTNA:BTN);

    // 状态广播 (Y=290)
    _lbl('状态广播', RX, 300, 200, S, 22);
    DrawButton(RX+400, 290, 130, BTN_H, broadcastOn?'开启':'关闭', broadcastOn?BTNA:BTN);

    // 叠加模式 (Y=370)
    _lbl('叠加模式', RX, 380, 200, S, 22);
    DrawButton(RX+400, 370, 100, BTN_H, '最高', zoneStackMode==='max'?BTNA:BTN);
    DrawButton(RX+510, 370, 100, BTN_H, '叠加', zoneStackMode==='add'?BTNA:BTN);
    DrawButton(RX+620, 370, 100, BTN_H, '平均', zoneStackMode==='avg'?BTNA:BTN);

    // ── 分组标题: 快捷 ──
    DrawText('── 快捷 ──', RX+100, 460, T, 'Gray');

    // 当前状态 (Y=510)
    _lbl('强度', RX, 515, 80, S, 22);
    _lbl(curIntensity+'%', RX+80, 515, 100, T, 22);
    _lbl('活跃区', RX+200, 515, 100, S, 22);
    var zonesText = (Object.keys(activeZones).map(function(k){ return getZoneLabel(k)+' '+activeZones[k].intensity+'%'; }).join('  ·  ')) || '无';
    _lbl(zonesText, RX+300, 515, 450, T, 20);

    // 快捷按钮 (Y=580)
    var presets=[[RX,0],[RX+140,25],[RX+280,50],[RX+420,80],[RX+560,100]];
    var PY = 580;
    for(var pi=0;pi<presets.length;pi++){
        DrawButton(presets[pi][0], PY, 120, BTN_H, presets[pi][1]+'%', BTN);
    }
    DrawButton(RX+700, PY, 160, BTN_H, waveRunning?'停止波形':'心跳波形', waveRunning?BTNA:BTN);

    // ── 分组标题: 配对 ──
    DrawText('── 配对 ──', RX+100, 670, T, 'Gray');

    // 配对状态 (Y=720)
    if(pairedPartner){
        _lbl(pairedPartner.name+(pairedPartner.limit<100?'  限幅'+pairedPartner.limit+'%':''), RX, 730, 400, T, 22);
        DrawButton(RX+500, 720, 150, BTN_H, '断开配对', BTN);
    } else {
        _lbl('未配对', RX, 730, 200, P, 22);
        DrawButton(RX+500, 720, 150, BTN_H, '分享配对码', BTN);
    }
    DrawButton(RX+670, 720, 130, BTN_H, '配对帮助', BTN);

    // ═══════════════ 底部 ═══════════════════════════
    if(s.feedback){
        _lbl(s.feedback, 400, 920, 1200, T, 20);
    } else {
        _lbl('快捷面板: 屏幕图标  |  聊天: /toy help  |  此页面: 设置 > 扩展插件', 400, 920, 1200, P, 18);
    }
}

function igClick(x, y){
    var s = igScreen;

    // ── 返回 (右上角) ──────────────────────────
    if(MouseIn(1760, 60, 70, 70)){
        igCloseInput();
        PreferenceSubscreenExtensionsExit();
        return;
    }

    // ── 左栏: Webhook 输入框 ──────────────────
    if(MouseIn(280, 320, 500, 50)){
        s.activeInput='webhook'; s.inputActive=true;
        ElementCreateInput('BCXToysIG_webhook','text',WS.getConns()[0]||'',256);
        igAttachInputEnter('BCXToysIG_webhook');
        return;
    }
    // 连接/断开
    if(MouseIn(800, 320, 120, 50)){
        if(WS.hasAnyConn()){
            WS.closeAll(); igFeedback('已断开所有连接');
        } else {
            var el=document.getElementById('BCXToysIG_webhook');
            var val=el?el.value.trim():(WS.getConns()[0]||'');
            if(val){ var url=/^wss?:\/\//i.test(val)?val:'wss://webhook.xtoys.app/'+val; WS.connect(url); igFeedback('正在连接...'); }
            else igFeedback('请先输入 ID 或 wss:// 地址');
        }
        igCloseInput(); return;
    }
    // 重置
    if(MouseIn(940, 320, 100, 50)){ WS.closeAll(); igFeedback('已重置所有连接'); igCloseInput(); return; }

    // ── 左栏: 白名单输入框 ──────────────────
    if(MouseIn(280, 530, 420, 50)){
        s.activeInput='whitelist'; s.inputActive=true;
        ElementCreateInput('BCXToysIG_whitelist','text',s.wlInput,64);
        igAttachInputEnter('BCXToysIG_whitelist');
        return;
    }
    // 添加
    if(MouseIn(720, 530, 90, 50)){
        var el=document.getElementById('BCXToysIG_whitelist'); var nm=(el?el.value.trim():s.wlInput);
        if(nm){ var found=false; for(var i=0;i<whitelist.length;i++) if(whitelist[i].toLowerCase()===nm.toLowerCase()){ found=true; break; }
            if(!found){ whitelist.push(nm); savePos(); igFeedback('已添加: '+nm); s.wlInput=''; } else igFeedback(nm+' 已在白名单中'); }
        igCloseInput(); return;
    }
    // 移除
    if(MouseIn(825, 530, 90, 50)){
        var el=document.getElementById('BCXToysIG_whitelist'); var nm=(el?el.value.trim():s.wlInput);
        if(nm){ whitelist=whitelist.filter(function(n){ return n.toLowerCase()!==nm.toLowerCase(); }); savePos(); igFeedback('已移除: '+nm); s.wlInput=''; }
        igCloseInput(); return;
    }
    // 清空
    if(MouseIn(930, 530, 90, 50)){ whitelist=[]; savePos(); igFeedback('白名单已清空'); igCloseInput(); return; }

    // ── 右栏: 远程控制 ──────────────────────
    if(MouseIn(1450, 220, 130, 50)){
        remoteAllow=!remoteAllow;
        var rb=document.getElementById('bcp-remote'); if(rb){ rb.textContent=remoteAllow?'开':'关'; rb.style.background=remoteAllow?'#2e7d32':'#555'; }
        var sv=loadS(); sv.remoteAllow=remoteAllow; saveS(sv);
        igFeedback('远程控制已'+(remoteAllow?'开启':'关闭'));
        igCloseInput(); return;
    }
    // 状态广播
    if(MouseIn(1450, 290, 130, 50)){
        broadcastOn=!broadcastOn;
        var bb=document.getElementById('bcp-bcast'); if(bb){ bb.textContent=broadcastOn?'开':'关'; bb.style.background=broadcastOn?'#2e7d32':'#555'; }
        var sv=loadS(); sv.broadcastOn=broadcastOn; saveS(sv);
        igFeedback('状态广播已'+(broadcastOn?'开启':'关闭'));
        igCloseInput(); return;
    }
    // 叠加模式
    if(MouseIn(1450, 370, 100, 50)){ zoneStackMode='max'; recalcZoneStack(); var zm=document.getElementById('bcp-zone-mode'); if(zm) zm.value='max'; igFeedback('叠加模式: 最高'); igCloseInput(); return; }
    if(MouseIn(1560, 370, 100, 50)){ zoneStackMode='add'; recalcZoneStack(); var zm=document.getElementById('bcp-zone-mode'); if(zm) zm.value='add'; igFeedback('叠加模式: 叠加'); igCloseInput(); return; }
    if(MouseIn(1670, 370, 100, 50)){ zoneStackMode='avg'; recalcZoneStack(); var zm=document.getElementById('bcp-zone-mode'); if(zm) zm.value='avg'; igFeedback('叠加模式: 平均'); igCloseInput(); return; }

    // ── 右栏: 快捷预设 ──────────────────────
    var pX=[1050,1190,1330,1470,1610], pV=[0,25,50,80,100], pY=580;
    for(var i=0;i<5;i++){
        if(MouseIn(pX[i], pY, 120, 50)){
            var v=pV[i];
            WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(v)],['itemName','IGPreset']]);
            curIntensity=v; toyMap['preset']=v; addLog('IGPreset','ItemVulva',v,'Self'); updUI(); maybeBroadcast();
            igFeedback('强度已设为 '+v+'%'); igCloseInput(); return;
        }
    }
    // 波形
    if(MouseIn(1750, 580, 160, 50)){
        if(waveRunning){ stopWave(); igFeedback('波形已停止'); }
        else { startWave('heartbeat',10,80,2000); igFeedback('心跳波形已启动'); }
        igCloseInput(); return;
    }

    // ── 右栏: 配对 ──────────────────────────
    if(MouseIn(1550, 720, 150, 50)){
        if(pairedPartner){ unpairPartner(); igFeedback('配对已断开'); }
        else { sharePairCode(); igFeedback('配对码已广播到聊天'); }
        igCloseInput(); return;
    }
    if(MouseIn(1720, 720, 130, 50)){ showHelp('pair'); igFeedback('配对帮助已发送到聊天'); igCloseInput(); return; }

    // 点击其他区域关闭输入
    if(s.activeInput) igCloseInput();
}

function igCloseInput(){
    var s=igScreen;
    if(s.activeInput==='webhook'){
        var el=document.getElementById('BCXToysIG_webhook'); if(el) el.remove();
    } else if(s.activeInput==='whitelist'){
        var el=document.getElementById('BCXToysIG_whitelist'); if(el){ s.wlInput=el.value.trim(); el.remove(); }
    }
    s.activeInput=null; s.inputActive=false;
}

// Enter 提交 / Esc 取消（替代失效的 CommonKeyDown hook）
function igAttachInputEnter(id){
    var el=document.getElementById(id); if(!el) return;
    el.addEventListener('keydown', function(e){
        if(e.key==='Enter'){ e.preventDefault(); igCloseInput(); }
        else if(e.key==='Escape'){ e.preventDefault(); igCloseInput(); }
    });
    setTimeout(function(){ try{ el.focus(); }catch(_){} }, 30);
}

function igExit(){
    igCloseInput();
    igScreen.open=false;
    igScreen.feedback='';
}

function igFeedback(msg){
    igScreen.feedback=msg;
    if(igScreen.feedbackTimer) clearTimeout(igScreen.feedbackTimer);
    igScreen.feedbackTimer=setTimeout(function(){ igScreen.feedback=''; },2500);
}

// ==================== 波形引擎 ====================
const WAVES = {
    sine:       {name:'正弦波 🌊', fn:function(t,mn,mx,sp){ var p=Math.sin(t/sp*Math.PI*2); return mn+(mx-mn)*(p+1)/2; }},
    square:     {name:'方波 ⏹️',   fn:function(t,mn,mx,sp){ return (Math.floor(t/sp*1000)%2===0)?mx:mn; }},
    triangle:   {name:'三角波 📐', fn:function(t,mn,mx,sp){ var p=(t/sp*1000)%2000/1000; return mn+(mx-mn)*(p<1?p:2-p); }},
    sawtooth:   {name:'锯齿波 🪚', fn:function(t,mn,mx,sp){ return mn+(mx-mn)*((t/sp*1000)%1000/1000); }},
    heartbeat:  {name:'心跳 💓',   fn:function(t,mn,mx,sp){ var p=t/sp*1000%2000; if(p<200) return mx; if(p<400) return mn; if(p<600) return mx; return mn; }},
    tease:      {name:'挑逗 😈',   fn:function(t,mn,mx,sp){ var p=Math.sin(t/sp*Math.PI*2); var v=mn+(mx-mn)*(p+1)/2; return v>mx*0.8?mn+Math.random()*20:v; }},
    turbulence: {name:'湍流 🌪️',   fn:function(t,mn,mx,sp){ var r=Math.random(); return (mx+mn)/2+(r-0.5)*(mx-mn); }},
    crescendo:  {name:'渐强 🎵',   fn:function(t,mn,mx,sp){ var c=t/sp*1000%1000/1000; return mn+(mx-mn)*Math.pow(c,2); }},
};

function startWave(type, min, max, speed){
    stopWave();
    var w=WAVES[type]; if(!w) return;
    var t0=Date.now();
    waveRunning={type:type, min:min, max:max, speed:speed||2000, start:t0};
    waveTimerId=setInterval(function(){
        if(!waveRunning) return;
        var elapsed=Date.now()-waveRunning.start;
        var v=Math.round(w.fn(elapsed,waveRunning.min,waveRunning.max,waveRunning.speed));
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(v)],['itemName','Wave_'+type]]);
        curIntensity=v; toyMap['wave']=v; updUI(); maybeBroadcast();
    },200);
    ChatRoomSendLocal('[🌊] 启动波形: '+w.name+' 范围 '+min+'%-'+max+'%',8000);
    addLog('Wave:'+w.name,'wave',(max+min)/2,'');
}

function stopWave(){
    if(waveTimerId) clearInterval(waveTimerId); waveTimerId=null;
    if(waveRunning) ChatRoomSendLocal('[🌊] 波形已停止',5000);
    waveRunning=null;
}

// ==================== 剧本/定时 ====================
function scriptRamp(targetPct, durationSec){
    if(scriptTimerId) clearInterval(scriptTimerId);
    var startPct=curIntensity, steps=Math.round(durationSec*5), step=0;
    ChatRoomSendLocal('[📜] 剧本: '+startPct+'% → '+targetPct+'% 用时 '+durationSec+'秒',8000);
    scriptTimerId=setInterval(function(){
        step++; var p=Math.min(1,step/steps);
        var v=Math.round(startPct+(targetPct-startPct)*p);
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(v)],['itemName','Script']]);
        curIntensity=v; toyMap['script']=v; updUI(); maybeBroadcast();
        if(step>=steps){ clearInterval(scriptTimerId); scriptTimerId=null; ChatRoomSendLocal('[📜] 剧本完成: '+targetPct+'%',5000); }
    },200);
}

function scriptTimer(minutes, targetPct){
    ChatRoomSendLocal('[⏱️] 定时器: '+minutes+'分钟后 → '+targetPct+'%',10000);
    setTimeout(function(){
        WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(targetPct)],['itemName','Timer']]);
        curIntensity=targetPct; toyMap['timer']=targetPct;
        addLog('Timer','timer',targetPct,''); updUI(); maybeBroadcast();
        ChatRoomSendLocal('[⏱️] 时间到! 强度 → '+targetPct+'%',8000);
    },minutes*60000);
}

// ==================== 自动响应 ====================
function checkAutoResponse(actionName, bodyPart){
    var keys=Object.keys(autoResponseMap);
    for(var i=0;i<keys.length;i++){
        var rule=autoResponseMap[keys[i]];
        if(rule.actions.indexOf(actionName)>=0&&(rule.parts.indexOf(bodyPart)>=0||rule.parts.indexOf('*')>=0)){
            if(rule.wave) startWave(rule.wave,rule.min||10,rule.max||curIntensity,rule.speed||2000);
            else { WS.sendFA('toyEvent',[['assetGroupName','ItemVulva'],['level',pctToLevel(rule.intensity)],['itemName','AutoResp']]); curIntensity=rule.intensity; toyMap['autoResp']=rule.intensity; }
            updUI(); maybeBroadcast(); addLog('AutoResp:'+actionName,bodyPart,rule.intensity||curIntensity,'');
            return;
        }
    }
}

// 预设自动响应规则
autoResponseMap['orgasm']    = {actions:['Orgasm','RuinedOrgasm','EdgeExplode'],parts:['*'],wave:'turbulence',min:60,max:100,speed:3000};
autoResponseMap['spankHard'] = {actions:['Spank','SpankItem','Slap','Kick'],parts:['ItemButt','ItemVulva'],intensity:70};
autoResponseMap['kissDeep']  = {actions:['FrenchKiss','Kiss','Lick','Nibble','Bite'],parts:['ItemMouth','ItemEar'],intensity:40};

// ==================== 帮助系统 ====================
function showHelp(topic){
    var h='';
    switch(topic){
        case 'main':
            h='[🎮] BC XToys v'+VER+' 帮助\n━━━━━━━━━━━━━━━━\n'+
              '/toy help basic    💡 基础命令\n/toy help remote   🔓 远程控制 & 白名单\n'+
              '/toy help pair     🔗 配对控制\n/toy help wave     🌊 波形引擎 (8种)\n'+
              '/toy help script   📜 剧本/定时\n/toy help zone     🔥 身体区域敏感度\n'+
              '/toy help auto     🤖 自动响应规则\n━━━━━━━━━━━━━━━━\n游戏内设置: 游戏设置 → 扩展插件 → XToys';
            break;
        case 'basic':
            h='[💡] 基础命令\n━━━━━━━━━━━━━━━━\n'+
              '/toy <0-100>  设置强度百分比\n/toy info     查看当前状态\n'+
              '/toy remote on|off  开关远程控制\n/toy broadcast on|off  开关广播\n\n'+
              '悬浮面板操作:\n  屏幕上 🎮 → 展开/隐藏  |  拖拽标题 → 移动\n  滑块+应用 → 手动强度  |  快捷预设 → 一键档位';
            break;
        case 'remote':
            h='[🔓] 远程控制 & 白名单\n━━━━━━━━━━━━━━━━\n'+
              '/toy remote on|off  开关远程控制\n'+
              '/toy allow <名>  加入白名单\n/toy block <名>  移出白名单\n/toy whitelist  查看白名单\n\n'+
              '白名单为空 → 所有人可控制\n白名单有人 → 仅白名单内可控制\n冷却时间: 同一玩家 3 秒内不可重复';
            break;
        case 'pair':
            h='[🔗] 配对控制\n━━━━━━━━━━━━━━━━\n'+
              '/toy pair share    生成6位配对码 (60秒有效)\n'+
              '/toy pair <code>   输入配对码连接\n'+
              '/toy pair stop     断开配对\n/toy pair limit <10-100>  限制最大强度\n\n'+
              '配对后对方面板可直接操控你的玩具\n强度限幅保护 / 随时一键断开';
            break;
        case 'wave':
            h='[🌊] 波形引擎 (8种)\n━━━━━━━━━━━━━━━━\n'+
              '/toy wave <类型> <最小> <最大> [速度ms]\n/toy wave stop  停止波形\n\n'+
              '  sine       🌊 正弦  square  ⏹️ 方波\n'+
              '  triangle   📐 三角  sawtooth 🪚 锯齿\n'+
              '  heartbeat  💓 心跳  tease   😈 挑逗\n'+
              '  turbulence 🌪️ 湍流  crescendo 🎵 渐强\n\n'+
              '例: /toy wave heartbeat 10 80 2000';
            break;
        case 'script':
            h='[📜] 剧本/定时\n━━━━━━━━━━━━━━━━\n'+
              '/toy ramp <目标%> [秒]   渐强剧本\n  例: /toy ramp 100 60\n\n'+
              '/toy timer <分钟> [强度%]  定时器\n  例: /toy timer 10 80';
            break;
        case 'zone':
            h='[🔥] 身体区域敏感度\n━━━━━━━━━━━━━━━━\n'+
              '私🌸100 环💍95 耳👂90 口👄85 头🎀80\n'+
              '胸💜75 颈💋70 臀🍑65 腰🩷60 头🧠55\n'+
              '腿🦵50 身👤45 臂💪40 脚🦶35 手🤲/靴👢30\n\n'+
              '动作加成: Shock/Orgasm+20 Spank/Slap+10 Caress-5\n'+
              '/toy zone list  查看完整列表\n/toy zone mode max|add|avg  堆叠模式';
            break;
        case 'auto':
            h='[🤖] 自动响应规则\n━━━━━━━━━━━━━━━━\n'+
              '预设: Orgasm→湍流60-100% / Spank→70% / Kiss→40%\n\n'+
              '/toy auto add <名> <强度> <动作列表> <部位列表>\n'+
              '  例: /toy auto add kiss 60 Kiss,Lick ItemMouth\n'+
              '/toy auto del <名>  删除规则\n/toy auto off  关闭所有自动响应';
            break;
        default:
            h='[🎮] 未知主题: '+topic+'  输入 /toy help 查看所有分类';
    }
    ChatRoomSendLocal(h, 30000);
}

// ==================== 聊天命令解析 ====================
function handleChatCommands(data){
    if(!data||!data.Content||data.Type!=='Chat') return false;
    var msg=data.Content.trim();
    if(!msg||msg.indexOf('/toy')!==0) return false;
    var sourceName=data.SenderName||sDict(data,'SourceCharacter','Name')||'Unknown';
    var parts=msg.split(/\s+/);
    if(parts.length<2){ showHelp('main'); return true; }
    var sub=parts[1].toLowerCase();

    if(sub==='help'){       showHelp(parts.length>=3?parts[2].toLowerCase():'main'); return true; }
    if(/^\d+$/.test(sub)){  handleRemoteCommand(sourceName,parseInt(sub)); return true; }

    if(sub==='info'){
        ChatRoomSendLocal('[🎮] '+Player.Name+' 状态:\n强度: '+curIntensity+'% '+intensityEmoji(curIntensity)+
            '\nWS: '+(WS.hasAnyConn()?'已连接('+WS.getConns().length+')':'未连接')+
            '  远程: '+(remoteAllow?'开':'关')+'  广播: '+(broadcastOn?'开':'关')+
            '\n白名单: '+(whitelist.length>0?whitelist.join(', '):'无(所有人可控制)'),20000);
        return true;
    }
    if(sub==='allow'&&parts.length>=3){
        var nm=parts.slice(2).join(' '), found=false;
        for(var i=0;i<whitelist.length;i++) if(whitelist[i].toLowerCase()===nm.toLowerCase()){ found=true; break; }
        if(!found){ whitelist.push(nm); savePos(); }
        ChatRoomSendLocal('[🎮] 白名单: '+(whitelist.length>0?whitelist.join(', '):'无'),10000); return true;
    }
    if(sub==='block'&&parts.length>=3){
        var nm=parts.slice(2).join(' ').toLowerCase();
        whitelist=whitelist.filter(function(n){ return n.toLowerCase()!==nm; }); savePos();
        ChatRoomSendLocal('[🎮] 白名单: '+(whitelist.length>0?whitelist.join(', '):'无'),10000); return true;
    }
    if(sub==='whitelist'||sub==='list'||sub==='wl'){
        ChatRoomSendLocal('[🎮] 白名单: '+(whitelist.length>0?whitelist.join(', '):'无(所有人可控制)'),10000); return true;
    }
    if(sub==='remote'&&parts.length>=3){
        remoteAllow=parts[2].toLowerCase()==='on';
        var rb=document.getElementById('bcp-remote'); if(rb){ rb.textContent=remoteAllow?'开':'关'; rb.style.background=remoteAllow?'#2e7d32':'#555'; }
        savePos(); ChatRoomSendLocal('[🎮] 远程控制已'+(remoteAllow?'开启':'关闭'),10000); return true;
    }
    if(sub==='broadcast'&&parts.length>=3){
        broadcastOn=parts[2].toLowerCase()==='on';
        var bb=document.getElementById('bcp-bcast'); if(bb){ bb.textContent=broadcastOn?'开':'关'; bb.style.background=broadcastOn?'#2e7d32':'#555'; }
        savePos(); ChatRoomSendLocal('[🎮] 广播已'+(broadcastOn?'开启':'关闭'),10000); return true;
    }
    if(sub==='pair'){
        if(parts.length<3){ ChatRoomSendLocal('[🎮] /toy pair share|stop|limit|<code>',10000); return true; }
        var act=parts[2].toLowerCase();
        if(act==='share'){ sharePairCode(); return true; }
        if(act==='stop'){  unpairPartner(); return true; }
        if(act==='limit'&&parts.length>=4){ var l=parseInt(parts[3]); pairLimitMax=Math.max(10,Math.min(100,l)); ChatRoomSendLocal('[🎮] 配对限幅: '+pairLimitMax+'%',8000); return true; }
        if(/^[A-Z2-9]{6}$/i.test(act)){ acceptPairCode(act.toUpperCase(),sourceName); return true; }
        return true;
    }
    if(sub==='wave'){
        if(parts.length<3||!WAVES[parts[2].toLowerCase()]){ var wl=Object.keys(WAVES).join(', '); ChatRoomSendLocal('[🌊] 波形: '+wl+'\n用法: /toy wave <类型> <最小> <最大> [速度ms]\n/toy wave stop',15000); return true; }
        var wact=parts[2].toLowerCase();
        if(wact==='stop'){ stopWave(); return true; }
        if(WAVES[wact]){ startWave(wact,parseInt(parts[3])||10,parseInt(parts[4])||80,parseInt(parts[5])||2000); return true; }
        return true;
    }
    if(sub==='ramp'&&parts.length>=3){  scriptRamp(Math.max(0,Math.min(100,parseInt(parts[2]))),parseInt(parts[3])||30); return true; }
    if(sub==='timer'&&parts.length>=3){ scriptTimer(Math.max(1,parseInt(parts[2])),Math.max(0,Math.min(100,parseInt(parts[3])||80))); return true; }
    if(sub==='zone'){
        if(parts.length<3){ ChatRoomSendLocal('[🔥] /toy zone list | mode max|add|avg',10000); return true; }
        if(parts[2]==='list'){ ChatRoomSendLocal('[🔥] '+Object.keys(BODY_ZONES).map(function(k){ var z=BODY_ZONES[k]; return z.label+z.sens+'%'; }).join(' '),20000); return true; }
        if(parts[2]==='mode'&&parts.length>=4){ var zm2=parts[3].toLowerCase(); if(zm2==='max'||zm2==='add'||zm2==='avg'){ zoneStackMode=zm2; recalcZoneStack(); ChatRoomSendLocal('[🔥] 叠加模式: '+zm2,5000); } return true; }
        return true;
    }
    if(sub==='auto'){
        if(parts.length<3){ ChatRoomSendLocal('[🤖] 规则: '+Object.keys(autoResponseMap).join(', ')+'\n/toy auto add <名> <强度> <动作> <部位>\n/toy auto del <名>\n/toy auto off',15000); return true; }
        if(parts[2]==='off'){ autoResponseMap={}; ChatRoomSendLocal('[🤖] 自动响应已全部关闭',5000); return true; }
        if(parts[2]==='del'&&parts.length>=4){ delete autoResponseMap[parts[3].toLowerCase()]; ChatRoomSendLocal('[🤖] 已删除: '+parts[3],5000); return true; }
        if(parts[2]==='add'&&parts.length>=6){ var rn=parts[3].toLowerCase(),ri=parseInt(parts[4]),ra=parts[5].split(','),rp=parts.length>=7?parts[6].split(','):['*'];
            autoResponseMap[rn]={actions:ra,parts:rp,intensity:Math.max(0,Math.min(100,ri))}; ChatRoomSendLocal('[🤖] 已添加规则: '+rn+' '+ri+'% 动作:'+ra.join(',')+' 部位:'+rp.join(','),8000); return true; }
        return true;
    }
    showHelp('main'); return true;
}

// ==================== 主逻辑 ====================
async function main(){
    log('v'+VER+' starting...');

    while(!window.hasOwnProperty('bcModSdk')){ await new Promise(function(r){ setTimeout(r,1000); }); log('waiting for bcModSdk...'); }
    await new Promise(function(r){
        var c=function(){
            var ok = typeof ServerIsConnected!=='undefined' && ServerIsConnected
                  && typeof ServerSocket!=='undefined' && typeof Commands!=='undefined'
                  && typeof Player!=='undefined' && Player && Player.MemberNumber;
            if(ok) r(); else setTimeout(c,500);
        }; c();
    });
    // 等待 PreferenceRegisterExtensionSetting 可用
    await new Promise(function(r){
        var c=function(){ if(typeof PreferenceRegisterExtensionSetting==='function') r(); else setTimeout(c,500); }; c();
    });

    log('SDK & Preference API ready');

    var modApi=bcModSdk.registerMod({ name:FULL, fullName:SHORT, version:VER, repository:'https://github.com/QAQMOON/XToys-Config' });

    // 单个 hook 失败不影响其余 hook 和 /toy 命令注册
    function safeHook(fnName, priority, cb){
        try{ modApi.hookFunction(fnName, priority, cb); return true; }
        catch(e){ log('hook 失败 ['+fnName+']: '+(e&&e.message||e)+' — 已跳过'); return false; }
    }

    // ── 注册游戏内扩展设置面板 ─────────────────────────────
    PreferenceRegisterExtensionSetting({
        Identifier: SHORT,
        ButtonText:  'XToys',
        Image:       'Icons/Magic.png',
        load:        igLoad,
        run:         igRun,
        click:       igClick,
        exit:        igExit,
    });
    log('游戏内设置面板已注册 ✅ (设置 → 扩展插件 → XToys)');

    // ── 创建悬浮面板 UI ────────────────────────────────────
    createUI();
    WS.uiCb=refDot;

    // ── Enter 键确认游戏内输入框 ──────────────────────────
    // 不 hook BC 的 CommonKeyDown（R128 已无此函数），直接监听 input keydown
    // （监听器在 igClick 创建 input 时挂载，见 igAttachInputEnter）

    // ── 注册 /toy 聊天命令 ────────────────────────────────
    if(!Commands.some(function(a){ return a.Tag==='toy'; })){
        Commands.push({
            Tag: 'toy',
            Description: 'XToys 玩具遥控。/toy help 查看帮助。',
            // BC Commands 标准签名: (args, msg, parsed)。msg 是完整原始命令，args 是 /toy 后面的内容
            Action: function(args, msg){
                var raw = (typeof msg==='string' && msg.indexOf('/toy')===0)
                          ? msg
                          : ('/toy ' + (typeof args==='string' ? args : ''));
                handleChatCommands({Content:raw, Type:'Chat', SenderName:Player&&Player.Name});
            }
        });
        log('/toy 命令已注册 ✅');
    }

    // ── 服务器重连 ────────────────────────────────────────
    safeHook('ServerSetConnected',2,function(args,next){ next(args); if(args[0]===true) WS.connectSaved(); });

    // ── 活动事件 ─────────────────────────────────────────
    function hActivities(data){
        if(data.Type!=='Activity') return;
        var g=sDict(data,'FocusAssetGroup','FocusGroupName'),n=sDict(data,'ActivityName'),a=sDict(data,'ActivityAsset','AssetName');
        var t=sDict(data,'TargetCharacter','MemberNumber'),s=sDict(data,'SourceCharacter','MemberNumber');
        if(!g||!n) return;
        if(t===Player.MemberNumber){
            var zi=calcZoneIntensity(g,n);
            WS.sendFA('activityEvent',[['assetGroupName',g],['actionName',n],['assetName',a]]);
            WS.sendFA('toyEvent',[['assetGroupName',g],['level',zi.level],['itemName',n]]);
            updateActiveZone(g,n,zi.pct,'');
            curIntensity=Math.max(curIntensity,zoneStackTotal); toyMap[g]=zi.pct;
            addLog(n,g,zi.pct,a); checkAutoResponse(n,g);
        } else if(s===Player.MemberNumber){
            WS.sendFA('activityOnOtherEvent',[['assetGroupName',g],['actionName',n],['assetName',a]]);
        }
    }

    function hItemEquip(data){
        if(data.Type!=='Action'||sDict(data,'DestinationCharacter','MemberNumber')!==Player.MemberNumber||sDict(data,'SourceCharacter','MemberNumber')===Player.MemberNumber) return;
        var slot=sDict(data,'FocusAssetGroup','FocusGroupName'); if(!slot) return;
        if(data.Content==='ActionUse'){
            var nm=sDict(data,'NextAsset','AssetName'); if(!nm) return;
            WS.sendFA('itemAdded',[['assetName',nm],['assetGroupName',slot]]);
            var asset=pByName(nm); if(asset) ItemState.updAll(asset);
            updateActiveZone(slot,'ItemAdded',10,''); addLog('ItemAdded',slot,10,nm);
        } else if(data.Content==='ActionRemove'){
            var pn=sDict(data,'PrevAsset','AssetName'); if(!pn) return;
            WS.sendFA('itemRemoved',[['assetName',pn],['assetGroupName',slot]]);
            ItemState.clearAll(slot); delete activeZones[slot]; recalcZoneStack();
        }
    }

    function hToyEvents(data){
        if(data.Type!=='Action'||!(sDict(data,'DestinationCharacter','MemberNumber')===Player.MemberNumber||sDict(data,'DestinationCharacterName','MemberNumber')===Player.MemberNumber||sDict(data,'TargetCharacterName','MemberNumber')===Player.MemberNumber)) return;
        var an=sDict(data,'AssetName','AssetName'),asset=pByName(an),g=asset&&asset.Asset&&asset.Asset.Group&&asset.Asset.Group.Name;
        if(!g||!asset||!an) return;
        ItemState.updAll(asset); ItemState.sendSK(g,getSKL(data),an);
        updateActiveZone(g,'ToyEvent',toyMap[g]||30,'');
    }

    function hPortalLink(data){
        if(data.Type!=='Action') return;
        var g=sDict(data,'FocusAssetGroup','FocusGroupName'),a=sDict(data,'AssetName','AssetName');
        var t=sDict(data,'TargetCharacter'),s=sDict(data,'SourceCharacter');
        var n=null;
        switch(data.Content){
            case 'PortalLinkFunctionActivityCaress':       n='Caress';            break;
            case 'PortalLinkFunctionActivityKiss':         n='Kiss';              break;
            case 'PortalLinkFunctionActivityMasturbateHand':n='MasturbateHand';   break;
            case 'PortalLinkFunctionActivitySlap':         n='Slap';              break;
            case 'PortalLinkFunctionActivityMasturbateTongue':n='MasturbateTongue';break;
        }
        if(!g||!n||a!=='PortalPanties') return;
        if(t===Player.MemberNumber){ WS.sendFA('activityEvent',[['assetGroupName',g],['actionName',n],['assetName',a]]); updateActiveZone(g,n,30,'Portal'); addLog('Portal:'+n,g,30,a); }
        else if(s===Player.MemberNumber){ WS.sendFA('activityOnOtherEvent',[['assetGroupName',g],['actionName',n],['assetName',a]]); }
    }

    function hCustomItemText(slot,itemName,Content,itemRegex,offR,lowR,medR,highR,maxR){
        if(!itemRegex.test(Content)) return;
        var intensity=-1;
        if(offR.test(Content)) intensity=0; else if(lowR.test(Content)) intensity=1; else if(medR.test(Content)) intensity=2; else if(highR.test(Content)) intensity=3; else if(maxR.test(Content)) intensity=4;
        if(intensity===-1) return;
        ItemState.updProps('Vibration','toyEvent',slot,itemName||slot,intensity,0);
        updateActiveZone(slot,'CustomItem',intensity*20,''); addLog('Custom:'+itemName,slot,intensity*20,'');
    }

    function hCustomTextItems(data){
        if(data.Type!=='Action'||sDict(data,'DestinationCharacter','MemberNumber')!==Player.MemberNumber) return;
        hCustomItemText('ItemNipples','LactationPump',    data.Content,/LactationPumpPower/i,/ToOff/i,/LowSuction/i,/MediumSuction/i,/HighSuction/i,/MaximumSuction/i);
        hCustomItemText('ItemNipples','NippleSuctionCups',data.Content,/NipSuc/i,  /ToLoose/i,/ToLight/i,/ToMedium/i,/ToHeavy/i,/ToMaximum/i);
        hCustomItemText('ItemNipples','PlateClamps',      data.Content,/ItemNipplesPlate/i,/ClampsLoose/i,/ClampsLight/i,/ClampsMedium/i,/ClampsHeavy/i,/ClampsTight/i);
        hCustomItemText('ItemButt',   'ButtPump',         data.Content,/BPumps/i,  /ToEmpty/i,/ToLight/i,/ToInflated/i,/ToBloated/i,/ToMaximum/i);
    }

    // 防止脚本热重载导致多个监听器叠加
    if(!window.__BCXToysChatRoomListenerInstalled){
        window.__BCXToysChatRoomListenerInstalled = true;
        ServerSocket.on('ChatRoomMessage', async function(data){
            if(!data||!data.Content||!data.Type||IG_CT.has(data.Content)||IG_TP.has(data.Type)) return;
            if(handleChatCommands(data)) return;
            hPortalLink(data); hActivities(data); hItemEquip(data); hToyEvents(data); hCustomTextItems(data);
        });
    }

    // ── 游戏钩子 ──────────────────────────────────────────
    safeHook('VibratorModePublish',3,function(args,next){ next(args); if(args[1]&&args[1].MemberNumber===Player.MemberNumber){ var slot=args[2]&&args[2].Asset&&args[2].Asset.DynamicGroupName; if(slot){ var asset=pBySlot(slot); if(asset) ItemState.updAll(asset); } } });
    safeHook('ExtendedItemSetOption',7,function(args,next){ next(args); if(args.length>=6&&args[1]&&args[1].MemberNumber===Player.MemberNumber){ var item=args[2]; if(item&&item.Asset&&item.Asset.DynamicGroupName) ItemState.updAll(item); } });
    safeHook('InventoryWear',8,function(args,next){ var ret=next(args); if(args[0]&&args[0].MemberNumber===Player.MemberNumber){ var asset=pByName(args[1]); if(asset){ WS.sendFA('itemAdded',[['assetName',asset.Asset.Name],['assetGroupName',asset.Asset.DynamicGroupName]]); ItemState.updAll(asset); } } return ret; });
    safeHook('InventoryRemove',3,function(args,next){ if(args[0]&&args[0].MemberNumber===Player.MemberNumber){ var asset=pBySlot(args[1]); if(asset){ WS.sendFA('itemRemoved',[['assetName',asset.Asset.Name],['assetGroupName',asset.Asset.DynamicGroupName]]); ItemState.clearAll(args[1]); } } next(args); });
    safeHook('PropertyShockPublishAction',3,function(args,next){ var si=null; if(Array.isArray(args)&&args[1]&&args[1].Property) si=args[1]; else if(typeof DialogFocusItem!=='undefined'&&DialogFocusItem&&DialogFocusItem.Property) si=DialogFocusItem; if(si){ var l=si.Property.ShockLevel; if(l===null||l===undefined) l=1; ItemState.sendSK(si.Asset&&si.Asset.DynamicGroupName,l,si.Asset&&si.Asset.Name); } next(args); });

    // ── 定时广播 ──────────────────────────────────────────
    setInterval(function(){ maybeBroadcast(); }, 8000);

    log('v'+VER+' 已就绪 ✅');
    log('聊天: /toy help | 游戏内设置: 设置 → 扩展插件 → XToys');
    refDot();
}

main().catch(function(e){ console.error('['+SHORT+'] init error',e); });

})();
