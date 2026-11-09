-- SPDX-License-Identifier: AGPL-3.0-only

local _ = require("gettext")
return {
    fullname = _("Dufs file server"),
    author = "Craftwork2720",
    description = _([[Starts a dufs web file manager on the device (upload, download, delete, mkdir, search, WebDAV) so you can manage files from a browser. Replacement for filebrowser.koplugin.]]),
    -- Load-bearing: the updater compares releases to it, so bump before tagging.
    version = "1.0.1",
}
