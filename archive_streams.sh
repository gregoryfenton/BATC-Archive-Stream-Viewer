#!/usr/bin/env bash

# ==============================================================================
# Script Name: archive_streams.sh
# Description: Continuous supervisor process that monitors stream_list.php for
#              active live streams, launches parallel FFmpeg recorders for RTMP,
#              and enforces a rolling 24-hour HLS buffer under /var/lib/vz/vod/vod_archive/.
# ==============================================================================

set -euo pipefail

# Configuration Parameters
VOD_DIR="/var/lib/vz/vod"
SUPERVISOR_PID_FILE="${VOD_DIR}/archive_streams.pid"
API_URL="https://batc.org.uk/live-api/stream_list.php"
RTMP_BASE_URL="rtmp://rtmp.batc.org.uk/live"
ARCHIVE_BASE_DIR="${VOD_DIR}/vod_archive"
POLL_INTERVAL=15       # Seconds between API checks
RETENTION_MINUTES=1440 # 24 Hours in minutes

# Ensure primary storage directory exists
mkdir -p "${ARCHIVE_BASE_DIR}"

# ------------------------------------------------------------------------------
# 0. Supervisor Single-Instance Enforcement (Kill and Replace Active PID)
# ------------------------------------------------------------------------------
if [ -f "${SUPERVISOR_PID_FILE}" ]; then
    OLD_SUPERVISOR_PID=$(cat "${SUPERVISOR_PID_FILE}")
    if [ -n "${OLD_SUPERVISOR_PID}" ] && kill -0 "${OLD_SUPERVISOR_PID}" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Archive] Existing supervisor instance detected (PID ${OLD_SUPERVISOR_PID}). Terminating and replacing..."
        kill -9 "${OLD_SUPERVISOR_PID}" 2>/dev/null || true
        sleep 1
    fi
    rm -f "${SUPERVISOR_PID_FILE}"
fi

# As an extra safety net against parallel spawns before PID file is written, 
# kill any other running instances of this script except ourself.
for other_pid in $(pgrep -f "archive_streams.sh"); do
    if [ "$other_pid" -ne "$$" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Archive] Terminating stray duplicate instance (PID ${other_pid})..."
        kill -9 "${other_pid}" 2>/dev/null || true
    fi
done

echo "$$" > "${SUPERVISOR_PID_FILE}"
trap "rm -f '${SUPERVISOR_PID_FILE}'; exit" INT TERM EXIT

# ------------------------------------------------------------------------------
# 1. Helper Functions
# ------------------------------------------------------------------------------

