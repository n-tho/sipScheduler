// ----------------------------------------------------------------------------
// nilstho-sipschedulerservice.js
// SIP Scheduler Service (AppService)
//
// - daily schedule via Config.run_at (HH:MM)
// - toggles /disabled flag for selected SIP interfaces (sip_mask, 1..16)
// - holds disabled state for Config.re_register (minutes)
// - recovers previous state on startup if needed
// ----------------------------------------------------------------------------

var serviceconns = [];
var appsocket_connect = null;

var sessionKey = null;
var devicesServiceUrl = null;
var devicesServiceName = null;
var devicesBaseHttpUrl = null;
var devicesConnecting = false;
var schedulerTimer = null;
var retryJobTimer = null;
var retryRecoverTimer = null;

// Standby
var failoverPending = false;
var failoverDone = false;
var failoverHoldTimer = null;
var failoverPollTimer = null;

var failoverActive = false;
var failbackPending = false;
var failbackPollTimer = null;
var failoverRetryTimer = null;

var isServicesOnMaster = false;
var isServicesOnStandby = false;

var cnMaster = "_STANDBY_";
var cnStandby = "_ACTIVE_";
// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
/**
 * Stop timeout if running
 * @param {number|null} ref - Timer reference to clear
 * @returns {null} Always returns null
 */
function stopTimeout(ref) {
    if (ref) {
        try { Timers.clearTimeout(ref); } catch (e) { }
    }
    return null;
}
/**
 * Start timeout after stopping previous one
 * @param {number|null} oldRef - Previous timer reference to stop first
 * @param {Function} fn - Callback function to execute
 * @param {number} ms - Delay in milliseconds
 * @returns {number} New timer reference
 */
function startTimeout(oldRef, fn, ms) {
    oldRef = stopTimeout(oldRef);
    return Timers.setTimeout(fn, ms);
}
/**
 * Transform http(s):// URL into ws(s):// URL
 * @param {string} url - HTTP(S) URL to transform
 * @returns {string} Transformed WS(S) URL
 */
function transformUrl(url) {
    if (!url) return url;
    if (url.indexOf("http://") === 0) return "ws://" + url.substr(7);
    if (url.indexOf("https://") === 0) return "wss://" + url.substr(8);
    return url;
}
/**
 * Parse runAt (HH:MM) into {h:HH, m:MM}
 * @param {string} runAt - Time string in HH:MM format
 * @returns {Object} Object with h (hours) and m (minutes) properties
 */
function parseRunAt(runAt) {
    var p = String(runAt || "00:00").split(":");
    var h = parseInt(p[0], 10); if (!(h >= 0 && h <= 23)) h = 0;
    var m = parseInt(p[1], 10); if (!(m >= 0 && m <= 59)) m = 0;
    return { h: h, m: m };
}
/**
 * Calculate ms until next run time based on runAt (HH:MM)
 * @param {string} runAt - Time string in HH:MM format
 * @returns {number} Milliseconds until next scheduled run time
 */
function msUntilNextRun(runAt) {
    var t = parseRunAt(runAt);

    var now = new Date();
    var next = new Date(now.getTime());
    next.setUTCHours(t.h, t.m, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);

    return next.getTime() - now.getTime();
}

/**
 * Format timestamp as "YYYY-MM-DD HH:MM:SS UTC"
 * @param {number} ts - Timestamp in milliseconds
 * @returns {string} Formatted timestamp string
 */
function fmtTs(ts) {
    var d = new Date(ts);
    return d.getUTCFullYear() + "-" +
        ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" +
        ("0" + d.getUTCDate()).slice(-2) + " " +
        ("0" + d.getUTCHours()).slice(-2) + ":" +
        ("0" + d.getUTCMinutes()).slice(-2) + ":" +
        ("0" + d.getUTCSeconds()).slice(-2) + " UTC";
}

/**
 * Convert bitmask to array of SIP interface numbers (1-16)
 * @param {number} mask - Bitmask where each bit represents a SIP interface
 * @returns {Array<number>} Array of SIP interface numbers
 */
function maskToSipList(mask) {
    mask = (mask | 0) >>> 0;
    var out = [];
    var i;
    for (i = 1; i <= 16; i++) {
        if (mask & (1 << (i - 1))) out.push(i);
    }
    return out;
}

// ---- HTTP helpers ----

/**
 * Decode helper for UTF-8 data, appends decoded data to buffer string
 * @param {string} bufStr - Current buffer string
 * @param {Uint8Array} data - Binary data to decode
 * @returns {string} Concatenated string with decoded data
 */
function appendUtf8(bufStr, data) {
    try {
        if (typeof TextDecoder !== "undefined") {
            return bufStr + (new TextDecoder("utf-8")).decode(data);
        }
    } catch (e) { }
    // fallback: best-effort
    try { return bufStr + String(data); } catch (e2) { }
    return bufStr;
}
/**
 * Simple HTTP GET returning full body as text
 * @param {string} url - URL to fetch
 * @param {Function} cb - Callback function(error, body)
 */
function httpGetText(url, cb) {
    var buf = "";
    HttpClient.request("GET", url)
        .onrecv(function (req, data, last) {
            buf = appendUtf8(buf, data);
            if (!last) req.recv();
        }, 2048)
        .oncomplete(function (req, ok) { cb(ok ? null : "GET failed", buf); })
        .onerror(function (err) { cb("HTTP error: " + err, null); });
}

// ----------------------------------------------------------------------------
// Logging helpers
// ----------------------------------------------------------------------------
/**
 * Convert value to safe string, handling undefined/null
 * @param {*} v - Value to convert
 * @returns {string} String representation or empty string
 */
