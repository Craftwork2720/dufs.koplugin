-- SPDX-License-Identifier: AGPL-3.0-only

local ButtonDialog = require("ui/widget/buttondialog")
local DataStorage = require("datastorage")
local Device = require("device")
local Dispatcher = require("dispatcher")
local InfoMessage = require("ui/widget/infomessage")
local MultiInputDialog = require("ui/widget/multiinputdialog")
local NetworkMgr = require("ui/network/manager")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local ffiutil = require("ffi/util")
local lfs = require("libs/libkoreader-lfs")
local logger = require("logger")
local socket = require("socket")
local T = ffiutil.template
local _ = require("gettext")

-- QR support is optional: some KOReader builds lack qrencode.
local has_qr, QRMessage = pcall(require, "ui/widget/qrmessage")
if not has_qr then QRMessage = nil end

-- Keep the updater optional so a broken/partial install still runs the server.
local Updater
do
    local ok, mod = pcall(require, "dufs/updater")
    if ok then
        Updater = mod
    else
        logger.warn("Dufs: updater unavailable:", mod)
    end
end

local PID_FILE = "/tmp/dufs_koreader.pid"
local LOG_FILE = "/tmp/dufs_koreader.log"
local START_SH = "/tmp/dufs_koreader_start.sh"
local UI_DIR = ".dufs"
local UI_PATHS_FILE = UI_DIR .. "/paths.json"
local UI_SETTINGS_SUBDIR = "dufs-ui"
local UI_SETTINGS_FILE = "settings.json"
local UI_CACHE_SUBDIR = "dufs"

local IDLE_CHECK_INTERVAL = 60
local idle_watchdog_token = 0

local Dufs = WidgetContainer:extend{
    name = "dufs",
    is_doc_only = false,
}

-- shell-quote a string
local function shq(s)
    return "'" .. (tostring(s):gsub("'", "'\\''")) .. "'"
end

local function sh_ok(cmd)
    local r = os.execute(cmd)
    return r == 0 or r == true
end

-- NetworkMgr:getLocalIpAddress() doesn't exist in all KOReader versions
local function getLocalIp()
    if NetworkMgr.getLocalIpAddress then
        local ok, ip = pcall(NetworkMgr.getLocalIpAddress, NetworkMgr)
        if ok and ip then return ip end
    end
    -- UDP "connect" picks the outgoing interface without sending any packet
    local ok, ip = pcall(function()
        local s = socket.udp()
        s:setpeername("1.1.1.1", 80)
        local addr = s:getsockname()
        s:close()
        return addr
    end)
    if ok and ip and ip ~= "0.0.0.0" then return ip end
    return nil
end

