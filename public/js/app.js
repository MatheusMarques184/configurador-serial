const STRUCT_SIZE = 268;
const DEVICE_INFO_SIZE = 55; // Status(1) + IMEI(8) + ICCID(8) + Lat(5) + Long(5) + Saida1(1) + Saida2(1) + In+1(1) + In+2(1) + In-1(1) + In-2(1) + Temp(2) + LetraVersao(1) + Version(1) + Subversion(1) + ADC(2) + Reserva(15)
const ENDERECO_DISPOSITIVO_485 = 0x99;
const DESTINATARIO_PADRAO = 0x01;
const timeRequestStruct = 2000; // ms

let port = null;
let reader = null;
let readLoopActive = false;
let sentBytes = 0;
let recvBytes = 0;
let recvBuffer = [];
let dirtyInputs = new Set();
let isLoadingConfig = false;
let map = null;
let mapMarker = null;

// polling/struct control
let pollInterval = null;
let shouldProcessStruct = false;

// send verification / retry
const MAX_SEND_RETRIES = 3;
let verifySnapshot = null;
let pendingCommands = null;
let retryAttempt = 0;
let verifyTimer = null;
let verifyStructReceived = false;

// Device Info
let deviceInfo = {
    statusConexao: '-',
    imei: '-',
    iccid: '-',
    temperatura: '-',
    versao: '-',
    adcPCBversion: '-',
    latitude: null,
    longitude: null,
    saida1: '-',
    saida2: '-',
    inPlus1: '-',
    inPlus2: '-',
    inMinus1: '-',
    inMinus2: '-'
};

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
		0x01,                      // ORIG_1 (PC type)
        ENDERECO_DISPOSITIVO_485,  // ORIG_0 (PC address)
        0xCF,					   // DEST_1 (device type)
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
        
        // on first connection we want to process the next struct
        shouldProcessStruct = true;
        startPolling();
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
    stopPolling();
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
    
    // Reset device info
    deviceInfo = {
        statusConexao: '-',
        imei: '-',
        iccid: '-',
        temperatura: '-',
        versao: '-',
        adcPCBversion: '-',
        latitude: null,
        longitude: null,
        saida1: '-',
        saida2: '-',
        inPlus1: '-',
        inPlus2: '-',
        inMinus1: '-',
        inMinus2: '-'
    };
    updateDeviceInfoDisplay();
    
    // Clear all configuration inputs
    document.querySelectorAll('[data-cmd]').forEach(el => {
        if (el.type === 'checkbox') {
            el.checked = false;
        } else {
            el.value = '';
        }
        el.classList.remove('input-invalid');
    });
    dirtyInputs.clear();
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
                    //logEntry('recv', hex, true);
                    //updateStats();
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

// ─── POLLING HELPERS ─────────────────────────────────────
function startPolling() {
    if (pollInterval !== null) return;
    // request struct every second (does not set processing flag)
    pollInterval = setInterval(() => {
        if (port) {
            // send request without toggling flag
            sendStructRequest();
        }
    }, timeRequestStruct);
}