function safeStr(v) {
    return (v === undefined || v === null) ? "" : String(v);
}
/**
 * Convert boolean to string representation
 * @param {*} v - Value to convert to boolean string
 * @returns {string} "true" or "false"
 */
function boolStr(v) {
    return v ? "true" : "false";
}
/**
 * Format MAC address or return placeholder if empty
 * @param {string} v - MAC address string
 * @returns {string} MAC address or "(none)"
 */
function macShort(v) {
    v = safeStr(v).trim();
    return v ? v : "(none)";
}

/**
 * Build passthrough command URL for device control
 * @param {string} baseUrl - Base HTTP URL of devices service
 * @param {string} mac - Device MAC address
 * @param {string} sessionKey - Session key for authentication
 * @param {string} cmd - Command to execute
 * @returns {string} Full command URL
 */
function passthroughCmdUrl(baseUrl, mac, sessionKey, cmd) {
    var cmdPath = encodeURI(cmd);
    return baseUrl + "/passthrough"
        + "/" + encodeURIComponent(mac)
        + "/" + encodeURIComponent(sessionKey)
        + "/" + cmdPath;
}

/**
 * Run passthrough command and return body as text
 * @param {string} baseUrl - Base HTTP URL of devices service
 * @param {string} mac - Device MAC address
 * @param {string} sessionKey - Session key for authentication
 * @param {string} cmd - Command to execute
 * @param {Function} cb - Callback function(error, body)
 */
function runCmd(baseUrl, mac, sessionKey, cmd, cb) {
    var url = passthroughCmdUrl(baseUrl, mac, sessionKey, cmd);
    httpGetText(url, function (err, body) {
        if (err) return cb && cb(err);
        cb && cb(null, body);
    });
}
/**
 * Find SIPx line in cfg.txt configuration text
 * @param {string} cfgText - Configuration file content
 * @param {number} sipIndex - SIP interface number (1-16)
 * @returns {string|null} The matching config line or null
 */
function findSipLine(cfgText, sipIndex) {
    var re = new RegExp("^config change RELAY0 SIP" + sipIndex + "\\b.*$", "m");
    var m = cfgText.match(re);
    return m ? m[0] : null;
}

/**
 * Check if SIP interface is disabled in configuration line
 * /disabled is a FLAG (no value). Disabled if token exists.
 * @param {string} line - Configuration line to check
 * @returns {boolean} True if /disabled flag is present
 */
function isSipDisabledInLine(line) {
    if (!line) return false;
    return (" " + line + " ").indexOf(" /disabled ") >= 0;
}
/**
 * Set or clear /disabled flag in SIP configuration line
 * @param {string} line - Configuration line to modify
 * @param {boolean} wantDisabled - True to add /disabled flag, false to remove
 * @returns {string} Modified configuration line
 */
function setDisabledFlagInLine(line, wantDisabled) {
    if (!line) return line;

    var has = (" " + line + " ").indexOf(" /disabled ") >= 0;

    if (wantDisabled) {
        if (has) return line;
        // Insert right after "... SIPx"
        return line.replace(/^(\s*config change RELAY0 SIP\d+\b)/, "$1 /disabled");
    }
    else {
        if (!has) return line;
        // Remove token
        line = line.replace(/\s\/disabled\b\s?/, " ");
        // Cleanup double spaces
        line = line.replace(/\s\s+/g, " ");
        return line;
    }
}
/**
 * Snapshot current /disabled state of selected SIP interfaces
 * @param {string} mac - Device MAC address
 * @param {Array<number>} sipList - Array of SIP interface numbers
 * @param {Function} cb - Callback function(error, stateObject)
 */
function snapshotPrevDisabled(mac, sipList, cb) {
    var cfgUrl = devicesBaseHttpUrl + "/passthrough/" + mac + "/" + sessionKey + "/cfg.txt";
    httpGetText(cfgUrl, function (err, cfgText) {
        if (err) return cb && cb(err, null);

        var prev = {};
        for (var i = 0; i < sipList.length; i++) {
            var idx = sipList[i];
            var line = findSipLine(cfgText, idx);
            prev[idx] = isSipDisabledInLine(line);
        }
        cb && cb(null, prev);
    });
}
/**
 * Restore SIP interfaces to previous disabled state
 * @param {Object} st - State object containing mac, sipList, and prev disabled states
 * @param {Function} cb - Callback function(error)
 */
function restoreFromState(st, cb) {
    if (!st || !st.sipList || !st.sipList.length) return cb && cb(null);

    var mac = String(st.mac || "").trim();
    if (!mac) return cb && cb("state missing mac");

    var cfgUrl = devicesBaseHttpUrl + "/passthrough/" + mac + "/" + sessionKey + "/cfg.txt";

    httpGetText(cfgUrl, function (err, cfgText) {
        if (err) return cb && cb("cfg fetch failed: " + err);

        var p = 0;

        function nextOne() {
            if (p >= st.sipList.length) return writeActivate();

            var idx = st.sipList[p++];
            var line = findSipLine(cfgText, idx);
            if (!line) {
                log("[RESTORE] missing SIP" + idx + " line in cfg.txt");
                return nextOne();
            }

            var wantDisabled = !!(st.prev && st.prev[idx]);
            var newLine = setDisabledFlagInLine(line, wantDisabled);
            var cmd = "!config " + newLine.replace(/^config\s+/, "");

            runCmd(devicesBaseHttpUrl, mac, sessionKey, cmd, function (err) {
                if (err) log("[RESTORE] change failed SIP" + idx + ": " + err);
                nextOne();
            });
        }

        // config write + activate after all changes
        function writeActivate() {
            runCmd(devicesBaseHttpUrl, mac, sessionKey, "!config write", function () {
                runCmd(devicesBaseHttpUrl, mac, sessionKey, "!config activate", function () {
                    cb && cb(null);
                });
            });
        }

        nextOne();
    });
}

