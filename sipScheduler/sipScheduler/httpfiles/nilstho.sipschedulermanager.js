
/// <reference path="../../web1/lib1/innovaphone.lib1.js" />
/// <reference path="../../web1/ui1.lib/innovaphone.ui1.lib.js" />
/// <reference path="../../web1/appwebsocket/innovaphone.appwebsocket.Connection.js" />
/// <reference path="../../web1/config/innovaphone.config.js" />
console.log("[SM] build 2026-01-31-1");

var plugin = plugin || {};
plugin.nilstho = plugin.nilstho || {};
plugin.nilstho.sipschedulermanager = plugin.nilstho.sipschedulermanager || function (start, item, app) {
    this.createNode("div", null, null, "item-node");
    innovaphone.lib1.loadCss(item.uri + ".css");
    console.log("[SM] ctor", item && item.uri);

    var colorSchemes = {
        dark: {
            "--nilstho-sipscheduler-item": "#333333",
            "--nilstho-sipscheduler-item-text": "#f2f5f6",
            "--nilstho-sipscheduler-c1": "#efefef",
            "--nilstho-sipscheduler-c2": "#939393",
            "--nilstho-sipscheduler-highlight-bg": "#595959",
            "--nilstho-sipscheduler-input": "#191919",
            "--nilstho-sipscheduler-input-text": "#f2f5f6",
            "--nilstho-sipscheduler-button": "#191919",
            "--nilstho-sipscheduler-button-text": "#f2f5f6",
            "--nilstho-sipscheduler-button-bg": "#3D3D3D",
            "--nilstho-sipscheduler-green": "#7cb270",
        },
        light: {
            "--nilstho-sipscheduler-item": "#e9eef1",
            "--nilstho-sipscheduler-item-text": "#4a4a4a",
            "--nilstho-sipscheduler-c1": "#444444",
            "--nilstho-sipscheduler-c2": "#777777",
            "--nilstho-sipscheduler-highlight-bg": "#eaeaea",
            "--nilstho-sipscheduler-input": "white",
            "--nilstho-sipscheduler-input-text": "#4a4a49",
            "--nilstho-sipscheduler-button": "white",
            "--nilstho-sipscheduler-button-text": "#4a4a49",
            "--nilstho-sipscheduler-button-bg": "#CCCCCC",
            "--nilstho-sipscheduler-green": "#7cb270",
        }
    };

    var schemes = new innovaphone.ui1.CssVariables(colorSchemes, start.scheme);
    start.onschemechanged.attach(function () { schemes.activate(start.scheme) });

    var texts, add, sipSchedulerList, templatesList, templatesListCn, instance;

    var panel = this.add(new innovaphone.ui1.Div(null, null, "nilstho-sipscheduler-panel"));
    panel.setAttribute("over")
    var src = new app.Src(pbx);
    var textValues = {};
    var configItems = null;
    var configItemsInitialized = false;
    var settingsOkBtn = null;
    var settingsValidators = null;

    var typeTexts = ["SIP Scheduler"];
    var typeText = ["sipscheduler"];
    var typeUrl = ["/nilstho-sipscheduler"];
    var typeCheckmarks = [
        { web: false, websocket: true, hidden: true, pbx: false, pbxsignal: false, epsignal: false, messages: false, tableusers: false, admin: true, services: true, rcc: false }
    ];
    var copyPwd = null;
    var managerApi = start.consumeApi("com.innovaphone.manager");

    innovaphone.lib1.loadObjectScripts(
        [
            item.uri + "texts",
            item.uri.slice(0, item.uri.lastIndexOf("/")) + "/web1/config/innovaphone.config"
        ],
        function () {
            console.log("[SM] scripts loaded OK");

            texts = new innovaphone.lib1.Languages(
                nilstho.sipschedulermanagertexts,
                start.lang
            );

            console.log("[SM] creating instance connection", "ws" + item.uri.slice(4));
            instance = new innovaphone.appwebsocket.Connection(
                "ws" + item.uri.slice(4),
                "-", null, app.domain,
                instanceConnected, instanceMessage,
                null, null,
                instanceLogin
            );
        }
    );

    function instanceLogin(app, challenge) {
        var src = new managerApi.Src(getlogin);
        src.send({ mt: "GetInstanceLogin", path: item.apUri.slice(0, item.apUri.lastIndexOf("/")), app: app, challenge: challenge }, item.ap);

        function getlogin(obj) { instance.login(obj.msg); }
    }

    function instanceConnected() {
        if (!configItems) configItems = new innovaphone.Config();
        if (!configItemsInitialized) {
            configItemsInitialized = true;
            configItems.evOnConfigLoaded.attach(onConfigLoaded);
            configItems.evOnConfigSaveResult.attach(onConfigSaveResult);
            configItems.init(instance);
        }
        setTimeout(read, 0);
    }


    function instanceMessage(msg) {
        console.log("instanceMessage", msg);
    }

    function setButtonDisabled(btnDiv, dis) {
        if (!btnDiv || !btnDiv.container) return;
        btnDiv.container.style.opacity = dis ? "0.55" : "1";
        btnDiv.container.style.pointerEvents = dis ? "none" : "auto";
        btnDiv.container.style.filter = dis ? "grayscale(0.3)" : "";
    }
    function addTooltipTranslation(fieldObj, key, args) {
        var el = fieldObj && fieldObj.input && fieldObj.input.container;
        if (!el || !texts || !texts.create) return;
        texts.create(el, "title", key, args);
    }

    function setTooltip(el, text) {
        if (!el) return;
        if (text) el.setAttribute("title", text);
        else el.removeAttribute("title");
    }


    // validation helpers
    function trimStr(s) { return String(s || "").replace(/^\s+|\s+$/g, ""); }
    function isEmpty(s) { return trimStr(s) === ""; }
    function isValidTime(s) { return /^\d{2}:\d{2}$/.test(trimStr(s)); }

    // Converts a time string "HH:MM" into minutes since midnight (0–1439).
    function hhmmToMinutes(hhmm) {
        var m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
        if (!m) return null;
        return (parseInt(m[1], 10) * 60) + parseInt(m[2], 10);
    }

    // Converts minutes since midnight back into a normalized "HH:MM" time string.
    function minutesToHHMM(mins) {
        mins = ((mins % 1440) + 1440) % 1440;
        var h = Math.floor(mins / 60);
        var m = mins % 60;
        return ("0" + h).slice(-2) + ":" + ("0" + m).slice(-2);
    }

    // Converts a local "HH:MM" time to UTC "HH:MM" using a fixed offset (minutes east of UTC).
    function localHHMMToUtcHHMM(localHHMM, offsetEastMinutes) {
        var local = hhmmToMinutes(localHHMM);
        if (local === null) return null;
        return minutesToHHMM(local - (offsetEastMinutes | 0));
    }

    // Converts a UTC "HH:MM" time to local "HH:MM" using a fixed offset (minutes east of UTC).
    function utcHHMMToLocalHHMM(utcHHMM, offsetEastMinutes) {
        var utc = hhmmToMinutes(utcHHMM);
        if (utc === null) return null;
        return minutesToHHMM(utc + (offsetEastMinutes | 0));
    }

    // marks a field as required and sets its error message.
    function markRequiredField(field, isValid, msg) {
        if (field && field.setError) {
            field.setError(!isValid, msg);
        }
        return !!isValid; // true if valid

    }

    // Validates a set of fields. Returns true if all are valid.
    function validateRequiredField(fields) {
        var allValid = true;

        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            var v = (typeof f.value === "function") ? f.value() : f.value;
            var ok;
            if (typeof f.validator === "function") ok = !!f.validator(v);
            else ok = !isEmpty(v);

            var msg = null;
            if (!ok) msg = f.msg || "Required";

            if (!markRequiredField(f.field, ok, msg)) allValid = false;
        }
        return allValid;
    }

    // Converts a string of sip checks to an integer bit mask.
    function maskToChecks(mask) {
        mask = (mask | 0) >>> 0;
        for (var i = 1; i <= 16; i++) {
            var on = !!(mask & (1 << (i - 1)));
            if (textValues.sipChecks && textValues.sipChecks[i]) {
                textValues.sipChecks[i].setValue(on);
            }
        }
    }
    // Converts an integer bit mask to a string of sip checks.
    function checksToMask() {
        var mask = 0;
        for (var i = 1; i <= 16; i++) {
            if (textValues.sipChecks && textValues.sipChecks[i] && textValues.sipChecks[i].getValue()) {
                mask |= (1 << (i - 1));
            }
        }
        return mask | 0;
    }

    // Normalizes a comma separated list of apps.
    function normalizeApps(s) {
        s = String(s || "").trim();
        if (!s) return "";
        return s
            .split(",")
            .map(function (x) { return x.trim(); })
            .filter(Boolean)
            .join(",");
    }

    // UI panel for the Manager Plugin.
    function read() {
        panel.clear();
        //settings
        var settingsBtn = panel
            .add(new innovaphone.ui1.Div("display:flex; flex-direction:row; margin-top:10px; margin-bottom:20px; position:relative; z-index:2;", null, "nilstho-sipscheduler-obj"))
            .testId("nilstho-sipscheduler-settings")
            .addEvent("click", onsettings);
        var settings = settingsBtn.add(new innovaphone.ui1.SvgInline("width:20px; height:20px; margin: 10px 20px 10px 20px; fill:var(--c1); cursor:pointer", "0 0 20 20", "<path d=\'M20,4.64V6.79H18V4.64ZM10,2.5h6V8.93H10V6.79H0V4.64H10Zm1,10.71v2.15h9V13.21ZM3,11.07H9V17.5H3V15.36H0V13.21H3Z'/>"));
        settingsBtn.add(new innovaphone.ui1.Div("font-size: 16px; margin-right: 20px; padding-left: 7px; padding-top: 7px", null, null)).addTranslation(texts, "scheduler_settings");

        var header = panel.add(new innovaphone.ui1.Div(
            "display:flex; flex-direction:row; position:relative; z-index:2;",
            null, "nilstho-sipscheduler-obj"
        )).addEvent("click", onadd);

        add = header.add(new innovaphone.ui1.SvgInline("position:relative; left:10px; width:20px; top:10px; height:20px; fill:var(--nilstho-sipscheduler-item-text); cursor:pointer", "0 0 20 20", "<path d=\'M8.24,8.24V0h3.52V8.24H20v3.52H11.76V20H8.24V11.76H0V8.24Z'/>"));
        header.add(new innovaphone.ui1.Div("padding: 5px 10px;", null, "nilstho-sipscheduler-label2")).addTranslation(texts, "addapp");
        sipSchedulerList = panel.add(new innovaphone.ui1.Scrolling("left:0px; right:0px; margin-top:15px; bottom:0px; z-index:1;", -1, -1));
        sipSchedulerList.container.style.zIndex = "1";
        copyPwd = null;
        console.log("sending GetAppObjects", item.httpsUri);
        reloadObjects();
    }
    // Reload the list of apps in the panel
    function reloadObjects() {
        sipSchedulerList && sipSchedulerList.clear();
        copyPwd = null;

        src.send({
            mt: "GetAppObjects",
            api: "PbxAdminApi",
            uri: item.httpsUri.slice(0, item.httpsUri.lastIndexOf("/"))
        });
    }

    function onadd() {
        panel.clear();
        var header = panel.add(new innovaphone.ui1.Div("position:absolute; box-sizing:border-box; padding:10px; width:100%; color: var(--nilstho-sipscheduler-c2); font-size: 18px;")).addTranslation(texts, "addapp");
        var content = panel.add(new innovaphone.ui1.Scrolling("position:absolute; width:100%; top:50px; bottom:40px; margin-top: 5px;", -1, -1, 9, "red"));
        var selection = content.add(new innovaphone.ui1.Div("position:relative; width:100%; display:flex; flex-wrap:wrap; align-content:flex-start"));
        var select = content.add(new innovaphone.ui1.Div("position:relative; width:100%; display:flex; flex-wrap:wrap; align-content:flex-start"));
        addSelect(select, 0, "sipscheduler", "/nilstho-sipscheduler.png");

        function addSelect(select, typeIndex, appid, iconpath) {
            if (!appid) appid = typeText[typeIndex];
            if (!iconpath) iconpath = typeUrl[typeIndex] + ".png";
            var appselect = select.add(new innovaphone.ui1.Div("width:170px;height:50px;", null, "nilstho-sipscheduler-choice")).addEvent("click", function () {
                select.clear();
                selection.add(new innovaphone.ui1.Div("text-align: left; background-color: transparent; font-size: 16px;", null, "nilstho-sipscheduler-selection")).addTranslation(texts, appid);
                new EditsipScheduler({ type: typeIndex }, content);
            }).testId("nilstho-sipscheduler-" + appid);
            var appicon = appselect.add(new innovaphone.ui1.Div(null, null, "nilstho-sipscheduler-appicon"));
            appicon.container.style.backgroundImage = "url(" + item.uri.slice(0, item.uri.lastIndexOf("/")) + iconpath + ")";
            appicon.container.style.backgroundSize = "cover";
            appselect.add(new innovaphone.ui1.Div("position:absolute; left:50px; top:5px; height:30px;", null, "nilstho-sipscheduler-label2")).addTranslation(texts, appid);
        }
    }
    // Read the values stored in the Config and set the values in the UI
    function onConfigLoaded() {
        if (!textValues) return;

        if (textValues.pbxname) textValues.pbxname.setValue(configItems.pbxname || "");
        if (textValues.run_at) {
            var offsetEast = -new Date().getTimezoneOffset();
            var utcVal = configItems.run_at || "00:00";
            var localVal = utcHHMMToLocalHHMM(utcVal, offsetEast) || utcVal;
            textValues.run_at.setValue(localVal);
        }

        if (textValues.pbxmacaddress) textValues.pbxmacaddress.setValue(configItems.pbxmacaddress || "");
        if (textValues.enabled) textValues.enabled.setValue(!!configItems.enabled);
        if (textValues.domain) textValues.domain.setValue(configItems.domain || app.domain || "");
        if (textValues.sipChecks) { maskToChecks(configItems.sip_mask || 0); }
        if (textValues.re_register) textValues.re_register.setValue(configItems.re_register || "");
        // standby
        if (textValues.failover_enabled) textValues.failover_enabled.setValue(!!configItems.failover_enabled);
        if (textValues.standby_pbxmacaddress) textValues.standby_pbxmacaddress.setValue(configItems.standby_pbxmacaddress || "");

        if (textValues.failover_master_ip) textValues.failover_master_ip.setValue(configItems.failover_master_ip || "");
        if (textValues.failover_master_dns) textValues.failover_master_dns.setValue(configItems.failover_master_dns || "");
        if (textValues.failover_standby_ip) textValues.failover_standby_ip.setValue(configItems.failover_standby_ip || "");
        if (textValues.failover_standby_dns) textValues.failover_standby_dns.setValue(configItems.failover_standby_dns || "");

        if (textValues.failover_delay_ms) textValues.failover_delay_ms.setValue(String(configItems.failover_delay_ms || 60000));
        if (textValues.failover_poll_ms) textValues.failover_poll_ms.setValue(String(configItems.failover_poll_ms || 5000));
        if (textValues.failover_confirm_polls) textValues.failover_confirm_polls.setValue(String(configItems.failover_confirm_polls || 2));
        if (textValues.failback_confirm_polls) textValues.failback_confirm_polls.setValue(String(configItems.failback_confirm_polls || 2));

        // Enable/Disable OK button after config values are applied
        if (settingsOkBtn && settingsValidators) {
            var ok = validateRequiredField(settingsValidators);
            setButtonDisabled(settingsOkBtn, !ok);

        }
    }

    // Settings Panel
    function onsettings() {
        panel.clear();
        settingsOkBtn = null;
        settingsValidators = null;

        if (!configItems) {
            configItems = new innovaphone.Config();
        }

        function oncancelSettings() {
            read();
        }

        var header = panel.add(new innovaphone.ui1.Div("position:absolute; box-sizing:border-box; padding:10px; width:100%; color: var(--nilstho-sipscheduler-c2); font-size: 18px;")).addTranslation(texts, "scheduler_settings");
        var content = panel.add(new innovaphone.ui1.Scrolling("position:absolute; width:100%; top:50px; bottom:40px; margin-top: 5px;", -1, -1, 9, "red"));
        var footer = panel.add(new innovaphone.ui1.Div("position:absolute; width:100%; bottom:0px; height:40px"));
        settingsOkBtn = footer.add(new innovaphone.ui1.Div("right:140px; bottom:10px", null, "nilstho-sipscheduler-button")).addTranslation(texts, "ok").addEvent("click", onSaveSettings).testId("nilstho-sipscheduler-settings-ok");
        footer.add(new innovaphone.ui1.Div("right:10px; bottom:10px", null, "nilstho-sipscheduler-button")).addTranslation(texts, "cancel").addEvent("click", oncancelSettings).testId("nilstho-sipscheduler-settings-cancel");

        textValues = {};
        var enableRow = content.add(new innovaphone.ui1.Div("display:flex; align-items:center; margin-bottom:20px; padding-bottom:10px; border-bottom:1px solid var(--nilstho-sipscheduler-highlight-bg);"));
        var enabled = enableRow
            .add(new ConfigCheckbox("enabled", false, "width:200px;", "width:252px"))
            .testId("nilstho-sipscheduler-settings-enabled");

        textValues.enabled = enabled;

        var pbxmacaddress = content.add(new ConfigText2("pbxmacaddress", "", 200)).testId("nilstho-sipscheduler-settings-pbxmacaddress");
        textValues.pbxmacaddress = pbxmacaddress;

        var pbxname = content.add(new ConfigText2("pbxname", "", 200)).testId("nilstho-sipscheduler-settings-pbxname");
        pbxname.setAttribute("placeholder", "master");
        textValues.pbxname = pbxname;

        var domain = content.add(new ConfigText2("domain", "", 200)).testId("nilstho-sipscheduler-settings-domain");
        domain.setAttribute("placeholder", app.domain);
        textValues.domain = domain;

        var run_at = content.add(new ConfigTime("run_at", "", 200)).testId("nilstho-sipscheduler-settings-run_at");
        run_at.input && (run_at.input.container.style.fontFamily = "monospace");
        textValues.run_at = run_at;


        var re_register = content.add(new ConfigNumber("re_register", "", 200)).testId("nilstho-sipscheduler-settings-re_register");
        textValues.re_register = re_register;

        var failover_enabled = content.add(new ConfigCheckbox("failover_enabled", false, "width:140px;", "width:252px")).testId("nilstho-sipscheduler-settings-failover-enabled");
        textValues.failover_enabled = failover_enabled;

        var standby_pbxmacaddress = content.add(new ConfigText2("standby_pbxmacaddress", "", 200)).testId("nilstho-sipscheduler-settings-standby-pbxmacaddress");
        standby_pbxmacaddress.setAttribute("placeholder", "standby mac");
        textValues.standby_pbxmacaddress = standby_pbxmacaddress;

        var failover_master_ip = content.add(new ConfigText2("failover_master_ip", "", 200)).testId("niltho-sipscheduler-settings-failover-master-ip");
        textValues.failover_master_ip = failover_master_ip;

        var failover_master_dns = content.add(new ConfigText2("failover_master_dns", "", 200)).testId("niltho-sipscheduler-settings-failover-master-dns");
        textValues.failover_master_dns = failover_master_dns;

        var failover_standby_ip = content.add(new ConfigText2("failover_standby_ip", "", 200)).testId("niltho-sipscheduler-settings-failover-standby-ip");
        textValues.failover_standby_ip = failover_standby_ip;

        var failover_standby_dns = content.add(new ConfigText2("failover_standby_dns", "", 200)).testId("niltho-sipscheduler-settings-failover-standby-dns");
        textValues.failover_standby_dns = failover_standby_dns;

        var foDelay = content.add(new ConfigNumberMs("failover_delay_ms", "", 200)).testId("nilstho-sipscheduler-settings-failover-delay");
        textValues.failover_delay_ms = foDelay;

        var foPoll = content.add(new ConfigNumberMs("failover_poll_ms", "", 200)).testId("nilstho-sipscheduler-settings-failover-poll");
        textValues.failover_poll_ms = foPoll;

        var foConf = content.add(new ConfigNumberSmall("failover_confirm_polls", "", 200)).testId("nilstho-sipscheduler-settings-failover-confirm");
        textValues.failover_confirm_polls = foConf;

        var fbConf = content.add(new ConfigNumberSmall("failback_confirm_polls", "", 200)).testId("nilstho-sipscheduler-settings-failback-confirm");
        textValues.failback_confirm_polls = fbConf;

        //tooltips
        addTooltipTranslation(pbxname, "pbxname_tooltip");
        addTooltipTranslation(pbxmacaddress, "pbxmacaddress_tooltip");
        addTooltipTranslation(run_at, "run_at_tooltip");
        addTooltipTranslation(re_register, "re_register_tooltip");
        addTooltipTranslation(standby_pbxmacaddress, "standby_pbxmacaddress_tooltip");
        addTooltipTranslation(failover_master_ip, "failover_master_ip_tooltip");
        addTooltipTranslation(failover_master_dns, "failover_master_dns_tooltip");
        addTooltipTranslation(failover_standby_ip, "failover_standby_ip_tooltip");
        addTooltipTranslation(failover_standby_dns, "failover_standby_dns_tooltip");
        addTooltipTranslation(foDelay, "failover_delay_ms_tooltip");
        addTooltipTranslation(foPoll, "failover_poll_ms_tooltip");
        addTooltipTranslation(foConf, "failover_confirm_polls_tooltip");
        addTooltipTranslation(fbConf, "failback_confirm_polls_tooltip");



        // Validation list for live disabling + marking
        settingsValidators = [
            { field: textValues.pbxmacaddress, value: function () { return textValues.pbxmacaddress.getValue(); }, msg: "Required" },
            { field: textValues.pbxname, value: function () { return textValues.pbxname.getValue(); }, msg: "Required" },
            { field: textValues.domain, value: function () { return textValues.domain.getValue(); }, msg: "Required" },
            { field: textValues.run_at, value: function () { return textValues.run_at.getValue(); }, validator: isValidTime, msg: "Required (HH:MM)" }
        ];

        // Validate the settings live
        function validateSettingsLive() {
            var ok = validateRequiredField(settingsValidators);
            setButtonDisabled(settingsOkBtn, !ok);
            return ok;
        }

        // Wire up the live validation
        function wireLive(fieldObj) {
            if (!fieldObj) return;
            if (fieldObj.input && fieldObj.input.container) {
                fieldObj.input.container.oninput = function () {
                    if (fieldObj.setError) fieldObj.setError(false);
                    validateSettingsLive();
                };
                fieldObj.input.container.onchange = function () {
                    if (fieldObj.setError) fieldObj.setError(false);
                    validateSettingsLive();
                };
            }
        }

        wireLive(textValues.pbxmacaddress);
        wireLive(textValues.pbxname);
        wireLive(textValues.domain);
        wireLive(textValues.run_at);


        var grid = content.add(new innovaphone.ui1.Div(
            "display:grid; grid-template-columns: 1fr 1fr; gap:6px 20px; margin-bottom:12px;"
        ));

        textValues.sipChecks = [];
        for (var i = 1; i <= 16; i++) {
            var cb = grid.add(new ConfigCheckbox("SIP" + i, false, "width:140px;"));
            cb.testId("nilstho-sipscheduler-settings-sip" + i);
            cb.setOnChange(validateSettingsLive);
            textValues.sipChecks[i] = cb;
        }

        configItems.init(instance);
        setButtonDisabled(settingsOkBtn, true);

    }
    // Save settings
    function onSaveSettings() {
        // Required fields
        var valid = validateRequiredField([
            { field: textValues.pbxmacaddress, value: function () { return textValues.pbxmacaddress.getValue(); } },
            { field: textValues.pbxname, value: function () { return textValues.pbxname.getValue(); } },
            { field: textValues.domain, value: function () { return textValues.domain.getValue(); } },
            { field: textValues.run_at, value: function () { return textValues.run_at.getValue(); }, validator: isValidTime }
        ]);

        if (!valid) {
            console.warn("Settings validation failed");
            return;
        }
        var localRunAt = trimStr(textValues.run_at.getValue());
        var offsetEast = -new Date().getTimezoneOffset();
        var utcRunAt = localHHMMToUtcHHMM(localRunAt, offsetEast) || "00:00";

        configItems.enabled = textValues.enabled ? textValues.enabled.getValue() : false;
        configItems.pbxmacaddress = textValues.pbxmacaddress.getValue();
        configItems.pbxname = textValues.pbxname.getValue();
        configItems.run_at = textValues.run_at.getValue();
        configItems.re_register = parseInt(textValues.re_register.getValue()) || 5;
        configItems.pbxname = trimStr(textValues.pbxname.getValue());
        configItems.domain = trimStr(textValues.domain ? textValues.domain.getValue() : "");
        configItems.failover_enabled = textValues.failover_enabled ? !!textValues.failover_enabled.getValue() : false;
        configItems.standby_pbxmacaddress = textValues.standby_pbxmacaddress ? textValues.standby_pbxmacaddress.getValue() : "";

        configItems.run_at = utcRunAt;

        configItems.failover_master_ip = textValues.failover_master_ip ? textValues.failover_master_ip.getValue() : "";
        configItems.failover_master_dns = textValues.failover_master_dns ? textValues.failover_master_dns.getValue() : "";
        configItems.failover_standby_ip = textValues.failover_standby_ip ? textValues.failover_standby_ip.getValue() : "";
        configItems.failover_standby_dns = textValues.failover_standby_dns ? textValues.failover_standby_dns.getValue() : "";

        configItems.failover_delay_ms = parseInt(textValues.failover_delay_ms.getValue(), 10) || 60000;
        configItems.failover_poll_ms = parseInt(textValues.failover_poll_ms.getValue(), 10) || 5000;
        configItems.failover_confirm_polls = parseInt(textValues.failover_confirm_polls.getValue(), 10) || 2;
        configItems.failback_confirm_polls = parseInt(textValues.failback_confirm_polls.getValue(), 10) || 2;

        configItems.sip_mask = checksToMask();

        configItems.save();
    }

    function onConfigSaveResult(sender, result) {
        console.log("Config save result: " + result);
        read();
    }

    function pbx(msg) {
        console.log("pbx msg", msg);
        if (msg.mt == "GetAppObjectsResult") {
            sipSchedulerList.clear();
            for (var i = 0; i < msg.objects.length; i++) {
                sipSchedulerList.add(new sipScheduler(msg.objects[i]));
            }
            templatesList = [];
            templatesListCn = [];
            src.send({ mt: "GetConfigObjects", api: "PbxAdminApi" });
        }
        else if (msg.mt == "GetConfigObjectsResult") {
            for (var i = 0; i < msg.objects.length; i++) {
                templatesListCn[templatesListCn.length] = msg.objects[i].cn;
            }
            if (templatesListCn.length > 0) src.send({ mt: "GetObject", api: "PbxAdminApi", cn: templatesListCn[0] });
        }
        else if (msg.mt == "GetObjectResult") {
            var tmpl = new Object();
            tmpl.apps = msg.apps ? msg.apps.split(",") : [];
            tmpl.cn = msg.cn;
            tmpl.guid = msg.guid;
            templatesList[templatesList.length] = tmpl;
            templatesListCn.splice(templatesListCn.indexOf(msg.cn), 1);
            if (templatesListCn.length > 0) src.send({ mt: "GetObject", api: "PbxAdminApi", cn: templatesListCn[0] });
        }
    }

    function sipScheduler(obj) {

        if (obj.type == undefined) {
            obj.type = (obj.url.slice(obj.url.lastIndexOf("/")) === typeUrl[0]) ? 0 : 0;
        }

        this.createNode("div", null, null, "nilstho-sipscheduler-obj").testId("nilstho-sipscheduler-obj-" + obj.sip);
        this.addEvent("click", onedit);
        var appName = this.add(new innovaphone.ui1.Div("width:100px; font-size:15px; color:var(--nilstho-sipscheduler-item-text);", null, "nilstho-sipscheduler-label2")).addTranslation(texts, typeText[obj.type]);
        var header = this.add(new innovaphone.ui1.Div(null, null, "nilstho-sipscheduler-header"));
        var title = header.add(new Text("title", obj.title, 120, 100));
        var sip = header.add(new Text("sip", obj.sip, 120));
        var url = header.add(new Text("url", obj.url.slice(obj.url.lastIndexOf("/")), 220));

        var src = new app.Src(result);
        src.send({ mt: "GetAppLogin", api: "PbxAdminApi", challenge: "1234", app: obj.sip });

        function result(msg) {
            var isrc = new instance.Src(check);
            isrc.send({ mt: "AppCheckLogin", app: msg.app, domain: msg.domain, challenge: "1234", digest: msg.digest });
            function check(msg) {
                if (msg.ok) {
                    if (!copyPwd) copyPwd = obj.sip;
                    header.add(new innovaphone.ui1.SvgInline("position:relative; width:20px; height:20px; margin:5px; fill:var(--nilstho-sipscheduler-green)", "0 0 20 20", "<path d=\'M6.67,17.5,0,10.81,1.62,9.18l5.05,5.06L18.38,2.5,20,4.13Z'/>"));
                }
            }
        }
        function onedit() {
            panel.clear();
            var header = panel.add(new innovaphone.ui1.Div("position:absolute; box-sizing:border-box; padding:10px; width:100%; color: var(--nilstho-sipscheduler-c2); font-size: 18px;")).addTranslation(texts, "editapp");
            var content = panel.add(new innovaphone.ui1.Scrolling("position:absolute; width:100%; top:50px; bottom:40px; margin-top: 5px;", -1, -1, 9, "red"));
            new EditsipScheduler(obj, content);
        }
    }
    sipScheduler.prototype = innovaphone.ui1.nodePrototype;

    function EditsipScheduler(obj, content) {
        var footer = panel.add(new innovaphone.ui1.Div("position:absolute; width:100%; bottom:0px; height:40px"));
        if (obj.guid) footer.add(new innovaphone.ui1.Div("left:10px; bottom:10px", null, "nilstho-sipscheduler-button")).addTranslation(texts, "del").addEvent("click", ondel).testId("nilstho-sipscheduler-del");
        footer.add(new innovaphone.ui1.Div("right:140px; bottom:10px", null, "nilstho-sipscheduler-button")).addTranslation(texts, "ok").addEvent("click", onok).testId("nilstho-sipscheduler-ok");
        footer.add(new innovaphone.ui1.Div("right:10px; bottom:10px", null, "nilstho-sipscheduler-button")).addTranslation(texts, "cancel").addEvent("click", oncancel).testId("nilstho-sipscheduler-cancel");

        var general = content.add(new innovaphone.ui1.Div("position:relative; display:flex; flex-wrap: wrap;"));
        var title = general.add(new ConfigText("title", obj.title, 150)).testId("nilstho-sipscheduler-cn");
        var sip = general.add(new ConfigText("sip", obj.sip, 150)).testId("nilstho-sipscheduler-sip");
        var devicesApps = general.add(new ConfigText("devices_apps", (obj.devices_apps || "devices"), 150)).testId("nilstho-sipscheduler-devices-apps");
        var tmp = [];
        var tmpSelected = [];

        function ondel() {
            var src = new app.Src(result);
            src.send({ mt: "DeleteObject", api: "PbxAdminApi", guid: obj.guid });

            function result(msg) {
                if (msg.mt === "DeleteObjectResult") {
                    src.close();
                    read();
                    setTimeout(function () {
                        reloadObjects();
                    }, 300);
                }
            }
        }


        function onok() {
            // Required fields for app object
            var ok = validateRequiredField([
                { name: "title", field: title, value: function () { return title.getValue(); } },
                { name: "sip", field: sip, value: function () { return sip.getValue(); } },
                { name: "devices_apps", field: devicesApps, value: function () { return devicesApps.getValue(); } }
            ]);
            if (!ok) {
                console.warn("[SM] app validation failed");
                return;
            }

            var src = new app.Src(result);
            var pwd = innovaphone.Manager.randomPwd(16);
            tmpSelected = [];
            for (var i = 0; i < tmp.length; i++) {
                if (tmp[i].getValue()) tmpSelected[tmpSelected.length] = tmp[i].getLabel();
            }
            var appObj = { url: item.httpsUri.slice(0, item.httpsUri.lastIndexOf("/")) + typeUrl[obj.type] };
            var appsStr = normalizeApps(trimStr(devicesApps.getValue()));
            for (var key in typeCheckmarks[obj.type]) appObj[key] = typeCheckmarks[obj.type][key];
            var msg = {
                mt: "UpdateObject",
                api: "PbxAdminApi",
                hide: true,
                critical: true,
                copyPwd: copyPwd,
                cn: trimStr(title.getValue()),
                guid: obj.guid,
                h323: trimStr(sip.getValue()),
                pwd: pwd,
                pseudo: { type: "app", app: appObj }
            };

            if (appsStr) {
                msg.apps = appsStr;
            }

            src.send(msg);
            function result(msg) {
                if (!msg.error) {
                    if (msg.mt == "UpdateObjectResult") {
                        var sent = false;
                        if (tmp.length > 0) {
                            for (var i = 0; i < templatesList.length; i++) {
                                if (templatesList[i].cn == tmp[0].getLabel()) {
                                    var selected = tmp[0].getValue();
                                    tmp.splice(0, 1);
                                    if (selected && templatesList[i].apps.indexOf(sip.getValue()) < 0) {
                                        templatesList[i].apps[templatesList[i].apps.length] = sip.getValue();
                                        src.send({ mt: "UpdateObject", api: "PbxAdminApi", cn: templatesList[i].cn, guid: templatesList[i].guid, apps: templatesList[i].apps.join(",") });
                                        sent = true;
                                        break;
                                    }
                                    else if (!selected && templatesList[i].apps.indexOf(sip.getValue()) >= 0) {
                                        templatesList[i].apps.splice(templatesList[i].apps.indexOf(sip.getValue()), 1);
                                        src.send({ mt: "UpdateObject", api: "PbxAdminApi", cn: templatesList[i].cn, guid: templatesList[i].guid, apps: templatesList[i].apps.join(",") });
                                        sent = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!sent) setPwd();
                    }

                    function setPwd() {
                        src.close();
                        if (copyPwd) {
                            read();
                        }
                        else {
                            src = new managerApi.Src(result);
                            src.send({ mt: "SetInstancePassword", path: item.apUri.slice(0, item.apUri.lastIndexOf("/")), pwd: pwd }, item.ap);
                            function result() {
                                src.close();
                                read();
                            }
                        }
                    }
                }
                else {
                    title.setError(true);
                }
            }
        }

        function oncancel() {
            read();
        }
    }

    EditsipScheduler.prototype = innovaphone.ui1.nodePrototype;

    function setFieldErrorStyle(el, on) {
        if (!el) return;

        if (on) {
            el.style.border = "1px solid #e53935";
            el.style.backgroundColor = "#fdecea";
        }
        else {
            el.style.border = "";
            el.style.backgroundColor = "";
        }
    }

    // Config fields
    function Text(label, text, width, lwidth) {
        this.createNode("div", "position:relative; display:flex");
        this.add(new innovaphone.ui1.Div(lwidth ? "width:" + lwidth + "px" : null, null, "nilstho-sipscheduler-label")).addTranslation(texts, label);
        var text = this.add(new innovaphone.ui1.Div("width:" + width + "px", text, "nilstho-sipscheduler-value"));
        this.set = function (t) { text.container.innerText = t; };
    }
    Text.prototype = innovaphone.ui1.nodePrototype;

    function ConfigText(label, text, width) {
        this.createNode("div", "position:relative; display:flex");
        var label = this.add(new innovaphone.ui1.Div(null, null, "nilstho-sipscheduler-label")).addTranslation(texts, label);
        var inputDiv = this.add(new innovaphone.ui1.Div("position:relative; width:" + width + "px"));
        var input = inputDiv.add(new innovaphone.ui1.Input(null, text, null, 100, null, "nilstho-sipscheduler-input"));
        input.container.oninput = function () { setFieldErrorStyle(input.container, false); };
        var err = this.add(new innovaphone.ui1.Div("margin-left:250px; margin-top:-6px; font-size:12px; color:#e53935; display:none;"));

        this.getValue = function () { return input.getValue(); };
        this.setValue = function (value) { input.setValue(value); };
        this.testId = function (id) { input.testId(id); return this; };
        this.setError = function (on, msg) {
            setFieldErrorStyle(input.container, !!on);
            if (on) { err.container.style.display = "block"; err.container.innerText = msg || "Required"; }
            else { err.container.style.display = "none"; err.container.innerText = ""; }
        };
        this.setTooltip = function (t) { setTooltip(input.container, t); };
        this.input = input;
    }
    ConfigText.prototype = innovaphone.ui1.nodePrototype;

    // Config Text with changed stylesheet, used for the settings panel
    function ConfigText2(label, text, width) {
        this.createNode("div", "position:relative; display:flex; align-items:center; margin-bottom:12px;");
        var label = this.add(new innovaphone.ui1.Div("width:250px; flex-shrink:0;", null, "nilstho-sipscheduler-label")).addTranslation(texts, label);
        var inputDiv = this.add(new innovaphone.ui1.Div("position:relative; width:" + width + "px"));
        var input = inputDiv.add(new innovaphone.ui1.Input(null, text, null, 100, null, "nilstho-sipscheduler-input"));
        input.container.oninput = function () { setFieldErrorStyle(input.container, false); };
        var err = this.add(new innovaphone.ui1.Div("margin-left:250px; margin-top:2px; font-size:12px; color:#e53935; display:none;"));

        this.getValue = function () { return input.getValue(); };
        this.setValue = function (value) { input.setValue(value); };
        this.testId = function (id) { input.testId(id); return this; };
        // error handler with tooltips
        this.setError = function (on, msg) {
            setFieldErrorStyle(input.container, !!on);
            if (on) { err.container.style.display = "block"; err.container.innerText = msg || "Required"; }
            else { err.container.style.display = "none"; err.container.innerText = ""; }
        };
        this.setTooltip = function (t) { setTooltip(input.container, t); };
        this.input = input;
        this.setAttribute = function (name, value) { input.container.setAttribute(name, value); };
        this.input = input;
    }
    ConfigText2.prototype = innovaphone.ui1.nodePrototype;

    // UI for the schedule time field
    function ConfigTime(label, text, width) {
        this.createNode("div", "position:relative; display:flex; align-items:center; margin-bottom:12px;");
        var label = this.add(new innovaphone.ui1.Div("width:250px; flex-shrink:0;", null, "nilstho-sipscheduler-label")).addTranslation(texts, label);
        var inputDiv = this.add(new innovaphone.ui1.Div("position:relative; width:" + width + "px"));
        var input = inputDiv.add(new innovaphone.ui1.Input(null, text, null, 100, "time", "nilstho-sipscheduler-input"));
        input.container.oninput = function () { setFieldErrorStyle(input.container, false); };
        var err = this.add(new innovaphone.ui1.Div("margin-left:250px; margin-top:-6px; font-size:12px; color:#e53935; display:none;"));
        this.getValue = function () { return input.getValue(); };
        this.setValue = function (value) { input.setValue(value); };
        this.testId = function (id) { input.testId(id); return this; };
        this.setError = function (on, msg) {
            setFieldErrorStyle(input.container, !!on);
            if (on) { err.container.style.display = "block"; err.container.innerText = msg || "Invalid value"; }
            else { err.container.style.display = "none"; err.container.innerText = ""; }
        };
        this.setTooltip = function (t) { setTooltip(input.container, t); };
        this.input = input;
    }

    ConfigTime.prototype = innovaphone.ui1.nodePrototype;

    // UI for the re-register time field
    function ConfigNumber(label, text, width) {
        this.createNode("div", "position:relative; display:flex; align-items:center; margin-bottom:12px;");
        var label = this.add(new innovaphone.ui1.Div("width:250px; flex-shrink:0;", null, "nilstho-sipscheduler-label")).addTranslation(texts, label);
        var inputDiv = this.add(new innovaphone.ui1.Div("position:relative; width:" + width + "px"));
        var input = inputDiv.add(new innovaphone.ui1.Input(null, text, null, 100, "number", "nilstho-sipscheduler-input"));
        input.container.min = 0;
        input.container.max = 60;
        input.container.step = 1;
        input.container.placeholder = "0-60";
        input.container.oninput = function () { setFieldErrorStyle(input.container, false); };
        var err = this.add(new innovaphone.ui1.Div("margin-left:250px; margin-top:-6px; font-size:12px; color:#e53935; display:none;"));

        this.getValue = function () { return input.getValue(); };
        this.setValue = function (value) { input.setValue(value); };
        this.testId = function (id) { input.testId(id); return this; };
        this.setError = function (on, msg) {
            setFieldErrorStyle(input.container, !!on);
            if (on) { err.container.style.display = "block"; err.container.innerText = msg || "Invalid value"; }
            else { err.container.style.display = "none"; err.container.innerText = ""; }
        };
        this.setTooltip = function (t) { setTooltip(input.container, t); };
        this.input = input;
    }
    ConfigNumber.prototype = innovaphone.ui1.nodePrototype;

    function ConfigTemplate(sip, template) {
        this.createNode("div", "position:relative; display:flex; margin-right: 5px;");
        var checkbox = this.add(new innovaphone.ui1.Checkbox("position:relative; margin: 7px 0px 7px 15px; width: 20px; height:20px; background-color:var(--nilstho-sipscheduler-green);", false, null, "var(--nilstho-sipscheduler-green)", "white", "var(--nilstho-sipscheduler-c1)"));
        var label = this.add(new innovaphone.ui1.Div("padding: 3px 5px 3px 0px;", template.cn, "nilstho-sipscheduler-label"));
        if (template.apps.indexOf(sip) >= 0) checkbox.setValue(true);

        this.getValue = function () { return checkbox.getValue(); };
        this.setValue = function (value) { checkbox.setValue(value); };
        this.getLabel = function () { return label.container.innerText; };
        this.testId = function (id) { checkbox.testId(id); return this; };
        this.setError = function (on) { setFieldErrorStyle(input.container, on); };
    }
    ConfigTemplate.prototype = innovaphone.ui1.nodePrototype;

    // UI for the checkboxes
    function ConfigCheckbox(labelKey, value, width, lblwidth) {
        this.createNode("div", "position:relative; display:flex; align-items:center");

        // label
        var labelDiv = this.add(new innovaphone.ui1.Div("flex-shrink:0; text-align:left;" + (lblwidth || "70px") + ";", null, "nilstho-sipscheduler-label")).addTranslation(texts, labelKey);

        // checkbox container
        var boxDiv = this.add(new innovaphone.ui1.Div(
            "position:relative; " + (width || "width:140px;") + " display:flex; align-items:center;"
        ));

        var checkbox = boxDiv.add(new innovaphone.ui1.Checkbox(
            "position:relative; margin: 7px 0px 7px 0px; background-color:var(--nilstho-sipscheduler-green);",
            !!value,
            null,
            "var(--nilstho-sipscheduler-green)",
            "white",
            "var(--nilstho-sipscheduler-c1)"
        ));

        this.getValue = function () { return !!checkbox.getValue(); };
        this.setValue = function (v) { checkbox.setValue(!!v); };

        this.testId = function (id) { checkbox.testId(id); return this; };
        this.setError = function (on) { checkbox.container.style.outline = (on ? "1px solid red" : ""); };
        this.setDisabled = function (dis) { checkbox.setDisabled(!!dis); };
        this.setOnChange = function (handler) {
            if (!handler) return this;
            if (checkbox && checkbox.container && checkbox.container.addEventListener) {
                checkbox.container.addEventListener("click", function () { handler(); });
            }
            return this;
        };
    }
    ConfigCheckbox.prototype = innovaphone.ui1.nodePrototype;


    function ConfigNumberMs(label, text, width) {
        this.createNode("div", "position:relative; display:flex; align-items:center; margin-bottom:12px;");
        var labelEl = this.add(new innovaphone.ui1.Div("width:250px; flex-shrink:0;", null, "nilstho-sipscheduler-label")).addTranslation(texts, label);
        var inputDiv = this.add(new innovaphone.ui1.Div("position:relative; width:" + width + "px"));
        var input = inputDiv.add(new innovaphone.ui1.Input(null, text, null, 100, "number", "nilstho-sipscheduler-input"));
        input.container.min = 0;
        input.container.max = 600000;
        input.container.step = 1000;
        input.container.placeholder = "ms";
        input.container.oninput = function () { setFieldErrorStyle(input.container, false); };
        var err = this.add(new innovaphone.ui1.Div("margin-left:250px; margin-top:-6px; font-size:12px; color:#e53935; display:none;"));
        this.getValue = function () { return input.getValue(); };
        this.setValue = function (value) { input.setValue(value); };
        this.testId = function (id) { input.testId(id); return this; };
        this.setError = function (on, msg) {
            setFieldErrorStyle(input.container, !!on);
            if (on) { err.container.style.display = "block"; err.container.innerText = msg || "Invalid value"; }
            else { err.container.style.display = "none"; err.container.innerText = ""; }
        };
        this.setTooltip = function (t) { setTooltip(input.container, t); };
        this.input = input;
    }
    ConfigNumberMs.prototype = innovaphone.ui1.nodePrototype;

    function ConfigNumberSmall(label, text, width) {
        this.createNode("div", "position:relative; display:flex; align-items:center; margin-bottom:12px;");
        this.add(new innovaphone.ui1.Div("width:250px; flex-shrink:0;", null, "nilstho-sipscheduler-label")).addTranslation(texts, label);
        var inputDiv = this.add(new innovaphone.ui1.Div("position:relative; width:" + width + "px"));
        var input = inputDiv.add(new innovaphone.ui1.Input(null, text, null, 100, "number", "nilstho-sipscheduler-input"));
        input.container.min = 1;
        input.container.max = 10;
        input.container.step = 1;
        input.container.placeholder = "1-10";
        input.container.oninput = function () { setFieldErrorStyle(input.container, false); };
        var err = this.add(new innovaphone.ui1.Div("margin-left:250px; margin-top:-6px; font-size:12px; color:#e53935; display:none;"));
        this.getValue = function () { return input.getValue(); };
        this.setValue = function (value) { input.setValue(value); };
        this.testId = function (id) { input.testId(id); return this; };
        this.setError = function (on, msg) {
            setFieldErrorStyle(input.container, !!on);
            if (on) { err.container.style.display = "block"; err.container.innerText = msg || "Invalid value"; }
            else { err.container.style.display = "none"; err.container.innerText = ""; }
        };
        this.setTooltip = function (t) { setTooltip(input.container, t); };
        this.input = input;
    }
    ConfigNumberSmall.prototype = innovaphone.ui1.nodePrototype;


}
plugin.nilstho.sipschedulermanager.prototype = innovaphone.ui1.nodePrototype;