function stopPolling() {
    if (pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

function resetPolling() {
    if (pollInterval !== null) {
        clearInterval(pollInterval);
    }
    pollInterval = setInterval(() => {
        if (port) {
            sendStructRequest();
        }
    }, timeRequestStruct);
}

async function writeBytes(bytes) {
    if (!port || !port.writable) {
        console.log('Porta não conectada');
        showCommandMessage('Porta não conectada', 'error');
        return;
    }
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
    // Terminal log disabled - moved to device info display
    //console.log(`[${type}] ${text}`);
}

// ─── SEND FROM TERMINAL BAR ───────────────────────────────
// async function sendFromTerminal() {
//     if (!port) { logEntry('error', 'Porta não conectada'); return; }
//     const useRS485 = document.getElementById('chk-hex-mode').checked;
//     const payloadStr = document.getElementById('quick-payload').value.trim();
//     if (useRS485) {
//         const idMsg = parseHexOrDec(document.getElementById('quick-idmsg').value.trim());
//         const dest = parseHexOrDec(document.getElementById('quick-dest').value.trim());
//         const payload = hexStringToBytes(payloadStr);
//         const frame = buildRS485Message(idMsg, payload, dest);
//         // pause polling during manual RS485 send
//         stopPolling();
//         await writeBytes(Array.from(frame));
//         setTimeout(() => { if (!pollInterval) startPolling(); }, 700);
//     } else {
//         const rawBytes = hexStringToBytes(payloadStr);
//         if (rawBytes.length === 0) { logEntry('error', 'Nenhum byte para enviar'); return; }
//         await writeBytes(rawBytes);
//     }
// }

// document.addEventListener('keydown', (e) => {
//     if (e.key === 'Enter' && document.activeElement.id === 'quick-payload') {
//         sendFromTerminal();
//     }
// });

// ─── HELPERS DE LEITURA DE CAMPOS ────────────────────────
function getVal(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked ? '1' : '0';
    return el.value.trim();
}

function setEl(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') { el.checked = (String(v) === '1'); return; }
    el.value = v;
}

function setSelectVal(id, v) {
    if (v != 0) v = 1;
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') { el.checked = (String(v) !== '0'); return; }
    const str = String(v);
    for (const opt of el.options) {
        if (opt.value === str) { el.value = str; return; }
    }
    el.value = '';
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

    writeStr(getVal('apn_apn'), 32);
    writeStr(getVal('apn_user'), 16);
    writeStr(getVal('apn_pass'), 16);

    writeStr(getVal('server1_host'), 64);
    writeU16(parseInt(getVal('server1_port')) || 0);

    writeU16(parseInt(getVal('timer_ignon')) || 0);
    writeU16(parseInt(getVal('timer_ignoff')) || 0);

    writeU8(parseInt(getVal('speedbuzz')) || 0);

    writeU8(parseInt(getVal('rfid')) || 0);
    writeU8(0);

    writeBool(false);
    writeU16(0);
    writeBool(getVal('accline') === '1');
    writeU8(parseInt(getVal('angletmt')) || 0);
    writeU8(getVal('ovspdrly2') !== '' ? parseInt(getVal('ovspdrly2')) : 0);
    writeU8(getVal('rfidrly2') !== '' ? parseInt(getVal('rfidrly2')) : 0);
    writeU8(0);
    writeU8(getVal('rfidrly1') !== '' ? parseInt(getVal('rfidrly1')) : 0);
    writeBool(false);
    writeBool(getVal('ovspdrly1') === '1');
    writeU8(0);
    writeU32(0);

    writeStr(getVal('server2_host'), 64);
    writeU16(parseInt(getVal('server2_port')) || 0);

    writeU8(parseInt(getVal('speedpunish_time')) || 0);
    writeU8(parseInt(getVal('speedpunish_duration')) || 0);
    writeU8(getVal('speedpunish_out1') !== '' ? parseInt(getVal('speedpunish_out1')) : 0);
    writeU8(getVal('speedpunish_out2') !== '' ? parseInt(getVal('speedpunish_out2')) : 0);

    writeU32(parseInt(getVal('mileage')) || 0);
    writeU32(parseInt(getVal('secsmeter')) || 0);

    return Array.from(buf);
}

// ─── DESSERIALIZAÇÃO DA STRUCT ────────────────────────────
function deserializeConfig(bytes) {
    if (bytes.length < STRUCT_SIZE) return;
    const buf = new Uint8Array(bytes);
    const view = new DataView(buf.buffer);
    let o = 0;

    function readStr(maxLen) {
        let s = '';
        for (let i = 0; i < maxLen; i++) {
            if (buf[o + i] === 0) break; // <-- para no primeiro null byte
            s += String.fromCharCode(buf[o + i]);
        }
        o += maxLen;
        return s;
    }
    function readU8() { return buf[o++]; }
    function readU16() { const v = view.getUint16(o, true); o += 2; return v; }
    function readU32() { const v = view.getUint32(o, true); o += 4; return v; }
    function readBool() { return buf[o++] !== 0; }

    setEl('apn_apn', readStr(32));
    setEl('apn_user', readStr(16));
    setEl('apn_pass', readStr(16));

    setEl('server1_host', readStr(64));
    setEl('server1_port', readU16() || '');

    setEl('timer_ignon', readU16() || '');
    setEl('timer_ignoff', readU16() || '');

    setEl('speedbuzz', readU8() || '');

    setSelectVal('rfid', readU8());

    readBool();
    readU16();

    setSelectVal('accline', readBool() ? 1 : 0);

    setEl('angletmt', readU8() || '');

    setSelectVal('ovspdrly2', readU8());
    setSelectVal('rfidrly2', readU8());

    readU8();

    setSelectVal('rfidrly1', readU8());

    readBool(); // rfid modo 2

    setSelectVal('ovspdrly1', readBool() ? 1 : 0);

    readU8();
    readU32();

    setEl('server2_host', readStr(64));
    setEl('server2_port', readU16() || '');

    setEl('speedpunish_time', readU8() || '');
    setEl('speedpunish_duration', readU8() || '');
    setSelectVal('speedpunish_out1', readU8());
    setSelectVal('speedpunish_out2', readU8());

    setEl('mileage', readU32() || '');
    setEl('secsmeter', readU32() || '');

    logEntry('info', `Configuração carregada (${STRUCT_SIZE} bytes)`);
    dirtyInputs.clear();
}

// ─── STATUS CONEXAO ENUM ──────────────────────────────────
const GSM_STATUS_MAP = {
    0: 'Início',
    1: 'Power Up',
    2: 'Comandos Iniciais',
    3: 'Verificando SIM',
    4: 'Buscando Rede',
    5: 'Tentando Conectar',
    6: 'Aguardando Conexão',
    7: 'Preparando Transmissão',
    8: 'Transmitindo Infos',
    9: 'Transmitindo Tracking',
    10: 'Transmitindo Memória',
    11: 'Conectado Ackado',
    12: 'Resetando Modem',
    13: 'Chip Ausente'
};

// ─── PARSE DEVICE INFO ────────────────────────────────────
function parseDeviceInfo(bytes) {
    if (bytes.length < DEVICE_INFO_SIZE) return;
    
    let offset = 0;
    
    const statusValue = bytes[offset++];
    deviceInfo.statusConexao = GSM_STATUS_MAP[statusValue] || `Desconhecido (${statusValue})`;

    const bytesView = new Uint8Array(bytes);
    const view = new DataView(bytesView.buffer, bytesView.byteOffset);
    
    deviceInfo.imei = view.getBigUint64(offset).toString().padStart(16, '0');
    offset += 8;

    deviceInfo.iccid = "89" + view.getBigUint64(offset).toString().padStart(16, '0');
    offset += 8;
    
    const latBytes = new Uint8Array(8); // 8 bytes zerados
    latBytes.set(bytes.slice(offset, offset + 5), 0); // copia 5 bytes no início
    const latitude = new DataView(latBytes.buffer).getFloat64(0, false);
    if (latitude !== 0) deviceInfo.latitude = latitude;
    offset += 5;

    // Longitude
    const lonBytes = new Uint8Array(8);
    lonBytes.set(bytes.slice(offset, offset + 5), 0);
    const longitude = new DataView(lonBytes.buffer).getFloat64(0, false);
    if (longitude !== 0) deviceInfo.longitude = longitude;
    offset += 5;

    // console.log("latitude: " + deviceInfo.latitude);
    // console.log("longitude: " + deviceInfo.longitude);
    
    // Saída 1 (1 byte)
    deviceInfo.saida1 = bytes[offset++] ? 'Acionada' : 'Inativa';
    
    // Saída 2 (1 byte)
    deviceInfo.saida2 = bytes[offset++] ? 'Acionada' : 'Inativa';
    
    // Entrada +1 (1 byte)
    deviceInfo.inPlus1 = bytes[offset++] ? 'Acionada' : 'Inativa';;
    
    // Entrada +2 (1 byte)
    deviceInfo.inPlus2 = bytes[offset++] ? 'Acionada' : 'Inativa';
    
    // Entrada -1 (1 byte)
    deviceInfo.inMinus1 = bytes[offset++] ? 'Acionada' : 'Inativa';
    
    // Entrada -2 (1 byte)
    deviceInfo.inMinus2 = bytes[offset++] ? 'Acionada' : 'Inativa';
    
    // Temperatura (2 bytes: 1st byte signed integer, 2nd byte unsigned decimal/100)
    const temperatureIntegerPart = (bytes[offset] << 24) >> 24; // sign-extend int8
    offset++;
    const temperatureDecimalPart = bytes[offset++];
    if (temperatureIntegerPart >= 0) {
        deviceInfo.temperatura = (temperatureIntegerPart + (temperatureDecimalPart / 100)).toFixed(2) + ' °C';
    } else {
        deviceInfo.temperatura = (temperatureIntegerPart - (temperatureDecimalPart / 100)).toFixed(2) + ' °C';
    }
    
    // LetraVersao (1 byte)
    const letraVersao = String.fromCharCode(bytes[offset++]);
    // Version (1 byte)
    const version = bytes[offset++];
    // Subversion (1 byte)
    const subversion = bytes[offset++];
    // Construct versao string
    deviceInfo.versao = letraVersao + version + '.' + subversion;
    
    // adcPCBversion (2 bytes) - unsigned 16-bit
    const adcRaw = (bytes[offset++] << 8) | bytes[offset++];
    deviceInfo.adcPCBversion = adcRaw;
    
    // Skip remaining 15 bytes of reserved space
    offset += 15;
    
    updateDeviceInfoDisplay();
}

// ─── UPDATE DEVICE INFO DISPLAY ────────────────────────────
// Helper: update element text and apply color based on active state
function updateIOElement(elId, value, activeValue = 'Acionada') {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = value;
    el.style.color = value === activeValue ? 'var(--red-dark)' : '';
}

function updateDeviceInfoDisplay() {
    document.getElementById('info-status-conexao').textContent = deviceInfo.statusConexao;
    document.getElementById('info-imei').textContent = deviceInfo.imei.trim() || '-';
    document.getElementById('info-iccid').textContent = deviceInfo.iccid.trim() || '-';
    document.getElementById('info-temperatura').textContent = deviceInfo.temperatura;
    document.getElementById('info-versao').textContent = deviceInfo.versao;
    document.getElementById('info-adc').textContent = deviceInfo.adcPCBversion;
    
    // Update I/O elements with conditional coloring
    const ioItems = [
        { id: 'info-saida1', value: deviceInfo.saida1 },
        { id: 'info-saida2', value: deviceInfo.saida2 },
        { id: 'info-in-plus1', value: deviceInfo.inPlus1 },
        { id: 'info-in-plus2', value: deviceInfo.inPlus2 },
        { id: 'info-in-minus1', value: deviceInfo.inMinus1 },
        { id: 'info-in-minus2', value: deviceInfo.inMinus2 }
    ];
    ioItems.forEach(item => updateIOElement(item.id, item.value));
    
    // Update map if coordinates available
    if (deviceInfo.latitude !== null && deviceInfo.longitude !== null) {
        updateMap(deviceInfo.latitude, deviceInfo.longitude);
    }
}
let firstTimeEL = true;
// Show a short-lived message in the UI between preset buttons and action buttons
function showCommandMessage(msg, type = 'info', timeoutMs = 2000) {
    const el = document.getElementById('command-msg');
    if (!el) return;
    // clear previous timers
    if (el._cmdClearTimer) { clearTimeout(el._cmdClearTimer); el._cmdClearTimer = null; }
    if (el._cmdHideTimer) { clearTimeout(el._cmdHideTimer); el._cmdHideTimer = null; }

    // set type class
    el.classList.remove('info', 'error');
    el.classList.add(type === 'error' ? 'error' : 'info');

    // perform fade-out then update text and fade-in to ensure visible change even if same text
    el.classList.add('hidden');

    if(firstTimeEL){
        el.textContent = msg;
        el.classList.remove('hidden');
        firstTimeEL = false;;
    }
   else {
        el._cmdHideTimer = setTimeout(() => {
            el.textContent = msg;
            el.classList.remove('hidden');
            el._cmdHideTimer = null;
        }, 220);
   }
    // if non-error, schedule automatic clear (fade out then clear text)
    if (timeoutMs > 0) {
        el._cmdClearTimer = setTimeout(() => {
            el.classList.add('hidden');
            // after fade completes, clear content and remove type classes
            el._cmdClearTimer = setTimeout(() => {
                if (el.textContent === msg) {
                    el.textContent = '';
                    el.classList.remove('info', 'error');
                }
                el._cmdClearTimer = null;
            }, 240);
        }, timeoutMs);
    }
}

// ─── MAP FUNCTIONS ────────────────────────────────────────
function initMap() {
    const mapContainer = document.getElementById('map');
    if (!mapContainer || map) return;
    
    // Default center (e.g., São Paulo, Brazil)
    const defaultLat = -23.42528;
    const defaultLng = -51.93861;
    
    map = L.map('map').setView([defaultLat, defaultLng], 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
        tileSize: 256
    }).addTo(map);
}

function updateMap(lat, lng) {
    if (!map) initMap();
    
    // Move map center
    map.setView([lat, lng], 15);
    
    // Remove old marker
    if (mapMarker) map.removeLayer(mapMarker);
    
    // Add new marker
    mapMarker = L.marker([lat, lng]).addTo(map)
        .bindPopup(`<b>Localização do Dispositivo</b><br>Lat: ${lat.toFixed(6)}<br>Lng: ${lng.toFixed(6)}`)
        .openPopup();
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
        let dataLen = (header[8] << 8) | header[9];
        //dataLen = dataLen + DEVICE_INFO_SIZE;

        // console.log("header: " + header);
        // console.log("dataLen: " + dataLen);
        // console.log("unescaped: " + unescaped);

        if (header[3] !== 0x99) { recvBuffer = recvBuffer.slice(endIdx + 1); continue; }

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
        if (idMsg === 0x01 && dataLen === (DEVICE_INFO_SIZE + STRUCT_SIZE)) {
            // always update device info; struct parameters only when flag is true
            const frameBytes = recvBuffer.slice(startIdx, endIdx + 1);
            const hex = frameBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
            logEntry('recv', hex, true);
            recvBytes += frameBytes.length;
            updateStats();
            
            const deviceInfoBytes = data.slice(0, DEVICE_INFO_SIZE);
            parseDeviceInfo(deviceInfoBytes);
            
            if (shouldProcessStruct) {
                const structBytes = data.slice(DEVICE_INFO_SIZE);
                deserializeConfig(structBytes);
                shouldProcessStruct = false;
                if (verifySnapshot !== null) {
                    onStructVerifyReceived();
                } else {
                    showCommandMessage('Configurações atualizadas', 'info');
                }
            }
        }

        recvBuffer = recvBuffer.slice(endIdx + 1);
    }

    if (recvBuffer.length > 4096) recvBuffer = recvBuffer.slice(-2048);
}