// ------------------------------------------------------------
// Recovery on startup
// ------------------------------------------------------------
/**
 * Check if previous hold was active on startup, restore if needed
 */
function recoverIfNeeded() {
    retryRecoverTimer = stopTimeout(retryRecoverTimer);
    if (!devicesBaseHttpUrl || !sessionKey) return;

    dbLoadState(function (err, st) {
        if (err) { log("[RECOVER] state load error: " + err); return; }
        if (!st || !st.active) return;

        var now = Date.now();
        var until = Number(st.until || 0);

        function doRestore() {
            log("[RECOVER] restore scheduled at " + fmtTs(st.until));
            restoreFromState(st, function (e) {
                if (e) {
                    log("[RECOVER] restore failed: " + e + " -> retry in 60s");
                    // optional: retry later
                    scheduleRecoverRetryIn60s();
                    return;
                }
                dbClearState(function (ce) {
                    if (ce) log("[RECOVER] clear state failed: " + ce);
                    else log("[RECOVER] restore ok, state cleared");
                });
            });
        }

        if (until && now < until) {
            var rest = until - now;
            log("[RECOVER] hold still active, restore at " + fmtTs(st.until) +
                " (in " + Math.round(rest / 1000) + "s)");
            Timers.setTimeout(doRestore, rest);
        } else {
            log("[RECOVER] hold expired, restore now");
            doRestore();
        }
    });
}

// ------------------------------------------------------------
// Scheduler
// ------------------------------------------------------------
/**
 * Schedule next run based on Config.run_at (HH:MM)
 */
function scheduleNextRun() {
    schedulerTimer = stopTimeout(schedulerTimer);

    if (!Config || !Config.enabled) {
        log("[SCHED] disabled (Config.enabled=false)");
        return;
    }
    if (!devicesBaseHttpUrl || !sessionKey) {
        log("[SCHED] not ready yet -> will schedule when sessionKey is available");
        return;
    }
    var delay = msUntilNextRun(Config.run_at);
    log("[TIME] now_utc=" + fmtTs(Date.now()) + " run_at_utc=" + String(Config.run_at));


    log("[SCHED] next job at " + fmtTs((new Date()).getTime() + delay) +
        " (in " + Math.round(delay / 1000) + "s)");


    schedulerTimer = Timers.setTimeout(function () {
        runSchedulerJob(function () {
            scheduleNextRun();
        });
    }, delay);
}

/**
 * Retry scheduler job in 60 seconds
 */
function scheduleRetryIn60s() {
    retryJobTimer = startTimeout(retryJobTimer, function () {
        runSchedulerJob(function () { });
    }, 60000);
}
/**
 * Retry recovery in 60 seconds
 */
function scheduleRecoverRetryIn60s() {
    retryRecoverTimer = startTimeout(retryRecoverTimer, function () {
        recoverIfNeeded();
    }, 60000);
}
/**
 * Get hold time in milliseconds from Config.re_register (in minutes)
 * @returns {number} Hold time in milliseconds, minimum 60000 (1 minute)
 */
function getHoldMs() {
    var m = (Config && typeof Config.re_register === "number") ? Config.re_register : 1;
    if (!(m > 0)) m = 1;
    return Math.floor(m * 60000);
}

// ------------------------------------------------------------
// SIP config manipulation
// ------------------------------------------------------------
/**
 * Apply /disabled flag to selected SIP interfaces
 * @param {string} mac - Device MAC address
 * @param {Array<number>} sipList - Array of SIP interface numbers
 * @param {boolean} wantDisabled - True to disable, false to enable
 * @param {Function} cb - Callback function(error)
 */
function applyDisabledFlag(mac, sipList, wantDisabled, cb) {

    var cfgUrl = devicesBaseHttpUrl + "/passthrough/" + mac + "/" + sessionKey + "/cfg.txt";

    httpGetText(cfgUrl, function (err, cfgText) {
        if (err) return cb && cb(err);

        var lines = {};
        for (var i = 0; i < sipList.length; i++) {
            var idx = sipList[i];
            lines[idx] = findSipLine(cfgText, idx);
        }

        var p = 0;

        function nextChange() {
            if (p >= sipList.length) return writeActivate();

            var sipIdx = sipList[p++];
            var oldLine = lines[sipIdx];
            if (!oldLine) return nextChange();

            var newLine = setDisabledFlagInLine(oldLine, wantDisabled);
            var cmd = "!config " + newLine.replace(/^config\s+/, "");

            runCmd(devicesBaseHttpUrl, mac, sessionKey, cmd, function (err) {
                if (err) log("[JOB] change failed SIP" + sipIdx + ": " + err);
                nextChange();
            });

        }

        function writeActivate() {
            runCmd(devicesBaseHttpUrl, mac, sessionKey, "!config write", function () {
                runCmd(devicesBaseHttpUrl, mac, sessionKey, "!config activate", function () {
                    cb && cb(null);
                });
            });
        }

        nextChange();
    });
}

/**
 * Verify SIP interfaces have expected disabled state
 * @param {string} mac - Device MAC address
 * @param {Array<number>} sipList - Array of SIP interface numbers
 * @param {boolean} expectedDisabled - Expected disabled state
 * @param {Function} cb - Callback function(error)
 */
function verifyDisabledAfter(mac, sipList, expectedDisabled, cb) {
    var cfgUrl = devicesBaseHttpUrl + "/passthrough/" + mac + "/" + sessionKey + "/cfg.txt";
    httpGetText(cfgUrl, function (err, cfgText) {
        if (err) return cb && cb("cfg fetch failed: " + err);

        for (var i = 0; i < sipList.length; i++) {
            var idx = sipList[i];
            var line = findSipLine(cfgText, idx);
            var isDis = isSipDisabledInLine(line);
            if (!!isDis !== !!expectedDisabled) {
                return cb && cb("SIP" + idx + " expected disabled=" + expectedDisabled + " but got " + isDis);
            }
        }
        cb && cb(null);
    });
}

