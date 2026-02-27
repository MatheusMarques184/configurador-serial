const STRUCT_SIZE = 268;
const ENDERECO_DISPOSITIVO_485 = 0x99;
const DESTINATARIO_PADRAO = 0x01;

let port = null;
let reader = null;
let readLoopActive = false;
let sentBytes = 0;
let recvBytes = 0;
let recvBuffer = [];
let dirtyCheckboxes = new Set();
let isLoadingConfig = false;

// ─── RS485 PROTOCOL ───────────────────────────────────────
// Spec: START(0x01) + Header(10) + Data + CRC(2) + END(0x04)
// Escape applied to Header + Data + CRC before transmission
// Escaped chars: 0x01,0x02,0x03,0x04,0x05,0x10 → 0x10,(char+0x20)

const ESCAPE_CHARS = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x10]);

function calcCRC(buffer) {
    let crcWord = 0xFFFF;
    for (let i = 0; i < buffer.length; i++) {
        const newChar = buffer[i] & 0xFF;
        for (let j = 0; j < 8; j++) {
            let test = (newChar << (j + 8)) & 0xFFFF;
            test = (test ^ crcWord) & 0xFFFF;
            if (test & 0x8000) {
                crcWord = ((crcWord << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crcWord = (crcWord << 1) & 0xFFFF;
            }
        }
    }
    return crcWord;
}

function applyEscape(bytes) {
    const out = [];
    for (const b of bytes) {
        if (ESCAPE_CHARS.has(b)) {
            out.push(0x10);
            out.push((b + 0x20) & 0xFF);
        } else {
            out.push(b);
        }
    }
    return out;
}

function removeEscape(bytes) {
    const out = [];
    let i = 0;
    while (i < bytes.length) {
        if (bytes[i] === 0x10 && i + 1 < bytes.length) {
            out.push((bytes[i + 1] - 0x20) & 0xFF);
            i += 2;
        } else {
            out.push(bytes[i]);
            i++;
        }
    }
    return out;
}

function buildRS485Message(idMsg, payload, dest) {
    dest = dest !== undefined ? dest : DESTINATARIO_PADRAO;
    const data = payload || [];
    const len = data.length;

    // Header: ORIG_1, ORIG_0, DEST_1, DEST_0, ID_MSG, NUM_SEQ, NUM_PCTS, PCT_CORR, TAM_1, TAM_0
    const header = [
        0xEC,                      // ORIG_1 (PC type)
        0x01,                      // ORIG_0 (PC address)
        ENDERECO_DISPOSITIVO_485,  // DEST_1 (device type)
        dest,                      // DEST_0 (device address)
        idMsg,                     // ID_MSG
        0x00,                      // NUM_SEQ
        0x01,                      // NUM_PCTS
        0x01,                      // PCT_CORR
        (len >> 8) & 0xFF,         // TAM_DADOS_1
        len & 0xFF                 // TAM_DADOS_0
    ];

    const crc = calcCRC([...header, ...data]);
    const crcBytes = [(crc >> 8) & 0xFF, crc & 0xFF];

    const escaped = applyEscape([...header, ...data, ...crcBytes]);

    return new Uint8Array([0x01, ...escaped, 0x04]);
}

// ─── CONNECTION ───────────────────────────────────────────
async function toggleConnect() {
    if (port) {
        await disconnectSerial();
    } else {
        await connectSerial();
    }
}

async function connectSerial() {
    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
        setStatus('connected', 'Conectado');
        logEntry('info', 'Porta serial conectada');
        document.getElementById('btn-connect').textContent = 'Desconectar';
        document.getElementById('btn-connect').classList.add('connected');
        startReadLoop();
        setTimeout(() => lerConfiguracoes(), 500);
    } catch (e) {
        setStatus('disconnected', 'Desconectado');
        if (e.name !== 'NotSelectedError') {
            logEntry('error', 'Erro ao conectar: ' + e.message);
        }
        port = null;
    }
}

async function disconnectSerial() {
    readLoopActive = false;
    try {
        if (reader) { await reader.cancel(); reader = null; }
        if (port) { await port.close(); }
    } catch (e) {}
    port = null;
    setStatus('disconnected', 'Desconectado');
    logEntry('info', 'Porta serial desconectada');
    document.getElementById('btn-connect').textContent = 'Conectar';
    document.getElementById('btn-connect').classList.remove('connected');
    updateStats();
}

async function startReadLoop() {
    readLoopActive = true;
    while (port && port.readable && readLoopActive) {
        reader = port.readable.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    const bytes = Array.from(value);
                    recvBytes += bytes.length;
                    const hex = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                    logEntry('recv', hex, true);
                    updateStats();
                    tryParseConfig(bytes);
                }
            }
        } catch (e) {
            if (readLoopActive) logEntry('error', 'Erro de leitura: ' + e.message);
        } finally {
            reader.releaseLock();
            reader = null;
        }
    }
    if (port) disconnectSerial();
}

