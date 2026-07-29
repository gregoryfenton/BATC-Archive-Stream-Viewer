/* ==============================================================================
 * Application: BATC VOD & Live Rewind Stream Viewer with Stable Scrubbing & UTC Clock
 * File: server.js
 * Description: Node.js server exposing stored HLS streams with live SSE updates,
 *              playlist-accurate buffer and timestamp parsing (anchored strictly to .ts file modification times),
 *              disk usage, locked timeline scrubbing, real-time UTC broadcast clock,
 *              instant client synchronization, and automatic self-reloading.
 * ============================================================================== */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

// Configuration Settings
const PORT = 3000;
const ARCHIVE_DIR = '/var/lib/vz/vod/vod_archive';
const SCAN_INTERVAL_MS = 3000;

const app = express();
const server = http.createServer(app);

let activeStreamsMetadata = [];
let sseClients = [];

/* ------------------------------------------------------------------------------
 * Helper Functions & Logging
 * ------------------------------------------------------------------------------ */

function logEvent(moduleName, message) {
    try {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${moduleName}] ${message}`);
    } catch (err) {
        console.error(`[Error] Failed to format log message - ${err.message}`);
    }
}

// Scan archive directory and calculate precise duration and segment time blocks using file modification times
function scanArchiveDirectory() {
    try {
        if (!fs.existsSync(ARCHIVE_DIR)) {
            return [];
        }

        const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
        const detectedStreams = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const slug = entry.name;
                
                if (slug === 'www' || slug === 'vod_www') {
                    continue;
                }

                const streamPath = path.join(ARCHIVE_DIR, slug);
                const playlistPath = path.join(streamPath, 'index.m3u8');

                if (fs.existsSync(playlistPath)) {
                    let segmentCount = 0;
                    let totalSizeBytes = 0;
                    let totalDurationSeconds = 0;
                    let segmentsMetadata = [];
                    const format = 'HLS (TS)';

                    try {
                        const playlistContent = fs.readFileSync(playlistPath, 'utf8');
                        const lines = playlistContent.split('\n');
                        
                        let currentSegmentFilename = null;

                        for (let line of lines) {
                            if (line.endsWith('.ts')) {
                                currentSegmentFilename = line.trim();
                            }
                            if (line.startsWith('#EXTINF:')) {
                                const durationStr = line.replace('#EXTINF:', '').split(',')[0];
                                const duration = parseFloat(durationStr);
                                
                                if (!isNaN(duration)) {
                                    totalDurationSeconds += duration;
                                    segmentCount++;

                                    let segmentStartTime = new Date();
                                    if (currentSegmentFilename) {
                                        const tsFilePath = path.join(streamPath, currentSegmentFilename);
                                        if (fs.existsSync(tsFilePath)) {
                                            const tsStat = fs.statSync(tsFilePath);
                                            const fileEndTime = tsStat.mtimeMs;
                                            segmentStartTime = new Date(fileEndTime - (duration * 1000));
                                        }
                                    }

                                    segmentsMetadata.push({
                                        start: segmentStartTime.toISOString(),
                                        duration: duration
                                    });
                                }
                            }
                        }

                        // Calculate total disk usage
                        const files = fs.readdirSync(streamPath);
                        for (const file of files) {
                            const filePath = path.join(streamPath, file);
                            const stats = fs.statSync(filePath);
                            totalSizeBytes += stats.size;
                        }
                    } catch (e) {
                        // Ignore active lock errors during file read
                    }

                    let sizeFormatted = (totalSizeBytes / (1024 * 1024)).toFixed(1) + ' MB';
                    if (totalSizeBytes > 1024 * 1024 * 1024) {
                        sizeFormatted = (totalSizeBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
                    }

                    const hours = Math.floor(totalDurationSeconds / 3600);
                    const minutes = Math.floor((totalDurationSeconds % 3600) / 60);
                    let timeStoredFormatted = '';
                    if (hours > 0) {
                        timeStoredFormatted = `${hours}h ${minutes}m`;
                    } else if (minutes > 0) {
                        timeStoredFormatted = `${minutes}m`;
                    } else {
                        timeStoredFormatted = `${Math.floor(totalDurationSeconds)}s`;
                    }

                    detectedStreams.push({
                        slug: slug,
                        format: format,
                        segmentCount: segmentCount > 0 ? segmentCount : 0,
                        size: sizeFormatted,
                        timeStored: totalDurationSeconds > 0 ? timeStoredFormatted : 'Initializing...',
                        segmentsMetadata: segmentsMetadata
                    });
                }
            }
        }

        return detectedStreams.sort((a, b) => a.slug.localeCompare(b.slug));
    } catch (err) {
        logEvent('ArchiveScanner', `Error reading archive directory - ${err.message}`);
        return [];
    }
}

// Broadcast updated stream details to browser clients via SSE
function notifySseClients(updatedList) {
    try {
        const payload = `data: ${JSON.stringify(updatedList)}\n\n`;
        sseClients.forEach((client) => {
            try {
                client.res.write(payload);
            } catch (err) {
                logEvent('SSE', `Failed to send update to client ID ${client.id} - ${err.message}`);
            }
        });
    } catch (err) {
        logEvent('SSE', `Error broadcasting updates - ${err.message}`);
    }
}

// Poll filesystem for changes
function monitorStreams() {
    try {
        const currentStreams = scanArchiveDirectory();
        const hasChanged = JSON.stringify(currentStreams) !== JSON.stringify(activeStreamsMetadata);

        if (hasChanged) {
            activeStreamsMetadata = currentStreams;
            notifySseClients(activeStreamsMetadata);
        }
    } catch (err) {
        logEvent('StreamMonitor', `Error during stream monitoring cycle - ${err.message}`);
    }
}

/* ------------------------------------------------------------------------------
 * HTTP Routes & Middleware
 * ------------------------------------------------------------------------------ */

try {
    app.use('/streams', express.static(ARCHIVE_DIR, {
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.m3u8')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Content-Type', 'application/x-mpegURL');
            } else if (filePath.endsWith('.ts')) {
                res.setHeader('Content-Type', 'video/mp2t');
            }
        }
    }));

    app.get('/api/stream-events', (req, res) => {
        try {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const clientId = Date.now();
            sseClients.push({ id: clientId, res });

            res.write(`data: ${JSON.stringify(activeStreamsMetadata)}\n\n`);

            req.on('close', () => {
                sseClients = sseClients.filter(client => client.id !== clientId);
            });
        } catch (err) {
            res.status(500).end();
        }
    });

    // Main Web Front-end with Stable Scrubbing & Strict UTC Broadcast Clock
    app.get('/', (req, res) => {
        res.send(`<!DOCTYPE html>
<html lang="en-GB">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BATC Archive Stream Viewer</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        :root {
            --bg-color: #121212;
            --panel-bg: #1e1e1e;
            --text-color: #e0e0e0;
            --accent-color: #0084ff;
            --active-color: #00c853;
            --border-color: #333333;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            margin: 0;
            padding: 20px;
        }
        header {
            margin-bottom: 20px;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }
        h1 { font-size: 1.5rem; margin: 0 0 5px 0; }
        p.subtitle { margin: 0; color: #888888; font-size: 0.9rem; }
        .operator-tag { text-align: right; color: var(--accent-color); font-weight: bold; font-size: 0.95rem; }
        .container {
            display: grid;
            grid-template-columns: 320px 1fr;
            gap: 20px;
            height: calc(100vh - 110px);
        }
        .sidebar {
            background-color: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 15px;
            display: flex;
            flex-direction: column;
        }
        .sidebar h2 { font-size: 1.1rem; margin-top: 0; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; }
        .stream-list { list-style: none; padding: 0; margin: 0; overflow-y: auto; flex-grow: 1; }
        .stream-item {
            padding: 12px;
            margin-bottom: 8px;
            background-color: #2a2a2a;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .stream-item:hover { background-color: #383838; }
        .stream-item.active { border-left: 4px solid var(--accent-color); background-color: #333333; }
        .badge { background-color: var(--active-color); color: #000; font-size: 0.75rem; padding: 2px 6px; border-radius: 10px; font-weight: bold; }
        .player-panel {
            background-color: var(--panel-bg);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 15px;
            display: flex;
            flex-direction: column;
        }
        .player-top-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .player-header { font-weight: bold; font-size: 1.2rem; }
        .live-btn {
            background-color: #333;
            color: #aaa;
            border: 1px solid #444;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85rem;
            font-weight: bold;
            transition: all 0.2s;
        }
        .live-btn.is-live {
            background-color: var(--active-color);
            color: #000;
            border-color: var(--active-color);
        }
        .live-btn:hover { opacity: 0.9; }
        .stats-box {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 10px;
            margin-bottom: 15px;
            background: #252525;
            padding: 10px;
            border-radius: 4px;
            font-size: 0.85rem;
        }
        .stat-item span { display: block; color: #888; font-size: 0.75rem; text-transform: uppercase; }
        .stat-item strong { font-size: 0.95rem; color: #fff; }
        .video-wrapper {
            background-color: #000;
            flex-grow: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            overflow: hidden;
        }
        video { width: 100%; height: 100%; max-height: 70vh; outline: none; }
        .empty-state { color: #666; font-style: italic; }
    </style>
</head>
<body>
    <header>
        <div>
            <h1>BATC Archive Stream Viewer</h1>
            <p class="subtitle">14-Day Rolling Buffer - Dynamic Event Monitor</p>
        </div>
        <div class="operator-tag">Greg Fenton - M0ODZ</div>
    </header>
    <div class="container">
        <div class="sidebar">
            <h2>Active Streams</h2>
            <ul id="streamList" class="stream-list">
                <li class="empty-state">Synchronising...</li>
            </ul>
        </div>
        <div class="player-panel">
            <div class="player-top-bar">
                <div id="playerTitle" class="player-header">No Stream Selected</div>
                <button id="skipToLiveBtn" class="live-btn" onclick="skipToLive()" title="Jump to live edge">LIVE</button>
            </div>
            <div class="stats-box">
                <div class="stat-item"><span>Format</span><strong id="statFormat">-</strong></div>
                <div class="stat-item"><span>Segments</span><strong id="statSegments">-</strong></div>
                <div class="stat-item"><span>Buffer Stored</span><strong id="statTime">-</strong></div>
                <div class="stat-item"><span>Disk Usage</span><strong id="statSize">-</strong></div>
                <div class="stat-item"><span>Broadcast Time (UTC)</span><strong id="statClock">-</strong></div>
            </div>
            <div class="video-wrapper">
                <video id="videoPlayer" controls autoplay muted></video>
            </div>
        </div>
    </div>
    <script>
        let currentSelectedStream = null;
        let hlsInstance = null;
        let cachedStreamsData = [];
        let hasInitialSeekDone = false;

        const videoElement = document.getElementById('videoPlayer');
        const streamListElement = document.getElementById('streamList');
        const playerTitleElement = document.getElementById('playerTitle');
        const liveBtnElement = document.getElementById('skipToLiveBtn');
        const clockElement = document.getElementById('statClock');

        function playStream(streamSlug) {
            if (currentSelectedStream !== streamSlug) {
                currentSelectedStream = streamSlug;
                hasInitialSeekDone = false;
            }
            playerTitleElement.textContent = "Stream Channel - " + streamSlug;
            updateStatsDisplay(streamSlug);

            const playlistUrl = "/streams/" + streamSlug + "/index.m3u8";
            if (hlsInstance) hlsInstance.destroy();

            if (Hls.isSupported()) {
                hlsInstance = new Hls({
                    enableWorker: true,
                    lowLatencyMode: true,
                    maxLiveSyncPlaybackRate: 1.5
                });
                hlsInstance.loadSource(playlistUrl);
                hlsInstance.attachMedia(videoElement);
                
                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                    videoElement.play().catch(() => {});
                    if (!hasInitialSeekDone) {
                        hasInitialSeekDone = true;
                        setTimeout(() => {
                            if (hlsInstance.liveSyncPosition) {
                                videoElement.currentTime = hlsInstance.liveSyncPosition;
                            } else if (videoElement.buffered.length > 0) {
                                videoElement.currentTime = Math.max(0, videoElement.buffered.end(videoElement.buffered.length - 1) - 2);
                            }
                        }, 200);
                    }
                });
            } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
                videoElement.src = playlistUrl;
                videoElement.addEventListener('loadedmetadata', () => {
                    videoElement.play();
                    if (!hasInitialSeekDone) {
                        hasInitialSeekDone = true;
                        if (videoElement.buffered.length > 0) {
                            videoElement.currentTime = Math.max(0, videoElement.buffered.end(videoElement.buffered.length - 1) - 2);
                        }
                    }
                });
            }
            updateActiveUiHighlight();
        }

        function skipToLive() {
            if (hlsInstance && hlsInstance.liveSyncPosition) {
                videoElement.currentTime = hlsInstance.liveSyncPosition;
            } else if (videoElement.buffered.length > 0) {
                const safeEdge = videoElement.buffered.end(videoElement.buffered.length - 1) - 0.5;
                videoElement.currentTime = Math.max(videoElement.buffered.start(0), safeEdge);
            }
            videoElement.play().catch(() => {});
        }

        videoElement.addEventListener('timeupdate', () => {
            if (videoElement.buffered.length > 0) {
                const liveEdge = videoElement.buffered.end(videoElement.buffered.length - 1);
                const latency = liveEdge - videoElement.currentTime;
                if (latency < 4.0) {
                    liveBtnElement.classList.add('is-live');
                } else {
                    liveBtnElement.classList.remove('is-live');
                }
            }
            updateBroadcastClock();
        });

        function updateBroadcastClock() {
            if (!currentSelectedStream) {
                clockElement.textContent = "-";
                return;
            }
            const stream = cachedStreamsData.find(s => s.slug === currentSelectedStream);
            if (!stream || !stream.segmentsMetadata || stream.segmentsMetadata.length === 0) {
                clockElement.textContent = "-";
                return;
            }

            const currentTimeOffset = videoElement.currentTime;
            let accumulatedTime = 0;
            let resolvedTime = null;

            for (let seg of stream.segmentsMetadata) {
                if (currentTimeOffset >= accumulatedTime && currentTimeOffset <= (accumulatedTime + seg.duration)) {
                    const offsetIntoSegment = currentTimeOffset - accumulatedTime;
                    const segStartDate = new Date(seg.start);
                    resolvedTime = new Date(segStartDate.getTime() + (offsetIntoSegment * 1000));
                    break;
                }
                accumulatedTime += seg.duration;
            }

            if (!resolvedTime && stream.segmentsMetadata.length > 0) {
                const lastSeg = stream.segmentsMetadata[stream.segmentsMetadata.length - 1];
                const lastSegDate = new Date(lastSeg.start);
                const extraOffset = currentTimeOffset - accumulatedTime;
                resolvedTime = new Date(lastSegDate.getTime() + (extraOffset * 1000));
            }

            if (resolvedTime && !isNaN(resolvedTime.getTime())) {
                clockElement.textContent = resolvedTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + " UTC";
            } else {
                clockElement.textContent = "Offline / Gap";
            }
        }

        function updateStatsDisplay(slug) {
            const stream = cachedStreamsData.find(s => s.slug === slug);
            if (stream) {
                document.getElementById('statFormat').textContent = stream.format;
                document.getElementById('statSegments').textContent = stream.segmentCount;
                document.getElementById('statTime').textContent = stream.timeStored;
                document.getElementById('statSize').textContent = stream.size;
            }
        }

        function updateActiveUiHighlight() {
            document.querySelectorAll('.stream-item').forEach(item => {
                if (item.getAttribute('data-slug') === currentSelectedStream) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
        }

        function renderStreamList(streams) {
            cachedStreamsData = streams;
            streamListElement.innerHTML = '';

            if (!streams || streams.length === 0) {
                streamListElement.innerHTML = '<li class="empty-state">No active stored streams found.</li>';
                playerTitleElement.textContent = "No Stream Selected";
                clockElement.textContent = "-";
                return;
            }

            streams.forEach(stream => {
                const li = document.createElement('li');
                li.className = 'stream-item' + (stream.slug === currentSelectedStream ? ' active' : '');
                li.setAttribute('data-slug', stream.slug);
                li.innerHTML = '<span>' + stream.slug + '</span><span class="badge">LIVE</span>';
                li.addEventListener('click', () => playStream(stream.slug));
                streamListElement.appendChild(li);
            });

            if (!currentSelectedStream && streams.length > 0) {
                playStream(streams[0].slug);
            } else if (currentSelectedStream) {
                updateStatsDisplay(currentSelectedStream);
            }
        }

        const initialPayload = ${JSON.stringify(activeStreamsMetadata)};
        if (initialPayload && initialPayload.length > 0) {
            renderStreamList(initialPayload);
        }

        const eventSource = new EventSource('/api/stream-events');
        eventSource.onmessage = (event) => {
            try {
                const streams = JSON.parse(event.data);
                renderStreamList(streams);
            } catch (err) {}
        };
    </script>
</body>
</html>`);
    });

} catch (err) {
    logEvent('ServerInit', `Error configuring routes - ${err.message}`);
}

/* ------------------------------------------------------------------------------
 * Application Startup Sequence & File Watcher
 * ------------------------------------------------------------------------------ */

server.listen(PORT, () => {
    logEvent('Startup', `VOD Server successfully started on port ${PORT}`);
    activeStreamsMetadata = scanArchiveDirectory();
    setInterval(monitorStreams, SCAN_INTERVAL_MS);

    try {
        fs.watch(__filename, (eventType) => {
            if (eventType === 'change') {
                logEvent('Watcher', 'server.js modified - restarting process automatically...');
                server.close(() => {
                    process.exit(0);
                });
            }
        });
    } catch (err) {
        logEvent('Watcher', `Failed to initialize file watcher - ${err.message}`);
    }
});
root@labby:/var/lib/vz# 
