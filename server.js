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

const COLUMN_CONFIG = {
    'Servers': { split: true, branches: ['Argenta', 'Laman'] },
    'Services': { split: true, branches: ['Argenta', 'Laman'] },
    'Network Appliances': { split: true, branches: ['Argenta', 'Laman'] },
    'Printers': { split: true, branches: ['Argenta', 'Laman'] },
    'Websites': { split: false },
    'Library Applications': { split: false },
    'Databases': { split: false },
};
const EXTRA_SECTION_TAGS = {};
const BRANCHED_ROWS = Object.entries(COLUMN_CONFIG).filter(([_, c]) => c.split).map(([k]) => k);
const SINGLE_ROWS = Object.entries(COLUMN_CONFIG).filter(([_, c]) => !c.split).map(([k]) => k);
const ALL_CATEGORIES = Object.keys(COLUMN_CONFIG);

let monitorCache = {};
let heartbeatCache = {};
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

    socket.on('monitorList', (list) => {
        monitorCache = list || {};
        console.log(`Monitor list updated: ${Object.keys(monitorCache).length} monitors`);
    });

    // Uptime Kuma sends this ONCE on initial load as a single object keyed
    // by monitor ID: { "1": [...beats], "2": [...beats] } - NOT as repeated
    // (monitorID, data) argument pairs. Loop over the keys to populate the
    // cache correctly for every monitor at once.
    socket.on('heartbeatList', (allBeats) => {
        if (!allBeats || typeof allBeats !== 'object') {
            console.error('Unexpected heartbeatList payload shape:', typeof allBeats);
            return;
        }
        for (const [monitorID, beats] of Object.entries(allBeats)) {
            heartbeatCache[String(monitorID)] = beats || [];
        }
        console.log(`Initial heartbeat history loaded for ${Object.keys(allBeats).length} monitors`);
    });

    socket.on('heartbeat', (data) => {
        const id = String(data.monitorID);
        if (!heartbeatCache[id]) heartbeatCache[id] = [];
        heartbeatCache[id].push(data);
        if (heartbeatCache[id].length > 50) {
            heartbeatCache[id] = heartbeatCache[id].slice(-50);
        }
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
        const hbRes = await fetch(`${KUMA_URL}/api/status-page/heartbeat/${STATUS_PAGE_SLUG}`);
        if (!hbRes.ok) throw new Error(`heartbeat fetch failed: ${hbRes.status}`);
        const hbData = await hbRes.json();

        const columns = {};
        for (const [cat, config] of Object.entries(COLUMN_CONFIG)) {
            if (config.split) {
                const branches = {};
                config.branches.forEach(b => branches[b] = []);
                const extra = {};
                (config.extraSections || []).forEach(e => extra[e] = []);
                columns[cat] = { split: true, color: null, branches, extraSections: extra };
            } else {
                columns[cat] = { split: false, color: null, monitors: [] };
            }
        }

        for (const monitorId of Object.keys(monitorCache)) {
            const monitor = monitorCache[monitorId];
            const tags = monitor.tags || [];

            const extraTag = tags.find(t =>
                EXTRA_SECTION_TAGS[t.name.trim()] !== undefined
            );
            if (extraTag) {
                const targetColName = EXTRA_SECTION_TAGS[extraTag.name.trim()];
                const col = columns[targetColName];
                if (col && col.extraSections && col.extraSections[extraTag.name.trim()] !== undefined) {
                    if (!col.color && extraTag.color) col.color = extraTag.color;
                    const beats = heartbeatCache[monitorId] || hbData.heartbeatList?.[monitorId] || [];
                    const lastBeat = beats[beats.length - 1];
                    const status = lastBeat ? lastBeat.status : null;
                    const msg = lastBeat ? lastBeat.msg : null;
                    const recentBeats = beats.slice(-20).map(b => b.status);
                    col.extraSections[extraTag.name.trim()].push({ id: monitor.id, name: monitor.name, status, msg, recentBeats });
                    continue;
                }
            }

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

            const beats = heartbeatCache[monitorId] || hbData.heartbeatList?.[monitorId] || [];
            const lastBeat = beats[beats.length - 1];
            const status = lastBeat ? lastBeat.status : null;
            const msg = lastBeat ? lastBeat.msg : null;
            const recentBeats = beats.slice(-20).map(b => b.status);
            const monitorObj = { id: monitor.id, name: monitor.name, status, msg, recentBeats };

            if (col.split) {
                const colBranches = COLUMN_CONFIG[categoryName].branches;
                const branchTag = tags.find(t =>
                    colBranches.some(b => b.toLowerCase() === (t.name || '').trim().toLowerCase())
                );
                if (!branchTag) continue;
                const branchName = colBranches.find(
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