// ─── VALIDAÇÃO ────────────────────────────────────────────
function validateInputs() {
    let valid = true;

    const cmdMap = {};
    document.querySelectorAll('[data-cmd]').forEach(el => {
        el.classList.remove('input-invalid');
        const cmd = el.dataset.cmd;
        if (!cmdMap[cmd]) cmdMap[cmd] = [];
        cmdMap[cmd].push(el);
    });

    for (const cmd of Object.keys(cmdMap)) {
        const els = cmdMap[cmd];
        const elVal = el => el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value.trim();
        const filled = els.filter(el => elVal(el) !== '');
        const anyFilled = filled.length > 0;

        els.forEach(el => {
            const val = elVal(el);

            if (anyFilled && el.type !== 'checkbox' && val === '') {
                el.classList.add('input-invalid');
                valid = false;
            }

            // numeric bounds
            if (val !== '' && el.type === 'number') {
                const n = Number(val);
                const min = el.getAttribute('min');
                const max = el.getAttribute('max');
                if ((min !== null && n < Number(min)) || (max !== null && n > Number(max))) {
                    el.classList.add('input-invalid');
                    valid = false;
                }
            }

            // server host must be either valid IP or domain
            if ((el.id === 'server1_host' || el.id === 'server2_host') && val !== '') {
                if (!(isValidIP(val) || isValidDomain(val))) {
                    el.classList.add('input-invalid');
                    valid = false;
                }
            }
        });
    }

    return valid;
}