// ------------------------------------------------------------
// Scheduler Job
// ------------------------------------------------------------
/**
 * Disable selected SIP interfaces for hold time, then restore previous state
 * @param {Function} done - Callback function to execute when job completes
 */
function runSchedulerJob(done) {
    retryJobTimer = stopTimeout(retryJobTimer);

    if (failoverPending || failbackPending || failoverActive) {
        log("[JOB] skipped: failover state (pending/active)");
        return done && done();
    }

    dbLoadState(function (serr, s) {
        if (!serr && s && s.active) {
            var now = Date.now();
            if (s.until && now < s.until) {
                log("[JOB] skipped: hold active until " + fmtTs(s.until) + " (" + Math.round((s.until - now) / 1000) + "s left)");

                return done && done();
            }
        }
        try {
            var sipList = maskToSipList(Config.sip_mask);
            if (!sipList.length) {
                log("[JOB] no SIP interfaces selected (sip_mask=0)");
                return done && done();
            }

            if (!devicesBaseHttpUrl || !sessionKey) {
                log("[JOB] not ready yet (devicesBaseHttpUrl/sessionKey missing) -> retry in 60s");
                scheduleRetryIn60s();
                return;
            }

            var mac = String(Config.pbxmacaddress || "").trim();
            if (!mac) {
                log("[JOB] missing Config.pbxmacaddress");
                return done && done();
            }
            var holdMs = getHoldMs();
            log("[JOB] selected SIPs: " + sipList.join(",") + " | action=DISABLE (" + Math.round(holdMs / 60000) + "min)");

            snapshotPrevDisabled(mac, sipList, function (snapErr, prev) {
                if (snapErr) {
                    log("[JOB] snapshot failed: " + snapErr + " -> retry in 60s");
                    scheduleRetryIn60s();
                    return;
                }

                var st = {
                    active: true,
                    mac: mac,
                    sipList: sipList,
                    prev: prev,
                    until: Date.now() + holdMs
                };

                dbSaveState(st, function (saveErr) {
                    if (saveErr) {
                        log("[JOB] save state failed: " + saveErr + " -> retry in 60s");
                        scheduleRetryIn60s();
                        return;
                    }
                    var now = (new Date()).getTime();
                    var secs = Math.max(0, Math.round((st.until - now) / 1000));

                    log("[HOLD] SIPs [" + st.sipList.join(",") + "] disabled, will restore at "
                        + fmtTs(st.until) + " (in " + secs + "s)");

                    // 1) DISABLE now
                    applyDisabledFlag(mac, sipList, true, function (e) {
                        if (e) {
                            log("[JOB] disable failed: " + e + " -> retry in 60s");
                            scheduleRetryIn60s();
                            return;
                        }

                        verifyDisabledAfter(mac, sipList, true, function (verr) {
                            if (verr) log("[JOB] verify-disable failed: " + verr);
                            else log("[JOB] verify-disable ok");
                        });

                        // 2) restore previous state after holdMs
                        Timers.setTimeout(function () {
                            dbLoadState(function (lerr, st2) {
                                if (lerr || !st2 || !st2.active) {
                                    log("[JOB] restore skipped (no active state): " + (lerr || "none"));
                                    return;
                                }
                                log("[JOB] restoring previous SIP state after hold...");
                                restoreFromState(st2, function (e2) {
                                    if (e2) log("[JOB] restore failed: " + e2);
                                    else {
                                        dbClearState(function (ce) {
                                            if (ce) log("[JOB] clear state failed: " + ce);
                                            else log("[JOB] restored + state cleared");
                                        });
                                    }
                                });
                            });
                        }, holdMs);

                        log("[JOB] done");
                        done && done();
                    });
                });
            });
        }
        catch (ex) {
            log("[JOB] exception: " + ex);
            done && done();
        }
    });
}

// ------------------------------------------------------------
// Connect to innovaphone-devices via Services API
// ------------------------------------------------------------

/**
 * Services API connection handler
 * Subscribes to services and connects to innovaphone-devices when available
 */
