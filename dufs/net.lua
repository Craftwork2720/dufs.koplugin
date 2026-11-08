-- SPDX-License-Identifier: AGPL-3.0-only

-- HTTP helpers for the updater. LuaSocket is synchronous, so callers must
-- avoid painting while a request runs.

local http = require("socket.http")
local logger = require("logger")
local ltn12 = require("ltn12")
local socket = require("socket")
local socketutil = require("socketutil")
local url = require("socket.url")

local Net = {}

local function supported(url_str)
    local parsed = url.parse(url_str)
    return parsed and (parsed.scheme == "http" or parsed.scheme == "https")
end

-- GET: (200, headers, body); nil on transport failure; (code, headers, nil) on
-- a non-200 response.
function Net.get(url_str, opts)
    opts = opts or {}
    if not supported(url_str) then
        logger.warn("Dufs: unsupported update URL")
        return nil
    end

    local sink = {}
    local request = {
        url = url_str,
        headers = {
            ["Accept"] = opts.accept or "*/*",
            ["Accept-Encoding"] = "identity",
            ["User-Agent"] = "dufs.koplugin-updater",
        },
        sink = ltn12.sink.table(sink),
    }

    socketutil:set_timeout(socketutil.FILE_BLOCK_TIMEOUT, socketutil.FILE_TOTAL_TIMEOUT)
    local ok, code, headers = pcall(function()
        -- socket.skip(1, ...) drops the connection status.
        return socket.skip(1, http.request(request))
    end)
    socketutil:reset_timeout()

    if not ok or type(code) ~= "number" then
        logger.warn("Dufs: update request failed:", tostring(code))
        return nil
    end
    if code ~= 200 then
        logger.warn("Dufs: update request returned HTTP", code)
        return code, headers, nil
    end
    return 200, headers, table.concat(sink)
end

-- GET to a file: true, or nil plus "network"/"http"/"write".
-- A partial file is removed so it cannot be mistaken for a complete download.
function Net.getToFile(url_str, path, opts)
    opts = opts or {}
    if not supported(url_str) then
        return nil, "network"
    end

    local handle, open_err = io.open(path, "wb")
    if not handle then
        logger.warn("Dufs: cannot write update file:", tostring(open_err))
        return nil, "write"
    end

    -- The release zip contains all musl binaries; 60s is too tight on slow
    -- Wi-Fi, while the per-read timeout still catches a dead connection.
    socketutil:set_timeout(socketutil.FILE_BLOCK_TIMEOUT, 300)
    local ok, code = pcall(function()
        return socket.skip(1, http.request({
            url = url_str,
            headers = {
                ["Accept"] = opts.accept or "*/*",
                ["Accept-Encoding"] = "identity",
                ["User-Agent"] = "dufs.koplugin-updater",
            },
            sink = socketutil.file_sink(handle),
        }))
    end)
    socketutil:reset_timeout()

    -- file_sink normally closes the handle; closing again is harmless here.
    pcall(handle.close, handle)

    if not ok or type(code) ~= "number" or code ~= 200 then
        logger.warn("Dufs: update download failed:", tostring(code))
        pcall(os.remove, path)
        return nil, (type(code) == "number") and "http" or "network"
    end
    return true
end

-- KOReader builds expose different JSON modules; require encode as well for
-- the updater's small release cache.
local json_decoder, json_looked
function Net.jsonDecoder()
    if json_looked then
        return json_decoder
    end
    json_looked = true
    for _, name in ipairs({ "rapidjson", "json", "cjson" }) do
        local ok, mod = pcall(require, name)
        if ok and type(mod) == "table"
            and type(mod.decode) == "function" and type(mod.encode) == "function" then
            json_decoder = mod
            return mod
        end
    end
    logger.warn("Dufs: no JSON module is available for update checks")
    return nil
end

return Net