// ─── CONSTRUÇÃO DOS COMANDOS A PARTIR DOS INPUTS ──────────
function buildCommandsFromInputs() {
    const cmdMap = {};
    document.querySelectorAll('[data-cmd]').forEach(el => {
        const cmd = el.dataset.cmd;
        if (!dirtyInputs.has(cmd)) return;
        const idx = parseInt(el.dataset.idx);
        if (!cmdMap[cmd]) cmdMap[cmd] = {};
        cmdMap[cmd][idx] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim();
    });

    const commands = [];
    for (const cmd of Object.keys(cmdMap)) {
        const params = cmdMap[cmd];
        const indices = Object.keys(params).map(Number).sort((a, b) => a - b);
        const vals = indices.map(i => params[i]);

        const anyFilled = vals.some(v => v !== '');
        if (!anyFilled) continue;

        const trimmed = [...vals];
        while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();

        commands.push(`${cmd},${trimmed.join(',')}#`);
    }
    return commands;
}

// ─── CONFIG ACTIONS ───────────────────────────────────────
async function enviarConfiguracoes() {
    if (!port) {
        console.log('Porta não conectada');
        showCommandMessage('Porta não conectada', 'error');
        return;
    }

    if (!validateInputs()) {
        logEntry('error', 'Campos com valores inválidos. Corrija antes de enviar.');
        showCommandMessage('Campos com valores inválidos. Corrija antes de enviar.', 'error');
        return;
    }

    const commands = buildCommandsFromInputs();

    if (commands.length === 0) {
        logEntry('error', 'Nenhum campo preenchido para enviar');
        showCommandMessage('Nenhum campo preenchido para enviar', 'error');
        return;
    }

    retryAttempt = 0;
    pendingCommands = commands;
    verifySnapshot = captureCurrentConfig();
    await sendConfigWithRetry();
}

