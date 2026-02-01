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


// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
// Stop timeout if running
function stopTimeout(ref) {
    if (ref) {
        try { Timers.clearTimeout(ref); } catch (e) { }
    }
    return null;
}
// Start timeout after stopping previous one 
function startTimeout(oldRef, fn, ms) {
    oldRef = stopTimeout(oldRef);
    return Timers.setTimeout(fn, ms);
}
// Transform http(s):// URL into ws(s):// URL
function transformUrl(url) {
    if (!url) return url;
    if (url.indexOf("http://") === 0) return "ws://" + url.substr(7);
    if (url.indexOf("https://") === 0) return "wss://" + url.substr(8);
    return url;
}
// Parse runAt (HH:MM) into {h:HH, m:MM}
function parseRunAt(runAt) {
    var p = String(runAt || "00:00").split(":");
    var h = parseInt(p[0], 10); if (!(h >= 0 && h <= 23)) h = 0;
    var m = parseInt(p[1], 10); if (!(m >= 0 && m <= 59)) m = 0;
    return { h: h, m: m };
}
// Calculate ms until next run time based on runAt (HH:MM)
function msUntilNextRun(runAt) {
    var t = parseRunAt(runAt);

    var now = new Date();
    var next = new Date(now.getTime());
    next.setUTCHours(t.h, t.m, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);

    return next.getTime() - now.getTime();
}

// Format timestamp as "YYYY-MM-DD HH:MM:SS UTC"
function fmtTs(ts) {
    var d = new Date(ts);
    return d.getUTCFullYear() + "-" +
        ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" +
        ("0" + d.getUTCDate()).slice(-2) + " " +
        ("0" + d.getUTCHours()).slice(-2) + ":" +
        ("0" + d.getUTCMinutes()).slice(-2) + ":" +
        ("0" + d.getUTCSeconds()).slice(-2) + " UTC";
}

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

// decode helper for UTF-8 data
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
// Simple HTTP GET returning full body as text
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
// Build passthrough command URL
function passthroughCmdUrl(baseUrl, mac, sessionKey, cmd) {
    var cmdPath = encodeURI(cmd);
    return baseUrl + "/passthrough"
        + "/" + encodeURIComponent(mac)
        + "/" + encodeURIComponent(sessionKey)
        + "/" + cmdPath;
}

// Run passthrough command and return body as text
function runCmd(baseUrl, mac, sessionKey, cmd, cb) {
    var url = passthroughCmdUrl(baseUrl, mac, sessionKey, cmd);
    httpGetText(url, function (err, body) {
        if (err) return cb && cb(err);
        cb && cb(null, body);
    });
}
// Find SIPx line in cfg.txt
function findSipLine(cfgText, sipIndex) {
    var re = new RegExp("^config change RELAY0 SIP" + sipIndex + "\\b.*$", "m");
    var m = cfgText.match(re);
    return m ? m[0] : null;
}

// /disabled is a FLAG (no value). Disabled if token exists.
function isSipDisabledInLine(line) {
    if (!line) return false;
    return (" " + line + " ").indexOf(" /disabled ") >= 0;
}
// Set or clear /disabled flag in SIP line
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
// Snapshot current /disabled state of selected SIP interfaces
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
// Restore SIP interfaces to previous disabled state
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
// Check if previous hold was active, restore if needed
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
// Schedule next run based on Config.run_at
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

// Retry job in 60s
function scheduleRetryIn60s() {
    retryJobTimer = startTimeout(retryJobTimer, function () {
        runSchedulerJob(function () { });
    }, 60000);
}
// Retry recover in 60s
function scheduleRecoverRetryIn60s() {
    retryRecoverTimer = startTimeout(retryRecoverTimer, function () {
        recoverIfNeeded();
    }, 60000);
}
// Get hold time in ms from Config.re_register
function getHoldMs() {
    var m = (Config && typeof Config.re_register === "number") ? Config.re_register : 1;
    if (!(m > 0)) m = 1;
    return Math.floor(m * 60000);
}

// ------------------------------------------------------------
// SIP config manipulation
// ------------------------------------------------------------
// Apply /disabled flag to selected SIP interfaces
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
// Disable selected SIP interfaces for hold time, then restore previous state

function runSchedulerJob(done) {
    retryJobTimer = stopTimeout(retryJobTimer);
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

var pbxServices = new PbxApi("Services").onconnected(function (conn) {
    serviceconns.push(conn);
    log("[SERV] connected");

    conn.send(JSON.stringify({ api: "Services", mt: "SubscribeServices" }));

    conn.onmessage(function (msg) {
        var obj;
        try { obj = JSON.parse(msg); } catch (e) { log("[SERV] JSON parse failed"); return; }

        if (obj.mt === "ServicesInfo") {
            log("[SERV] ServicesInfo received");

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

            if (devicesConnecting || appsocket_connect) {
                log("[SERV] devices already connected/connecting, skip");
                return;
            }

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
        log("[SERV] conn closed");
        devicesConnecting = false;
        var idx = serviceconns.indexOf(conn);
        if (idx >= 0) serviceconns.splice(idx, 1);
    });
});

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
            log("[DEV] sessionKey received");
            recoverIfNeeded();
            scheduleNextRun();
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
// Quote value for SQL insertion
function q(v) {
    return "'" + String(v === undefined || v === null ? "" : v).replace(/'/g, "''") + "'";
}

// Load SIP scheduler state from database
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

// Save SIP scheduler state to database
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

// Clear SIP scheduler state from database
function dbClearState(cb) {
    if (!Database || !Database.exec) return cb && cb("Database not available");
    Database.exec('DELETE FROM sip_scheduler_state WHERE id=1')
        .onerror(function () { cb && cb("clear failed"); })
        .oncomplete(function () { cb && cb(null); });
}

// ------------------------------------------------------------
// Config change handling
// ------------------------------------------------------------
function isReady() {
    return !!(devicesBaseHttpUrl && sessionKey);
}

try {
    log("[INIT] service started, ready=" + isReady());
} catch (e) { }


try {
    Config.onchanged(function () {
        log("[CFG] changed -> reschedule");
        scheduleNextRun();
    });
} catch (e) {
    log("[CFG] Config.onchanged not available or failed: " + e);
}
