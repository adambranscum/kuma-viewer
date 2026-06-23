require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { io } = require('socket.io-client');

const app = express();
const PORT = process.env.PORT || 4000;

const KUMA_URL = process.env.KUMA_URL || 'http://localhost:3001';
const KUMA_USERNAME = process.env.KUMA_USERNAME;
const KUMA_PASSWORD = process.env.KUMA_PASSWORD;
const STATUS_PAGE_SLUG = process.env.STATUS_PAGE_SLUG || 'viewer';

const ROWS = [
    'Servers',
    'Applications',
    'Services',
    'Websites',
    'Network Appliances',
    'Cameras & Security'
];

// In-memory cache of monitor metadata (id -> { name, tags: [{name, color}] })
let monitorCache = {};
let socketConnected = false;

function connectSocket() {
    const socket = io(KUMA_URL, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 5000,
    });

    socket.on('connect', () => {
        console.log('Socket.IO connected, logging in...');
        socket.emit('login', { username: KUMA_USERNAME, password: KUMA_PASSWORD }, (res) => {
            if (res.ok) {
                console.log('Logged into Uptime Kuma via Socket.IO');
                socketConnected = true;
            } else {
                console.error('Uptime Kuma login failed:', res.msg);
            }
        });
    });

    // Uptime Kuma pushes the full monitor list (with tags) on this event
    socket.on('monitorList', (list) => {
        monitorCache = list || {};
        console.log(`Monitor list updated: ${Object.keys(monitorCache).length} monitors`);
    });

    socket.on('disconnect', () => {
        socketConnected = false;
        console.log('Socket.IO disconnected, will auto-reconnect');
    });

    socket.on('connect_error', (err) => {
        console.error('Socket.IO connect error:', err.message);
    });
}

connectSocket();

app.use(express.static('public'));

app.get('/api/status', async (req, res) => {
    try {
        // Live up/down status still comes from the public heartbeat endpoint
        const hbRes = await fetch(`${KUMA_URL}/api/status-page/heartbeat/${STATUS_PAGE_SLUG}`);
        if (!hbRes.ok) throw new Error(`heartbeat fetch failed: ${hbRes.status}`);
        const hbData = await hbRes.json();

        const rows = {};
        const rowColors = {};
        ROWS.forEach(r => {
            rows[r] = [];
            rowColors[r] = null;
        });

        for (const monitorId of Object.keys(monitorCache)) {
            const monitor = monitorCache[monitorId];
            const tags = monitor.tags || [];

            const matchedTag = tags.find(t =>
                ROWS.some(r => r.toLowerCase() === (t.name || '').trim().toLowerCase())
            );
            if (!matchedTag) continue;

            const matchedRow = ROWS.find(
                r => r.toLowerCase() === matchedTag.name.trim().toLowerCase()
            );

            if (!rowColors[matchedRow] && matchedTag.color) {
                rowColors[matchedRow] = matchedTag.color;
            }

            const beats = hbData.heartbeatList?.[monitorId] || [];
            const lastBeat = beats[beats.length - 1];
            const status = lastBeat ? lastBeat.status : null;

            rows[matchedRow].push({
                id: monitor.id,
                name: monitor.name,
                status,
            });
        }

        res.json({ rows, rowColors, socketConnected, monitorCount: Object.keys(monitorCache).length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kuma viewer running at http://localhost:${PORT}`);
});