var pbxServices = new PbxApi("Services").onconnected(function (conn) {
    serviceconns.push(conn);
    log("[SERV] connected"
        + " | enabled=" + boolStr(Config && Config.enabled)
        + " | failover_enabled=" + boolStr(Config && Config.failover_enabled)
        + " | master_mac=" + macShort(Config && Config.pbxmacaddress)
        + " | standby_mac=" + macShort(Config && Config.standby_pbxmacaddress)
        + " | devicesReady=" + boolStr(!!(devicesBaseHttpUrl && sessionKey))
        + "conn: " + JSON.stringify(conn)
    );
    updateServicesPeerRole(conn);
    conn._isMaster = isServicesOnMaster;
    conn._isStandby = isServicesOnStandby;

    if (failoverActive && isServicesOnMaster) {
        failbackStartPolling();
    }

    conn.send(JSON.stringify({ api: "Services", mt: "SubscribeServices" }));

    conn.onmessage(function (msg) {
        var obj;
        try { obj = JSON.parse(msg); } catch (e) { log("[SERV] JSON parse failed"); return; }

        if (obj.mt === "ServicesInfo") {
            log("[SERV] ServicesInfo received (services=" + (obj.services ? obj.services.length : 0) + ")");


            var picked = null;
            for (var i = 0; i < obj.services.length; i++) {
                var s = obj.services[i];
                if (!s || !s.url || !s.name) continue;
                if (s.url.indexOf("/innovaphone-devices") < 0) continue;
                picked = s;
                break;
            }

            if (!picked) {
                log("[SERV] innovaphone-devices not found");
                return;
            }

            devicesServiceName = picked.name;
            devicesServiceUrl = picked.url;
            devicesBaseHttpUrl = devicesServiceUrl.substring(0, devicesServiceUrl.lastIndexOf("/"));
            log("[SERV] picked devices service name=" + safeStr(devicesServiceName)
                + " url=" + safeStr(devicesServiceUrl)
                + " base=" + safeStr(devicesBaseHttpUrl));

            if (devicesConnecting || appsocket_connect) {
                log("[SERV] devices already connected/connecting, skip");
                return;
            }
            log("[SERV] connecting to devices now | devicesConnecting=" + boolStr(devicesConnecting)
                + " | appsocket_connect=" + boolStr(!!appsocket_connect));
            connectToDevices(transformUrl(devicesServiceUrl), devicesServiceName);
        }


        else if (obj.mt === "GetServiceLoginResult") {
            var pbxObj = obj.pbxObj || null;
            var app = obj.app || null;

            log("[SERV] GetServiceLoginResult app=" + (app || "(none)") +
                " pbxObj=" + (pbxObj || "(none)") +
                " expectedService=" + (devicesServiceName || "(null)") +
                " error=" + (obj.error || "none"));

            if (!devicesServiceName) {
                log("[SERV] ERROR: devicesServiceName is null");
                return;
            }

            if (pbxObj) {
                if (pbxObj !== devicesServiceName) return;
            }
            else {
                if (app !== devicesServiceName) return;
            }

            if (obj.error) {
                log("[SERV] Login failed");
                if (appsocket_connect) try { appsocket_connect.close(); } catch (e) { }
                return;
            }

            try {
                var key = conn.decrypt(obj.salt, obj.key);
                var info = JSON.stringify(obj.info);

                appsocket_connect.auth(
                    obj.domain, obj.sip, obj.guid, obj.dn,
                    devicesServiceName,
                    obj.app,
                    info, obj.digest, key
                );
            } catch (e2) {
                log("[SERV] auth failed: " + e2);
            }
        }


        else if (obj.mt === "SubscribeServicesResult") {
            log("[SERV] SubscribeServicesResult");
        }
    });

    conn.onclose(function () {
        log("[SERV] conn closed | wasMaster=" + boolStr(conn._isMaster));

        if (conn._isMaster) {
            if (Config && Config.failover_enabled) {
                failoverOnMasterDown();
            }
            else if (conn._isMaster) {
                failoverOnMasterDown();
            }
            else {
                log("[FO] skip: Services closed on non-master connection");
            }
        }

    });
    if (failoverActive && isServicesOnMaster) {
        failbackStartPolling();
    }
});

/**
 * Connect to innovaphone-devices service via AppWebsocket
 * @param {string} uri - WebSocket URI of devices service
 * @param {string} appName - Application name for authentication
 */
function connectToDevices(uri, appName) {
    devicesConnecting = true;
    log("[DEV] connecting to " + uri + " app=" + appName);

    var appwebsocket = AppWebsocketClient.connect(uri, null, appName);
    appsocket_connect = appwebsocket;

    appwebsocket.onauth(function (conn, app, challenge) {
        log("[DEV] auth challenge for app=" + app + " challenge=" + challenge);
        var i;
        for (i = 0; i < serviceconns.length; i++) {
            serviceconns[i].send(JSON.stringify({
                api: "Services",
                mt: "GetServiceLogin",
                challenge: challenge,
                pbxObj: devicesServiceName,
                app: app
            }));
        }
    });

    appwebsocket.onopen(function (conn) {
        devicesConnecting = false;
        log("[DEV] websocket open");
        conn.send(JSON.stringify({ mt: "GetUserInfo", src: "sipscheduler" }));
    });

    appwebsocket.onmessage(function (conn, msg) {
        var obj;
        try { obj = JSON.parse(msg); } catch (e) { return; }

        if (obj.mt === "GetUserInfoResult") {
            sessionKey = obj.key;
            log("[DEV] sessionKey received"
                + " | base=" + safeStr(devicesBaseHttpUrl)
                + " | master_mac=" + macShort(Config && Config.pbxmacaddress)
                + " | standby_mac=" + macShort(Config && Config.standby_pbxmacaddress));
            recoverIfNeeded();
            scheduleNextRun();
            failoverStartupCheck();
            failbackMaybeStart();
        }
    });

    appwebsocket.onclose(function () {
        devicesConnecting = false;
        appsocket_connect = null;
        sessionKey = null;
        log("[DEV] websocket closed -> waiting for ServicesInfo");
    });
}


// ------------------------------------------------------------
// Database
// ------------------------------------------------------------
/**
 * Quote value for SQL insertion (escape single quotes)
 * @param {*} v - Value to quote
 * @returns {string} Quoted value safe for SQL
 */