function captureCurrentConfig() {
    const snapshot = {};
    document.querySelectorAll('[data-cmd]').forEach(el => {
        if (!el.id) return;
        if (el.type === 'checkbox') {
            snapshot[el.id] = el.checked ? '1' : '0';
        } else {
            snapshot[el.id] = el.value.trim();
        }
    });
    return snapshot;
}

async function sendConfigWithRetry() {
    if (retryAttempt >= MAX_SEND_RETRIES) {
        openRetryFailedModal();
        return;
    }

    retryAttempt++;
    verifyStructReceived = false;
    shouldProcessStruct = true;

    const attemptMsg = retryAttempt > 1 ? ` (tentativa ${retryAttempt}/${MAX_SEND_RETRIES})` : '';
    logEntry('info', `Enviando ${pendingCommands.length} comando(s)${attemptMsg}...`);

    const payload = Array.from(new TextEncoder().encode(pendingCommands.join('')));
    const frame = buildRS485Message(0x02, payload, 0x01);

    resetPolling();
    await writeBytes(Array.from(frame));

    const sentSummary = pendingCommands.map(c => c.replace(/#$/, '')).join(' | ');
    console.log('Enviado: ' + sentSummary);

    const hexDB = Array.from(frame)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
    console.log(`📦 Frame (${hexDB.length} bytes): ${hexDB}`);

    showCommandMessage(`Enviados: ${sentSummary}${attemptMsg}`, 'info', 0);

    const waitTime = 600 + Math.random() * 300;
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(async () => {
        if (!verifyStructReceived) {
            console.log(`Timeout aguardando resposta (tentativa ${retryAttempt})`);
            logEntry('warn', `Sem resposta na tentativa ${retryAttempt}, reenviando...`);
            await sendConfigWithRetry();
        }
    }, waitTime);
}

function onStructVerifyReceived() {
    verifyStructReceived = true;
    if (verifyTimer) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
    }

    const currentConfig = captureCurrentConfig();
    let allMatch = true;
    const mismatches = [];

    for (const key in verifySnapshot) {
        const expected = verifySnapshot[key];
        const actual = currentConfig[key];
        if (expected !== actual) {
            allMatch = false;
            mismatches.push(key);
        }
    }

    if (allMatch) {
        console.log(`Verificação bem-sucedida na tentativa ${retryAttempt}`);
        logEntry('info', `Configurações aplicadas com sucesso (tentativa ${retryAttempt})`);
        showCommandMessage('Configurações aplicadas com sucesso', 'info');
        verifySnapshot = null;
        pendingCommands = null;
        retryAttempt = 0;
        dirtyInputs.clear();
    } else {
        console.log(`Verificação falhou (tentativa ${retryAttempt}): ${mismatches.length} campo(s) não correspondem`);
        logEntry('warn', `Verificação falhou (tentativa ${retryAttempt}): campos ${mismatches.join(', ')}`);
        sendConfigWithRetry();
    }
}

function openRetryFailedModal() {
    const modal = document.getElementById('retry-failed-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    logEntry('error', `Falha no envio após ${MAX_SEND_RETRIES} tentativas`);
    showCommandMessage(`Falha no envio após ${MAX_SEND_RETRIES} tentativas`, 'error', 0);
}

function closeRetryFailedModal(event) {
    const modal = document.getElementById('retry-failed-modal');
    if (!modal) return;
    if (event && event.target !== modal) return;
    modal.style.display = 'none';
    verifySnapshot = null;
    pendingCommands = null;
    retryAttempt = 0;
    if (verifyTimer) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
    }
}

function retryConfigSend() {
    const modal = document.getElementById('retry-failed-modal');
    if (modal) modal.style.display = 'none';
    if (verifyTimer) {
        clearTimeout(verifyTimer);
        verifyTimer = null;
    }
    retryAttempt = 0;
    if (pendingCommands && pendingCommands.length > 0) {
        sendConfigWithRetry();
    } else {
        showCommandMessage('Nenhum comando pendente para reenviar', 'error');
    }
}

// send the struct request without altering the processing flag
async function sendStructRequest() {
    if (!port) {
        console.log('Porta não conectada');
        showCommandMessage('Porta não conectada', 'error');
        return;
    }
    logEntry('info', 'Solicitando configuração do dispositivo...');
    const payload = Array.from(new TextEncoder().encode('STRUCT#'));
    const frame = buildRS485Message(0x01, payload, 0x01);
    await writeBytes(Array.from(frame));
}

async function lerConfiguracoes() {
    if (!port) { 
        console.log('Porta não conectada');
        showCommandMessage('Porta não conectada', 'error');
        return;
    }

    // next struct response should be parsed
    shouldProcessStruct = true;
    dirtyInputs.clear();
    recvBuffer = [];
    await sendStructRequest();
}

async function sendCommand(cmd) {
    if (!port) { 
        console.log('Porta não conectada');
        showCommandMessage('Porta não conectada', 'error');
        return; 
    }
    logEntry('info', `Enviando comando: ${cmd}`);
    const payload = Array.from(new TextEncoder().encode(cmd));
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
function hexStringToBytes(str) {
    if (!str) return [];
    return str.split(/\s+/)
        .filter(s => s.length > 0)
        .map(s => parseInt(s.replace(/^0x/i, ''), 16))
        .filter(n => !isNaN(n) && n >= 0 && n <= 255);
}

// ─── IP / DNS VALIDATION HELPERS ─────────────────────────
function isValidIP(str) {
    if (typeof str !== 'string') return false;
    const parts = str.split('.');
    if (parts.length !== 4) return false;
    for (const part of parts) {
        if (!/^[0-9]+$/.test(part)) return false;
        const num = parseInt(part, 10);
        if (num < 0 || num > 255) return false;
        if (part.length > 1 && part[0] === '0') return false; // no leading zeroes
    }
    return true;
}

function isValidDomain(str) {
    if (typeof str !== 'string') return false;
    const len = str.length;
    if (len < 3 || len > 253) return false;
    if (str[0] === '.' || str[0] === '-' || str[len - 1] === '.' || str[len - 1] === '-') {
        return false;
    }
    const labels = str.split('.');
    if (labels.length < 2) return false; // must contain at least one dot
    // Reject ambiguous dotted-quad-like strings that mix numeric and alpha labels,
    // e.g. "123.331.A42.120" should not be accepted as a domain (nor as an IP).
    if (labels.length === 4) {
        const anyNumericOnly = labels.some(l => /^[0-9]+$/.test(l));
        const anyAlpha = labels.some(l => /[A-Za-z]/.test(l));
        if (anyNumericOnly && anyAlpha) return false;
    }

    for (const lbl of labels) {
        if (lbl.length === 0 || lbl.length > 63) return false;
        if (!/^[a-zA-Z0-9-]+$/.test(lbl)) return false;
        if (lbl[0] === '-' || lbl[lbl.length - 1] === '-') return false;
    }

    return true;
}

function parseHexOrDec(str) {
    str = (str || '').trim();
    if (/^0x/i.test(str)) return parseInt(str, 16);
    return parseInt(str, 10) || 0;
}

function clamp8(v) { return Math.max(0, Math.min(255, v | 0)); }
function clamp16(v) { return Math.max(0, Math.min(65535, v | 0)); }
function clampU32(v) { return Math.max(0, Math.min(4294967295, v >>> 0)); }


// ─── REAL-TIME NUMBER VALIDATION & DIRTY TRACKING ────────
document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.hasAttribute('data-cmd')) return;
    dirtyInputs.add(el.dataset.cmd);
    // number fields are checked below, but host inputs also need validation
    const val = el.value.trim();
    if (val === '') { el.classList.remove('input-invalid'); setInputError(el, ''); return; }

    if (el.type === 'number') {
        const n = Number(val);
        const min = el.getAttribute('min');
        const max = el.getAttribute('max');
        let msg = '';
        if (max !== null && n > Number(max)) msg = 'Valor máximo permitido: ' + max;
        else if (min !== null && n < Number(min)) msg = 'Valor mínimo permitido: ' + min;
        el.classList.toggle('input-invalid', msg !== '');
        setInputError(el, msg);
        return;
    }

    // live validation for server hostname/IP
    if (el.id === 'server1_host' || el.id === 'server2_host') {
        let msg = '';
        if (val && !(isValidIP(val) || isValidDomain(val))) msg = 'IP/DNS inválido';
        el.classList.toggle('input-invalid', msg !== '');
        setInputError(el, msg);
    }
});

