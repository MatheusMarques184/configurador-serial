const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const ENDERECO_DISPOSITIVO_485 = 0x99;
const DESTINATARIO_PADRAO = 0x01;

let currentPort = null;

function buildRS485Header(idMsg, payloadSize, destinatario) {
    const header = Buffer.alloc(10);
    header[0] = 0x01;
    header[1] = ENDERECO_DISPOSITIVO_485;
    header[2] = 0xEC;
    header[3] = destinatario;
    header[4] = idMsg;
    header[5] = 0x00;
    header[6] = 0x01;
    header[7] = 0x01;
    header[8] = (payloadSize >> 8) & 0xFF;
    header[9] = payloadSize & 0xFF;

    if (idMsg === 0xFE || idMsg === 0xFF) {
        header[2] = 0xFF;
        header[3] = 0xFF;
    }

    return header;
}

function buildRS485Message(idMsg, payload, destinatario) {
    destinatario = destinatario !== undefined ? destinatario : DESTINATARIO_PADRAO;
    const payloadBuf = payload ? Buffer.from(payload) : Buffer.alloc(0);
    const header = buildRS485Header(idMsg, payloadBuf.length, destinatario);
    return Buffer.concat([header, payloadBuf]);
}

app.get('/api/ports', async (req, res) => {
    try {
        const ports = await SerialPort.list();
        res.json(ports);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/build-message', (req, res) => {
    try {
        const { idMsg, payload, destinatario } = req.body;
        const msg = buildRS485Message(idMsg, payload, destinatario);
        res.json({
            hex: Array.from(msg).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
            bytes: Array.from(msg),
            length: msg.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

io.on('connection', (socket) => {
    console.log('Cliente conectado via WebSocket');

    socket.on('serial:connect', (data) => {
        const { portPath, baudRate, dataBits, stopBits, parity } = data;

        if (currentPort && currentPort.isOpen) {
            currentPort.close();
            currentPort = null;
        }

        try {
            currentPort = new SerialPort({
                path: portPath,
                baudRate: parseInt(baudRate) || 9600,
                dataBits: parseInt(dataBits) || 8,
                stopBits: parseFloat(stopBits) || 1,
                parity: parity || 'none',
                autoOpen: false
            });

            currentPort.open((err) => {
                if (err) {
                    socket.emit('serial:error', { message: err.message });
                    currentPort = null;
                    return;
                }
                socket.emit('serial:connected', { portPath, baudRate });
            });

            currentPort.on('data', (data) => {
                const bytes = Array.from(data);
                const hex = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                socket.emit('serial:data', { hex, bytes, length: bytes.length });
            });

            currentPort.on('error', (err) => {
                socket.emit('serial:error', { message: err.message });
            });

            currentPort.on('close', () => {
                socket.emit('serial:disconnected');
            });

        } catch (err) {
            socket.emit('serial:error', { message: err.message });
        }
    });

    socket.on('serial:disconnect', () => {
        if (currentPort && currentPort.isOpen) {
            currentPort.close();
        } else {
            socket.emit('serial:disconnected');
        }
    });

    socket.on('serial:write', (data) => {
        if (!currentPort || !currentPort.isOpen) {
            socket.emit('serial:error', { message: 'Porta não conectada' });
            return;
        }

        let { idMsg, payload, destinatario, rawBytes } = data;

        let buffer;
        if (rawBytes && rawBytes.length > 0) {
            buffer = Buffer.from(rawBytes);
        } else {
            destinatario = destinatario !== undefined ? destinatario : DESTINATARIO_PADRAO;
            payload = payload || [];
            buffer = buildRS485Message(idMsg, payload, destinatario);
        }

        currentPort.write(buffer, (err) => {
            if (err) {
                socket.emit('serial:error', { message: err.message });
                return;
            }
            currentPort.drain(() => {
                const bytes = Array.from(buffer);
                const hex = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                socket.emit('serial:sent', { hex, bytes, length: bytes.length });
            });
        });
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
