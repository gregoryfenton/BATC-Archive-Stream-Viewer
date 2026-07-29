#!/bin/bash

# Configuration
VOD_DIR="/var/lib/vz/vod"
WEB_DIR="/var/lib/vz/vod/vod_www"
LOG_FILE="/var/lib/vz/vod/vod_startup.log"

echo "[$(date)] [Startup] Starting VOD services..." | tee -a "$LOG_FILE"

# 1. Start your archive/ingest process (adjust command if your script has a specific name)
if [ -f "$VOD_DIR/archive_streams.sh" ]; then
    echo "[$(date)] [VOD] Launching stream archiver..." | tee -a "$LOG_FILE"
    nohup bash "$VOD_DIR/archive_streams.sh" >> "$LOG_FILE" 2>&1 &
else
    echo "[$(date)] [VOD] Warning: archive_streams.sh not found in $VOD_DIR" | tee -a "$LOG_FILE"
fi

# 2. Start the Node.js Web Server
if [ -f "$WEB_DIR/server.js" ]; then
    echo "[$(date)] [Web] Stopping any running node server..." | tee -a "$LOG_FILE"
    pkill -f "node server.js" || true

    echo "[$(date)] [Web] Launching Node.js web server..." | tee -a "$LOG_FILE"
    cd "$WEB_DIR"
    nohup node server.js >> "$LOG_FILE" 2>&1 &
    echo "[$(date)] [Web] Server started successfully on port 3000." | tee -a "$LOG_FILE"
else
    echo "[$(date)] [Web] Error: server.js not found in $WEB_DIR" | tee -a "$LOG_FILE"
fi

echo "[$(date)] [Startup] All services initiated." | tee -a "$LOG_FILE"