# Measure Keyframe (GOP) interval to calculate accurate segment parameters
get_stream_gop() {
    local rtmp_url="$1"
    
    local gop_sec
    gop_sec=$( (timeout 4s ffprobe -v error -rw_timeout 3000000 -select_streams v:0 \
        -show_entries frame=pkt_pts_time,key_frame \
        -of csv "${rtmp_url}" 2>/dev/null || true) \
        | python3 -c '
import sys
try:
    pts = []
    for line in sys.stdin:
        parts = line.strip().split(",")
        if len(parts) >= 2 and parts[1] == "1":
            try:
                pts.append(float(parts[0]))
                if len(pts) == 2:
                    break
            except ValueError:
                pass
    if len(pts) >= 2 and (pts[1] - pts[0]) > 0:
        print(f"{pts[1] - pts[0]:.2f}")
    else:
        print("2.00")
except Exception:
    print("2.00")
' )

    # Clean string output and ensure single-line fallback
    gop_sec=$(echo "${gop_sec}" | head -n 1 | tr -d '\r\n')

    if [ -z "${gop_sec}" ] || [ "${gop_sec}" = "0.00" ]; then
        gop_sec="2.00"
    fi

    echo "${gop_sec}"
}

# Run retention cleanup on disk
perform_retention_cleanup() {
    # Remove segment files older than 24 hours
    find "${ARCHIVE_BASE_DIR}" -type f \( -name "*.ts" -o -name "*.m4s" \) -mmin +"${RETENTION_MINUTES}" -delete 2>/dev/null || true
    # Remove empty directories (except base)
    find "${ARCHIVE_BASE_DIR}" -mindepth 1 -type d -empty -delete 2>/dev/null || true
}

# ------------------------------------------------------------------------------
# 2. Main Supervisor Loop
# ------------------------------------------------------------------------------

echo "=========================================================================="
echo "  BATC Continuous Live Stream Supervisor Started (PID $$)"
echo "  Storage Location: ${ARCHIVE_BASE_DIR}"
echo "  Poll Interval:    ${POLL_INTERVAL} seconds"
echo "=========================================================================="

while true; do
    # Perform background retention cleanup
    perform_retention_cleanup

    # Query API for current live stream status
    api_json=$(curl -s "${API_URL}" || true)

    if [ -n "${api_json}" ]; then
        # Parse active streams into a list of stream identifiers
        active_list=$(echo "${api_json}" | python3 -c '
import sys, json
try:
    data = json.loads(sys.stdin.read())
    members = data.get("members", []) if isinstance(data, dict) else data
    for item in members:
        is_active = item.get("active")
        if is_active and str(is_active) not in ["0", "false", "None"]:
            slug = item.get("stream_output_url") or item.get("file") or item.get("stream_title")
            if slug:
                print(str(slug).strip())
except Exception:
    pass
' 2>/dev/null | sort -u || true)

        # Convert active list to Bash array
        mapfile -t active_streams <<< "${active_list}"

        # Maintain map of currently desired active processes
        declare -A current_active_map=()

        for slug in "${active_streams[@]}"; do
            if [ -z "${slug}" ]; then
                continue
            fi

            current_active_map["${slug}"]=1
            stream_dir="${ARCHIVE_BASE_DIR}/${slug}"
            mkdir -p "${stream_dir}"

            pid_file="${stream_dir}/recorder.pid"
            rtmp_url="${RTMP_BASE_URL}/${slug}"
            playlist_path="${stream_dir}/index.m3u8"
            ffmpeg_log="${stream_dir}/ffmpeg.log"

            # Check if process is actively running
            is_running=0
            if [ -f "${pid_file}" ]; then
                existing_pid=$(cat "${pid_file}")
                if kill -0 "${existing_pid}" 2>/dev/null; then
                    is_running=1
                fi
            fi

            # If stream is active in API but process died or was not started
            if [ "${is_running}" -eq 0 ]; then
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stream detected/restarting: ${slug}. Probing keyframe interval..."

                gop_sec=$(get_stream_gop "${rtmp_url}")
                
                # Calculate window size safely using python
                list_size=$(python3 -c "import sys, math; print(math.ceil(86400 / float(sys.argv[1])))" "${gop_sec}")

                echo "  - Dynamic Keyframe Interval: ${gop_sec}s"
                echo "  - Playlist Window Size:     ${list_size} segments (24 Hours)"

                # Launch non-blocking FFmpeg recorder for RTMP input with 10-digit zero-padded segments
                nohup ffmpeg -hide_banner -loglevel error \
                    -rw_timeout 5000000 \
                    -i "${rtmp_url}" \
                    -c copy \
                    -f hls \
                    -hls_time "${gop_sec}" \
                    -hls_list_size "${list_size}" \
                    -hls_flags delete_segments+append_list \
                    -hls_segment_filename "${stream_dir}/segment_%010d.ts" \
                    "${playlist_path}" > "${ffmpeg_log}" 2>&1 &

                recorder_pid=$!
                echo "${recorder_pid}" > "${pid_file}"
                echo "  - Recorder process spawned (PID: ${recorder_pid})"
            fi
        done

        # Reconcile stopped streams: terminate recorders for streams no longer listed as active
        for dir in "${ARCHIVE_BASE_DIR}"/*; do
            if [ -d "${dir}" ]; then
                slug=$(basename "${dir}")
                pid_file="${dir}/recorder.pid"

                if [ -f "${pid_file}" ]; then
                    if [ -z "${current_active_map[${slug}]:-}" ]; then
                        running_pid=$(cat "${pid_file}")
                        if kill -0 "${running_pid}" 2>/dev/null; then
                            echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stream ${slug} went offline. Terminating PID ${running_pid}..."
                            kill "${running_pid}" 2>/dev/null || true
                        fi
                        rm -f "${pid_file}"
                    fi
                fi
            fi
        done
    fi

    # Wait for next evaluation tick
    sleep "${POLL_INTERVAL}"
done

exit 0
root@labby:/var/lib/vz# 