function q(v) {
    return "'" + String(v === undefined || v === null ? "" : v).replace(/'/g, "''") + "'";
}

/**
 * Load SIP scheduler state from database
 * @param {Function} cb - Callback function(error, stateObject)
 */
function dbLoadState(cb) {

    if (!Database || !Database.exec) return cb && cb("Database not available", null);

    Database.exec('SELECT active, mac, sip_list, prev_disabled, until_ms FROM sip_scheduler_state WHERE id=1')
        .onerror(function () { cb && cb("load failed", null); })
        .oncomplete(function (rows) {
            if (!rows || !rows.length) return cb && cb(null, null);

            var r = rows[0];
            var st;
            try {
                st = {
                    active: !!r.active,
                    mac: r.mac || null,
                    sipList: (r.sip_list ? JSON.parse(r.sip_list) : []).map(function (x) { return x | 0; }),
                    prev: r.prev_disabled ? JSON.parse(r.prev_disabled) : {},
                    until: Number(r.until_ms || 0)
                };
            } catch (e) {
                return cb && cb("state parse failed: " + e, null);
            }
            cb && cb(null, st);
        });
}

/**
 * Save SIP scheduler state to database
 * @param {Object} st - State object to save
 * @param {Function} cb - Callback function(error)
 */
function dbSaveState(st, cb) {
    if (!Database || !Database.exec) return cb && cb("Database not available");

    var sipListJson = JSON.stringify(st.sipList || []);
    var prevJson = JSON.stringify(st.prev || {});

    var sql =
        'INSERT INTO sip_scheduler_state (id, active, mac, sip_list, prev_disabled, until_ms) VALUES (' +
        '1, ' + (st.active ? 'TRUE' : 'FALSE') + ', ' +
        q(st.mac || '') + ', ' +
        q(sipListJson) + ', ' +
        q(prevJson) + ', ' +
        (st.until || 0) +
        ') ON CONFLICT (id) DO UPDATE SET ' +
        'active=EXCLUDED.active, mac=EXCLUDED.mac, sip_list=EXCLUDED.sip_list, prev_disabled=EXCLUDED.prev_disabled, until_ms=EXCLUDED.until_ms';

    Database.exec(sql)
        .onerror(function () { cb && cb("save failed"); })
        .oncomplete(function () { cb && cb(null); });
}

/**
 * Clear SIP scheduler state from database
 * @param {Function} cb - Callback function(error)
 */
function dbClearState(cb) {
    if (!Database || !Database.exec) return cb && cb("Database not available");
    Database.exec('DELETE FROM sip_scheduler_state WHERE id=1')
        .onerror(function () { cb && cb("clear failed"); })
        .oncomplete(function () { cb && cb(null); });
}

// ------------------------------------------------------------
// Failover: activate SIP trunks on standby when master is down
//
// Logic:
// - detect master PBX down via Services websocket close
// - confirm standby takeover by polling standby registrations XML
//   (failover condition: no <reg cn="_ACTIVE_"> entry on standby regs page)
// - then enable configured SIP trunks (sip_mask) on standby PBX
// ------------------------------------------------------------

/**
 * Get registrations XML URL for a specific device MAC address
 * @param {string} mac - Device MAC address
 * @returns {string|null} Full registrations URL or null if not ready
 */
function getRegsUrlForMac(mac) {
    mac = String(mac || "").trim();
    if (!mac) return null;
    if (!devicesBaseHttpUrl || !sessionKey) return null;

    return devicesBaseHttpUrl
        + "/passthrough/" + encodeURIComponent(mac)
        + "/" + encodeURIComponent(sessionKey)
        + "/PBX0/ADMIN/mod_cmd_login.xml"
        + "?cmd=show&reg=*";
}

/**
 * Get registrations URL for standby PBX
 * @returns {string|null} Registrations URL or null
 */
function getStandbyRegsUrl() {
    return getRegsUrlForMac(Config.standby_pbxmacaddress);
}

/**
 * Get registrations URL for master PBX
 * @returns {string|null} Registrations URL or null
 */
function getMasterRegsUrl() {
    return getRegsUrlForMac(Config.pbxmacaddress);
}

/**
 * Check if registrations response contains specific attribute value
 * @param {string} body - XML response body
 * @param {string} cn - Attribute value to search for
 * @returns {boolean} True if attribute value is found
 */
function regsHasCn(body, cn) {
    body = String(body || "");
    // minimal entity decode
    var s = body.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
    // fast reject
    if (s.toUpperCase().indexOf(String(cn).toUpperCase()) < 0) return false;
    // XML-ish attribute
    var re = new RegExp("\\bcn\\s*=\\s*['\"]?" + cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "['\"]?", "i");
    if (re.test(s)) return true;
    // HTML/table-ish fallback
    var re2 = new RegExp(">\\s*" + cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*<", "i");
    return re2.test(s);
}

/**
 * Stop failover process and clear timers
 * @param {string} reason - Optional reason for stopping
 */
function failoverStop(reason) {
    if (reason) log("[FO] stop: " + reason);
    failoverHoldTimer = stopTimeout(failoverHoldTimer);
    failoverPollTimer = stopTimeout(failoverPollTimer);
    failoverPending = false;
}

/**
 * Handle master PBX coming back up - initiate failback process
 */
function failbackStartPolling() {
    if (failoverPending) failoverStop("master up");

    if (!failoverActive) { failoverDone = false; return; }
    if (!Config || !Config.failover_enabled) return;
    if (!devicesBaseHttpUrl || !sessionKey) {
        log("[FB] not ready (devices/sessionKey missing) -> cannot poll regs yet");
        return;
    }

    if (failbackPending) return;
    failbackPending = true;

    var pollMs = (Config.failover_poll_ms | 0) || 5000;
    var confirmNeed = (Config.failback_confirm_polls | 0) || 2;
    var okCount = 0;

    log("[FB] master up -> pending failback | poll=" + (pollMs + "ms")
        + " | standby_mac=" + macShort(Config && Config.standby_pbxmacaddress));

    function pollOnce() {
        if (!failbackPending) return;

        var urlS = getStandbyRegsUrl();
        var urlM = getMasterRegsUrl();
        if (!urlS || !urlM) {
            log("[FB] regs url not ready"
                + " | master_mac=" + macShort(Config && Config.pbxmacaddress)
                + " | standby_mac=" + macShort(Config && Config.standby_pbxmacaddress)
                + " | base=" + safeStr(devicesBaseHttpUrl)
                + " | sessionKey=" + boolStr(!!sessionKey));
            failbackPollTimer = startTimeout(failbackPollTimer, pollOnce, pollMs);
            return;
        }

        log("[FB] poll regs (dual)");

        httpGetText(urlM, function (errM, bodyM) {
            if (!failbackPending) return;
            log("[FB] master regs head=" + safeStr(bodyM).slice(0, 120).replace(/\s+/g, " "));

            httpGetText(urlS, function (errS, bodyS) {
                if (!failbackPending) return;

                // For failback we must be able to read BOTH sides reliably.
                if (errM || errS) {
                    log("[FB] regs poll failed | master_err=" + safeStr(errM) + " | standby_err=" + safeStr(errS));
                    okCount = 0;
                    failbackPollTimer = startTimeout(failbackPollTimer, pollOnce, pollMs);
                    return;
                }

                var masterHasStandby = regsHasCn(bodyM, cnMaster);
                var standbyHasActive = regsHasCn(bodyS, cnStandby);

                // log("[FB] regs polled"
                //     + " | master_has_" + cnMaster + "=" + boolStr(masterHasStandby)
                //     + " | standby_has_" + cnStandby + "=" + boolStr(standbyHasActive));

                var cond = (masterHasStandby && standbyHasActive);
                okCount = cond ? (okCount + 1) : 0;

                if (okCount >= confirmNeed) {
                    log("[FB] confirm (" + okCount + "/" + confirmNeed + "): disabling trunks on standby");
                    deactivateTrunksOnStandby(function (e2) {
                        if (e2) log("[FB] deactivate failed: " + e2);
                        else {
                            log("[FB] deactivate done");
                            failoverActive = false;
                        }
                        failbackStop("completed");
                    });
                    return;
                }

                failbackPollTimer = startTimeout(failbackPollTimer, pollOnce, pollMs);
            });
        });


    }

    pollOnce();
    failoverDone = false;
}

/**
 * Schedule retry of failover process after delay
 * @param {number} ms - Delay in milliseconds
 */
function scheduleFailoverRetry(ms) {
    ms = (ms | 0) || 5000;
    failoverRetryTimer = startTimeout(failoverRetryTimer, function () {
        // only retry if failover is still enabled and not already pending/done
        if (Config && Config.failover_enabled) {
            failoverOnMasterDown();
        }
    }, ms);
}
var failoverStartupChecked = false;

function failoverStartupCheck() {
    if (failoverStartupChecked) return;
    failoverStartupChecked = true;

    if (!Config || !Config.failover_enabled) return;
    if (!devicesBaseHttpUrl || !sessionKey) return;

    if (isServicesOnMaster) {
        log("[FO] startup-check: connected to master -> skip");
        return;
    }

    log("[FO] startup-check: scheduling master-down evaluation");
    failoverOnMasterDown();
}

/**
 * Handle master PBX going down - initiate failover process
 */
function failoverOnMasterDown() {
    if (!Config || !Config.failover_enabled) return;
    if (!devicesBaseHttpUrl || !sessionKey) {
        var ms = (Config.failover_poll_ms | 0) || 5000;
        log("[FO] not ready (devices/sessionKey missing) -> retry in " + ms + "ms");

        scheduleFailoverRetry(ms);
        return;
    }

    failoverRetryTimer = stopTimeout(failoverRetryTimer);
    if (failbackPending) failbackStop("master down!");

    // already failed over -> do not repeat
    if (failoverDone || failoverPending) return;

    var mac = String(Config.standby_pbxmacaddress || "").trim();
    if (!mac || !devicesBaseHttpUrl || !sessionKey) {
        log("[FO] missing standby_pbxmacaddress or cannot build regs url"
            + " | standby_mac=" + macShort(mac)
            + " | base=" + safeStr(devicesBaseHttpUrl)
            + " | sessionKey=" + boolStr(!!sessionKey));
        return;
    }

    failoverPending = true;
    log("[FO] master down -> pending"
        + " | hold=" + (((Config.failover_delay_ms | 0) || 15000) + "ms")
        + " | poll=" + (((Config.failover_poll_ms | 0) || 5000) + "ms")
        + " | standby_mac=" + macShort(mac));

    var delay = (Config.failover_delay_ms | 0) || 15000;
    failoverHoldTimer = startTimeout(failoverHoldTimer, function () {
        failoverStartPolling();
    }, delay);
}

/**
 * Start polling standby registrations to confirm failover condition
 */
function failoverStartPolling() {
    if (!failoverPending) return;

    var pollMs = (Config.failover_poll_ms | 0) || 5000;
    var confirmNeed = (Config.failover_confirm_polls | 0) || 2;
    var okCount = 0;

    function pollOnce() {
        if (!failoverPending) return;

        var urlS = getStandbyRegsUrl();
        var urlM = getMasterRegsUrl();
        if (!urlS || !urlM) {
            log("[FO] regs url not ready"
                + " | master_mac=" + macShort(Config && Config.pbxmacaddress)
                + " | standby_mac=" + macShort(Config && Config.standby_pbxmacaddress)
                + " | base=" + safeStr(devicesBaseHttpUrl)
                + " | sessionKey=" + boolStr(!!sessionKey));
            failoverPollTimer = startTimeout(failoverPollTimer, pollOnce, pollMs);
            return;
        }

        //log("[FO] poll regs (dual)");

        httpGetText(urlM, function (errM, bodyM) {
            if (!failoverPending) return;

            httpGetText(urlS, function (errS, bodyS) {
                if (!failoverPending) return;

                if (errS) {
                    log("[FO] standby regs poll failed | standby_err=" + safeStr(errS));
                    okCount = 0;
                    failoverPollTimer = startTimeout(failoverPollTimer, pollOnce, pollMs);
                    return;
                }

                var masterHasStandby = false;
                if (errM) {
                    log("[FO] master regs poll failed -> treat master as down | master_err=" + safeStr(errM));
                    masterHasStandby = false;
                } else {
                    masterHasStandby = regsHasCn(bodyM, cnMaster);
                }
                var standbyHasActive = regsHasCn(bodyS, cnStandby);

                // log("[FO] regs polled"
                //     + " | master_has_" + cnMaster + "=" + boolStr(masterHasStandby)
                //     + " | standby_has_" + cnStandby + "=" + boolStr(standbyHasActive));

                // Failover condition:
                // - master missing _STANDBY_ AND standby missing _ACTIVE_
                var cond = (!masterHasStandby && !standbyHasActive);
                okCount = cond ? (okCount + 1) : 0;

                if (okCount >= confirmNeed) {
                    log("[FO] confirm (" + okCount + "/" + confirmNeed + "): activating trunks on standby");
                    activateTrunksOnStandby(function (e2) {
                        if (e2) log("[FO] activate failed: " + e2);
                        else log("[FO] activate done");

                        failoverDone = (!e2 && failoverActive);
                        failoverStop("completed");
                    });

                    return;
                }

                failoverPollTimer = startTimeout(failoverPollTimer, pollOnce, pollMs);
            });
        });
    }

    pollOnce();
}


/**
 * Stop failback process and clear timers
 * @param {string} reason - Optional reason for stopping
 */
function failbackStop(reason) {
    if (reason) log("[FB] stop: " + reason);
    failbackPollTimer = stopTimeout(failbackPollTimer);
    failbackPending = false;
}

/**
 * Disable (deactivate) SIP trunks on standby PBX
 * @param {Function} cb - Callback function(error)
 */
function deactivateTrunksOnStandby(cb) {
    var mac = String(Config.standby_pbxmacaddress || "").trim();
    if (!mac) return cb && cb("no standby_pbxmacaddress");

    var sipList = maskToSipList(Config.sip_mask || 0);
    log("[FB] disabling SIPs on standby"
        + " | standby_mac=" + macShort(mac)
        + " | sip_mask=" + (Config.sip_mask | 0)
        + " | sip_list=" + (sipList.length ? sipList.join(",") : "(none)"));

    applyDisabledFlag(mac, sipList, true, function (err) {
        cb && cb(err || null);
    });
}

/**
 * Enable (activate) SIP trunks on standby PBX
 * @param {Function} cb - Callback function(error)
 */
function activateTrunksOnStandby(cb) {
    var mac = String(Config.standby_pbxmacaddress || "").trim();
    if (!mac) return cb && cb("no standby_pbxmacaddress");

    var sipList = maskToSipList(Config.sip_mask || 0);
    log("[FO] enabling SIPs on standby"
        + " | standby_mac=" + macShort(mac)
        + " | sip_mask=" + (Config.sip_mask | 0)
        + " | sip_list=" + (sipList.length ? sipList.join(",") : "(none)"));

    applyDisabledFlag(mac, sipList, false, function (err) {
        if (!err) failoverActive = true;
        cb && cb(err || null);
    });
}

function failbackMaybeStart() {
    // only consider failback if we are actually failed over
    if (!failoverActive) return;
    if (!Config || !Config.failover_enabled) return;
    if (!devicesBaseHttpUrl || !sessionKey) return;
    if (failbackPending || failoverPending) return;

    // Start the existing failback logic (which will confirm via regs)
    failbackStartPolling();
}

function updateServicesPeerRole(connInfo) {
    isServicesOnMaster = false;
    isServicesOnStandby = false;
    if (!Config || !Config.failover_enabled) return;
    if (!connInfo) return;

    var ip = String(connInfo.remoteAddr || "").trim();
    var dns = String(connInfo.pbxDns || "").trim();

    var masterIp = String(Config.failover_master_ip || "").trim();
    var standbyIp = String(Config.failover_standby_ip || "").trim();
    var masterDns = String(Config.failover_master_dns || "").trim();
    var standbyDns = String(Config.failover_standby_dns || "").trim();

    if (ip && masterIp && ip === masterIp) isServicesOnMaster = true;
    else if (ip && standbyIp && ip === standbyIp) isServicesOnStandby = true;
    else if (dns && masterDns && dns === masterDns) isServicesOnMaster = true;
    else if (dns && standbyDns && dns === standbyDns) isServicesOnStandby = true;

    log("[SERV] peer role | remoteAddr=" + safeStr(ip)
        + " | pbxDns=" + safeStr(dns)
        + " | isMaster=" + boolStr(isServicesOnMaster)
        + " | isStandby=" + boolStr(isServicesOnStandby));
}

function refreshServicesPeerRoles() {
    var i, c;
    for (i = 0; i < serviceconns.length; i++) {
        c = serviceconns[i];
        if (!c) continue;
        updateServicesPeerRole(c);
        c._isMaster = isServicesOnMaster;
        c._isStandby = isServicesOnStandby;
    }
}
// ------------------------------------------------------------
// Config change handling
// ------------------------------------------------------------
/**
 * Check if service is ready (devices service and session key available)
 * @returns {boolean} True if ready to execute commands
 */
function isReady() {
    return !!(devicesBaseHttpUrl && sessionKey);
}

try {
    log("[INIT] service started, ready=" + isReady());
} catch (e) { }


try {
    Config.onchanged(function () {
        log("[CFG] changed -> reschedule | ready=" + boolStr(isReady()));
        log(JSON.stringify(Config));
        refreshServicesPeerRoles();
        scheduleNextRun();
        recoverIfNeeded();
    });
} catch (e) {
    log("[CFG] Config.onchanged not available or failed: " + e);
}