// Prevent non-digit keystrokes (e.g. '+', '-', 'e') on number inputs and sanitize paste
document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'number' || !el.hasAttribute('data-cmd')) return;

    const key = e.key;
    
    // Handle ArrowUp and ArrowDown for increment/decrement
    if (key === 'ArrowUp') {
        e.preventDefault();
        const currentVal = parseInt(el.value) || 0;
        const max = el.getAttribute('max');
        const newVal = max !== null ? Math.min(currentVal + 1, parseInt(max)) : currentVal + 1;
        el.value = newVal;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }
    if (key === 'ArrowDown') {
        e.preventDefault();
        const currentVal = parseInt(el.value) || 0;
        const min = el.getAttribute('min');
        const newVal = min !== null ? Math.max(currentVal - 1, parseInt(min)) : currentVal - 1;
        el.value = newVal;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }
    
    // Allow control/navigation keys
    const allowed = ['Backspace','Tab','ArrowLeft','ArrowRight','Delete','Home','End','Enter'];
    if (allowed.includes(key)) return;
    // Allow common shortcuts
    if ((e.ctrlKey || e.metaKey) && /^[acvxzy]$/i.test(key)) return;
    // Allow digits
    if (/^[0-9]$/.test(key)) return;

    // Block everything else (including '+', '-', 'e', '.')
    e.preventDefault();
});