async function writeBytes(bytes) {
    if (!port || !port.writable) { logEntry('error', 'Porta não conectada'); return; }
    const writer = port.writable.getWriter();
    try {
        await writer.write(new Uint8Array(bytes));
        sentBytes += bytes.length;
        const hex = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        logEntry('sent', hex, true);
        updateStats();
    } finally {
        writer.releaseLock();
    }
}

// ─── STATUS / STATS ───────────────────────────────────────
function setStatus(state, text) {
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    dot.className = 'status-dot ' + state;
    dot.title = text;
    statusText.textContent = text;
}

function updateStats() {
    document.getElementById('stats-text').textContent =
        `TX: ${sentBytes} B   RX: ${recvBytes} B`;
}

function loadPorts() {
    logEntry('info', 'Clique em "Conectar" para selecionar a porta serial.');
}

// ─── TERMINAL LOG ─────────────────────────────────────────
function logEntry(type, text, isHex = false) {
    const log = document.getElementById('terminal-log');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const now = new Date();
    const time = now.toTimeString().substring(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const typeLabels = { sent: 'TX', recv: 'RX', info: 'INFO', error: 'ERR' };
    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-type ${type}">${typeLabels[type] || type}</span>
        <span class="log-hex">${isHex ? colorizeHex(text, type) : escapeHtml(text)}</span>
    `;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

function colorizeHex(hexStr, type) {
    const bytes = hexStr.split(' ');
    const n = bytes.length;
    if ((type === 'sent' || type === 'recv') && n >= 13) {
        return bytes.map((b, i) => {
            if (i === 0) return `<span class="byte byte-start">${b}</span>`;
            if (i === n - 1) return `<span class="byte byte-end">${b}</span>`;
            if (i >= n - 3) return `<span class="byte byte-crc">${b}</span>`;
            if (i <= 11) return `<span class="byte byte-header">${b}</span>`;
            return `<span class="byte byte-payload">${b}</span>`;
        }).join(' ');
    }
    return `<span class="byte">${bytes.join(' </span><span class="byte">')}</span>`;
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clearTerminal() {
    document.getElementById('terminal-log').innerHTML = '';
}

function terminalFocus() {
    document.getElementById('quick-payload').focus();
}

// ─── SEND FROM TERMINAL BAR ───────────────────────────────
async function sendFromTerminal() {
    if (!port) { logEntry('error', 'Porta não conectada'); return; }
    const useRS485 = document.getElementById('chk-hex-mode').checked;
    const payloadStr = document.getElementById('quick-payload').value.trim();
    if (useRS485) {
        const idMsg = parseHexOrDec(document.getElementById('quick-idmsg').value.trim());
        const dest = parseHexOrDec(document.getElementById('quick-dest').value.trim());
        const payload = hexStringToBytes(payloadStr);
        const frame = buildRS485Message(idMsg, payload, dest);
        await writeBytes(Array.from(frame));
    } else {
        const rawBytes = hexStringToBytes(payloadStr);
        if (rawBytes.length === 0) { logEntry('error', 'Nenhum byte para enviar'); return; }
        await writeBytes(rawBytes);
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement.id === 'quick-payload') {
        sendFromTerminal();
    }
});

// ─── HELPERS DE LEITURA DE CAMPOS ────────────────────────
function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

function getChecked(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
}

function setEl(id, v) {
    const el = document.getElementById(id);
    if (el) el.value = v;
}

function setChk(id, v) {
    const el = document.getElementById(id);
    if (el) el.checked = v;
}

// ─── SERIALIZAÇÃO DA STRUCT ───────────────────────────────
function serializeConfig() {
    const buf = new Uint8Array(STRUCT_SIZE);
    const view = new DataView(buf.buffer);
    let o = 0;

    function writeStr(str, maxLen) {
        for (let i = 0; i < maxLen; i++)
            buf[o + i] = i < str.length ? str.charCodeAt(i) & 0xFF : 0;
        o += maxLen;
    }
    function writeU8(v) { buf[o++] = clamp8(v); }
    function writeU16(v) { view.setUint16(o, clamp16(v), true); o += 2; }
    function writeU32(v) { view.setUint32(o, clampU32(v), true); o += 4; }
    function writeBool(v) { buf[o++] = v ? 1 : 0; }

    // APN: "apn,user,pass"
    const apnParts = getVal('apn').split(',');
    writeStr(apnParts[0] || '', 32);
    writeStr(apnParts[1] || '', 16);
    writeStr(apnParts[2] || '', 16);

    // server1: "host,port"
    const s1 = splitHostPort(getVal('server1'));
    writeStr(s1.host, 64);
    writeU16(s1.port);

    // timerTrans: "ignon,ignoff"
    const timers = getVal('timerTrans').split(',');
    writeU16(parseInt(timers[0]) || 0);
    writeU16(parseInt(timers[1]) || 0);

    // speed_buzz
    writeU8(parseInt(getVal('speed_buzz')) || 0);

    // rfid: "val0,val1"
    const rfidParts = getVal('rfid').split(',');
    writeU8(parseInt(rfidParts[0]) || 0);
    writeU8(parseInt(rfidParts[1]) || 0);

    writeBool(false);   // cfg_usa_eeprom
    writeU16(0);        // cfg_sim_pin
    writeBool(getChecked('ignVirtual'));
    writeU8(parseInt(getVal('anglesTrans')) || 0);
    writeU8(getChecked('overspeedRelay2') ? 1 : 0);
    writeU8(getChecked('rfidRelay2') ? 1 : 0);
    writeU8(0);         // cfg_buzz_volume
    writeU8(getChecked('rfidRelay1') ? 1 : 0);
    writeBool(false);   // cfg_delayed_auth_rfid
    writeBool(getChecked('overspeedRelay1'));
    writeU8(0);         // cfg_speed_buzz_km_modoviagem
    writeU32(0);        // cfg_speed_buzz_km_modoviagem_unixtime

    // server2: "host,port"
    const s2 = splitHostPort(getVal('server2'));
    writeStr(s2.host, 64);
    writeU16(s2.port);

    // speed_punish: "time_over,km,saida1,saida2"
    const sp = getVal('speed_punish').split(',');
    writeU8(parseInt(sp[0]) || 0);
    writeU8(parseInt(sp[1]) || 0);
    writeU8(parseInt(sp[2]) || 0);
    writeU8(parseInt(sp[3]) || 0);

    // mileage (uint32) — offset 223
    writeU32(parseInt(getVal('mileage')) || 0);

    // secondsMeter (uint32) — offset 227
    writeU32(parseInt(getVal('secondsMeter')) || 0);

    return Array.from(buf);
}

// ─── DESSERIALIZAÇÃO DA STRUCT ────────────────────────────
function deserializeConfig(bytes) {
    isLoadingConfig = true;
    if (bytes.length < STRUCT_SIZE) { isLoadingConfig = false; return; }
    const buf = new Uint8Array(bytes);
    const view = new DataView(buf.buffer);
    let o = 0;

    function readStr(maxLen) {
        let s = '';
        for (let i = 0; i < maxLen; i++)
            if (buf[o + i] !== 0) s += String.fromCharCode(buf[o + i]);
        o += maxLen;
        return s;
    }
    function readU8() { return buf[o++]; }
    function readU16() { const v = view.getUint16(o, true); o += 2; return v; }
    function readU32() { const v = view.getUint32(o, true); o += 4; return v; }
    function readBool() { return buf[o++] !== 0; }

    const apn = readStr(32);
    const apnUser = readStr(16);
    const apnPass = readStr(16);
    setEl('apn', [apn, apnUser, apnPass].filter(Boolean).join(','));

    const serverAddr = readStr(64);
    const serverPort = readU16();
    setEl('server1', serverPort ? `${serverAddr},${serverPort}` : serverAddr);

    const timerIgnOn = readU16();
    const timerIgnOff = readU16();
    setEl('timerTrans', `${timerIgnOn},${timerIgnOff}`);

    setEl('speed_buzz', readU8());

    const rfid0 = readU8();
    const rfid1 = readU8();
    setEl('rfid', `${rfid0},${rfid1}`);

    readBool();                                     // cfg_usa_eeprom
    readU16();                                      // cfg_sim_pin
    setChk('ignVirtual', readBool());
    setEl('anglesTrans', readU8());
    setChk('overspeedRelay2', readU8() !== 0);
    setChk('rfidRelay2', readU8() !== 0);
    readU8();                                       // cfg_buzz_volume
    setChk('rfidRelay1', readU8() !== 0);
    readBool();                                     // cfg_delayed_auth_rfid
    setChk('overspeedRelay1', readBool());
    readU8();                                       // cfg_speed_buzz_km_modoviagem
    readU32();                                      // cfg_speed_buzz_km_modoviagem_unixtime

    const serverAddr2 = readStr(64);
    const serverPort2 = readU16();
    setEl('server2', serverPort2 ? `${serverAddr2},${serverPort2}` : serverAddr2);

    const sp0 = readU8(); const sp1 = readU8();
    const sp2 = readU8(); const sp3 = readU8();
    setEl('speed_punish', `${sp0},${sp1},${sp2},${sp3}`);

    setEl('mileage', readU32());
    setEl('secondsMeter', readU32());

    logEntry('info', `Configuração carregada (${STRUCT_SIZE} bytes)`);
    isLoadingConfig = false;
}

// ─── PARSE CONFIG DO BUFFER RX ────────────────────────────
function tryParseConfig(bytes) {
    recvBuffer = recvBuffer.concat(bytes);

    while (true) {
        const startIdx = recvBuffer.indexOf(0x01);
        if (startIdx === -1) { recvBuffer = []; break; }

        const endIdx = recvBuffer.indexOf(0x04, startIdx + 1);
        if (endIdx === -1) { recvBuffer = recvBuffer.slice(startIdx); break; }

        const unescaped = removeEscape(recvBuffer.slice(startIdx + 1, endIdx));

        if (unescaped.length < 12) {
            recvBuffer = recvBuffer.slice(endIdx + 1);
            continue;
        }

        const header = unescaped.slice(0, 10);
        const dataLen = (header[8] << 8) | header[9];

        if (unescaped.length < 10 + dataLen + 2) {
            recvBuffer = recvBuffer.slice(endIdx + 1);
            continue;
        }

        const data = unescaped.slice(10, 10 + dataLen);
        const receivedCRC = (unescaped[10 + dataLen] << 8) | unescaped[10 + dataLen + 1];
        const calculatedCRC = calcCRC([...header, ...data]);

        if (receivedCRC !== calculatedCRC) {
            logEntry('error', `CRC inválido: recebido=0x${receivedCRC.toString(16).toUpperCase()}, calculado=0x${calculatedCRC.toString(16).toUpperCase()}`);
            recvBuffer = recvBuffer.slice(endIdx + 1);
            continue;
        }

        const idMsg = header[4];
        if (idMsg === 0x11 && dataLen === STRUCT_SIZE) {
            deserializeConfig(data);
        } else {
            logEntry('info', `Frame recebido: ID=0x${idMsg.toString(16).toUpperCase()}, ${dataLen} bytes`);
        }

        recvBuffer = recvBuffer.slice(endIdx + 1);
    }

    if (recvBuffer.length > 4096) recvBuffer = recvBuffer.slice(-2048);
}

// ─── CONFIG ACTIONS ───────────────────────────────────────
async function enviarConfiguracoes() {
    if (!port) { logEntry('error', 'Porta não conectada'); return; }

    const commands = [];

    const apn = getVal('apn');
    if (apn) commands.push(`APN,${apn}#`);

    const server1 = getVal('server1');
    if (server1) commands.push(`SERVER1,${server1}#`);

    const server2 = getVal('server2');
    if (server2) commands.push(`SERVER2,${server2}#`);

    const timer = getVal('timerTrans');
    if (timer) commands.push(`TIMER,${timer}#`);

    const angle = getVal('anglesTrans');
    if (angle) commands.push(`ANGLETMT,${angle}#`);

    const speedBuzz = getVal('speed_buzz');
    if (speedBuzz) commands.push(`SPEEDBUZZ,${speedBuzz}#`);

    if (dirtyCheckboxes.has('overspeedRelay1')) commands.push(`OVSPDRLY1,${getChecked('overspeedRelay1') ? 1 : 0}#`);
    if (dirtyCheckboxes.has('overspeedRelay2')) commands.push(`OVSPDRLY2,${getChecked('overspeedRelay2') ? 1 : 0}#`);

    const speedPunish = getVal('speed_punish');
    if (speedPunish) commands.push(`SPEEDPUNISH,${speedPunish}#`);

    const rfid = getVal('rfid');
    if (rfid) commands.push(`RFID,${rfid}#`);

    if (dirtyCheckboxes.has('rfidRelay1')) commands.push(`RFIDRLY1,${getChecked('rfidRelay1') ? 1 : 0}#`);
    if (dirtyCheckboxes.has('rfidRelay2')) commands.push(`RFIDRLY2,${getChecked('rfidRelay2') ? 1 : 0}#`);

    const mileage = getVal('mileage');
    if (mileage) commands.push(`MILEAGE,${mileage}#`);

    const secsMeter = getVal('secondsMeter');
    if (secsMeter) commands.push(`SECSMETER,${secsMeter}#`);

    if (dirtyCheckboxes.has('ignVirtual')) commands.push(`ACCLINE,${getChecked('ignVirtual') ? 1 : 0}#`);

    if (commands.length === 0) {
        logEntry('error', 'Nenhum campo preenchido para enviar');
        return;
    }

    logEntry('info', `Enviando ${commands.length} comando(s)...`);
    const payload = Array.from(new TextEncoder().encode(commands.join('')));
    const frame = buildRS485Message(0x01, payload, 0x01);
    await writeBytes(Array.from(frame));
    dirtyCheckboxes.clear();
    logEntry('info', 'Comandos enviados com sucesso');
}

async function lerConfiguracoes() {
    if (!port) { logEntry('error', 'Porta não conectada'); return; }
    recvBuffer = [];
    logEntry('info', 'Solicitando configuração do dispositivo...');
    const payload = Array.from(new TextEncoder().encode('STRUCT#'));
    const frame = buildRS485Message(0x01, payload, 0x01);
    await writeBytes(Array.from(frame));
}

// ─── GROUPS ──────────────────────────────────────────────
function toggleGroup(header) {
    header.classList.toggle('collapsed');
    const body = header.nextElementSibling;
    body.classList.toggle('hidden');
}

// ─── HELPERS ─────────────────────────────────────────────
function splitHostPort(str) {
    const lastComma = str.lastIndexOf(',');
    if (lastComma === -1) return { host: str, port: 0 };
    return { host: str.substring(0, lastComma), port: parseInt(str.substring(lastComma + 1)) || 0 };
}

function hexStringToBytes(str) {
    if (!str) return [];
    return str.split(/\s+/)
        .filter(s => s.length > 0)
        .map(s => parseInt(s.replace(/^0x/i, ''), 16))
        .filter(n => !isNaN(n) && n >= 0 && n <= 255);
}

function parseHexOrDec(str) {
    str = (str || '').trim();
    if (/^0x/i.test(str)) return parseInt(str, 16);
    return parseInt(str, 10) || 0;
}

function clamp8(v) { return Math.max(0, Math.min(255, v | 0)); }
function clamp16(v) { return Math.max(0, Math.min(65535, v | 0)); }
function clampU32(v) { return Math.max(0, Math.min(4294967295, v >>> 0)); }

// ─── INIT ─────────────────────────────────────────────────
if (!('serial' in navigator)) {
    setTimeout(() => logEntry('error', 'Web Serial API não suportada. Use Chrome ou Edge.'), 100);
}

['overspeedRelay1', 'overspeedRelay2', 'rfidRelay1', 'rfidRelay2', 'ignVirtual'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { if (!isLoadingConfig) dirtyCheckboxes.add(id); });
});
logEntry('info', 'Painel iniciado. Clique em "Conectar" para selecionar a porta serial.');
