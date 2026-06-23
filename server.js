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

const BRANCHED_ROWS = ['Servers', 'Services', 'Network Appliances', 'Cameras & Security'];
const SINGLE_ROWS = ['Websites'];
const BRANCHES = ['Argenta', 'Laman'];
const ALL_CATEGORIES = [...BRANCHED_ROWS, ...SINGLE_ROWS];

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

        // Initialize columns — branched categories split by Argenta/Laman, single categories flat
        const columns = {};
        for (const cat of BRANCHED_ROWS) {
            columns[cat] = { split: true, color: null, branches: { Argenta: [], Laman: [] } };
        }
        for (const cat of SINGLE_ROWS) {
            columns[cat] = { split: false, color: null, monitors: [] };
        }

        for (const monitorId of Object.keys(monitorCache)) {
            const monitor = monitorCache[monitorId];
            const tags = monitor.tags || [];

            const categoryTag = tags.find(t =>
                ALL_CATEGORIES.some(c => c.toLowerCase() === (t.name || '').trim().toLowerCase())
            );
            if (!categoryTag) continue;

            const categoryName = ALL_CATEGORIES.find(
                c => c.toLowerCase() === categoryTag.name.trim().toLowerCase()
            );
            const col = columns[categoryName];

            if (!col.color && categoryTag.color) {
                col.color = categoryTag.color;
            }

            const beats = hbData.heartbeatList?.[monitorId] || [];
            const lastBeat = beats[beats.length - 1];
            const status = lastBeat ? lastBeat.status : null;
            const recentBeats = beats.slice(-20).map(b => b.status);
            const monitorObj = { id: monitor.id, name: monitor.name, status, recentBeats };

            if (col.split) {
                const branchTag = tags.find(t =>
                    BRANCHES.some(b => b.toLowerCase() === (t.name || '').trim().toLowerCase())
                );
                if (!branchTag) continue; // skip monitors with no branch tag in a branched category
                const branchName = BRANCHES.find(
                    b => b.toLowerCase() === branchTag.name.trim().toLowerCase()
                );
                col.branches[branchName].push(monitorObj);
            } else {
                col.monitors.push(monitorObj);
            }
        }

        res.json({ columns, socketConnected, monitorCount: Object.keys(monitorCache).length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kuma viewer running at http://localhost:${PORT}`);
});