document.addEventListener('paste', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'number' || !el.hasAttribute('data-cmd')) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    const cleaned = text.replace(/[^0-9]/g, '');
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const val = el.value || '';
    const newVal = val.slice(0, start) + cleaned + val.slice(end);
    el.value = newVal;
    el.dispatchEvent(new Event('input', { bubbles: true }));
});

document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.hasAttribute('data-cmd')) return;
    dirtyInputs.add(el.dataset.cmd);
});

document.addEventListener('click', (e) => {
    const label = e.target.closest('label[for]');
    if (!label) return;
    const input = document.getElementById(label.htmlFor);
    if (!input || !input.hasAttribute('data-cmd')) return;
    dirtyInputs.add(input.dataset.cmd);
});

function setInputError(el, msg) {
    let err = el.parentElement.querySelector('.input-error-msg');
    if (!err) { err = document.createElement('span'); err.className = 'input-error-msg'; el.parentElement.appendChild(err); }
    err.textContent = msg || '';
    err.classList.toggle('visible', !!msg);
}

// ─── PRESET MANAGEMENT ────────────────────────────────────
const PRESET_STORAGE_KEY = 'rs485_presets';
const EXCLUDED_CMDS = new Set(['MILEAGE', 'SECSMETER']);

function openPresetModal(mode) {
    const modal = document.getElementById('preset-modal');
    const title = document.getElementById('preset-modal-title');
    const savePanel = document.getElementById('preset-save-panel');
    const loadPanel = document.getElementById('preset-load-panel');
    const ioPanel = document.getElementById('preset-io-panel');

    // hide all by default
    savePanel.style.display = 'none';
    loadPanel.style.display = 'none';
    if (ioPanel) ioPanel.style.display = 'none';

    if (mode === 'save') {
        title.textContent = 'Salvar Preset';
        savePanel.style.display = 'block';
        document.getElementById('preset-name-input').value = '';
        setTimeout(() => document.getElementById('preset-name-input').focus(), 50);
    } else if (mode === 'load') {
        title.textContent = 'Carregar Preset';
        loadPanel.style.display = 'block';
        loadPresetList();
    } else if (mode === 'io') {
        title.textContent = 'Importar / Exportar Presets';
        if (ioPanel) ioPanel.style.display = 'flex';
    } else {
        // default to load if unknown
        title.textContent = 'Carregar Preset';
        loadPanel.style.display = 'block';
        loadPresetList();
    }

    modal.classList.add('open');
}

function closePresetModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('preset-modal').classList.remove('open');
}

function confirmSavePreset() {
    const name = document.getElementById('preset-name-input').value.trim();
    if (!name) {
        logEntry('error', 'Digite um nome para o preset');
        return;
    }

    const config = {};
    document.querySelectorAll('[data-cmd]').forEach(el => {
        const cmd = el.dataset.cmd;
        if (EXCLUDED_CMDS.has(cmd)) return;
        if (!el.id) return;

        if (el.type === 'checkbox') {
            config[el.id] = el.checked ? '1' : '0';
        } else {
            const val = el.value.trim();
            if (val !== '') config[el.id] = val;
        }
    });

    const presets = getPresets();
    const id = Date.now().toString();
    presets[id] = { name, date: new Date().toISOString(), config };
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    logEntry('info', `Preset "${name}" salvo com sucesso`);
    document.getElementById('preset-modal').classList.remove('open');
}

function getPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '{}'); }
    catch { return {}; }
}

function loadPresetList() {
    const presets = getPresets();
    const list = document.getElementById('preset-list');
    const empty = document.getElementById('preset-empty');
    list.innerHTML = '';

    const ids = Object.keys(presets).sort((a, b) => b - a);

    if (ids.length === 0) {
        empty.style.display = 'block';
        list.style.display = 'none';
        return;
    }

    empty.style.display = 'none';
    list.style.display = 'flex';

    ids.forEach(id => {
        const preset = presets[id];
        const date = new Date(preset.date);
        const dateStr = date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const item = document.createElement('div');
        item.className = 'preset-item';
        item.innerHTML = `
            <span class="preset-item-name" title="${preset.name}">${preset.name}</span>
            <span class="preset-item-date">${dateStr}</span>
            <button class="btn btn-preset-item-load" onclick="loadPreset('${id}')">Carregar</button>
            <button class="btn btn-preset-item-del" onclick="deletePreset('${id}')" title="Excluir">&#x1F5D1;</button>
        `;
        list.appendChild(item);
    });
}

function loadPreset(id) {
    const presets = getPresets();
    const preset = presets[id];
    if (!preset) { logEntry('error', 'Preset não encontrado'); return; }

    Object.keys(preset.config).forEach(elId => {
        const el = document.getElementById(elId);
        if (!el) return;
        const val = preset.config[elId];
        if (el.type === 'checkbox') {
            el.checked = (val === '1');
        } else {
            el.value = val;
        }
    });

    logEntry('info', `Preset "${preset.name}" carregado. Clique em "Enviar Configurações" para aplicar.`);
    document.getElementById('preset-modal').classList.remove('open');
    dirtyInputs.clear();
}

function deletePreset(id) {
    const presets = getPresets();
    const preset = presets[id];
    if (!preset) return;
    if (!confirm(`Excluir preset "${preset.name}"?`)) return;
    delete presets[id];
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    logEntry('info', `Preset "${preset.name}" excluído`);
    loadPresetList();
}

// export current presets to a JSON file
function exportPresets() {
    const presets = getPresets();
    const dataStr = JSON.stringify(presets, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
    a.download = `rs485-presets-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logEntry('info', 'Presets exportados');
    // close modal after exporting
    closePresetModal();
}

// handle file input change event
function handleImportPresets(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const imported = JSON.parse(e.target.result);
            importPresets(imported);
        } catch (err) {
            logEntry('error', 'Erro ao ler arquivo: ' + err.message);
        }
    };
    reader.readAsText(file);
    // reset input to allow re-importing same file
    event.target.value = '';
}

// merge imported presets into existing storage
function importPresets(imported) {
    if (typeof imported !== 'object' || imported === null) {
        logEntry('error', 'Arquivo de presets inválido');
        return;
    }
    const existing = getPresets();
    let count = 0;
    for (const key in imported) {
        const preset = imported[key];
        if (!preset || typeof preset !== 'object') continue;
        let newId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        while (existing[newId]) {
            newId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5);
        }
        existing[newId] = preset;
        count++;
    }
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(existing));
    logEntry('info', `Importados ${count} preset(s)`);
    loadPresetList();
    // close modal after importing
    closePresetModal();
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('preset-modal').classList.remove('open');
});

// ─── INIT ─────────────────────────────────────────────────
if (!('serial' in navigator)) {
    setTimeout(() => logEntry('error', 'Web Serial API não suportada. Use Chrome ou Edge.'), 100);
}

logEntry('info', 'Painel iniciado. Clique em "Conectar" para selecionar a porta serial.');

document.querySelectorAll('input, select').forEach(el => {
    const err = document.createElement('span'); err.className = 'input-error-msg'; el.parentElement.appendChild(err);
});

// Initialize map
setTimeout(() => initMap(), 100);

// --- Special command confirmation modal handlers ---
function openSpecialModal(cmd, label) {
    if (!port) {
        console.log('Porta não conectada');
        showCommandMessage('Porta não conectada', 'error');
        return;
    }
    const modal = document.getElementById('special-confirm-modal');
    const textEl = document.getElementById('special-confirm-text');
    const btn = document.getElementById('special-confirm-btn');
    if (!modal || !textEl || !btn) return;
    textEl.innerHTML = `Você tem certeza que deseja <span style="text-decoration: underline; color: var(--red-dark); font-weight: bold;">${label}</span>?`;
    // replace click handler
    btn.onclick = function () {
        try {
            sendCommand(cmd);
            showCommandMessage('Comando enviado', 'info');
        } catch (e) {
            console.error('Error sending special command', e);
            showCommandMessage('Erro ao enviar comando', 'error');
        }
        closeSpecialModal();
    };
    modal.style.display = 'flex';
}

function closeSpecialModal(event) {
    const modal = document.getElementById('special-confirm-modal');
    if (!modal) return;
    if (event && event.target && event.target !== modal) return;
    modal.style.display = 'none';
}