-- The device may expose several IPv4 addresses at once (Wi-Fi/LAN, Tailscale,
-- USB...). `ip`/`ifconfig` availability varies across readers, so try both and
-- deduplicate; getLocalIp() remains the fallback when no command works.
local function getLocalIps()
    local ips, seen = {}, {}
    local function add(ip)
        if not ip or ip == "0.0.0.0" or ip:match("^127%.") then return end
        if not ip:match("^%d+%.%d+%.%d+%.%d+$") then return end
        if seen[ip] then return end
        seen[ip] = true
        ips[#ips + 1] = ip
    end

    add(getLocalIp())

    local function collect(cmd, ...)
        local p = io.popen(cmd)
        if not p then return end
        local patterns = { ... }
        for line in p:lines() do
            for _, pattern in ipairs(patterns) do
                for ip in line:gmatch(pattern) do
                    add(ip)
                end
            end
        end
        p:close()
    end

    collect("ip addr show 2>/dev/null", "inet%s+(%d+%.%d+%.%d+%.%d+)")
    collect("ifconfig -a 2>/dev/null",
        "inet%s+addr:%s*(%d+%.%d+%.%d+%.%d+)",
        "inet%s+(%d+%.%d+%.%d+%.%d+)")
    collect("hostname -I 2>/dev/null", "(%d+%.%d+%.%d+%.%d+)")

    return ips
end

local function url_escape_path(path)
    return (path:gsub("([^%w%-%._~/])", function(char)
        return string.format("%%%02X", string.byte(char))
    end))
end

local function getDirectUrls(port, home_rel)
    local suffix = ""
    if home_rel and home_rel ~= "" then
        suffix = "/" .. url_escape_path(home_rel) .. "/"
    end
    local urls = {}
    for _, ip in ipairs(getLocalIps()) do
        urls[#urls + 1] = string.format("http://%s:%s%s", ip, port, suffix)
    end
    return urls
end

local function is_tailscale_ip(ip)
    local a, b = ip:match("^(%d+)%.(%d+)%.")
    a, b = tonumber(a), tonumber(b)
    return a == 100 and b ~= nil and b >= 64 and b <= 127
end

local function read_file(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local s = f:read("*a")
    f:close()
    return s
end

-- /proc/net/tcp uses uppercase hex ports and state 01 for ESTABLISHED.
-- Any established connection means a transfer or an open client session is
-- still using the server, so the idle watchdog must not stop it.
local function has_active_connection(port)
    local port_number = tonumber(port)
    if not port_number then return false end
    local file = io.open("/proc/net/tcp", "r")
    if not file then return false end
    local suffix = ":" .. string.format("%04X", port_number)
    file:read("*l") -- header
    local active = false
    for line in file:lines() do
        local local_addr, state = line:match("^%s*%d+:%s*(%S+)%s+%S+%s+(%x+)")
        if local_addr and state == "01" and local_addr:sub(-#suffix) == suffix then
            active = true
            break
        end
    end
    file:close()
    return active
end

function Dufs:reloadSettings()
    self.port = G_reader_settings:readSetting("dufs_port") or "5020"
    self.username = G_reader_settings:readSetting("dufs_username") or ""
    self.password = G_reader_settings:readSetting("dufs_password") or ""
    self.root = G_reader_settings:readSetting("dufs_root")
    self.home = G_reader_settings:readSetting("dufs_home")
end

function Dufs:init()
    self:reloadSettings()
    self.keep_on_suspend = G_reader_settings:isTrue("dufs_keep_on_suspend")
    self._restore_after_suspend = false
    self._starting = false
    self.ui.menu:registerToMainMenu(self)
    self:onDispatcherRegisterActions()

    if Updater then
        Updater.setPluginDir(self:getPluginDir())
        Updater.setInstalledVersion(self.version)
        Updater.checkAtStartup()
    end

    self._running = self:isRunning()
    if self._running then self:startIdleWatchdog() end
end

function Dufs:getPluginDir()
    if self.path then return self.path end
    local src = debug.getinfo(1, "S").source:gsub("^@", "")
    return src:match("^(.*)/main%.lua$") or "."
end

function Dufs:getRoot()
    return self.root
        or G_reader_settings:readSetting("home_dir")
        or Device.home_dir
        or lfs.currentdir()
end

local function relative_path(path, base)
    if not path or not base then return nil end
    path = path:gsub("/+$", "")
    base = base:gsub("/+$", "")
    if base == "" then return (path:gsub("^/+", "")) end
    if path == base then return "" end
    if path:sub(1, #base + 1) == base .. "/" then
        return path:sub(#base + 2)
    end
    return nil
end

local function has_dot_segments(path)
    for segment in path:gmatch("[^/]+") do
        if segment == "." or segment == ".." then return true end
    end
    return false
end

function Dufs:getHome()
    local root = self:getRoot()
    if self.home and self.home ~= ""
        and not has_dot_segments(self.home)
        and relative_path(self.home, root) ~= nil then
        return self.home
    end
    return root
end

-- Short base address for the menu status line; the address dialog adds the
-- home path to the QR target.
function Dufs:getPrimaryUrl()
    local ip = getLocalIp()
    if not ip or not ip:match("^%d+%.%d+%.%d+%.%d+$") then return nil end
    return string.format("http://%s:%s", ip, self.port)
end

local function json_escape(value)
    return (value:gsub("\\", "\\\\"):gsub('"', '\\"'))
end

local function is_symlink(path)
    if not lfs.symlinkattributes then return false end
    local ok, mode = pcall(lfs.symlinkattributes, path, "mode")
    return ok and mode == "link"
end

local function create_symlink(link, target)
    if is_symlink(link) then
        os.remove(link)
    elseif lfs.attributes(link) ~= nil then
        return false
    end
    return sh_ok("ln -s " .. shq(target) .. " " .. shq(link) .. " 2>/dev/null")
end

-- Keep every technical web UI file inside one hidden .dufs directory in the
-- served root. Settings and the cover cache still live in KOReader's own
-- directories when they are reachable, either directly or through links in
-- .dufs. FAT storage cannot create symlinks, so it keeps both under .dufs.
function Dufs:setupUiStorage()
    local root = self:getRoot()
    local root_prefix = root:gsub("/+$", "")
    local data_dir = DataStorage.getFullDataDir and DataStorage:getFullDataDir()
        or DataStorage:getDataDir()
    local relative_data = relative_path(data_dir, root_prefix)

    local ui_dir = root_prefix .. "/" .. UI_DIR
    sh_ok("mkdir -p " .. shq(ui_dir))
    local settings_link = ui_dir .. "/settings"
    local cache_link = ui_dir .. "/covers"
    local settings_dir, cache_dir, settings_rel, cache_rel
    local use_symlinks = false

    if relative_data then
        local prefix = relative_data ~= "" and relative_data .. "/" or ""
        settings_dir = data_dir .. "/settings/" .. UI_SETTINGS_SUBDIR
        cache_dir = data_dir .. "/cache/" .. UI_CACHE_SUBDIR
        settings_rel = prefix .. "settings/" .. UI_SETTINGS_SUBDIR .. "/" .. UI_SETTINGS_FILE
        cache_rel = prefix .. "cache/" .. UI_CACHE_SUBDIR .. "/"
        -- Keep .dufs itself free of stale links when settings are reachable
        -- directly (for example when the root contains KOReader's data dir).
        if is_symlink(settings_link) then os.remove(settings_link) end
        if is_symlink(cache_link) then os.remove(cache_link) end
    else
        local settings_target = data_dir .. "/settings/" .. UI_SETTINGS_SUBDIR
        local cache_target = data_dir .. "/cache/" .. UI_CACHE_SUBDIR
        sh_ok("mkdir -p " .. shq(settings_target) .. " " .. shq(cache_target))

        local created_settings = create_symlink(settings_link, settings_target)
        local created_cache = create_symlink(cache_link, cache_target)

        if is_symlink(settings_link) and is_symlink(cache_link) then
            use_symlinks = true
            settings_dir = settings_target
            cache_dir = cache_target
            settings_rel = UI_DIR .. "/settings/" .. UI_SETTINGS_FILE
            cache_rel = UI_DIR .. "/covers/"
        else
            -- Drop any link (including one left by an earlier start) so the
            -- fallback never writes through a symlink without --allow-symlink.
            if created_settings or is_symlink(settings_link) then os.remove(settings_link) end
            if created_cache or is_symlink(cache_link) then os.remove(cache_link) end
            settings_dir = ui_dir .. "/settings"
            cache_dir = ui_dir .. "/covers"
            settings_rel = UI_DIR .. "/settings/" .. UI_SETTINGS_FILE
            cache_rel = UI_DIR .. "/covers/"
        end
    end

    sh_ok("mkdir -p " .. shq(settings_dir) .. " " .. shq(cache_dir))
    local home_rel = relative_path(self:getHome(), root_prefix) or ""
    local config = io.open(root_prefix .. "/" .. UI_PATHS_FILE, "w")
    if config then
        config:write(string.format(
            '{"settings":"%s","cache":"%s","home":"%s"}\n',
            json_escape(settings_rel), json_escape(cache_rel), json_escape(home_rel)))
        config:close()
    end
    return use_symlinks
end

function Dufs:showAddressDialog(started)
    local root = self:getRoot()
    local home_rel = relative_path(self:getHome(), root) or ""
    local urls = getDirectUrls(self.port, home_rel)
    local heading = started and _("Dufs started.") or _("Dufs addresses")
    local target_line = T(_("Root: %1"), root)
    local network_note = _("Both devices must be on the same local network (or Tailscale).")
    if #urls == 0 then
        UIManager:show(InfoMessage:new{
            text = T(_("%1\n\nNo network address found.\n\n%2\n\n%3"),
                heading, target_line, network_note),
        })
        return
    end
    if not QRMessage then
        UIManager:show(InfoMessage:new{
            text = T(_("%1\n\nDirect:\n%2\n\n%3\n\n%4"),
                heading, table.concat(urls, "\n"), target_line, network_note),
        })
        return
    end

    local qr_title = _("Scan to open Dufs")
    local buttons = {}
    local dialog
    for _index = 1, #urls do
        local url = urls[_index]
        local label = url:match("^https?://([^/]+)") or url
        local ip = label:match("^([^:]+)")
        if ip and is_tailscale_ip(ip) then
            label = label .. " (Tailscale)"
        end
        buttons[#buttons + 1] = {{
            text = label,
            callback = function()
                UIManager:show(QRMessage:new{
                    title = qr_title,
                    text = url,
                })
            end,
        }}
    end
    buttons[#buttons + 1] = {{
        text = _("Close"),
        callback = function() UIManager:close(dialog) end,
    }}

    local title = T(_("%1\n\nTap an address to show its QR code.\n%2"),
        heading, network_note)
    dialog = ButtonDialog:new{
        title = title,
        buttons = buttons,
    }
    UIManager:show(dialog)
end

function Dufs:getArch()
    local p = io.popen("uname -m")
    local m = p and p:read("*l") or ""
    if p then p:close() end
    if m:match("^aarch64") or m:match("^arm64") then return "aarch64" end
    if m:match("^arm") then return "armv7" end
    if m:match("^x86_64") then return "x86_64" end
    return m
end

-- looks for bin/dufs-<arch>, then bin/dufs, then dufs in PATH
function Dufs:findBinary()
    local dir = self:getPluginDir() .. "/bin/"
    for _, name in ipairs({ "dufs-" .. self:getArch(), "dufs" }) do
        if lfs.attributes(dir .. name, "mode") == "file" then
            os.execute("chmod +x " .. shq(dir .. name))
            return dir .. name
        end
    end
    if sh_ok("command -v dufs >/dev/null 2>&1") then return "dufs" end
    return nil
end

-- kill -0 alone is not enough: after a KOReader restart the PID left in the
-- file may be reused by an unrelated process. /proc/<pid>/comm identifies the
-- actual process without depending on ps.
local function process_is_dufs(pid)
    local handle = io.open("/proc/" .. pid .. "/comm", "r")
    if not handle then return false end
    local name = handle:read("*l") or ""
    handle:close()
    return name:match("^dufs") ~= nil
end

function Dufs:isRunning()
    local pid = read_file(PID_FILE)
    if not pid then
        self._running = false
        return false
    end
    pid = pid:match("%d+")
    if not pid then
        self._running = false
        os.remove(PID_FILE)
        return false
    end
    self._running = sh_ok("kill -0 " .. pid .. " 2>/dev/null")
        and process_is_dufs(pid)
    if not self._running then
        os.remove(PID_FILE)
    end
    return self._running
end

-- isRunning spawns a shell; redrawing a button only reads the PID file and
-- /proc, yet still notices a process killed outside the plugin.
function Dufs:isRunningCached()
    if self._running ~= true then
        return false
    end
    local pid = read_file(PID_FILE)
    pid = pid and pid:match("%d+")
    return pid ~= nil and process_is_dufs(pid)
end

function Dufs:getIdleTimeout()
    return tonumber(G_reader_settings:readSetting("dufs_idle_timeout")) or 0
end

function Dufs:stopIdleWatchdog()
    idle_watchdog_token = idle_watchdog_token + 1
end

function Dufs:startIdleWatchdog()
    self:stopIdleWatchdog()
    local minutes = self:getIdleTimeout()
    if minutes <= 0 then return end
    local token = idle_watchdog_token
    local function check()
        if token ~= idle_watchdog_token then return end
        if not self:isRunningCached() then return end
        if has_active_connection(self.port) then
            UIManager:scheduleIn(IDLE_CHECK_INTERVAL, check)
            return
        end
        local now = os.time()
        local mtime = lfs.attributes(LOG_FILE, "modification") or now
        if now - mtime >= minutes * 60 then
            self:stop()
            UIManager:show(InfoMessage:new{
                text = T(_("Dufs stopped after %1 minutes of inactivity."), minutes),
                timeout = 2,
            })
            return
        end
        UIManager:scheduleIn(IDLE_CHECK_INTERVAL, check)
    end
    UIManager:scheduleIn(IDLE_CHECK_INTERVAL, check)
end

function Dufs:setIdleTimeout(minutes)
    G_reader_settings:saveSetting("dufs_idle_timeout", minutes)
    if self:isRunning() then
        self:startIdleWatchdog()
    else
        self:stopIdleWatchdog()
    end
end

function Dufs:openFirewall()
    if Device:isKindle() then
        os.execute(string.format(
            "iptables -I INPUT -p tcp --dport %s -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT 2>/dev/null",
            self.port))
    end
end

function Dufs:closeFirewall()
    if Device:isKindle() then
        os.execute(string.format(
            "iptables -D INPUT -p tcp --dport %s -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT 2>/dev/null",
            self.port))
    end
end

function Dufs:start(silent)
    if self._starting then return end
    if self:isRunning() then
        self:startIdleWatchdog()
        return
    end
    self._starting = true
    local bin = self:findBinary()
    if not bin then
        self._starting = false
        UIManager:show(InfoMessage:new{
            text = T(_("dufs binary not found.\nPut dufs-%1 (or dufs) in:\n%2/bin/"),
                self:getArch(), self:getPluginDir()),
        })
        return
    end

    local use_symlinks = self:setupUiStorage()
    local args = { shq(bin), "-p", shq(self.port), "-b", "0.0.0.0" }
    local assets = self:getPluginDir() .. "/assets"
    if lfs.attributes(assets .. "/index.html", "mode") == "file" then
        table.insert(args, "--assets")
        table.insert(args, shq(assets))
    end
    if use_symlinks then
        table.insert(args, "--allow-symlink")
    end
    -- Keep the whole technical directory out of directory listings.
    table.insert(args, "--hidden")
    table.insert(args, shq(".dufs*"))
    if self.username ~= "" and self.password ~= "" then
        table.insert(args, "--auth")
        table.insert(args, shq(self.username .. ":" .. self.password .. "@/:rw"))
        -- `:rw` in the auth rule only grants what the global operation flags
        -- enable; without these an authenticated account is read-only.
        table.insert(args, "--allow-upload")
        table.insert(args, "--allow-delete")
        table.insert(args, "--allow-search")
        table.insert(args, "--allow-archive")
    else
        table.insert(args, "-A") -- anonymous full access
    end
    table.insert(args, shq(self:getRoot()))

    local f = io.open(START_SH, "w")
    if not f then
        self._starting = false
        return
    end
    f:write("#!/bin/sh\n")
    f:write("echo $$ > " .. shq(PID_FILE) .. "\n")
    f:write("exec " .. table.concat(args, " ") .. "\n")
    f:close()

    self:openFirewall()
    os.execute(string.format("sh %s > %s 2>&1 &", shq(START_SH), shq(LOG_FILE)))

    UIManager:scheduleIn(1.5, function()
        self._starting = false
        os.remove(START_SH) -- don't leave the password lying around
        if self:isRunning() then
            self:startIdleWatchdog()
            if not silent then
                self:showAddressDialog(true)
            end
        else
            self:closeFirewall()
            UIManager:show(InfoMessage:new{
                text = _("Dufs failed to start:\n") .. (read_file(LOG_FILE) or "?"):sub(-400),
            })
        end
    end)
end

function Dufs:stop()
    self:stopIdleWatchdog()
    self._starting = false
    local pid = read_file(PID_FILE)
    pid = pid and pid:match("%d+")
    if pid then os.execute("kill " .. pid .. " 2>/dev/null") end
    os.remove(PID_FILE)
    self._running = false
    self:closeFirewall()
end

function Dufs:toggle()
    if self._starting then return end
    if self:isRunning() then
        self:stop()
        UIManager:show(InfoMessage:new{ text = _("Dufs stopped."), timeout = 2 })
    else
        NetworkMgr:runWhenOnline(function() self:start() end)
    end
end

function Dufs:onDispatcherRegisterActions()
    Dispatcher:registerAction("dufs_start", {
        category = "none",
        event = "DufsStart",
        title = _("Start Dufs server"),
        general = true,
    })
    Dispatcher:registerAction("dufs_stop", {
        category = "none",
        event = "DufsStop",
        title = _("Stop Dufs server"),
        general = true,
    })
    Dispatcher:registerAction("dufs_toggle", {
        category = "none",
        event = "DufsToggle",
        title = _("Toggle Dufs server"),
        general = true,
        separator = true,
    })
end

function Dufs:onDufsStart()
    if not self:isRunning() then
        NetworkMgr:runWhenOnline(function() self:start() end)
    end
    return true
end

function Dufs:onDufsStop()
    if self:isRunning() then
        self:stop()
        UIManager:show(InfoMessage:new{ text = _("Dufs stopped."), timeout = 2 })
    end
    return true
end

function Dufs:onDufsToggle()
    self:toggle()
    return true
end

function Dufs:showSettings(touchmenu_instance)
    local dialog
    dialog = MultiInputDialog:new{
        title = _("Dufs settings"),
        fields = {
            { text = self.port, description = _("Port"), input_type = "number" },
            { text = self.username, description = _("Username (empty = no auth)") },
            { text = self.password, description = _("Password"), text_type = "password" },
            { text = self:getRoot(), description = _("Root directory") },
            { text = self:getHome(), description = _("Home directory (inside root)") },
        },
        buttons = {{
            {
                text = _("Cancel"),
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Save"),
                callback = function()
                    local f = dialog:getFields()

                    local port = tonumber(f[1] ~= "" and f[1] or "5020")
                    if not port or port % 1 ~= 0 or port < 1 or port > 65535 then
                        UIManager:show(InfoMessage:new{
                            text = _("Port must be a whole number between 1 and 65535."),
                        })
                        return
                    end

                    local username, password = f[2], f[3]
                    if (username ~= "") ~= (password ~= "") then
                        UIManager:show(InfoMessage:new{
                            text = _("Enter both a username and a password, or leave both empty to disable authentication."),
                        })
                        return
                    end

                    local old_home = self:getHome():gsub("/+$", "")
                    local new_root = f[4] ~= "" and f[4]
                        or G_reader_settings:readSetting("home_dir")
                        or Device.home_dir
                        or lfs.currentdir()
                    local root_check = new_root:gsub("/+$", "")
                    if root_check == "" then root_check = "/" end
                    if lfs.attributes(root_check, "mode") ~= "directory" then
                        UIManager:show(InfoMessage:new{
                            text = _("Root directory does not exist or is not a directory."),
                        })
                        return
                    end

                    local new_home = f[5] ~= "" and f[5]:gsub("/+$", "") or nil
                    -- A prefilled default home follows the root when it changes;
                    -- only an explicitly saved home is treated as fixed.
                    if new_home == old_home and not self.home then
                        new_home = nil
                    end
                    if new_home and new_home == new_root:gsub("/+$", "") then
                        new_home = nil
                    end
                    if new_home and (has_dot_segments(new_home)
                        or relative_path(new_home, new_root) == nil) then
                        UIManager:show(InfoMessage:new{
                            text = _("Home directory must be inside the root directory."),
                        })
                        return
                    end
                    if new_home and lfs.attributes(new_home, "mode") ~= "directory" then
                        UIManager:show(InfoMessage:new{
                            text = _("Home directory does not exist or is not a directory."),
                        })
                        return
                    end

                    local was_running = self:isRunning()
                    if was_running then self:stop() end
                    self.port = tostring(port)
                    self.username, self.password = username, password
                    self.root = f[4] ~= "" and f[4] or nil
                    self.home = new_home
                    G_reader_settings:saveSetting("dufs_port", self.port)
                    G_reader_settings:saveSetting("dufs_username", self.username)
                    G_reader_settings:saveSetting("dufs_password", self.password)
                    G_reader_settings:saveSetting("dufs_root", self.root)
                    G_reader_settings:saveSetting("dufs_home", self.home)
                    UIManager:close(dialog)
                    UIManager:show(InfoMessage:new{
                        text = _("Settings saved."),
                        timeout = 2,
                    })
                    if touchmenu_instance then touchmenu_instance:updateItems() end
                    if was_running then self:toggle() end
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

function Dufs:addToMainMenu(menu_items)
    local function idle_option(label, minutes)
        return {
            text = label,
            radio = true,
            keep_menu_open = true,
            checked_func = function() return self:getIdleTimeout() == minutes end,
            callback = function(touchmenu_instance)
                self:setIdleTimeout(minutes)
                if touchmenu_instance then touchmenu_instance:updateItems() end
            end,
        }
    end
    local sub_item_table = {
        {
            text_func = function()
                if self._starting then return _("Starting…") end
                if not self:isRunningCached() then return T(_("Stopped (port %1)"), self.port) end
                local url = self:getPrimaryUrl()
                return url and T(_("Running at %1"), url)
                    or T(_("Running on port %1"), self.port)
            end,
            enabled = false,
            help_text_func = function()
                if self._starting then return _("The server is starting.") end
                if not self:isRunningCached() then return _("The server is stopped.") end
                if self.username == "" or self.password == "" then
                    return _("Authentication is disabled: anyone on the network can access the server.")
                end
                return _("The server is running.")
            end,
        },
        {
            text_func = function()
                if self._starting then return _("Starting…") end
                return self:isRunningCached() and _("Stop server") or _("Start server")
            end,
            enabled_func = function() return not self._starting end,
            keep_menu_open = true,
            callback = function(touchmenu_instance)
                self:toggle()
                -- runWhenOnline starts synchronously when already online, so
                -- refresh once now and again after the process came up.
                if touchmenu_instance then touchmenu_instance:updateItems() end
                UIManager:scheduleIn(2, function()
                    if touchmenu_instance then touchmenu_instance:updateItems() end
                end)
            end,
            help_text = _("Start or stop the file server."),
        },
        {
            text_func = function()
                return QRMessage and _("Addresses & QR codes") or _("Addresses")
            end,
            enabled_func = function() return self:isRunningCached() end,
            callback = function() self:showAddressDialog(false) end,
            help_text_func = function()
                return QRMessage
                    and _("Tap an address to show its QR code.")
                    or _("Shows this server's addresses on the network.")
            end,
            separator = true,
        },
        {
            text = _("Settings"),
            keep_menu_open = true,
            callback = function(touchmenu_instance) self:showSettings(touchmenu_instance) end,
            help_text_func = function()
                return T(_("Port: %1\nRoot: %2"), self.port, self:getRoot())
            end,
        },
        {
            text = _("Keep server running when sleeping"),
            keep_menu_open = true,
            checked_func = function() return self.keep_on_suspend end,
            callback = function(touchmenu_instance)
                self.keep_on_suspend = not self.keep_on_suspend
                G_reader_settings:saveSetting("dufs_keep_on_suspend", self.keep_on_suspend)
                if touchmenu_instance then touchmenu_instance:updateItems() end
            end,
        },
        {
            text_func = function()
                local minutes = self:getIdleTimeout()
                if minutes <= 0 then return _("Stop when idle: off") end
                if minutes % 60 == 0 then
                    return T(_("Stop when idle: %1 h"), math.floor(minutes / 60))
                end
                return T(_("Stop when idle: %1 min"), minutes)
            end,
            separator = true,
            sub_item_table = {
                idle_option(_("Off"), 0),
                idle_option(_("5 minutes"), 5),
                idle_option(_("15 minutes"), 15),
                idle_option(_("30 minutes"), 30),
                idle_option(_("1 hour"), 60),
                idle_option(_("2 hours"), 120),
            },
            help_text = _("Stop the server after this period without requests."),
        },
    }
    if Updater then
        sub_item_table[#sub_item_table + 1] = {
            text = _("Check for updates"),
            callback = function() pcall(Updater.checkForUpdates) end,
            help_text_func = function()
                return self.version and T(_("Installed version: %1"), self.version)
                    or _("Check GitHub for a newer release.")
            end,
        }
    end
    menu_items.dufs = {
        text = _("Dufs file server"),
        sorting_hint = "network",
        sub_item_table = sub_item_table,
    }
end

function Dufs:onSuspend()
    -- Remember the state even when keeping the process alive: the OS may
    -- still kill it while suspended. Do not clear a previous true when a
    -- second suspend event arrives after the process was already stopped.
    if self:isRunning() then
        self._restore_after_suspend = true
        if not self.keep_on_suspend then
            self:stop()
        end
    end
end

function Dufs:onResume()
    if not self._restore_after_suspend then return end
    self._restore_after_suspend = false
    if not self:isRunning() then
        -- Silent: a wake-up should not open the address/QR dialog.
        self:start(true)
    end
end

function Dufs:onExit()
    self._restore_after_suspend = false
    if self:isRunning() then self:stop() end
end

return Dufs
