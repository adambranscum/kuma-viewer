const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 4000;
const KUMA_BASE = 'http://localhost:3001';
const STATUS_PAGE_SLUG = 'viewer'; // <-- change this to match your slug

const ROWS = [
    'Servers',
    'Applications',
    'Services',
    'Websites',
    'Network Appliances',
    'Cameras & Security'
];

app.use(express.static('public'));

app.get('/api/status', async (req, res) => {
    try {
        const pageRes = await fetch(`${KUMA_BASE}/api/status-page/${STATUS_PAGE_SLUG}`);
        if (!pageRes.ok) throw new Error(`status-page fetch failed: ${pageRes.status}`);
        const pageData = await pageRes.json();

        const hbRes = await fetch(`${KUMA_BASE}/api/status-page/heartbeat/${STATUS_PAGE_SLUG}`);
        if (!hbRes.ok) throw new Error(`heartbeat fetch failed: ${hbRes.status}`);
        const hbData = await hbRes.json();

        const allMonitors = [];
        for (const group of pageData.publicGroupList || []) {
            for (const m of group.monitorList || []) {
                allMonitors.push(m);
            }
        }

        const rows = {};
        const rowColors = {};
        ROWS.forEach(r => {
            rows[r] = [];
            rowColors[r] = null; // fallback handled on frontend if no color found
        });

        for (const monitor of allMonitors) {
            const tags = monitor.tags || [];
            const matchedTag = tags.find(t =>
                ROWS.some(r => r.toLowerCase() === (t.name || '').trim().toLowerCase())
            );
            if (!matchedTag) continue;

            const matchedRow = ROWS.find(
                r => r.toLowerCase() === matchedTag.name.trim().toLowerCase()
            );

            // Capture the tag's color the first time we see it
            if (!rowColors[matchedRow] && matchedTag.color) {
                rowColors[matchedRow] = matchedTag.color;
            }

            const beats = hbData.heartbeatList?.[monitor.id] || [];
            const lastBeat = beats[beats.length - 1];
            const status = lastBeat ? lastBeat.status : null;

            rows[matchedRow].push({
                id: monitor.id,
                name: monitor.name,
                status,
            });
        }

        res.json({ rows, rowColors });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Kuma viewer running at http://localhost:${PORT}`);
});