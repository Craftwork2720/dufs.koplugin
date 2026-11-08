/* SPDX-License-Identifier: AGPL-3.0-only */

/**
 * Dufs web client.
 *
 * The server injects DATA into <template id="index-data">. Everything else is
 * rendered here. Dialogs are native <dialog> elements opened with showModal():
 * focus trapping, Esc, inert background and ::backdrop come from the browser.
 */

"use strict";

var DUFS_MAX_UPLOADINGS = 1;

/**
 * @type {DATA}
 */
var DATA;

/**
 * @typedef {object} PARAMS
 * @property {string} q
 * @property {string} sort
 * @property {string} order
 */
const PARAMS = Object.fromEntries(new URLSearchParams(window.location.search).entries());

// Keep in sync with _meta.lua and manifest.json; the release workflow checks it.
const APP_VERSION = "1.0.0";
const MAX_SUBPATHS_COUNT = 1000;
const MAX_VIEW_TEXT_SIZE = 1024 * 1024;
const LIGHTBOX_SWIPE_THRESHOLD = 40;
const SPLIT_VIEW_QUERY = "(min-width: 1000px)";
const VIEW_STORAGE_KEY = "dufs-view";
const ANIM_MS = 180;
const UI_PATHS_FILE = ".dufs/paths.json";
const DEFAULT_UI_PATHS = {
  settings: ".dufs/settings/settings.json",
  cache: ".dufs/covers/",
  home: "",
};
let UI_PATHS = { ...DEFAULT_UI_PATHS };
const DEFAULT_UI_SETTINGS = { covers: true, showHidden: false, favorites: [] };
let UI_SETTINGS = { ...DEFAULT_UI_SETTINGS };

const I18N = window.I18N || {
  lang: "en",
  t: (key, vars) => {
    if (!vars) return key;
    return String(key).replace(/\{(\w+)\}/g, (match, name) => (
      vars[name] !== undefined ? String(vars[name]) : match
    ));
  },
  tn: (key, count) => `${count} ${key}`,
  localizeDocument() { },
};
const t = (key, vars) => I18N.t(key, vars);
const tn = (key, count, vars) => I18N.tn(key, count, vars);

function textWithLink(template, token, node) {
  const $fragment = document.createDocumentFragment();
  const parts = String(template).split(`{${token}}`);
  parts.forEach((part, index) => {
    if (index > 0) $fragment.append(node);
    if (part) $fragment.append(part);
  });
  return $fragment;
}

/*
 * Every extension is registered exactly once. The category drives the icon and
 * the preview capability, so there is no priority between overlapping lists.
 * `preview` is one of: "image", "pdf", "audio", "video", "text" or null.
 */
const FORMAT_INFO = Object.create(null);
const BASENAME_FORMATS = Object.create(null);
const FALLBACK_FORMAT = { category: "other", icon: "file", preview: null };

function registerFormats(category, icon, preview, extensions) {
  for (const ext of extensions) {
    if (FORMAT_INFO[ext]) throw new Error(`Duplicate file extension: ${ext}`);
    FORMAT_INFO[ext] = { category, icon, preview };
  }
}

function registerBasenames(category, icon, preview, basenames) {
  for (const basename of basenames) {
    if (BASENAME_FORMATS[basename]) throw new Error(`Duplicate file basename: ${basename}`);
    BASENAME_FORMATS[basename] = { category, icon, preview };
  }
}

// Books and comics.
registerFormats("book", "book", null, [
  ".epub", ".kepub", ".mobi", ".prc", ".azw", ".azw3", ".azw4", ".kfx",
  ".fb2", ".djvu", ".djv", ".xps", ".oxps", ".lit", ".pdb", ".lrf", ".htmlz", ".txtz",
]);
registerFormats("comic", "bookImage", null, [".cbz", ".cbr", ".cbt", ".cb7"]);

// Images: only the browser-decodable formats get a preview.
registerFormats("image", "fileImage", "image", [
  ".jpg", ".jpeg", ".jfif", ".png", ".gif", ".webp", ".svg", ".bmp", ".avif", ".apng", ".ico",
]);
registerFormats("image", "fileImage", null, [
  ".tif", ".tiff", ".heic", ".heif", ".jxl", ".jp2", ".psd", ".raw", ".cr2", ".nef",
  ".arw", ".dng", ".exr", ".hdr",
]);

// Audio/video: the "playable" group can use <audio>/<video>, the rest only Download.
registerFormats("audio", "fileAudio", "audio", [
  ".mp3", ".wav", ".ogg", ".oga", ".m4a", ".m4b", ".flac", ".aac", ".opus", ".weba",
]);
registerFormats("audio", "fileAudio", null, [
  ".wma", ".aiff", ".aif", ".ape", ".wv", ".mka", ".mid", ".midi", ".amr",
  ".ac3", ".dts", ".tta", ".spx",
]);
registerFormats("video", "fileVideo", "video", [".mp4", ".m4v", ".webm", ".ogv"]);
registerFormats("video", "fileVideo", null, [
  ".mov", ".avi", ".wmv", ".flv", ".mkv", ".mpg", ".mpeg", ".3gp", ".3g2",
  ".mts", ".m2ts", ".vob", ".rm", ".rmvb", ".asf", ".divx", ".f4v",
]);

// Archives, packages, disc images and binaries.
registerFormats("archive", "fileArchive", null, [
  ".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".tbz", ".tbz2", ".xz",
  ".txz", ".lz", ".lzma", ".zst", ".cab", ".zipx", ".arj", ".lzh", ".cpio",
]);
registerFormats("package", "package", null, [
  ".jar", ".war", ".ear", ".aar", ".apk", ".aab", ".ipa", ".deb", ".rpm",
  ".appimage", ".flatpak", ".snap", ".msi", ".msix", ".pkg", ".xpi", ".crx",
  ".vsix", ".whl", ".gem", ".nupkg", ".crate",
]);
registerFormats("disc", "disc", null, [
  ".iso", ".img", ".dmg", ".vhdx", ".vdi", ".vmdk", ".nrg", ".mdf",
]);
registerFormats("executable", "binary", null, [
  ".exe", ".dll", ".so", ".dylib", ".bin", ".elf", ".o", ".a", ".lib",
  ".class", ".pyc", ".pyo", ".wasm",
]);

// Text-like formats. Only the ones in FORMAT_INFO with preview "text" open in
// the viewer/editor; the icon is chosen independently by `icon`.
registerFormats("json", "fileJson", "text", [
  ".json", ".jsonc", ".json5", ".jsonl", ".ndjson", ".geojson", ".ipynb",
]);
registerFormats("config", "fileCog", "text", [
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".config", ".properties",
  ".plist", ".desktop", ".service", ".cnf", ".rc", ".reg", ".env",
]);
registerFormats("script", "fileTerminal", "text", [
  ".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".bat", ".cmd", ".ps1",
  ".psm1", ".psd1", ".command",
]);
registerFormats("font", "fileType", null, [
  ".ttf", ".otf", ".woff", ".woff2", ".eot", ".fon", ".fnt",
]);
registerFormats("database", "database", null, [
  ".db", ".sqlite", ".sqlite3", ".mdb", ".accdb", ".dbf", ".parquet", ".avro",
]);
registerFormats("key", "fileKey", null, [
  ".pem", ".crt", ".cer", ".key", ".p12", ".pfx", ".asc", ".gpg", ".pgp",
  ".csr", ".der", ".jks", ".keystore",
]);
registerFormats("subtitle", "subtitles", "text", [
  ".srt", ".vtt", ".ass", ".ssa", ".sub", ".sbv", ".ttml", ".dfxp", ".lrc",
]);
registerFormats("code", "fileCode", "text", [
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".cs", ".java", ".go",
  ".rs", ".swift", ".kt", ".kts", ".scala", ".dart", ".lua", ".py", ".pyw",
  ".rb", ".php", ".pl", ".pm", ".r", ".jl", ".ex", ".exs", ".erl", ".hrl",
  ".fs", ".fsx", ".vb", ".asm", ".s", ".sql", ".html", ".htm", ".xhtml", ".css",
  ".scss", ".sass", ".less", ".styl", ".js", ".mjs", ".cjs", ".jsx", ".ts",
  ".tsx", ".vue", ".svelte", ".astro", ".xml", ".xsl", ".xslt", ".graphql",
  ".gql", ".proto", ".sol", ".clj", ".cljs", ".groovy", ".gradle", ".nim",
  ".zig", ".v", ".vhdl", ".vhd", ".verilog", ".tf", ".hcl", ".nix", ".cmake",
  ".diff", ".patch",
]);
registerFormats("text", "fileText", "text", [
  ".txt", ".text", ".md", ".markdown", ".mdx", ".rst", ".adoc", ".asciidoc",
  ".org", ".tex", ".latex", ".log", ".nfo", ".readme", ".me",
]);
registerFormats("document", "fileText", "pdf", [".pdf"]);
registerFormats("document", "fileText", null, [
  ".doc", ".docx", ".docm", ".dot", ".dotx", ".odt", ".rtf", ".pages", ".chm",
]);
registerFormats("spreadsheet", "fileSpreadsheet", "text", [".csv", ".tsv"]);
registerFormats("spreadsheet", "fileSpreadsheet", null, [
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".xltx", ".ods", ".fods", ".numbers",
]);
registerFormats("presentation", "presentation", null, [
  ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".potx", ".odp", ".fodp",
]);

registerBasenames("code", "fileCode", "text", [
  "makefile", "gnumakefile", "dockerfile", "containerfile", "cmakelists.txt",
  "jenkinsfile", "vagrantfile", "gemfile", "rakefile", "podfile", "brewfile", "procfile",
]);
registerBasenames("text", "fileText", "text", [
  "license", "copying", "notice", "readme", "changelog", "authors", "contributors",
]);
registerBasenames("config", "fileCog", "text", [
  ".gitignore", ".gitattributes", ".gitmodules", ".dockerignore", ".editorconfig",
  ".npmrc", ".yarnrc", ".babelrc", ".eslintrc", ".prettierrc", ".htaccess",
  ".vimrc", ".gitconfig", ".env", ".envrc",
]);
registerBasenames("script", "fileTerminal", "text", [
  ".bashrc", ".zshrc", ".bash_profile", ".profile", ".zprofile", ".zshenv",
]);

function formatInfoFor(name) {
  const base = String(name || "").split("/").pop() || "";
  const lower = base.toLowerCase();
  if (lower.endsWith(".fb2.zip")) return FORMAT_INFO[".fb2"] || FALLBACK_FORMAT;
  if (BASENAME_FORMATS[lower]) return BASENAME_FORMATS[lower];
  if (lower.startsWith("dockerfile.") || lower.startsWith("containerfile.")) {
    return BASENAME_FORMATS["dockerfile"] || FALLBACK_FORMAT;
  }
  if (lower.startsWith("makefile.")) return BASENAME_FORMATS["makefile"] || FALLBACK_FORMAT;
  if (lower.startsWith(".env.")) return BASENAME_FORMATS[".env"] || FALLBACK_FORMAT;
  return FORMAT_INFO[extName(lower)] || FALLBACK_FORMAT;
}

// Icon paths from Lucide (ISC; Feather-derived icons also MIT) — see licenses/lucide/.
const ICONS = {
  folder: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>`,
  folderOpen: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" /></svg>`,
  folderRoot: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" x2="2" y1="12" y2="12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /><line x1="6" x2="6.01" y1="16" y2="16" /><line x1="10" x2="10.01" y1="16" y2="16" /></svg>`,
  folderCog: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3" /><path d="M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3.3" /><path d="m21.7 19.4-.9-.3" /><path d="m15.2 16.9-.9-.3" /><path d="m16.6 21.7.3-.9" /><path d="m19.1 15.2.3-.9" /><path d="m19.6 21.7-.4-1" /><path d="m16.8 15.3-.4-1" /><path d="m14.3 19.6 1-.4" /><path d="m20.7 16.8 1-.4" /></svg>`,
  folderPlus: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 10v6" /><path d="M9 13h6" /><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>`,
  file: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /></svg>`,
  book: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" /></svg>`,
  bookImage: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 13.7-2.1-2.1a2 2 0 0 0-2.8 0L9.7 17" /><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" /><circle cx="10" cy="8" r="2" /></svg>`,
  fileAudio: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0" /></svg>`,
  fileArchive: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M8 12v-1" /><path d="M8 18v-2" /><path d="M8 7V6" /><circle cx="8" cy="20" r="2" /></svg>`,
  fileCode: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 12.5 8 15l2 2.5" /><path d="m14 12.5 2 2.5-2 2.5" /></svg>`,
  fileImage: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><circle cx="10" cy="12" r="2" /><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22" /></svg>`,
  fileSpreadsheet: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M8 13h2" /><path d="M14 13h2" /><path d="M8 17h2" /><path d="M14 17h2" /></svg>`,
  fileText: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>`,
  fileJson: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" /><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" /></svg>`,
  fileCog: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="m3.2 12.9-.9-.4" /><path d="m3.2 15.1-.9.4" /><path d="M4.677 21.5a2 2 0 0 0 1.313.5H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v2.5" /><path d="m4.9 11.2-.4-.9" /><path d="m4.9 16.8-.4.9" /><path d="m7.5 10.3-.4.9" /><path d="m7.5 17.7-.4-.9" /><path d="m9.7 12.5-.9.4" /><path d="m9.7 15.5-.9-.4" /><circle cx="6" cy="14" r="3" /></svg>`,
  fileTerminal: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="m8 16 2-2-2-2" /><path d="M12 18h4" /></svg>`,
  fileType: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M9 13v-1h6v1" /><path d="M12 12v6" /><path d="M11 18h2" /></svg>`,
  fileKey: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><circle cx="10" cy="16" r="2" /><path d="m16 10-4.5 4.5" /><path d="m15 11 1 1" /></svg>`,
  database: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" /></svg>`,
  disc: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="2" /></svg>`,
  subtitles: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="14" x="3" y="5" rx="2" ry="2" /><path d="M7 15h4M15 15h2M7 11h2M13 11h4" /></svg>`,
  binary: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="14" y="14" width="4" height="6" rx="2" /><rect x="6" y="4" width="4" height="6" rx="2" /><path d="M6 20h4" /><path d="M14 10h4" /><path d="M6 14h2v6" /><path d="M14 4h2v6" /></svg>`,
  package: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" /><path d="m7.5 4.27 9 5.15" /></svg>`,
  fileVideo: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z" /></svg>`,
  presentation: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M8 18v-1" /><path d="M12 18v-6" /><path d="M16 18v-3" /></svg>`,
  filePlus: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M9 15h6" /><path d="M12 18v-6" /></svg>`,
  symlinkFile: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="m10 18 3-3-3-3" /></svg>`,
  symlinkDir: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9.35V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7" /><path d="m8 16 3-3-3-3" /></svg>`,
  download: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /></svg>`,
  externalLink: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>`,
  maximize: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg>`,
  save: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" /></svg>`,
  upload: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></svg>`,
  move: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 7.5V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-1.5" /><path d="M2 13h10" /><path d="m5 10-3 3 3 3" /></svg>`,
  rename: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1" /><path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5" /><path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1" /><path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7" /><path d="M9 7v10" /></svg>`,
  edit: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>`,
  delete: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>`,
  view: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></svg>`,
  list: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h.01" /><path d="M8 6h13" /><path d="M3 12h.01" /><path d="M8 12h13" /><path d="M3 18h.01" /><path d="M8 18h13" /></svg>`,
  grid: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>`,
  chevronLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>`,
  chevronRight: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>`,
  arrowUp: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></svg>`,
  arrowDown: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>`,
  chevronsUpDown: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></svg>`,
  more: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>`,
  star: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>`,
  home: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></svg>`,
  check: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>`,
  checkCircle: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>`,
  alert: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></svg>`,
  info: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>`,
  refresh: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>`,
  user: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>`,
  login: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 17 5-5-5-5" /><path d="M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /></svg>`,
  logout: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /></svg>`,
  settings: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>`,
};

const state = {
  view: readView(),
  selected: new Set(),
  lastSelectedIndex: null,
  suppressClickUntil: 0,
  emptyAction: null,
  editorOriginal: "",
  editorDirty: false,
  savingStandalone: false,
};

const detailState = {
  item: null,
  mode: null,
  dirty: false,
  saving: false,
  original: "",
  seq: 0,
};

let $indexPage;
let $editorPage;
let $brand;
let $breadcrumb;
let $searchForm;
let $searchInput;
let $searchClear;
let $uploadLabel;
let $fileInput;
let $newFolderBtn;
let $newFileBtn;
let $viewSwitch;
let $loginBtn;
let $moreBtn;
let $transfers;
let $transfersStatus;
let $transfersProgress;
let $transfersProgressFill;
let $transfersActive;
let $transfersFailed;
let $transfersQueue;
let $transfersQueueToggle;
let $transfersQueueLabel;
let $transfersQueueList;
let $itemCount;
let $gridSort;
let $empty;
let $emptyIcon;
let $emptyTitle;
let $emptyDesc;
let $emptyAction;
let $listing;
let $listingHead;
let $listingBody;
let $detailPane;
let $selectAll;
let $selectionbar;
let $selectionCount;
let $selectionClear;
let $toastStack;
let $menu;
let $dropzone;
let $editor;
let $editorName;
let $editorSub;
let $editorIcon;
let $editorStatus;
let $editorFoot;
let $editorFrame;
let $notEditable;
let $saveBtn;
let $renameFileBtn;
let $moveFileBtn;
let $deleteFileBtn;
let $editorDownload;
let $editFileBtn;
let $coverPreview = null;
let coverPreviewTimer = null;
let coverPreviewToken = 0;
let coverPreviewRow = null;
let topBreadcrumb = null;
let tableNameFitObserver = null;
let tableNameFitFrame = 0;
let tableNameFitTimer = 0;

/* ------------------------------------------------------------------------- */
/* small helpers                                                             */
/* ------------------------------------------------------------------------- */

function $(selector, root = document) {
  return root.querySelector(selector);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "on") {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function toggle(node, show) {
  if (node) node.classList.toggle("hidden", !show);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isDirType(pathType) {
  return pathType === "Dir" || pathType === "SymlinkDir";
}

function isImageName(name) {
  return formatInfoFor(name).preview === "image";
}

function isHiddenName(name) {
  return String(name).split("/").some(part => (
    part.startsWith(".") || part.toLowerCase().endsWith(".sdr")
  ));
}

function isHiddenItem(item) {
  return !UI_SETTINGS.showHidden && isHiddenName(item.name);
}

function visiblePaths() {
  if (!UI_SETTINGS.showHidden && isHiddenName(DATA.href || "")) return [];
  return (DATA.paths || []).filter(item => item && !isHiddenItem(item));
}

function isEpubName(name) {
  return extName(name).toLowerCase() === ".epub";
}

function isCbzName(name) {
  return extName(name).toLowerCase() === ".cbz";
}

function isBookCoverName(name) {
  return isEpubName(name) || isCbzName(name) || isPdfName(name);
}

function isPdfName(name) {
  return extName(name).toLowerCase() === ".pdf";
}

function isBrowserViewableName(name) {
  const preview = formatInfoFor(name).preview;
  return preview === "pdf" || preview === "audio" || preview === "video";
}

function canPreviewItem(item) {
  const preview = formatInfoFor(item.name).preview;
  return preview === "image" || preview === "pdf" || preview === "audio" || preview === "video"
    || (preview === "text" && item.size <= MAX_VIEW_TEXT_SIZE);
}

function readView() {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch (err) {
    return "list";
  }
}

function displayPath(path) {
  return path || "/";
}

/* ------------------------------------------------------------------------- */
/* path and format helpers                                                   */
/* ------------------------------------------------------------------------- */

function uriPrefix() {
  return (DATA.uri_prefix || "/").slice(0, -1);
}

function pathFromUrl(url) {
  const pathname = decodeURIComponent(new URL(url, location.href).pathname);
  const prefix = uriPrefix();
  return prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
}

function urlFromPath(path) {
  if (!path.startsWith("/")) path = "/" + path;
  return location.origin + uriPrefix() + path.split("/").map(encodeURIComponent).join("/");
}

function dirUrlFromPath(path) {
  const url = urlFromPath(path);
  return url.endsWith("/") ? url : url + "/";
}

function parentPath(path) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function basePathName(path) {
  return path.split("/").filter(Boolean).pop() || "";
}

function joinPath(dir, name) {
  return (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;
}

function newUrl(name) {
  let url = baseUrl();
  if (!url.endsWith("/")) url += "/";
  url += name.split("/").map(encodeURIComponent).join("/");
  return url;
}

function baseUrl() {
  return location.href.split(/[?#]/)[0];
}

function extName(filename) {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0 || dotIndex === filename.length - 1) return "";
  return filename.substring(dotIndex);
}

function isSdrName(name) {
  return basePathName(String(name || "")).toLowerCase().endsWith(".sdr");
}

function fileIconFor(name) {
  return ICONS[formatInfoFor(name).icon] || ICONS.file;
}

function getPathSvg(pathType, name) {
  switch (pathType) {
    case "Dir":
      return isSdrName(name) ? ICONS.folderCog : ICONS.folder;
    case "SymlinkFile":
      return ICONS.symlinkFile;
    case "SymlinkDir":
      return isSdrName(name) ? ICONS.folderCog : ICONS.symlinkDir;
    default:
      return name ? fileIconFor(name) : ICONS.file;
  }
}

const measureText = (() => {
  const canvas = document.createElement("canvas");
  let context = null;
  try {
    context = canvas.getContext("2d");
  } catch (err) { }
  let currentFont = "";
  return (text, font) => {
    if (!context) return text.length * 8;
    if (font && font !== currentFont) {
      try {
        context.font = font;
        currentFont = font;
      } catch (err) { }
    }
    return context.measureText(text).width;
  };
})();

function fontStringOf($element) {
  const style = getComputedStyle($element);
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function middleTruncate(text, maxWidth, font, options = {}) {
  if (!text || maxWidth <= 0) return "";
  if (measureText(text, font) <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisWidth = measureText(ellipsis, font);
  if (ellipsisWidth > maxWidth) return "";
  let stem = text;
  let suffix = "";
  if (options.keepExtension) {
    const dot = text.lastIndexOf(".");
    if (dot > 0 && dot < text.length - 1) {
      const extension = text.slice(dot);
      if (ellipsisWidth + measureText(extension, font) <= maxWidth) {
        stem = text.slice(0, dot);
        suffix = extension;
      }
    }
  }
  const available = maxWidth - ellipsisWidth - measureText(suffix, font);
  if (available <= 0) return ellipsis + suffix;
  const chars = Array.from(stem);
  let low = 0;
  let high = chars.length;
  let best = ellipsis + suffix;
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    const left = Math.ceil(kept / 2);
    const right = kept - left;
    const candidate = chars.slice(0, left).join("")
      + ellipsis + chars.slice(chars.length - right).join("") + suffix;
    if (measureText(candidate, font) <= maxWidth) {
      best = candidate;
      low = kept + 1;
    } else {
      high = kept - 1;
    }
  }
  return best;
}

function formatMtime(mtime) {
  if (!mtime) return "";
  const date = new Date(mtime);
  const year = date.getFullYear();
  const month = padZero(date.getMonth() + 1, 2);
  const day = padZero(date.getDate(), 2);
  const hours = padZero(date.getHours(), 2);
  const minutes = padZero(date.getMinutes(), 2);
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function padZero(value, size) {
  return ("0".repeat(size) + value).slice(-1 * size);
}

function formatDirSizeLabel(size) {
  const count = Number(size) || 0;
  if (count >= MAX_SUBPATHS_COUNT) return t(">999 items");
  return tn("itemsCount", count, { count });
}

function formatFileSize(size, unit) {
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.max(0, unit ? sizes.indexOf(unit) : (size > 0 ? parseInt(Math.floor(Math.log(size) / Math.log(1024))) : 0));
  const raw = size > 0 ? size / Math.pow(1024, i) : 0;
  if (i === 0) return [Math.round(raw), "B"];
  return [raw.toFixed(1), sizes[i]];
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  seconds = Math.ceil(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds - h * 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  if (h > 0) return `${padZero(h, 2)}:${padZero(m, 2)}:${padZero(s, 2)}`;
  return `${padZero(m, 2)}:${padZero(s, 2)}`;
}

function formatUploadSize(uploaded, total) {
  const unit = formatFileSize(total)[1];
  const [uploadedValue] = formatFileSize(uploaded, unit);
  const [totalValue] = formatFileSize(total, unit);
  return `${uploadedValue}/${totalValue} ${unit}`;
}

function formatPercent(percent) {
  return Math.round(percent) + "%";
}

function itemSizeLabel(item) {
  return isDirType(item.path_type) ? formatDirSizeLabel(item.size) : formatFileSize(item.size).join(" ");
}

function itemSubtitle(item) {
  return [itemSizeLabel(item), formatMtime(item.mtime)].filter(Boolean).join(" · ");
}

async function assertResOK(res) {
  if (!(res.status >= 200 && res.status < 300)) {
    const body = (await res.text()).trim();
    const status = `${res.status} ${res.statusText}`.trim();
    throw new Error(body ? `${status}: ${body}` : status);
  }
}

function getEncoding(contentType) {
  const charset = contentType ? contentType.split(";")[1] : "";
  if (charset && /charset/i.test(charset)) {
    const encoding = charset.split("=")[1];
    if (encoding) return encoding.toLowerCase();
  }
  return "utf-8";
}

async function fetchText(url) {
  const res = await fetch(url);
  await assertResOK(res);
  const encoding = getEncoding(res.headers.get("content-type"));
  if (encoding === "utf-8") return await res.text();
  const bytes = await res.arrayBuffer();
  return new TextDecoder(encoding).decode(bytes);
}

async function fetchEditData(url) {
  const res = await fetch(url + "?edit");
  await assertResOK(res);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const $data = doc.getElementById("index-data");
  if (!$data) throw new Error(t("Missing page data"));
  return JSON.parse(decodeBase64($data.innerHTML.trim()));
}

// Parsing base64 strings with Unicode characters
function decodeBase64(base64String) {
  const binString = atob(base64String);
  const len = binString.length;
  const bytes = new Uint8Array(len);
  const arr = new Uint32Array(bytes.buffer, 0, Math.floor(len / 4));
  let i = 0;
  for (; i < arr.length; i++) {
    arr[i] = binString.charCodeAt(i * 4) |
      (binString.charCodeAt(i * 4 + 1) << 8) |
      (binString.charCodeAt(i * 4 + 2) << 16) |
      (binString.charCodeAt(i * 4 + 3) << 24);
  }
  for (i = i * 4; i < len; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/* ------------------------------------------------------------------------- */
/* toasts                                                                    */
/* ------------------------------------------------------------------------- */

const TOAST_MAX = 4;

function showToast(message, options = {}) {
  const type = options.type || "info";
  const duration = options.duration !== undefined ? options.duration : (type === "error" ? 0 : 4000);
  while ($toastStack.children.length >= TOAST_MAX) {
    $toastStack.firstElementChild.remove();
  }
  const iconName = type === "error" ? "alert" : type === "success" ? "checkCircle" : "info";
  const $toast = el("div", {
    class: `toast toast-${type}`,
    role: type === "error" ? "alert" : "status",
  });
  $toast.append(
    el("span", { class: "toast-icon", html: ICONS[iconName] }),
    el("span", { class: "toast-text", text: message }),
  );
  const $close = el("button", {
    type: "button",
    class: "toast-close",
    "aria-label": t("Dismiss notification"),
    html: ICONS.close,
  });
  $close.addEventListener("click", () => dismissToast($toast));
  $toast.append($close);
  $toastStack.append($toast);

  let timer = duration > 0 ? window.setTimeout(() => dismissToast($toast), duration) : null;
  $toast.addEventListener("mouseenter", () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
  $toast.addEventListener("mouseleave", () => {
    if (duration > 0 && !timer && $toast.isConnected) {
      timer = window.setTimeout(() => dismissToast($toast), duration);
    }
  });
  return $toast;
}

function dismissToast($toast) {
  if (!$toast || $toast.classList.contains("toast-out")) return;
  $toast.classList.add("toast-out");
  window.setTimeout(() => $toast.remove(), 180);
}

function showErrorToast(message) {
  showToast(message, { type: "error", duration: 0 });
}

function toastRequestError(prefix, err) {
  const detail = err && err.message ? err.message : String(err);
  showErrorToast(prefix ? `${prefix}: ${detail}` : detail);
}

// Keeps a toast across the navigations the standalone pages still need.
function queueToast(message, type = "success") {
  try {
    sessionStorage.setItem("dufs-toast", JSON.stringify({ message, type }));
  } catch (err) { }
}

function showQueuedToast() {
  try {
    const raw = sessionStorage.getItem("dufs-toast");
    if (!raw) return;
    sessionStorage.removeItem("dufs-toast");
    const item = JSON.parse(raw);
    showToast(item.message, { type: item.type || "success" });
  } catch (err) { }
}

function showPageError(message) {
  const main = $(".main") || document.body;
  main.replaceChildren();
  const $card = el("div", { class: "page-error", role: "alert" },
    el("div", { class: "page-error-icon", html: ICONS.alert }),
    el("h1", { class: "page-error-title", text: t("Something went wrong") }),
    el("p", { class: "page-error-text", text: message }),
    el("button", { type: "button", class: "btn btn-outline", text: t("Reload"), on: { click: () => location.reload() } }),
  );
  main.append($card);
}

/* ------------------------------------------------------------------------- */
/* native <dialog> base                                                      */
/* ------------------------------------------------------------------------- */

let dialogSeq = 0;
let topLayerCount = 0;

function pushTopLayer() {
  topLayerCount++;
  document.body.classList.add("dialog-open");
}

function popTopLayer() {
  topLayerCount = Math.max(0, topLayerCount - 1);
  if (topLayerCount === 0) document.body.classList.remove("dialog-open");
}

function hasOpenDialog() {
  return !!document.querySelector("dialog[open]");
}

class Dialog {
  constructor(options = {}) {
    this.options = options;
    this.opened = false;
    this.closed = false;
    this.closing = false;
    this.pending = false;
    this.closeReason = null;
    this.buttons = [];
    this.byKey = {};
    this.onKeyDown = options.onKeyDown || null;
    this.beforeClose = options.beforeClose || null;
    this.build();
  }

  build() {
    const opts = this.options;
    const id = `dialog-title-${++dialogSeq}`;
    this.$dialog = el("dialog", {
      class: `dialog${opts.className ? " " + opts.className : ""}`,
      "aria-labelledby": id,
      tabindex: "-1",
    });

    this.$title = el("h2", { class: "dialog-title", id, text: opts.title || "" });
    const heading = el("div", { class: "dialog-heading" }, this.$title);
    if (opts.description) {
      const $description = el("p", { class: "dialog-desc" });
      if (opts.description instanceof Node) $description.append(opts.description);
      else $description.textContent = opts.description;
      heading.append($description);
    }
    this.$close = el("button", {
      type: "button",
      class: "dialog-close",
      "aria-label": t("Close dialog"),
      html: ICONS.close,
    });
    this.$close.addEventListener("click", () => this.requestClose("close"));
    this.$dialog.append(el("div", { class: "dialog-head" }, heading, this.$close));

    this.$body = el("div", { class: "dialog-body" });
    if (opts.body) this.$body.append(opts.body);
    this.$dialog.append(this.$body);

    this.$foot = el("div", { class: "dialog-foot" });
    (opts.buttons || []).forEach(button => this.addButton(button));
    if (opts.footer) this.$foot.append(opts.footer);
    this.$dialog.append(this.$foot);

    this.$dialog.addEventListener("cancel", event => {
      event.preventDefault();
      this.requestClose("escape");
    });
    this.$dialog.addEventListener("click", event => {
      if (event.target === this.$dialog) this.requestClose("backdrop");
    });
    this.$dialog.addEventListener("keydown", event => {
      if (this.onKeyDown && this.onKeyDown(event, this)) return;
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        const target = event.target;
        if (target && target.tagName === "INPUT" && target.type !== "checkbox") {
          const $primary = this.$foot.querySelector("[data-primary]");
          if ($primary && !$primary.disabled) {
            event.preventDefault();
            $primary.click();
          }
        }
      }
    });
    this.$dialog.addEventListener("close", () => this.cleanup());
  }

  addButton(button) {
    const variant = button.variant || "outline";
    const $btn = el("button", {
      type: "button",
      class: `btn btn-${variant}`,
      text: button.label,
      disabled: !!button.disabled,
    });
    if (button.primary) $btn.dataset.primary = "true";
    if (button.key) this.byKey[button.key] = $btn;
    $btn.addEventListener("click", () => {
      if (button.onClick) button.onClick(this, $btn);
      else this.close(button.reason || "button");
    });
    this.buttons.push({ button, $btn });
    this.$foot.append($btn);
    return $btn;
  }

  open() {
    if (this.opened) return this;
    this.opened = true;
    document.body.append(this.$dialog);
    pushTopLayer();
    try {
      this.$dialog.showModal();
    } catch (err) {
      this.cleanup();
      throw err;
    }
    const focus = this.options.initialFocus;
    let $focus = typeof focus === "function" ? focus(this) : focus;
    if (typeof $focus === "string") $focus = this.$dialog.querySelector($focus);
    if (!$focus) $focus = this.$body.querySelector("input, textarea, select") || this.$foot.querySelector("button") || this.$dialog;
    $focus.focus({ preventScroll: true });
    if (this.options.onOpen) this.options.onOpen(this);
    return this;
  }

  async requestClose(reason = "close") {
    if (this.closed || this.closing || this.pending) return false;
    if (this.beforeClose) {
      this.pending = true;
      let allowed;
      try {
        allowed = await this.beforeClose(reason, this);
      } catch (err) {
        allowed = false;
      }
      this.pending = false;
      if (!allowed) return false;
    }
    this.close(reason);
    return true;
  }

  close(reason = "close") {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.closeReason = reason;
    this.$dialog.classList.add("is-closing");
    const delay = prefersReducedMotion() ? 0 : ANIM_MS;
    window.setTimeout(() => {
      if (!this.$dialog.open) {
        this.cleanup();
        return;
      }
      this.$dialog.close(reason);
    }, delay);
  }

  setBusy(busy) {
    this.$dialog.querySelectorAll("button, input, textarea, select").forEach(node => {
      if (busy) {
        if (node.dataset.busyDisabled === undefined) node.dataset.busyDisabled = node.disabled ? "1" : "0";
        node.disabled = true;
      } else if (node.dataset.busyDisabled !== undefined) {
        node.disabled = node.dataset.busyDisabled === "1";
        delete node.dataset.busyDisabled;
      }
    });
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    if (this.$dialog.isConnected) this.$dialog.remove();
    popTopLayer();
    if (this.options.onClose) this.options.onClose(this.closeReason || "close", this);
  }
}

/* ------------------------------------------------------------------------- */
/* confirm / prompt helpers                                                  */
/* ------------------------------------------------------------------------- */

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) { }

  // Plain HTTP on a LAN has no async clipboard API; fall back to a
  // temporary selection so the same click still copies.
  try {
    const $area = document.createElement("textarea");
    $area.value = text;
    $area.setAttribute("readonly", "");
    $area.style.position = "fixed";
    $area.style.top = "0";
    $area.style.left = "0";
    $area.style.width = "1px";
    $area.style.height = "1px";
    $area.style.padding = "0";
    $area.style.border = "0";
    $area.style.opacity = "0";
    $area.style.fontSize = "16px";
    // The page behind a modal dialog is inert; keep the scratch field inside
    // the topmost dialog so focus/select still work on iOS and Safari.
    const $dialogs = document.querySelectorAll("dialog[open]");
    const $host = $dialogs[$dialogs.length - 1] || document.body;
    $host.append($area);
    $area.focus();
    $area.select();
    $area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    $area.remove();
    return copied;
  } catch (err) {
    return false;
  }
}

function copyableValue(text, onCopied) {
  const $btn = el("button", {
    type: "button",
    class: "inline-link",
    title: t("Copy"),
    "aria-label": t("Copy “{text}”", { text }),
    text,
  });
  $btn.dataset.copiedLabel = t("copied");
  $btn.dataset.copyFailedLabel = t("copy failed");
  $btn.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    const copied = await copyText(text);
    const className = copied ? "is-copied" : "is-copy-failed";
    $btn.classList.add(className);
    window.setTimeout(() => $btn.classList.remove(className), copied ? 1600 : 2000);
    if (copied && onCopied) onCopied();
  });
  return $btn;
}

function confirmDialog(options) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let $input = null;
    let body = options.details || null;
    if (options.requirement) {
      const inputId = `confirm-${++dialogSeq}`;
      const hintId = `${inputId}-hint`;
      $input = el("input", {
        id: inputId,
        class: "input",
        type: "text",
        autocomplete: "off",
        spellcheck: "false",
        autocapitalize: "off",
        enterkeyhint: "done",
        "aria-describedby": hintId,
      });
      options.requirement.focusInput = () => $input.focus();
      const $hint = el("p", { class: "field-hint", id: hintId });
      $hint.append(textWithLink(
        t("Type “{value}” to confirm."),
        "value",
        copyableValue(options.requirement.value, () => $input.focus()),
      ));
      const $field = el("div", { class: "field" },
        el("label", { class: "field-label", for: inputId, text: options.requirement.label || t("Confirmation") }),
        $input,
        $hint,
      );
      body = el("div", { class: "confirm-body" }, options.details || null, $field);
    }

    const dialog = new Dialog({
      title: options.title,
      description: options.description,
      body,
      buttons: [
        {
          key: "cancel",
          label: options.cancelText || t("Cancel"),
          variant: "outline",
          onClick: m => {
            finish(false);
            m.close("cancel");
          },
        },
        {
          key: "confirm",
          label: options.confirmText || t("Confirm"),
          variant: options.danger ? "danger" : "primary",
          primary: true,
          disabled: !!options.requirement,
          onClick: m => {
            if (options.requirement && $input.value !== options.requirement.value) return;
            finish(true);
            m.close("confirm");
          },
        },
      ],
      initialFocus: options.requirement ? () => $input : m => m.byKey.cancel,
      onClose: () => finish(false),
    });

    if (options.requirement) {
      const $confirm = dialog.byKey.confirm;
      const update = () => {
        $confirm.disabled = $input.value !== options.requirement.value;
      };
      $input.addEventListener("input", update);
      update();
    }

    dialog.open();
  });
}

function promptDialog(options) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const inputId = `field-${++dialogSeq}`;
    const $input = el("input", {
      id: inputId,
      class: "input",
      type: options.inputType || "text",
      value: options.value || "",
      placeholder: options.placeholder || "",
      autocomplete: "off",
      spellcheck: "false",
      enterkeyhint: "done",
    });
    const $error = el("p", { class: "field-error", role: "alert", hidden: true });
    const $field = el("div", { class: "field" },
      el("label", { class: "field-label", for: inputId, text: options.label || t("Name") }),
      $input,
      $error,
    );
    const submit = () => {
      const value = $input.value.trim();
      const error = options.validate ? options.validate(value) : "";
      if (error) {
        $error.textContent = error;
        $error.hidden = false;
        $input.focus();
        $input.select();
        return;
      }
      finish(value);
      dialog.close("confirm");
    };
    const dialog = new Dialog({
      title: options.title,
      description: options.description,
      body: $field,
      buttons: [
        {
          key: "cancel",
          label: options.cancelText || t("Cancel"),
          variant: "outline",
          onClick: m => {
            finish(null);
            m.close("cancel");
          },
        },
        {
          key: "confirm",
          label: options.confirmText || t("OK"),
          variant: "primary",
          primary: true,
          onClick: submit,
        },
      ],
      initialFocus: () => $input,
      onOpen: () => {
        $input.focus();
        if (options.selectRange) $input.setSelectionRange(options.selectRange[0], options.selectRange[1]);
        else $input.select();
      },
      onClose: () => finish(null),
    });
    $input.addEventListener("input", () => {
      $error.hidden = true;
    });
    dialog.open();
  });
}

/* ------------------------------------------------------------------------- */
/* dropdown / context menu                                                   */
/* ------------------------------------------------------------------------- */

const menuState = {
  open: false,
  opener: null,
  row: null,
  outside: null,
  scroll: null,
  resize: null,
};

function openMenu(items, options = {}) {
  if (!items.length) return;
  closeMenu({ restoreFocus: false });
  const {
    x = 0,
    y = 0,
    align = "start",
    anchor = null,
    returnFocus = document.activeElement,
    row = null,
  } = options;

  $menu.replaceChildren();
  const focusables = [];
  items.forEach(item => {
    if (item.header) {
      $menu.append(el("div", { class: "menu-header", text: item.header }));
      return;
    }
    if (item.separator) {
      $menu.append(el("div", { class: "menu-sep", role: "separator" }));
      return;
    }
    const attrs = {
      type: "button",
      class: "menu-item" + (item.danger ? " danger" : ""),
      role: "menuitem",
      disabled: !!item.disabled,
    };
    if (item.title) attrs.title = item.title;
    const $item = el("button", attrs);
    if (item.icon) $item.insertAdjacentHTML("beforeend", ICONS[item.icon]);
    $item.append(el("span", { text: item.label }));
    $item.addEventListener("click", () => {
      closeMenu();
      if (item.onSelect) item.onSelect();
    });
    focusables.push($item);
    $menu.append($item);
  });

  $menu.classList.remove("hidden");
  $menu.style.visibility = "hidden";
  $menu.style.left = "0px";
  $menu.style.top = "0px";
  // offsetWidth/Height ignore the scale() of the entry animation.
  const menuWidth = $menu.offsetWidth;
  const menuHeight = $menu.offsetHeight;
  const pad = 8;
  let left = x;
  let top = y;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    left = align === "end" ? rect.right - menuWidth : rect.left;
    top = rect.bottom + 6;
    if (top + menuHeight > window.innerHeight - pad) {
      top = rect.top - menuHeight - 6;
    }
  } else if (y + menuHeight > window.innerHeight - pad && y - menuHeight - pad > 0) {
    top = y - menuHeight - pad;
  }
  left = Math.min(Math.max(pad, left), window.innerWidth - menuWidth - pad);
  top = Math.min(Math.max(pad, top), window.innerHeight - menuHeight - pad);
  $menu.style.left = `${Math.round(left)}px`;
  $menu.style.top = `${Math.round(top)}px`;
  $menu.style.visibility = "";

  menuState.open = true;
  menuState.opener = returnFocus || null;
  menuState.row = row;
  if (row) row.classList.add("menu-open");

  menuState.outside = event => {
    if ($menu.contains(event.target)) return;
    if (menuState.opener && (event.target === menuState.opener || (menuState.opener.contains && menuState.opener.contains(event.target)))) return;
    closeMenu({ restoreFocus: false });
  };
  menuState.scroll = event => {
    if (event.target === $menu || $menu.contains(event.target)) return;
    closeMenu({ restoreFocus: false });
  };
  menuState.resize = () => closeMenu({ restoreFocus: false });
  document.addEventListener("pointerdown", menuState.outside, true);
  window.addEventListener("scroll", menuState.scroll, true);
  window.addEventListener("resize", menuState.resize);

  if (focusables.length) focusables[0].focus({ preventScroll: true });
}

function closeMenu({ restoreFocus = true } = {}) {
  if (!menuState.open) return;
  menuState.open = false;
  const opener = menuState.opener;
  const row = menuState.row;
  $menu.classList.add("hidden");
  $menu.replaceChildren();
  if (row) row.classList.remove("menu-open");
  document.removeEventListener("pointerdown", menuState.outside, true);
  window.removeEventListener("scroll", menuState.scroll, true);
  window.removeEventListener("resize", menuState.resize);
  menuState.opener = null;
  menuState.row = null;
  menuState.outside = null;
  menuState.scroll = null;
  menuState.resize = null;
  if (restoreFocus && opener && opener.isConnected) opener.focus({ preventScroll: true });
}

function onMenuKeyDown(event) {
  if (!menuState.open) return;
  const items = [...$menu.querySelectorAll(".menu-item:not(:disabled)")];
  const current = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    return;
  }
  if (event.key === "Tab") {
    closeMenu();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    if (!items.length) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current === -1 ? 0 : (current + delta + items.length) % items.length;
    items[next].focus();
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    if (!items.length) return;
    items[event.key === "Home" ? 0 : items.length - 1].focus();
  }
}

/* ------------------------------------------------------------------------- */
/* bootstrap                                                                 */
/* ------------------------------------------------------------------------- */

window.addEventListener("DOMContentLoaded", boot);

async function boot() {
  cacheRefs();
  I18N.localizeDocument(document);
  document.documentElement.lang = I18N.lang;
  const $version = document.getElementById("app-version");
  if ($version) $version.textContent = `Dufs v${APP_VERSION}`;
  const $engine = document.getElementById("dufs-engine-version");
  if ($engine) {
    const prefix = document.querySelector('meta[name="dufs-assets-prefix"]')?.content || "";
    const match = prefix.match(/__dufs_v([^/]+?)__/);
    if (match) {
      $engine.textContent = `dufs ${match[1]}`;
      $engine.title = `Bundled dufs binaries: ${match[1]}`;
      $engine.hidden = false;
      const $engineSep = document.getElementById("dufs-engine-sep");
      if ($engineSep) $engineSep.hidden = false;
    }
  }

  const $indexData = document.getElementById("index-data");
  if (!$indexData) {
    showPageError(t("No data. The server response is missing page data."));
    return;
  }
  try {
    DATA = JSON.parse(decodeBase64($indexData.innerHTML.trim()));
  } catch (err) {
    showPageError(t("No data. The server response could not be read."));
    return;
  }
  try {
    await ready();
  } catch (err) {
    console.error(err);
    showPageError(t("Failed to initialise the page: {message}", { message: err.message || err }));
  }
}

function cacheRefs() {
  $indexPage = $(".index-page");
  $editorPage = $(".editor-page");
  $brand = $("#brand");
  $breadcrumb = $(".breadcrumb");
  $searchForm = $("#search-form");
  $searchInput = $("#search");
  $searchClear = $("#search-clear");
  $uploadLabel = $(".upload-file");
  $fileInput = $("#file");
  $newFolderBtn = $(".new-folder");
  $newFileBtn = $(".new-file");
  $viewSwitch = $(".view-switch");
  $loginBtn = $(".login-btn");
  $moreBtn = $("#more-btn");
  $transfers = $("#transfers");
  $transfersStatus = $("#transfers-status");
  $transfersProgress = $("#transfers-progress");
  $transfersProgressFill = $("#transfers-progress-fill");
  $transfersActive = $("#transfers-active");
  $transfersFailed = $("#transfers-failed");
  $transfersQueue = $("#transfers-queue");
  $transfersQueueToggle = $("#transfers-queue-toggle");
  $transfersQueueLabel = $("#transfers-queue-label");
  $transfersQueueList = $("#transfers-queue-list");
  $itemCount = $("#item-count");
  $gridSort = $("#grid-sort");
  $empty = $("#empty");
  $emptyIcon = $("#empty-icon");
  $emptyTitle = $("#empty-title");
  $emptyDesc = $("#empty-desc");
  $emptyAction = $("#empty-action");
  $listing = $("#listing");
  $listingHead = $("#listing-head");
  $listingBody = $("#listing-body");
  $detailPane = $("#detail-pane");
  $selectionbar = $("#selectionbar");
  $selectionCount = $("#selection-count");
  $selectionClear = $("#selection-clear");
  $toastStack = $("#toast-stack");
  $menu = $("#menu");
  $dropzone = $("#dropzone");
  $editor = $("#editor");
  $editorName = $("#editor-name");
  $editorSub = $("#editor-sub");
  $editorIcon = $("#editor-icon");
  $editorStatus = $("#editor-status");
  $editorFoot = $("#editor-foot");
  $editorFrame = $("#editor-frame");
  $notEditable = $("#not-editable");
  $saveBtn = $(".save-btn");
  $renameFileBtn = $(".rename-file");
  $moveFileBtn = $(".move-file");
  $deleteFileBtn = $(".delete-file");
  $editorDownload = $(".editor-actions .download");
  $editFileBtn = $(".editor-actions .edit-file");
}

async function ready() {
  $brand.href = DATA.uri_prefix || "/";
  showQueuedToast();
  window.addEventListener("beforeunload", beforeUnloadHandler);
  setupTopbar();
  setupSelectionBar();
  setupDropzone();
  setupTransfers();
  setupGlobalKeys();
  setupCoverPreview();
  setupTableNameFit();
  $menu.addEventListener("keydown", onMenuKeyDown);
  UI_PATHS = await loadUiPaths();
  window.DUFS_UI_PATHS = UI_PATHS;
  topBreadcrumb = createBreadcrumb($breadcrumb, {
    path: DATA.href,
    homePath: homePathFromUiPaths(),
    favorite: DATA.kind === "Index" && DATA.allow_upload ? {
      isFavorite: isFavoritePath,
      onToggle: toggleFavoritePath,
    } : null,
    hrefFor: path => urlFromPath(path),
    onNavigate: path => {
      location.href = urlFromPath(path);
    },
  });
  applyView(state.view, { render: false });
  setupDownloadWithToken();

  if (DATA.kind === "Index") {
    // Use just the folder name in the tab; the root is the bare brand.
    const folderName = basePathName(DATA.href);
    document.title = folderName ? `${folderName} - Dufs` : "Dufs";
    $indexPage.classList.remove("hidden");
    $editorPage.classList.add("hidden");
    UI_SETTINGS = await loadUiSettings();
    topBreadcrumb.setPath(DATA.href);
    syncTopbar();
    renderListing();
  } else {
    document.title = DATA.kind === "Edit"
      ? t("Edit {path} - Dufs", { path: DATA.href })
      : t("View {path} - Dufs", { path: DATA.href });
    $indexPage.classList.add("hidden");
    $editorPage.classList.remove("hidden");
    syncTopbar();
    await setupEditorPage();
  }

  window.addEventListener("pageshow", event => {
    if (event.persisted && DATA.kind === "Index") refreshListing();
  });
}

function beforeUnloadHandler(event) {
  if (Uploader.queues.length > 0 || Uploader.runnings > 0 || state.editorDirty || detailState.dirty) {
    event.preventDefault();
    event.returnValue = "";
    return "";
  }
}

/* ------------------------------------------------------------------------- */
/* top bar                                                                   */
/* ------------------------------------------------------------------------- */

function setupTopbar() {
  $fileInput.addEventListener("change", event => {
    const entries = Array.from(event.target.files || []).map(file => ({ file, dirs: [] }));
    event.target.value = "";
    queueUploads(entries);
  });

  $newFolderBtn.addEventListener("click", createFolderFlow);
  $newFileBtn.addEventListener("click", createFileFlow);

  $viewSwitch.querySelectorAll(".view-btn").forEach($btn => {
    $btn.addEventListener("click", () => setView($btn.dataset.view));
  });

  $loginBtn.addEventListener("click", async () => {
    try {
      await checkAuth("login");
    } catch (err) { }
    location.reload();
  });

  $moreBtn.addEventListener("click", () => {
    if (menuState.open && menuState.opener === $moreBtn) {
      closeMenu();
      return;
    }
    openMoreMenu();
  });

  $searchForm.addEventListener("submit", event => {
    event.preventDefault();
    const q = $searchInput.value.trim();
    location.href = q ? baseUrl() + "?q=" + encodeURIComponent(q) : baseUrl();
  });
  $searchClear.addEventListener("click", () => {
    $searchInput.value = "";
    updateSearchClear();
    if (PARAMS.q) location.href = baseUrl();
    else $searchInput.focus();
  });
  $searchInput.addEventListener("input", updateSearchClear);
  $searchInput.addEventListener("keydown", event => {
    if (event.key === "Escape" && $searchInput.value) {
      event.preventDefault();
      event.stopPropagation();
      $searchInput.value = "";
      updateSearchClear();
      if (PARAMS.q) location.href = baseUrl();
    }
  });
  if (PARAMS.q) $searchInput.value = PARAMS.q;
  updateSearchClear();

  $emptyAction.addEventListener("click", () => {
    if (state.emptyAction) state.emptyAction();
  });
}

function updateSearchClear() {
  toggle($searchClear, !!$searchInput.value);
}

function syncTopbar() {
  const index = DATA.kind === "Index";
  toggle($uploadLabel, index && DATA.allow_upload);
  toggle($newFolderBtn, index && DATA.allow_upload);
  toggle($newFileBtn, index && DATA.allow_upload);
  toggle($viewSwitch, index);
  toggle($searchForm, index && DATA.allow_search);
  toggle($moreBtn, index || !!DATA.auth);

  const auth = !!DATA.auth;
  toggle($loginBtn, auth && !DATA.user);
}

function normalizeBreadcrumbPath(value) {
  let path = String(value || "/").trim();
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+$/, "");
  return path || "/";
}

let openCrumbMenu = null;

function openBreadcrumbMenu(anchor, parts, onSelect) {
  if (!parts.length) return;
  if (openCrumbMenu) openCrumbMenu();
  const $dialog = el("dialog", {
    class: "crumb-menu-dialog",
    "aria-label": t("Hidden path segments"),
  });
  let closed = false;
  let pushed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if ($dialog.open) $dialog.close();
    else $dialog.dispatchEvent(new Event("close"));
  };
  openCrumbMenu = close;
  parts.forEach(part => {
    const $item = el("button", {
      type: "button",
      class: "menu-item",
      title: part.path,
      "aria-label": t("Go to {path}", { path: part.path }),
    });
    $item.append(el("span", { text: part.name }));
    $item.addEventListener("click", () => {
      close();
      onSelect(part.path);
    });
    $dialog.append($item);
  });
  $dialog.addEventListener("cancel", event => {
    event.preventDefault();
    close();
  });
  $dialog.addEventListener("click", event => {
    if (event.target === $dialog) close();
  });
  $dialog.addEventListener("close", () => {
    $dialog.remove();
    if (pushed) popTopLayer();
    if (openCrumbMenu === close) openCrumbMenu = null;
    if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
  });
  document.body.append($dialog);
  try {
    pushTopLayer();
    pushed = true;
    $dialog.showModal();
  } catch (err) {
    $dialog.remove();
    if (pushed) popTopLayer();
    if (openCrumbMenu === close) openCrumbMenu = null;
    return;
  }
  $dialog.style.visibility = "hidden";
  const rect = anchor.getBoundingClientRect();
  const width = $dialog.offsetWidth;
  const height = $dialog.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  left = Math.max(8, left);
  top = Math.max(8, top);
  $dialog.style.left = `${Math.round(left)}px`;
  $dialog.style.top = `${Math.round(top)}px`;
  $dialog.style.visibility = "";
  const $first = $dialog.querySelector("button");
  if ($first) $first.focus({ preventScroll: true });
}

function createBreadcrumb($container, options = {}) {
  const homePath = normalizeBreadcrumbPath(options.homePath || "/");
  const state = {
    path: normalizeBreadcrumbPath(options.path),
    hiddenCount: 0,
    segments: [],
    intermediates: [],
    basePath: "/",
    baseIsHome: true,
    outsideHome: false,
    fitFrame: 0,
  };
  const hrefFor = options.hrefFor || null;
  const onNavigate = options.onNavigate || (path => {
    location.href = urlFromPath(path);
  });

  function pathIsWithin(path, base) {
    return base === "/" || path === base || path.startsWith(base + "/");
  }

  function rebuildSegments() {
    state.baseIsHome = pathIsWithin(state.path, homePath);
    state.outsideHome = !state.baseIsHome;
    state.basePath = state.baseIsHome ? homePath : "/";
    const rest = state.path === state.basePath
      ? ""
      : state.path.slice(state.basePath === "/" ? 1 : state.basePath.length + 1);
    const parts = rest ? rest.split("/").filter(Boolean) : [];
    state.segments = parts.map((name, index) => ({
      name,
      path: state.basePath === "/"
        ? "/" + parts.slice(0, index + 1).join("/")
        : state.basePath + "/" + parts.slice(0, index + 1).join("/"),
      current: index === parts.length - 1,
    }));
    state.intermediates = state.segments.filter(segment => !segment.current);
  }

  function separator() {
    return el("span", {
      class: "crumb-sep",
      html: ICONS.chevronRight,
      "aria-hidden": "true",
    });
  }

  function homeCrumb(current) {
    const attrs = {
      class: "crumb home" + (current ? " current" : ""),
      title: t("Home"),
      "aria-label": t("Home"),
      html: ICONS.home,
    };
    if (current) {
      attrs["aria-current"] = "page";
      return el("span", attrs);
    }
    const href = hrefFor && hrefFor(homePath);
    if (href) return el("a", { ...attrs, href });
    const $button = el("button", { ...attrs, type: "button" });
    $button.addEventListener("click", () => onNavigate(homePath));
    return $button;
  }

  function rootCrumb(current) {
    const attrs = {
      class: "crumb root" + (current ? " current" : ""),
      title: t("Root"),
      "aria-label": t("Root"),
      html: ICONS.folderRoot,
    };
    if (current) {
      attrs["aria-current"] = "page";
      return el("span", attrs);
    }
    const href = hrefFor && hrefFor("/");
    if (href) return el("a", { ...attrs, href });
    const $button = el("button", { ...attrs, type: "button" });
    $button.addEventListener("click", () => onNavigate("/"));
    return $button;
  }

  function segmentCrumb(segment) {
    const attrs = {
      class: "crumb" + (segment.current ? " current" : ""),
      title: segment.path,
      dataset: { fullName: segment.name },
      text: segment.name,
    };
    if (segment.current) {
      attrs["aria-current"] = "page";
      return el("span", attrs);
    }
    const href = hrefFor && hrefFor(segment.path);
    if (href) return el("a", { ...attrs, href });
    const $button = el("button", { ...attrs, type: "button" });
    $button.addEventListener("click", () => onNavigate(segment.path));
    return $button;
  }

  function moreCrumb() {
    const $button = el("button", {
      type: "button",
      class: "crumb crumb-more",
      title: t("Show hidden path segments"),
      "aria-label": t("Show hidden path segments"),
      "aria-haspopup": "dialog",
      text: "…",
    });
    $button.addEventListener("click", event => {
      event.stopPropagation();
      openBreadcrumbMenu(
        $button,
        state.intermediates.slice(0, state.hiddenCount),
        path => onNavigate(path),
      );
    });
    return $button;
  }

  function favoriteCrumb() {
    const active = options.favorite.isFavorite(state.path);
    const label = active ? t("Remove from favorites") : t("Add to favorites");
    const $button = el("button", {
      type: "button",
      class: "crumb crumb-favorite" + (active ? " is-favorite" : ""),
      title: label,
      "aria-label": label,
      "aria-pressed": String(active),
      html: ICONS.star,
    });
    $button.addEventListener("click", event => {
      event.stopPropagation();
      if ($button.disabled) return;
      $button.disabled = true;
      Promise.resolve(options.favorite.onToggle(state.path))
        .then(nextActive => {
          const isActive = !!nextActive;
          const nextLabel = isActive ? t("Remove from favorites") : t("Add to favorites");
          $button.classList.toggle("is-favorite", isActive);
          $button.setAttribute("aria-pressed", String(isActive));
          $button.title = nextLabel;
          $button.setAttribute("aria-label", nextLabel);
        })
        .catch(() => { })
        .finally(() => {
          $button.disabled = false;
        });
    });
    return $button;
  }

  function render(hiddenCount) {
    state.hiddenCount = Math.max(0, Math.min(hiddenCount, state.intermediates.length));
    $container.replaceChildren();
    const atHome = state.baseIsHome && state.path === homePath;
    $container.append(homeCrumb(atHome));
    if (state.outsideHome) {
      $container.append(separator(), rootCrumb(state.path === "/"));
    }
    if (state.hiddenCount > 0) {
      $container.append(separator(), moreCrumb());
    }
    const current = state.segments.find(segment => segment.current);
    state.intermediates.slice(state.hiddenCount).forEach(segment => {
      $container.append(separator(), segmentCrumb(segment));
    });
    if (current) {
      $container.append(separator(), segmentCrumb(current));
    }
    if (options.favorite) {
      $container.append(el("span", { class: "crumb-tools" }, favoriteCrumb()));
    }
  }

  function horizontalPadding($element) {
    const style = getComputedStyle($element);
    return (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  }

  function availableWidth() {
    if (!$container.isConnected) return 0;
    const style = getComputedStyle($container);
    return $container.clientWidth
      - (parseFloat(style.paddingLeft) || 0)
      - (parseFloat(style.paddingRight) || 0);
  }

  function contentWidth() {
    const children = [...$container.children];
    if (!children.length) return 0;
    const gap = parseFloat(getComputedStyle($container).columnGap) || 0;
    return children.reduce((width, child) => width + child.getBoundingClientRect().width, 0)
      + gap * Math.max(0, children.length - 1);
  }

  function truncateSegments(available) {
    $container.querySelectorAll(".crumb[data-full-name]").forEach($crumb => {
      const fullName = $crumb.dataset.fullName;
      const isCurrent = $crumb.classList.contains("current");
      const maxWidth = Math.max(
        0,
        available * (isCurrent ? 0.6 : 0.35) - horizontalPadding($crumb) - 1,
      );
      $crumb.textContent = middleTruncate(fullName, maxWidth, fontStringOf($crumb));
    });
  }

  function fit() {
    const available = availableWidth();
    if (available <= 0) return;
    let hiddenCount = 0;
    while (true) {
      render(hiddenCount);
      truncateSegments(available);
      if (contentWidth() <= available + 0.5
        || hiddenCount >= state.intermediates.length) {
        break;
      }
      hiddenCount++;
    }
    state.hiddenCount = hiddenCount;
    if (contentWidth() > available + 0.5) {
      const $current = $container.querySelector(".crumb.current");
      if ($current) {
        const overflow = contentWidth() - available;
        const currentWidth = $current.getBoundingClientRect().width;
        const target = currentWidth - horizontalPadding($current) - overflow - 1;
        $current.textContent = middleTruncate(
          $current.dataset.fullName,
          Math.max(0, target),
          fontStringOf($current),
        );
      }
    }
  }

  function scheduleFit() {
    if (state.fitFrame) return;
    state.fitFrame = requestAnimationFrame(() => {
      state.fitFrame = 0;
      fit();
    });
  }

  function setPath(path) {
    state.path = normalizeBreadcrumbPath(path);
    rebuildSegments();
    render(0);
    scheduleFit();
  }

  let observer = null;
  const onResize = () => {
    fit();
    scheduleFit();
  };
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(onResize);
    observer.observe($container);
  }
  window.addEventListener("resize", onResize);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleFit).catch(() => { });
  }

  rebuildSegments();
  render(0);
  scheduleFit();

  return {
    setPath,
    destroy() {
      if (observer) observer.disconnect();
      window.removeEventListener("resize", onResize);
      if (state.fitFrame) cancelAnimationFrame(state.fitFrame);
    },
  };
}

function openMoreMenu() {
  const index = DATA.kind === "Index";
  const items = [];
  const addSeparator = () => {
    if (items.length && !items[items.length - 1].separator) {
      items.push({ separator: true });
    }
  };
  if (index) {
    const favorites = favoritePaths();
    if (favorites.length) {
      items.push({ header: t("Favorites") });
      favorites.forEach(path => {
        items.push({
          label: favoriteLabel(path),
          title: path,
          icon: "star",
          onSelect: () => { location.href = dirUrlFromPath(path); },
        });
      });
    }
  }
  if (index && DATA.allow_upload) {
    addSeparator();
    items.push({ label: t("Upload files"), icon: "upload", onSelect: () => $fileInput.click() });
    items.push({ label: t("New folder"), icon: "folderPlus", onSelect: createFolderFlow });
    items.push({ label: t("New file"), icon: "filePlus", onSelect: createFileFlow });
  }
  if (index && DATA.allow_archive) {
    addSeparator();
    items.push({ label: t("Download folder (.zip)"), icon: "package", onSelect: () => downloadUrl(baseUrl() + "?zip") });
  }
  if (index) {
    addSeparator();
    items.push({ label: t("Select all"), icon: "check", onSelect: selectAll });
    items.push({ label: t("Refresh"), icon: "refresh", onSelect: () => refreshListing() });
    if (!$viewSwitch || getComputedStyle($viewSwitch).display === "none") {
      items.push({
        label: state.view === "list" ? t("Grid view") : t("List view"),
        icon: state.view === "list" ? "grid" : "list",
        onSelect: () => setView(state.view === "list" ? "grid" : "list"),
      });
    }
    items.push({ label: t("Settings"), icon: "settings", onSelect: openSettingsDialog });
  }
  if (DATA.auth) {
    addSeparator();
    if (DATA.user) items.push({ label: t("Sign out"), icon: "logout", onSelect: logout });
    else items.push({ label: t("Sign in"), icon: "login", onSelect: () => $loginBtn.click() });
  }
  if (!items.length) return;
  openMenu(items, { anchor: $moreBtn, align: "end", returnFocus: $moreBtn });
}

function uiRootUrl() {
  const prefix = DATA.uri_prefix || "/";
  return new URL(prefix.endsWith("/") ? prefix : prefix + "/", location.origin).toString();
}

function normalizeUiPath(value, fallback) {
  if (typeof value !== "string" || value === ""
    || value.startsWith("/") || value.includes("..")
    || value.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return fallback;
  }
  return value;
}

function normalizeUiHome(value) {
  if (typeof value !== "string" || value === "") return "";
  if (value.startsWith("/") || value.includes("\\")
    || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return "";
  }
  const path = value.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (path.split("/").some(part => part === "." || part === "..")) return "";
  return path;
}

async function loadUiPaths() {
  try {
    const res = await fetch(new URL(UI_PATHS_FILE, uiRootUrl()), {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return { ...DEFAULT_UI_PATHS };
    const data = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ...DEFAULT_UI_PATHS };
    }
    const cache = normalizeUiPath(data.cache, DEFAULT_UI_PATHS.cache);
    return {
      settings: normalizeUiPath(data.settings, DEFAULT_UI_PATHS.settings),
      cache: cache.endsWith("/") ? cache : cache + "/",
      home: normalizeUiHome(data.home),
    };
  } catch (err) {
    return { ...DEFAULT_UI_PATHS };
  }
}

function homePathFromUiPaths() {
  const home = String(UI_PATHS.home || "").replace(/^\/+|\/+$/g, "");
  return home ? "/" + home : "/";
}

function uiSettingsUrl() {
  return new URL(UI_PATHS.settings, uiRootUrl()).toString();
}

async function readUiSettings(url) {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function normalizeFavoritePaths(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const favorites = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.startsWith("/")) continue;
    if (item.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(item)) continue;
    const path = item.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
    if (path.split("/").some(part => part === "." || part === "..")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    favorites.push(path);
    if (favorites.length >= 50) break;
  }
  return favorites;
}

async function loadUiSettings() {
  const data = await readUiSettings(uiSettingsUrl());
  if (!data) return { ...DEFAULT_UI_SETTINGS };
  return {
    ...DEFAULT_UI_SETTINGS,
    ...data,
    covers: data.covers !== false,
    showHidden: data.showHidden === true,
    favorites: normalizeFavoritePaths(data.favorites),
  };
}

async function putUiSettings(url, settings) {
  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
    credentials: "same-origin",
  });
}

async function saveUiSettings(settings) {
  const res = await putUiSettings(uiSettingsUrl(), settings);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
}

function favoritePaths() {
  return Array.isArray(UI_SETTINGS.favorites) ? UI_SETTINGS.favorites : [];
}

function isFavoritePath(path) {
  return favoritePaths().includes(path);
}

function favoriteLabel(path) {
  const homePath = homePathFromUiPaths();
  if (path === homePath) return t("Home");
  if (path === "/") return t("Root");
  return basePathName(path) || displayPath(path);
}

async function toggleFavoritePath(path) {
  const favorites = favoritePaths();
  const active = favorites.includes(path);
  let nextFavorites = active
    ? favorites.filter(favorite => favorite !== path)
    : [...favorites, path];
  if (nextFavorites.length > 50) nextFavorites = nextFavorites.slice(-50);
  const next = { ...UI_SETTINGS, favorites: nextFavorites };
  try {
    await saveUiSettings(next);
    UI_SETTINGS = next;
    showToast(
      active ? t("Removed from favorites") : t("Added to favorites"),
      { type: "success" },
    );
    return !active;
  } catch (err) {
    showToast(t("Failed to save settings"), { type: "error" });
    return active;
  }
}

function openSettingsDialog() {
  const $covers = el("input", {
    type: "checkbox",
    class: "check",
    "aria-describedby": "ui-settings-covers-hint",
  });
  $covers.checked = UI_SETTINGS.covers !== false;

  const $showHidden = el("input", {
    type: "checkbox",
    class: "check",
    "aria-describedby": "ui-settings-hidden-hint",
  });
  $showHidden.checked = UI_SETTINGS.showHidden === true;

  const $body = el("div", { class: "settings-list" },
    el("label", { class: "settings-row" },
      el("span", { class: "settings-copy" },
        el("span", { class: "settings-label", text: t("Book covers") }),
        el("span", {
          class: "settings-hint",
          id: "ui-settings-covers-hint",
          text: t("Show book covers in the grid and list, and on eye-icon hover."),
        }),
      ),
      $covers,
    ),
    el("label", { class: "settings-row" },
      el("span", { class: "settings-copy" },
        el("span", { class: "settings-label", text: t("Show hidden files and folders") }),
        el("span", {
          class: "settings-hint",
          id: "ui-settings-hidden-hint",
          text: t("Includes KOReader .sdr sidecar folders."),
        }),
      ),
      $showHidden,
    ),
  );

  const dialog = new Dialog({
    title: t("Settings"),
    description: t("Settings are stored on the KOReader device."),
    body: $body,
    buttons: [
      {
        label: t("Cancel"),
        variant: "outline",
        onClick: model => model.close("cancel"),
      },
      {
        label: t("Save"),
        variant: "primary",
        primary: true,
        onClick: async (model, $button) => {
          const next = {
            ...UI_SETTINGS,
            covers: $covers.checked,
            showHidden: $showHidden.checked,
          };
          $button.disabled = true;
          try {
            await saveUiSettings(next);
            const hiddenChanged = UI_SETTINGS.showHidden !== next.showHidden;
            const changed = UI_SETTINGS.covers !== next.covers || hiddenChanged;
            UI_SETTINGS = next;
            if (hiddenChanged) clearSelection();
            model.close("save");
            if (changed) renderListing();
            showToast(t("Settings saved"), { type: "success" });
          } catch (err) {
            $button.disabled = false;
            showToast(t("Failed to save settings"), { type: "error" });
          }
        },
      },
    ],
    initialFocus: $covers,
  });
  dialog.open();
}

function setupGlobalKeys() {
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || menuState.open) return;
    const target = event.target;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (event.key === "/" && !typing && !hasOpenDialog() && DATA.kind === "Index" && DATA.allow_search) {
      event.preventDefault();
      $searchInput.focus();
      $searchInput.select();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "a" && !typing && !hasOpenDialog() && DATA.kind === "Index") {
      event.preventDefault();
      selectAll();
      return;
    }
    if (event.key === "Escape" && !hasOpenDialog()) {
      if (detailState.item) {
        if (!typing) requestCloseDetailPane();
        return;
      }
      if (state.selected.size > 0) clearSelection();
    }
  });
}

/* ------------------------------------------------------------------------- */
/* listing rendering                                                         */
/* ------------------------------------------------------------------------- */

function setView(view) {
  applyView(view, { render: true });
}

function applyView(view, { render = true } = {}) {
  state.view = view === "grid" ? "grid" : "list";
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, state.view);
  } catch (err) { }
  $indexPage.dataset.view = state.view;
  $listing.dataset.view = state.view;
  document.querySelectorAll(".view-btn").forEach($btn => {
    $btn.setAttribute("aria-pressed", String($btn.dataset.view === state.view));
  });
  toggle($gridSort, state.view === "grid");
  if (render) renderListing();
}

function getSort() {
  const field = ["name", "mtime", "size"].includes(PARAMS.sort) ? PARAMS.sort : "name";
  const order = PARAMS.order === "desc" ? "desc" : "asc";
  return { field, order };
}

function listingParams() {
  const params = new URLSearchParams();
  if (PARAMS.q) params.set("q", PARAMS.q);
  if (PARAMS.sort) params.set("sort", PARAMS.sort);
  if (PARAMS.order) params.set("order", PARAMS.order);
  return params;
}

function updateUrl() {
  const qs = listingParams().toString();
  history.replaceState(null, "", baseUrl() + (qs ? "?" + qs : ""));
}

function changeSort(field) {
  const current = getSort();
  const order = current.field === field
    ? (current.order === "asc" ? "desc" : "asc")
    : (field === "name" ? "asc" : "desc");
  PARAMS.sort = field;
  PARAMS.order = order;
  updateUrl();
  refreshListing();
}

function renderListing() {
  const paths = visiblePaths();
  hideCoverPreview();
  if (window.EpubCovers) window.EpubCovers.reset();
  $listingHead.replaceChildren();
  $listingBody.replaceChildren();
  $listing.dataset.view = state.view;

  if (paths.length === 0) {
    $listing.classList.add("hidden");
    renderEmptyState();
  } else {
    $empty.classList.add("hidden");
    $listing.classList.remove("hidden");
    buildListingHead();
    const fragment = document.createDocumentFragment();
    paths.forEach((item, index) => fragment.append(createRow(item, index)));
    $listingBody.append(fragment);
  }

  updateItemCount(paths.length);
  renderGridSort();
  updateSelectionUI();
  scheduleTableNameFit();
}

function buildListingHead() {
  $selectAll = el("input", { type: "checkbox", class: "check", "aria-label": t("Select all items") });
  $selectAll.addEventListener("change", () => {
    if ($selectAll.checked) selectAll();
    else clearSelection();
  });
  $listingHead.append(
    el("div", { class: "cell-check" }, $selectAll),
    el("div", { class: "cell-name" }, sortButton("name", "Name")),
    el("div", { class: "cell-mtime" }, sortButton("mtime", "Last modified")),
    el("div", { class: "cell-size" }, sortButton("size", "Size")),
    el("div", { class: "cell-actions" }),
  );
}

function sortButton(field, label) {
  const current = getSort();
  const active = current.field === field;
  const labelText = t(label);
  const $btn = el("button", {
    type: "button",
    class: "sort-btn" + (active ? " active" : ""),
    "aria-label": active
      ? t(current.order === "asc" ? "Sort by {label}, ascending" : "Sort by {label}, descending", { label: labelText })
      : t("Sort by {label}", { label: labelText }),
  });
  $btn.append(el("span", { text: labelText }));
  const icon = active ? (current.order === "asc" ? "arrowUp" : "arrowDown") : "chevronsUpDown";
  $btn.append(el("span", { class: "sort-icon", html: ICONS[icon] }));
  $btn.addEventListener("click", () => changeSort(field));
  return $btn;
}

function renderGridSort() {
  const current = getSort();
  $gridSort.replaceChildren();
  [["name", "Name"], ["mtime", "Modified"], ["size", "Size"]].forEach(([field, label]) => {
    const active = current.field === field;
    const labelText = t(label);
    const $chip = el("button", {
      type: "button",
      class: "sort-chip" + (active ? " active" : ""),
      "aria-label": active
        ? t(current.order === "asc" ? "Sort by {label}, ascending" : "Sort by {label}, descending", { label: labelText })
        : t("Sort by {label}", { label: labelText }),
    });
    $chip.append(el("span", { text: labelText }));
    if (active) $chip.insertAdjacentHTML("beforeend", ICONS[current.order === "asc" ? "arrowUp" : "arrowDown"]);
    $chip.addEventListener("click", () => changeSort(field));
    $gridSort.append($chip);
  });
}

function updateItemCount(count) {
  const isSearch = !!PARAMS.q;
  $itemCount.textContent = tn(isSearch ? "resultsCount" : "itemsCount", count, { count });
}

function renderEmptyState() {
  const isSearch = !!PARAMS.q;
  let icon = "folderOpen";
  let title = t("This folder is empty");
  let desc = DATA.allow_upload ? t("Upload files or create a new folder to get started.") : t("There is nothing here yet.");
  let action = null;

  if (isSearch) {
    icon = "search";
    title = t("No results");
    desc = t("No files or folders match “{q}”.", { q: PARAMS.q });
    action = { label: t("Clear search"), run: () => { location.href = baseUrl(); } };
  } else if (!DATA.dir_exists) {
    icon = "folderPlus";
    title = t("This folder doesn’t exist yet");
    desc = t("It will be created when you upload a file.");
    if (DATA.allow_upload) action = { label: t("Upload files"), run: () => $fileInput.click() };
  } else if (!UI_SETTINGS.showHidden && (DATA.paths || []).length > 0) {
    title = t("Only hidden items");
    desc = t("Turn on “Show hidden files and folders” in Settings to see them.");
    if (DATA.allow_upload) action = { label: t("Upload files"), run: () => $fileInput.click() };
  } else if (DATA.allow_upload) {
    action = { label: t("Upload files"), run: () => $fileInput.click() };
  }

  $emptyIcon.innerHTML = ICONS[icon];
  $emptyTitle.textContent = title;
  $emptyDesc.textContent = desc;
  if (action) {
    $emptyAction.textContent = action.label;
    $emptyAction.classList.remove("hidden");
    state.emptyAction = action.run;
  } else {
    $emptyAction.classList.add("hidden");
    state.emptyAction = null;
  }
  $empty.classList.remove("hidden");
}

function setupCoverPreview() {
  document.addEventListener("pointerdown", hideCoverPreview, true);
  window.addEventListener("scroll", hideCoverPreview, true);
  window.addEventListener("resize", hideCoverPreview);
  window.addEventListener("blur", hideCoverPreview);
}

function hideCoverPreview() {
  coverPreviewToken++;
  coverPreviewRow = null;
  if (coverPreviewTimer) {
    clearTimeout(coverPreviewTimer);
    coverPreviewTimer = null;
  }
  if ($coverPreview) {
    $coverPreview.classList.add("hidden");
    const $img = $coverPreview.querySelector("img");
    if ($img) {
      $img.onload = null;
      $img.onerror = null;
      $img.removeAttribute("src");
    }
  }
}

function coverPreviewElement() {
  if ($coverPreview) return $coverPreview;
  $coverPreview = el("div", { class: "cover-preview hidden" });
  $coverPreview.append(el("img", { alt: "", draggable: "false" }));
  document.body.append($coverPreview);
  return $coverPreview;
}

function positionCoverPreview($preview, point) {
  const pad = 12;
  const gap = 14;
  const rect = $preview.getBoundingClientRect();
  const $topbar = document.querySelector(".topbar");
  const minTop = ($topbar ? $topbar.getBoundingClientRect().bottom : 0) + pad;
  const maxTop = Math.max(minTop, window.innerHeight - rect.height - pad);
  let left = point.x + gap;
  let top = point.y + gap;
  if (left + rect.width > window.innerWidth - pad) left = point.x - rect.width - gap;
  if (top + rect.height > window.innerHeight - pad) top = point.y - rect.height - gap;
  left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - rect.width - pad));
  top = Math.min(Math.max(minTop, top), maxTop);
  $preview.style.left = `${Math.round(left)}px`;
  $preview.style.top = `${Math.round(top)}px`;
}

function revealCoverPreview($row, previewUrl, point, token, image) {
  if (token !== coverPreviewToken || coverPreviewRow !== $row || !$row.isConnected) return;
  const $preview = coverPreviewElement();
  const $img = $preview.querySelector("img");
  const reveal = () => {
    if (token !== coverPreviewToken || coverPreviewRow !== $row || !$row.isConnected) return;
    $img.onload = null;
    $img.onerror = null;
    $preview.classList.toggle("is-image", !!image);
    $preview.classList.remove("hidden");
    $preview.style.visibility = "hidden";
    positionCoverPreview($preview, point);
    $preview.style.visibility = "";
  };
  $img.onload = reveal;
  $img.onerror = hideCoverPreview;
  $img.src = previewUrl;
  if ($img.complete && $img.naturalWidth > 0) reveal();
}

function previewSource(item, url) {
  if (isImageName(item.name)) {
    return { image: true, load: () => Promise.resolve(url) };
  }
  if (isBookCoverName(item.name) && UI_SETTINGS.covers !== false && window.EpubCovers) {
    return {
      image: false,
      load: () => window.EpubCovers.load(item, url),
      loadFull: typeof window.EpubCovers.loadFull === "function"
        ? () => window.EpubCovers.loadFull(item, url)
        : null,
    };
  }
  return null;
}

function openPreviewHint(item, source) {
  hideCoverPreview();
  if (source.image) {
    openLightbox(item);
    return;
  }
  Promise.resolve().then(source.load).then(coverUrl => {
    if (!coverUrl) {
      showToast(t("Cannot preview “{name}”", { name: item.name }), { type: "error" });
      return;
    }
    openLightbox(item, {
      images: [{ name: item.name, src: coverUrl }],
      loadFull: source.loadFull,
    });
  }).catch(() => {
    showToast(t("Cannot preview “{name}”", { name: item.name }), { type: "error" });
  });
}

function schedulePreview($row, source, event) {
  if (state.view !== "list" || !canLoadThumbnails()) return;
  if (event.pointerType && event.pointerType !== "mouse") return;
  hideCoverPreview();
  coverPreviewRow = $row;
  const point = { x: event.clientX, y: event.clientY };
  const token = ++coverPreviewToken;
  coverPreviewTimer = setTimeout(() => {
    coverPreviewTimer = null;
    if (token !== coverPreviewToken || coverPreviewRow !== $row) return;
    Promise.resolve().then(source.load).then(previewUrl => {
      if (previewUrl) revealCoverPreview($row, previewUrl, point, token, source.image);
    }).catch(() => { });
  }, 200);
}

function attachPreviewHover($trigger, $row, source) {
  $trigger.addEventListener("pointerenter", event => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    schedulePreview($row, source, event);
  });
  $trigger.addEventListener("pointerleave", event => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    if (coverPreviewRow === $row) hideCoverPreview();
  });
}

function setupTableNameFit() {
  const onResize = () => {
    fitTableNames();
    scheduleTableNameFit();
  };
  window.addEventListener("resize", onResize);
  if (typeof ResizeObserver === "function") {
    tableNameFitObserver = new ResizeObserver(onResize);
    tableNameFitObserver.observe($listing);
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleTableNameFit).catch(() => { });
  }
  scheduleTableNameFit();
}

function scheduleTableNameFit() {
  if (!tableNameFitFrame) {
    tableNameFitFrame = requestAnimationFrame(() => {
      tableNameFitFrame = 0;
      fitTableNames();
    });
  }
  clearTimeout(tableNameFitTimer);
  tableNameFitTimer = window.setTimeout(fitTableNames, 120);
}

function fitTableNames() {
  const links = [...$listingBody.querySelectorAll(".path-name")];
  if (!links.length) return;
  links.forEach(link => {
    if (link.dataset.fullName) link.textContent = link.dataset.fullName;
  });
  if (state.view !== "list") return;
  const font = fontStringOf(links[0]);
  links.forEach(link => {
    const fullName = link.dataset.fullName;
    if (!fullName) return;
    const width = link.clientWidth;
    if (width <= 0) return;
    const maxWidth = width - 1;
    if (measureText(fullName, font) <= maxWidth) return;
    link.textContent = middleTruncate(fullName, maxWidth, font, { keepExtension: true });
  });
}

function createRow(item, index) {
  const isDir = isDirType(item.path_type);
  const url = newUrl(item.name) + (isDir ? "/" : "");
  const $row = el("div", { class: "row", role: "listitem", dataset: { name: item.name } });

  const $check = el("input", { type: "checkbox", class: "check", "aria-label": t("Select {name}", { name: item.name }) });
  $check.addEventListener("click", event => {
    event.stopPropagation();
    toggleSelectionAt(item.name, index, $check.checked, event.shiftKey);
  });
  const $checkWrap = el("label", { class: "row-check", title: t("Select") }, $check);

  const $icon = el("span", {
    class: "cell-icon " + (isDir ? "is-dir" : "is-file"),
    html: getPathSvg(item.path_type, item.name),
  });
  if (!isDir && state.view === "grid" && isImageName(item.name) && canLoadThumbnails()) {
    const $thumb = el("img", {
      class: "thumb",
      src: url,
      alt: "",
      loading: "lazy",
      decoding: "async",
      draggable: "false",
    });
    $thumb.addEventListener("error", () => {
      $icon.innerHTML = getPathSvg(item.path_type, item.name);
    });
    $icon.replaceChildren($thumb);
  } else if (!isDir && state.view === "grid" && isBookCoverName(item.name)
    && canLoadThumbnails() && UI_SETTINGS.covers !== false && window.EpubCovers) {
    window.EpubCovers.attach($icon, item, url);
  }
  let $iconHost = $icon;
  if (!isDir && state.view === "grid" && isBookCoverName(item.name) && canLoadThumbnails()) {
    const gridPreview = previewSource(item, url);
    if (gridPreview) {
      const $gridHint = el("button", {
        type: "button",
        class: "grid-cover-preview",
        "aria-label": t("Preview") + ": " + item.name,
        html: ICONS.view,
      });
      $gridHint.addEventListener("click", event => {
        event.stopPropagation();
        openPreviewHint(item, gridPreview);
      });
      $iconHost = el("span", { class: "cell-icon-host" }, $icon, $gridHint);
    }
  }
  let $previewHint = null;
  const preview = !isDir && state.view === "list" && canLoadThumbnails()
    ? previewSource(item, url) : null;
  if (preview) {
    $previewHint = el("button", {
      type: "button",
      class: "row-cover-preview",
      "aria-label": t("Preview") + ": " + item.name,
      html: ICONS.view,
    });
    $previewHint.addEventListener("click", event => {
      event.stopPropagation();
      openPreviewHint(item, preview);
    });
    attachPreviewHover($previewHint, $row, preview);
  }

  const $nameLink = el("a", {
    class: "path-name",
    href: url,
    title: item.name,
    "aria-label": item.name,
    dataset: { fullName: item.name },
    text: item.name,
  });
  if (!isDir) {
    $nameLink.target = "_blank";
    $nameLink.rel = "noopener";
  }
  $nameLink.addEventListener("click", event => {
    event.preventDefault();
    if (event.detail === 0) {
      openRowItem(item);
      return;
    }
    selectRowAtClick(item, index, event);
  });

  const $nameCell = el("div", { class: "cell-name" },
    $iconHost,
    $nameLink,
    $previewHint,
    el("span", { class: "row-sub", text: itemSubtitle(item) }),
  );

  const $mtime = el("div", { class: "cell-mtime", text: formatMtime(item.mtime) });
  const $size = el("div", { class: "cell-size", text: itemSizeLabel(item) });

  const $menuBtn = el("button", {
    type: "button",
    class: "row-menu",
    title: t("Actions"),
    "aria-label": t("Actions for {name}", { name: item.name }),
    "aria-haspopup": "menu",
    html: ICONS.more,
  });
  $menuBtn.addEventListener("click", event => {
    event.stopPropagation();
    if (menuState.open && menuState.opener === $menuBtn) {
      closeMenu();
      return;
    }
    openItemMenu(item, { anchor: $menuBtn, returnFocus: $menuBtn, row: $row });
  });

  $row.append($checkWrap, $nameCell, $mtime, $size, $menuBtn);

  $row.addEventListener("click", event => {
    if (Date.now() < state.suppressClickUntil) return;
    if (event.target.closest("a, button, input, label, textarea, select")) return;
    selectRowAtClick(item, index, event);
  });

  $row.addEventListener("dblclick", event => {
    if (Date.now() < state.suppressClickUntil) return;
    if (event.target.closest("input, label, button, textarea, select")) return;
    event.preventDefault();
    openRowItem(item);
  });

  $row.addEventListener("keydown", event => {
    if (event.key !== " " || event.target !== $nameLink) return;
    event.preventDefault();
    toggleSelectionAt(item.name, index, !state.selected.has(item.name), event.shiftKey);
  });

  $row.addEventListener("contextmenu", event => {
    event.preventDefault();
    if (menuState.open && menuState.row === $row) return;
    openItemMenu(item, {
      x: event.clientX,
      y: event.clientY,
      returnFocus: $nameLink,
      row: $row,
    });
  });

  attachLongPress($row, item, $nameLink);

  return $row;
}

function attachLongPress($row, item, $nameLink) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  $row.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") return;
    if (event.target.closest("a, button, input, label")) return;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = window.setTimeout(() => {
      timer = null;
      state.suppressClickUntil = Date.now() + 700;
      openItemMenu(item, {
        x: event.clientX,
        y: event.clientY,
        returnFocus: $nameLink,
        row: $row,
      });
    }, 520);
  });
  $row.addEventListener("pointermove", event => {
    if (timer && (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10)) cancel();
  });
  $row.addEventListener("pointerup", cancel);
  $row.addEventListener("pointercancel", cancel);
  $row.addEventListener("pointerleave", cancel);
}

function canLoadThumbnails() {
  return !DATA.auth || !!DATA.user;
}

function openRowItem(item) {
  if (isDirType(item.path_type)) {
    location.href = newUrl(item.name) + "/";
    return;
  }
  if (openPreview(item)) return;
  openUnavailablePreview(item);
}

function openUnavailablePreview(item) {
  hideCoverPreview();
  const buttons = [
    { key: "close", label: t("Close"), variant: "outline", onClick: m => m.close("close") },
  ];
  if (isBrowserViewableName(item.name)) {
    buttons.push({
      key: "open",
      label: t("Open in new tab"),
      variant: "outline",
      onClick: m => {
        window.open(newUrl(item.name), "_blank", "noopener");
        m.close("open");
      },
    });
  }
  buttons.push({
    key: "download",
    label: t("Download"),
    variant: "primary",
    primary: true,
    onClick: m => {
      downloadUrl(newUrl(item.name));
      m.close("download");
    },
  });
  const dialog = new Dialog({
    title: t("Preview unavailable"),
    description: item.name,
    body: el("p", {
      class: "dialog-message",
      text: t("This file cannot be shown here because it is binary or too large. Use Download to open it locally."),
    }),
    buttons,
    initialFocus: m => m.byKey.download,
  });
  dialog.open();
}

function openPreview(item) {
  if (isDirType(item.path_type)) return false;
  const preview = formatInfoFor(item.name).preview;
  if (preview === "image") {
    openLightbox(item);
    return true;
  }
  if (preview === "pdf") {
    openPdfPreview(item);
    return true;
  }
  if (preview === "audio" || preview === "video") {
    openDetailPane(item, preview);
    return true;
  }
  if (preview === "text" && item.size <= MAX_VIEW_TEXT_SIZE) {
    openTextViewer(item);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------------- */
/* item actions                                                              */
/* ------------------------------------------------------------------------- */

function openItemMenu(item, options = {}) {
  hideCoverPreview();
  const isDir = isDirType(item.path_type);
  const url = newUrl(item.name) + (isDir ? "/" : "");
  const items = [];

  if (isDir) {
    items.push({ label: t("Open"), icon: "folderOpen", onSelect: () => { location.href = url; } });
    if (DATA.allow_archive) {
      items.push({ label: t("Download as .zip"), icon: "package", onSelect: () => downloadUrl(url + "?zip") });
    }
  } else {
    if (canPreviewItem(item)) {
      items.push({ label: t("Preview"), icon: "view", onSelect: () => openPreview(item) });
    }
    if (isBrowserViewableName(item.name)) {
      items.push({
        label: t("Open in new tab"),
        icon: "view",
        onSelect: () => window.open(url, "_blank", "noopener"),
      });
    }
    items.push({ label: t("Download"), icon: "download", onSelect: () => downloadItem(item) });
    if (DATA.allow_upload) {
      items.push({ label: t("Edit"), icon: "edit", onSelect: () => editPath(item) });
    }
  }

  if (DATA.allow_delete && DATA.allow_upload) {
    items.push({ separator: true });
    items.push({ label: t("Rename"), icon: "rename", onSelect: () => renameItem(item) });
    items.push({ label: t("Move"), icon: "move", onSelect: () => moveItem(item) });
  }
  if (DATA.allow_delete && !isServerRootItem(item)) {
    items.push({ separator: true });
    items.push({ label: t("Delete"), icon: "delete", danger: true, onSelect: () => deleteItems([item]) });
  }

  openMenu(items, { ...options, align: options.anchor ? "end" : "start" });
}

async function renameItem(item) {
  const isFolder = isDirType(item.path_type);
  const currentName = basePathName(item.name);
  const newName = await promptRename(currentName, isFolder);
  if (newName === null || newName === currentName) return;
  const oldPath = pathFromUrl(newUrl(item.name));
  const destUrl = urlFromPath(joinPath(parentPath(oldPath), newName));
  if (await performMove(newUrl(item.name), destUrl, { name: currentName })) {
    await refreshListing();
    showToast(t("Renamed “{from}” to “{to}”", { from: currentName, to: newName }), { type: "success" });
  }
}

async function moveItem(item) {
  const result = await openMovePicker([item]);
  if (!result) return;
  await refreshListing();
  showToast(t("Moved “{name}” to {path}", { name: basePathName(item.name), path: displayPath(result.dir) }), { type: "success" });
}

function isServerRootItem(item) {
  try {
    return pathFromUrl(item.url || newUrl(item.name)) === "/";
  } catch (err) {
    return false;
  }
}

function sidecarFor(item) {
  if (!item || isDirType(item.path_type)) return null;
  // KOReader drops the last suffix for sidecars: Book.epub -> Book.sdr.
  const name = String(item.name);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const sidecarName = `${stem}.sdr`;
  return (DATA.paths || []).find(entry => (
    entry && isDirType(entry.path_type) && entry.name === sidecarName
  )) || null;
}

function sidecarsFor(items) {
  const sidecars = [];
  const seen = new Set();
  for (const item of items) {
    const sidecar = sidecarFor(item);
    if (sidecar && !seen.has(sidecar.name)) {
      seen.add(sidecar.name);
      sidecars.push({ source: item, sidecar });
    }
  }
  return sidecars;
}

async function deleteItems(items) {
  items = items.filter(item => !isServerRootItem(item));
  if (!items.length) return;
  const choice = await confirmDelete(items);
  if (!choice.confirmed) return;
  const errors = [];
  try {
    await checkAuth();
  } catch (err) {
    toastRequestError(t("Authentication failed"), err);
    return;
  }
  const deleted = new Set();
  for (const item of items) {
    try {
      const res = await fetch(newUrl(item.name), { method: "DELETE" });
      await assertResOK(res);
      deleted.add(item.name);
    } catch (err) {
      errors.push({ item, err });
    }
  }
  if (choice.deleteSidecars) {
    const selectedNames = new Set(items.map(item => item.name));
    for (const { source, sidecar } of sidecarsFor(items)) {
      if (!deleted.has(source.name) || selectedNames.has(sidecar.name)) continue;
      try {
        const res = await fetch(newUrl(sidecar.name), { method: "DELETE" });
        await assertResOK(res);
        deleted.add(sidecar.name);
      } catch (err) {
        errors.push({ item: sidecar, err });
      }
    }
  }
  clearSelection();
  await refreshListing();
  if (errors.length) {
    errors.slice(0, 3).forEach(({ item, err }) => toastRequestError(t("Cannot delete “{name}”", { name: item.name }), err));
    if (errors.length > 3) {
      showErrorToast(tn("moreDeletionsFailed", errors.length - 3, { count: errors.length - 3 }));
    }
  } else if (items.length === 1) {
    showToast(t("Deleted “{name}”", { name: items[0].name }), { type: "success" });
  } else {
    showToast(tn("deletedItems", items.length, { count: items.length }), { type: "success" });
  }
}

async function confirmDelete(items) {
  const eligible = items.filter(item => !isServerRootItem(item));
  if (!eligible.length) return { confirmed: false, deleteSidecars: false };

  const single = eligible.length === 1;
  const item = eligible[0];
  const isFolder = single && isDirType(item.path_type);
  let title;
  let description;
  let details = null;
  let requirement = null;

  if (single && !isFolder) {
    title = t("Delete file?");
    description = t("“{name}” will be permanently deleted. This action cannot be undone.", { name: item.name });
  } else if (isFolder) {
    title = t("Delete folder?");
    requirement = {
      value: item.name,
      label: t("Folder name"),
    };
    const count = Number(item.size);
    const hasCount = item.size !== undefined && item.size !== null && Number.isFinite(count);
    let template;
    if (!hasCount) template = t("folderDeleteDescriptionNoCount");
    else if (count >= MAX_SUBPATHS_COUNT) template = t("folderDeleteDescriptionMany");
    else template = tn("folderDeleteDescription", count, { count });
    description = textWithLink(
      template,
      "name",
      copyableValue(item.name, () => requirement.focusInput?.()),
    );
  } else {
    title = tn("deleteItemsTitle", eligible.length, { count: eligible.length });
    description = t("The selected items will be permanently deleted. This action cannot be undone.");
    const $list = el("ul", { class: "dialog-list" },
      eligible.slice(0, 6).map(entry => el("li", { text: entry.name })),
    );
    if (eligible.length > 6) $list.append(el("li", { text: t("and {count} more…", { count: eligible.length - 6 }) }));
    details = $list;
    requirement = {
      value: String(eligible.length),
      label: t("Number of items"),
    };
  }

  let $deleteSidecars = null;
  if (sidecarsFor(eligible).length > 0) {
    $deleteSidecars = el("input", { type: "checkbox", class: "check" });
    const $option = el("label", { class: "confirm-option" },
      el("span", { class: "confirm-option-copy" },
        el("span", { class: "confirm-option-label", text: t("Delete KOReader sidecar folders too") }),
        el("span", {
          class: "field-hint",
          text: t("Bookmarks, notes and highlights will be lost."),
        }),
      ),
      $deleteSidecars,
    );
    details = details ? el("div", {}, details, $option) : $option;
  }

  const confirmed = await confirmDialog({
    title,
    description,
    details,
    requirement,
    confirmText: t("Delete"),
    danger: true,
  });
  return {
    confirmed,
    deleteSidecars: confirmed && !!($deleteSidecars && $deleteSidecars.checked),
  };
}

function promptRename(name, isFolder) {
  return promptDialog({
    title: t("Rename"),
    description: t("Rename “{name}”.", { name }),
    label: t("New name"),
    value: name,
    confirmText: t("Rename"),
    selectRange: renameSelection(name, isFolder),
    validate: value => validateName(value, { exclude: name }),
  });
}

function renameSelection(name, isFolder) {
  if (isFolder) return [0, name.length];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [0, dot] : [0, name.length];
}

function validateName(value, options = {}) {
  if (!value) return t("Enter a name.");
  if (value.includes("/")) return t('The name cannot contain "/".');
  if (value === "." || value === "..") return t('The name cannot be "." or "..".');
  const existing = (DATA.paths || [])
    .filter(item => item && !item.name.includes("/"))
    .map(item => item.name);
  if (existing.some(name => name === value && name !== options.exclude)) {
    return t("An item with this name already exists.");
  }
  return "";
}

async function createFolderFlow() {
  const name = await promptDialog({
    title: t("New folder"),
    description: t("Create a folder in the current location."),
    label: t("Folder name"),
    placeholder: t("Folder name"),
    confirmText: t("Create"),
    validate: value => validateName(value),
  });
  if (name !== null) await createFolder(name);
}

async function createFolder(name) {
  try {
    await checkAuth();
    const res = await fetch(newUrl(name), { method: "MKCOL" });
    await assertResOK(res);
    await refreshListing();
    showToast(t("Created folder “{name}”", { name }), { type: "success" });
  } catch (err) {
    toastRequestError(t("Cannot create folder “{name}”", { name }), err);
  }
}

async function createFileFlow() {
  const name = await promptDialog({
    title: t("New file"),
    description: t("Create an empty file in the current location."),
    label: t("File name"),
    placeholder: t("File name"),
    confirmText: t("Create"),
    validate: value => validateName(value),
  });
  if (name !== null) await createFile(name);
}

async function createFile(name) {
  const url = newUrl(name);
  try {
    await checkAuth();
    const res = await fetch(url, { method: "PUT", body: "" });
    await assertResOK(res);
    if (!(await refreshListing())) return;
    showToast(t("Created file “{name}”", { name }), { type: "success" });
    editPath({ name, path_type: "File", size: 0 });
  } catch (err) {
    toastRequestError(t("Cannot create file “{name}”", { name }), err);
  }
}

async function performMove(fileUrl, destUrl, options = {}) {
  const name = options.name || basePathName(pathFromUrl(fileUrl));
  const destName = basePathName(pathFromUrl(destUrl));
  try {
    await checkAuth();
    const head = await fetch(destUrl, { method: "HEAD" });
    if (head.status === 200) {
      const replace = await confirmDialog({
        title: t("Replace existing item?"),
        description: t("“{name}” already exists in the destination folder. Replacing it cannot be undone.", { name: destName }),
        confirmText: t("Replace"),
        danger: true,
      });
      if (!replace) return false;
    }
    const res = await fetch(fileUrl, {
      method: "MOVE",
      headers: { Destination: destUrl },
    });
    await assertResOK(res);
    return true;
  } catch (err) {
    toastRequestError(t("Cannot move “{name}”", { name }), err);
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* selection                                                                 */
/* ------------------------------------------------------------------------- */

function setupSelectionBar() {
  $selectionClear.addEventListener("click", clearSelection);
  $selectionbar.querySelectorAll("[data-selection-action]").forEach($btn => {
    $btn.addEventListener("click", () => {
      const action = $btn.dataset.selectionAction;
      if (action === "download") downloadSelection();
      else if (action === "move") moveSelection();
      else if (action === "delete") deleteSelection();
    });
  });
  document.addEventListener("click", event => {
    if (!state.selected.size || DATA.kind !== "Index") return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".row, .selectionbar, .detail-pane, dialog, .menu, button, a, input, label, select, textarea")) return;
    clearSelection();
  });
}

function selectedItems() {
  return visiblePaths().filter(item => state.selected.has(item.name));
}

function selectAll() {
  visiblePaths().forEach(item => state.selected.add(item.name));
  state.lastSelectedIndex = null;
  updateSelectionUI();
}

function clearSelection() {
  state.selected.clear();
  state.lastSelectedIndex = null;
  updateSelectionUI();
}

function selectOnlyAt(name, index) {
  state.selected.clear();
  state.selected.add(name);
  state.lastSelectedIndex = index;
  updateSelectionUI();
}

function selectRowAtClick(item, index, event) {
  if (event.shiftKey) {
    toggleSelectionAt(item.name, index, true, true);
  } else if (event.ctrlKey || event.metaKey) {
    toggleSelectionAt(item.name, index, !state.selected.has(item.name), false);
  } else {
    selectOnlyAt(item.name, index);
  }
}

function toggleSelectionAt(name, index, checked, shiftKey) {
  const paths = visiblePaths();
  if (shiftKey && state.lastSelectedIndex !== null && paths[state.lastSelectedIndex]) {
    const from = Math.min(state.lastSelectedIndex, index);
    const to = Math.max(state.lastSelectedIndex, index);
    for (let i = from; i <= to; i++) {
      const target = paths[i];
      if (!target) continue;
      if (checked) state.selected.add(target.name);
      else state.selected.delete(target.name);
    }
  } else if (checked) {
    state.selected.add(name);
  } else {
    state.selected.delete(name);
  }
  state.lastSelectedIndex = index;
  updateSelectionUI();
}

function updateSelectionUI() {
  if (!DATA || DATA.kind !== "Index") {
    $selectionbar.classList.add("hidden");
    document.body.classList.remove("has-selection");
    return;
  }
  const selected = selectedItems();
  const count = selected.length;
  $selectionbar.classList.toggle("hidden", count === 0);
  document.body.classList.toggle("has-selection", count > 0);
  $selectionCount.textContent = tn("selectedCount", count, { count });

  document.querySelectorAll(".row").forEach($row => {
    const isSelected = state.selected.has($row.dataset.name);
    $row.classList.toggle("is-selected", isSelected);
    const $check = $row.querySelector(".row-check input");
    if ($check) $check.checked = isSelected;
  });

  if ($selectAll) {
    const total = visiblePaths().length;
    $selectAll.checked = total > 0 && count === total;
    $selectAll.indeterminate = count > 0 && count < total;
  }

  const deletable = selected.filter(item => !isServerRootItem(item));
  const hasFolder = selected.some(item => isDirType(item.path_type));
  const $download = $selectionbar.querySelector('[data-selection-action="download"]');
  const $move = $selectionbar.querySelector('[data-selection-action="move"]');
  const $delete = $selectionbar.querySelector('[data-selection-action="delete"]');
  if ($download) $download.disabled = selected.length === 0 || (hasFolder && !DATA.allow_archive);
  if ($move) $move.disabled = selected.length === 0 || !DATA.allow_upload || !DATA.allow_delete;
  if ($delete) $delete.disabled = deletable.length === 0 || !DATA.allow_delete;
}

async function downloadSelection() {
  const items = selectedItems();
  if (!items.length) return;
  let started = 0;
  for (const item of items) {
    if (isDirType(item.path_type)) {
      if (!DATA.allow_archive) continue;
      await downloadUrl(newUrl(item.name) + "/?zip");
    } else {
      await downloadUrl(newUrl(item.name));
    }
    started++;
  }
  if (started > 0) {
    showToast(tn("startedDownloads", started, { count: started }), { type: "success" });
  }
}

async function moveSelection() {
  const items = selectedItems();
  if (!items.length) return;
  const result = await openMovePicker(items);
  if (!result) return;
  await refreshListing();
  const suffix = result.failed ? ` (${tn("failedCount", result.failed, { count: result.failed })})` : "";
  showToast(tn("movedItems", result.count, { count: result.count, path: displayPath(result.dir) }) + suffix, { type: "success" });
}

async function deleteSelection() {
  const items = selectedItems();
  if (!items.length) return;
  await deleteItems(items);
}

/* ------------------------------------------------------------------------- */
/* listing refresh                                                           */
/* ------------------------------------------------------------------------- */

async function refreshListing() {
  if (DATA.kind !== "Index") return false;
  const params = listingParams();
  params.set("json", "");
  try {
    const res = await fetch(baseUrl() + "?" + params.toString(), {
      headers: { Accept: "application/json" },
    });
    await assertResOK(res);
    const data = await res.json();
    if (!data || !Array.isArray(data.paths)) throw new Error("Invalid listing response");
    DATA.paths = data.paths;
    DATA.dir_exists = data.dir_exists;
    DATA.allow_upload = data.allow_upload;
    DATA.allow_delete = data.allow_delete;
    DATA.allow_search = data.allow_search;
    DATA.allow_archive = data.allow_archive;
    DATA.user = data.user;
    // Keep the selection across sorts and background refreshes, but drop
    // entries that no longer exist.
    const names = new Set(data.paths.map(item => item && item.name));
    for (const name of [...state.selected]) {
      if (!names.has(name)) state.selected.delete(name);
    }
    syncTopbar();
    renderListing();
    return true;
  } catch (err) {
    location.reload();
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* downloads and auth                                                        */
/* ------------------------------------------------------------------------- */

async function downloadUrl(url) {
  try {
    const originalHref = new URL(url, location.href).href;
    let href = originalHref;
    if (DATA.user) {
      const tokengenUrl = new URL(originalHref);
      tokengenUrl.searchParams.set("tokengen", "");
      const res = await fetch(tokengenUrl);
      if (!res.ok) {
        throw new Error(t("Failed to fetch token: {status}", {
          status: `${res.status} ${res.statusText}`.trim(),
        }));
      }
      const token = await res.text();
      const tokenUrl = new URL(originalHref);
      tokenUrl.searchParams.set("token", token);
      href = tokenUrl.toString();
    }
    const tempA = document.createElement("a");
    tempA.href = href;
    tempA.download = "";
    document.body.appendChild(tempA);
    tempA.click();
    document.body.removeChild(tempA);
  } catch (err) {
    toastRequestError(t("Failed to download"), err);
  }
}

function downloadItem(item) {
  if (isDirType(item.path_type)) {
    if (DATA.allow_archive) downloadUrl(newUrl(item.name) + "/?zip");
    return;
  }
  downloadUrl(newUrl(item.name));
}

function setupDownloadWithToken() {
  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const $link = event.target.closest("a.dlwt");
    if (!$link || !DATA.user) return;
    event.preventDefault();
    downloadUrl($link.href);
  });
}

async function checkAuth(variant) {
  if (!DATA.auth) return;
  const qs = variant ? `?${variant}` : "";
  const res = await fetch(baseUrl() + qs, { method: "CHECKAUTH" });
  await assertResOK(res);
  DATA.user = await res.text();
  syncTopbar();
}

function logout() {
  if (!DATA.auth) return;
  const url = baseUrl();
  const xhr = new XMLHttpRequest();
  xhr.open("LOGOUT", url, true, DATA.user);
  xhr.onload = () => {
    location.href = url;
  };
  xhr.send();
}

/* ------------------------------------------------------------------------- */
/* move picker (Nextcloud-style destination browser)                         */
/* ------------------------------------------------------------------------- */

function openMovePicker(items) {
  return new Promise(resolve => {
    if (!items.length) {
      resolve(null);
      return;
    }
    const sources = items.map(item => {
      const url = item.url || newUrl(item.name);
      let sourcePath = pathFromUrl(url);
      if (sourcePath !== "/") sourcePath = sourcePath.replace(/\/+$/, "");
      return {
        item,
        url,
        path: sourcePath,
        isFolder: isDirType(item.path_type),
      };
    });
    const parents = sources.map(source => parentPath(source.path));
    const commonParent = parents.every(parent => parent === parents[0]) ? parents[0] : "/";
    let currentPath = commonParent;
    let requestSeq = 0;
    let busy = false;
    let result = null;

    const $crumbs = el("nav", { class: "breadcrumb move-crumbs", "aria-label": t("Destination path") });
    const $list = el("div", { class: "move-list" });
    const $note = el("p", { class: "move-note", "aria-live": "polite" });
    const $destPath = el("span", { class: "move-dest-path", "aria-live": "polite" });
    const $dest = el("div", { class: "move-destination" },
      el("span", { html: ICONS.folder, "aria-hidden": "true" }),
      el("span", { class: "move-dest-label", text: t("Move to") }),
      $destPath,
    );
    const $body = el("div", {}, $crumbs, $list, $note, $dest);

    const dialog = new Dialog({
      title: t("Move"),
      description: items.length === 1
        ? basePathName(sources[0].path)
        : tn("itemsSelected", items.length, { count: items.length }),
      className: "dialog-move",
      body: $body,
      buttons: [
        { key: "cancel", label: t("Cancel"), variant: "outline", onClick: m => m.requestClose("cancel") },
        { key: "move", label: t("Move here"), variant: "primary", primary: true, disabled: true, onClick: () => moveHere() },
      ],
      initialFocus: m => m.byKey.cancel,
      beforeClose: () => !busy,
      onClose: () => {
        moveBreadcrumb.destroy();
        resolve(result);
      },
    });

    const moveBreadcrumb = createBreadcrumb($crumbs, {
      path: currentPath,
      homePath: homePathFromUiPaths(),
      onNavigate: dir => navigate(dir),
    });

    function movableSources() {
      return sources.filter(source => {
        if (currentPath === parentPath(source.path)) return false;
        if (source.isFolder && (currentPath === source.path || currentPath.startsWith(source.path + "/"))) return false;
        return true;
      });
    }

    function updateState() {
      const movable = movableSources();
      const skipped = sources.length - movable.length;
      dialog.byKey.move.disabled = busy || movable.length === 0;
      if (movable.length > 0) {
        $note.classList.remove("danger");
        $note.textContent = skipped > 0
          ? t("{skipped} of {total} items cannot be moved here and will be skipped.", { skipped, total: sources.length })
          : t("Choose a folder to move into.");
        return;
      }
      let reason = t("Already in this folder.");
      for (const source of sources) {
        if (source.isFolder && (currentPath === source.path || currentPath.startsWith(source.path + "/"))) {
          reason = t("A folder cannot be moved into itself.");
          break;
        }
      }
      $note.classList.add("danger");
      $note.textContent = reason;
    }

    async function navigate(dir) {
      const seq = ++requestSeq;
      currentPath = normalizeBreadcrumbPath(dir);
      moveBreadcrumb.setPath(currentPath);
      $destPath.textContent = displayPath(currentPath);
      updateState();
      $list.replaceChildren(el("div", { class: "move-loading" },
        el("span", { class: "spinner", "aria-hidden": "true" }),
        t("Loading…"),
      ));
      try {
        const params = new URLSearchParams({ json: "", sort: "name" });
        const res = await fetch(dirUrlFromPath(dir) + "?" + params.toString(), {
          headers: { Accept: "application/json" },
        });
        await assertResOK(res);
        const data = await res.json();
        if (seq !== requestSeq) return;
        const folders = (Array.isArray(data.paths) ? data.paths : [])
          .filter(item => item && isDirType(item.path_type) && !isHiddenItem(item))
          .sort((a, b) => a.name.localeCompare(b.name));
        $list.replaceChildren();
        if (currentPath !== "/") {
          const $up = el("button", { type: "button", class: "move-entry up" },
            el("span", { html: ICONS.arrowUp, "aria-hidden": "true" }),
            el("span", { class: "move-entry-name", text: t("Parent folder") }),
          );
          $up.addEventListener("click", () => navigate(parentPath(currentPath)));
          $list.append($up);
        }
        if (folders.length === 0) {
          $list.append(el("div", { class: "move-empty", text: t("No subfolders") }));
        } else {
          let shown = 0;
          folders.forEach(folder => {
            const folderPath = joinPath(currentPath, folder.name);
            // Never offer to enter a folder that is itself being moved.
            if (sources.some(source => source.isFolder && folderPath === source.path)) return;
            shown++;
            const $entry = el("button", { type: "button", class: "move-entry" },
              el("span", { html: ICONS.folder, "aria-hidden": "true" }),
              el("span", { class: "move-entry-name", text: folder.name }),
              el("span", { class: "move-entry-chevron", html: ICONS.chevronRight, "aria-hidden": "true" }),
            );
            $entry.addEventListener("click", () => navigate(folderPath));
            $list.append($entry);
          });
          if (shown === 0) {
            $list.append(el("div", { class: "move-empty", text: t("No subfolders") }));
          }
        }
      } catch (err) {
        if (seq !== requestSeq) return;
        $list.replaceChildren(el("div", { class: "move-error", text: t("Cannot load this folder: {message}", { message: err.message }) }));
      }
    }

    async function moveHere() {
      if (busy) return;
      const movable = movableSources();
      if (!movable.length) return;
      busy = true;
      dialog.setBusy(true);
      $note.textContent = t("Moving…");
      const failures = [];
      try {
        await checkAuth();
      } catch (err) {
        failures.push(err);
      }
      for (const source of movable) {
        const destUrl = urlFromPath(joinPath(currentPath, basePathName(source.path)));
        const moved = await performMove(source.url, destUrl, { name: basePathName(source.path) });
        if (!moved) failures.push(source);
      }
      busy = false;
      dialog.setBusy(false);
      const movedCount = movable.length - failures.length;
      if (movedCount > 0) {
        result = { dir: currentPath, count: movedCount, failed: failures.length };
        dialog.close("moved");
      } else {
        updateState();
        $note.classList.add("danger");
        $note.textContent = t("Nothing was moved. Check the error notifications and try again.");
      }
    }

    dialog.open();
    navigate(commonParent);
  });
}

/* ------------------------------------------------------------------------- */
/* editor and viewer                                                         */
/* ------------------------------------------------------------------------- */

async function editPath(item) {
  if (isDirType(item.path_type)) return;
  const url = newUrl(item.name);
  if (!usesSplitView()) {
    location.href = url + "?edit";
    return;
  }
  try {
    const editData = await fetchEditData(url);
    if (!editData || !editData.editable) {
      window.open(url + "?edit", "_blank", "noopener");
      return;
    }
    openDetailPane(item, "edit");
  } catch (err) {
    toastRequestError(t("Cannot open “{name}” for editing", { name: item.name }), err);
  }
}

function usesSplitView() {
  return window.matchMedia(SPLIT_VIEW_QUERY).matches;
}

function detailPageUrl(item, mode) {
  return newUrl(item.name) + (mode === "edit" ? "?edit" : "?view");
}

function detailMeta(item) {
  return [formatFileSize(item.size).join(" "), formatMtime(item.mtime)].filter(Boolean).join(" · ");
}

function paneAction(icon, label, onClick, variant = "ghost") {
  const $button = el("button", {
    type: "button",
    class: `btn btn-${variant} btn-icon`,
    title: label,
    "aria-label": label,
    html: ICONS[icon],
  });
  $button.addEventListener("click", onClick);
  return $button;
}

async function openDetailPane(item, mode) {
  if (!usesSplitView() || !$detailPane) {
    location.href = detailPageUrl(item, mode);
    return;
  }
  if (detailState.saving) return;
  if (detailState.item && detailState.item.name === item.name && detailState.mode === mode) return;
  if (detailState.dirty && detailState.item) {
    const discard = await confirmDiscard(detailState.item.name);
    if (!discard) return;
  }
  renderDetailPane(item, mode);
}

function closeDetailPane() {
  const name = detailState.item && detailState.item.name;
  detailState.seq++;
  detailState.item = null;
  detailState.mode = null;
  detailState.dirty = false;
  detailState.saving = false;
  detailState.original = "";
  $detailPane.classList.add("hidden");
  $detailPane.replaceChildren();
  $indexPage.classList.remove("is-split");
  if (name) {
    const $row = [...$listingBody.querySelectorAll(".row")].find(row => row.dataset.name === name);
    const $link = $row && $row.querySelector(".path-name");
    if ($link) $link.focus({ preventScroll: true });
  }
}

async function requestCloseDetailPane() {
  if (detailState.saving) return;
  if (detailState.dirty && detailState.item) {
    const discard = await confirmDiscard(detailState.item.name);
    if (!discard) {
      const $textarea = $detailPane.querySelector("textarea");
      if ($textarea) $textarea.focus();
      return;
    }
  }
  closeDetailPane();
}

async function openDetailFullPage() {
  if (!detailState.item || detailState.saving) return;
  const item = detailState.item;
  const mode = detailState.mode;
  if (detailState.dirty && !(await confirmDiscard(item.name))) return;
  detailState.dirty = false;
  location.href = detailPageUrl(item, mode);
}

function setDetailStatus($status, text, className = "") {
  $status.textContent = text;
  $status.className = "editor-status" + (className ? " " + className : "");
}

function renderDetailPane(item, mode) {
  const token = ++detailState.seq;
  detailState.item = item;
  detailState.mode = mode;
  detailState.dirty = false;
  detailState.saving = false;
  detailState.original = "";
  $detailPane.replaceChildren();
  $detailPane.setAttribute("aria-label", mode === "edit" ? t("Edit file") : t("Preview"));
  $indexPage.classList.add("is-split");
  $detailPane.classList.remove("hidden");

  const $actions = el("div", { class: "detail-pane-actions" });
  const $heading = el("div", { class: "detail-pane-heading" },
    el("h2", { class: "detail-pane-title", title: item.name, text: item.name }),
    el("p", { class: "detail-pane-meta", text: detailMeta(item) }),
  );
  const $head = el("div", { class: "detail-pane-head" },
    el("span", { class: "detail-pane-icon", html: getPathSvg(item.path_type, item.name) }),
    $heading,
    $actions,
  );
  const $body = el("div", { class: "detail-pane-body" });
  $detailPane.append($head, $body);

  const $close = paneAction("close", t("Close"), () => requestCloseDetailPane());
  const $download = paneAction("download", t("Download"), () => downloadUrl(newUrl(item.name)));
  const $fullPage = paneAction("maximize", t("Open full page"), () => openDetailFullPage());

  if (mode === "edit") {
    $actions.append(
      renderDetailEditor(item, $body, token),
      $download,
      $fullPage,
      $close,
    );
  } else if (mode === "pdf") {
    $actions.append(
      $download,
      paneAction("externalLink", t("Open in new tab"), () => window.open(newUrl(item.name), "_blank", "noopener")),
      $fullPage,
      $close,
    );
    $body.append(el("iframe", {
      class: "detail-pane-frame",
      src: newUrl(item.name),
      title: item.name,
    }));
  } else if (mode === "audio" || mode === "video") {
    $actions.append(
      $download,
      paneAction("externalLink", t("Open in new tab"), () => window.open(newUrl(item.name), "_blank", "noopener")),
      $fullPage,
      $close,
    );
    $body.append(el(mode, {
      class: `detail-pane-media detail-pane-${mode}`,
      src: newUrl(item.name),
      controls: true,
      preload: "metadata",
      playsinline: mode === "video" ? true : undefined,
    }));
  } else {
    const actions = [$download];
    if (DATA.allow_upload) {
      actions.push(paneAction("edit", t("Edit"), () => editPath(item)));
    }
    actions.push($fullPage, $close);
    $actions.append(...actions);
    renderDetailText(item, $body, token);
  }
}

function renderDetailText(item, $body, token) {
  const $pre = el("pre", { class: "viewer-pre is-loading", text: t("Loading…") });
  $body.append($pre);
  fetchText(newUrl(item.name))
    .then(text => {
      if (token !== detailState.seq) return;
      $pre.classList.remove("is-loading");
      $pre.textContent = text;
    })
    .catch(err => {
      if (token !== detailState.seq) return;
      $pre.classList.remove("is-loading");
      $pre.classList.add("is-error");
      $pre.textContent = t("Cannot preview this file: {message}", { message: err.message });
      toastRequestError(t("Cannot preview “{name}”", { name: item.name }), err);
    });
}

function renderDetailEditor(item, $body, token) {
  const $save = paneAction("save", t("Save"), () => saveDetail(), "primary");
  $save.disabled = true;
  const $textarea = el("textarea", {
    class: "editor-textarea detail-pane-textarea",
    spellcheck: "false",
    "aria-label": t("File contents"),
    disabled: true,
  });
  const $status = el("span", { class: "editor-status", text: t("Loading…") });
  const $foot = el("div", { class: "editor-foot detail-pane-foot" },
    $status,
    el("span", { class: "editor-hint", text: t("Ctrl+S to save") }),
  );
  $body.append($textarea);
  $detailPane.append($foot);

  const updateDirty = () => {
    if (token !== detailState.seq || detailState.mode !== "edit") return;
    detailState.dirty = !$textarea.disabled && $textarea.value !== detailState.original;
    $save.disabled = detailState.saving || !detailState.dirty;
    if (!detailState.saving) {
      setDetailStatus($status, detailState.dirty ? t("Unsaved changes") : t("No changes"), detailState.dirty ? "dirty" : "");
    }
  };

  const saveDetail = async () => {
    if (token !== detailState.seq || detailState.saving || !detailState.dirty) return;
    detailState.saving = true;
    $save.disabled = true;
    try {
      const res = await fetch(newUrl(item.name), { method: "PUT", body: $textarea.value });
      await assertResOK(res);
      if (token !== detailState.seq) return;
      detailState.original = $textarea.value;
      detailState.dirty = false;
      setDetailStatus($status, t("Saved"), "saved");
      showToast(t("Saved “{name}”", { name: item.name }), { type: "success" });
      refreshListing();
    } catch (err) {
      if (token !== detailState.seq) return;
      setDetailStatus($status, t("Unsaved changes"), "dirty");
      toastRequestError(t("Failed to save file"), err);
    } finally {
      if (token === detailState.seq) {
        detailState.saving = false;
        if (detailState.dirty) {
          updateDirty();
        } else {
          $save.disabled = true;
          setDetailStatus($status, t("Saved"), "saved");
        }
      }
    }
  };

  $textarea.addEventListener("input", updateDirty);
  $textarea.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      requestCloseDetailPane();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveDetail();
    }
  });
  fetchText(newUrl(item.name))
    .then(text => {
      if (token !== detailState.seq || detailState.mode !== "edit") return;
      $textarea.value = text;
      $textarea.disabled = false;
      detailState.original = text;
      updateDirty();
      $textarea.focus();
      $textarea.setSelectionRange(0, 0);
    })
    .catch(err => {
      if (token !== detailState.seq) return;
      $body.replaceChildren(el("p", {
        class: "dialog-message",
        text: t("Cannot preview this file: {message}", { message: err.message }),
      }));
      setDetailStatus($status, t("Cannot preview “{name}”", { name: item.name }), "dirty");
      toastRequestError(t("Cannot preview “{name}”", { name: item.name }), err);
    });
  return $save;
}

function confirmDiscard(name) {
  return confirmDialog({
    title: t("Discard changes?"),
    description: t("Your unsaved changes to “{name}” will be lost.", { name }),
    cancelText: t("Keep editing"),
    confirmText: t("Discard"),
    danger: true,
  });
}

function openPdfPreview(item) {
  if (!usesSplitView()) {
    location.href = detailPageUrl(item, "pdf");
    return;
  }
  openDetailPane(item, "pdf");
}

function openTextViewer(item) {
  if (!usesSplitView()) {
    location.href = detailPageUrl(item, "view");
    return;
  }
  openDetailPane(item, "view");
}

/* ------------------------------------------------------------------------- */
/* lightbox                                                                  */
/* ------------------------------------------------------------------------- */

let lightboxOpen = false;

function openLightbox(item, options = {}) {
  if (lightboxOpen) return;
  const images = options.images || visiblePaths()
    .filter(path => !isDirType(path.path_type) && isImageName(path.name))
    .map(path => ({
      name: path.name,
      src: newUrl(path.name),
      download: newUrl(path.name),
    }));
  let index = images.findIndex(path => path.name === item.name);
  if (index === -1) {
    if (options.images) {
      index = 0;
    } else {
      images.unshift({ name: item.name, src: newUrl(item.name), download: newUrl(item.name) });
      index = 0;
    }
  }

  const $dialog = el("dialog", { class: "lightbox", "aria-label": t("Image preview") });
  const $name = el("span", { class: "lightbox-name", "aria-live": "polite" });
  const $count = el("span", { class: "lightbox-count" });
  const $download = el("button", {
    type: "button",
    class: "lightbox-btn",
    title: t("Download"),
    "aria-label": t("Download image"),
    html: ICONS.download,
  });
  const $close = el("button", {
    type: "button",
    class: "lightbox-btn",
    title: t("Close"),
    "aria-label": t("Close preview"),
    html: ICONS.close,
  });
  const $prev = el("button", {
    type: "button",
    class: "lightbox-nav prev",
    "aria-label": t("Previous image"),
    html: ICONS.chevronLeft,
  });
  const $next = el("button", {
    type: "button",
    class: "lightbox-nav next",
    "aria-label": t("Next image"),
    html: ICONS.chevronRight,
  });
  const $img = el("img", { class: "lightbox-image", alt: "", draggable: "false" });
  const $spinner = el("div", { class: "lightbox-spinner", "aria-hidden": "true" });
  const $error = el("p", { class: "lightbox-error hidden", role: "alert" });
  const $stage = el("div", { class: "lightbox-stage" }, $img, $prev, $next, $spinner, $error);
  const $head = el("div", { class: "lightbox-head" }, $name, $count, $download, $close);
  $dialog.append($head, $stage);

  const render = () => {
    const current = images[index];
    if (!current) return;
    $name.textContent = current.name;
    $name.title = current.name;
    $count.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : "";
    toggle($prev, images.length > 1);
    toggle($next, images.length > 1);
    toggle($download, !!current.download);
    $img.classList.remove("is-loaded");
    $spinner.classList.remove("hidden");
    $error.classList.add("hidden");
    $img.alt = current.name;
    $img.src = current.src;
  };

  const step = delta => {
    if (images.length < 2) return;
    index = (index + delta + images.length) % images.length;
    render();
  };

  const close = () => {
    if (!$dialog.open || $dialog.classList.contains("is-closing")) return;
    $dialog.classList.add("is-closing");
    window.setTimeout(() => {
      if ($dialog.open) $dialog.close();
    }, prefersReducedMotion() ? 0 : ANIM_MS);
  };

  let fullCoverUrl = null;
  const loadFullCover = () => {
    Promise.resolve().then(options.loadFull).then(url => {
      if (!url) return;
      if (!$dialog.open || $dialog.classList.contains("is-closing")) {
        URL.revokeObjectURL(url);
        return;
      }
      const preloader = new Image();
      preloader.onload = () => {
        if (!$dialog.open || $dialog.classList.contains("is-closing")) {
          URL.revokeObjectURL(url);
          return;
        }
        if (fullCoverUrl) URL.revokeObjectURL(fullCoverUrl);
        fullCoverUrl = url;
        const current = images[index];
        if (current) current.src = url;
        $img.src = url;
      };
      preloader.onerror = () => URL.revokeObjectURL(url);
      preloader.src = url;
    }).catch(() => { });
  };

  $img.addEventListener("load", () => {
    $img.classList.add("is-loaded");
    $spinner.classList.add("hidden");
  });
  $img.addEventListener("error", () => {
    $spinner.classList.add("hidden");
    $img.classList.remove("is-loaded");
    $error.textContent = t("Cannot load “{name}”.", { name: images[index].name });
    $error.classList.remove("hidden");
  });
  $prev.addEventListener("click", () => step(-1));
  $next.addEventListener("click", () => step(1));
  $download.addEventListener("click", () => {
    const current = images[index];
    if (current && current.download) downloadUrl(current.download);
  });
  $close.addEventListener("click", close);
  $dialog.addEventListener("cancel", event => {
    event.preventDefault();
    close();
  });
  $dialog.addEventListener("click", event => {
    if (event.target === $dialog || event.target === $stage) close();
  });
  $dialog.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    }
  });
  $dialog.addEventListener("close", () => {
    lightboxOpen = false;
    if (fullCoverUrl) {
      URL.revokeObjectURL(fullCoverUrl);
      fullCoverUrl = null;
    }
    if ($dialog.isConnected) $dialog.remove();
    popTopLayer();
  });

  let touchX = null;
  let touchY = null;
  $stage.addEventListener("touchstart", event => {
    const touch = event.changedTouches[0];
    touchX = touch.clientX;
    touchY = touch.clientY;
  }, { passive: true });
  $stage.addEventListener("touchend", event => {
    if (touchX === null) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchX;
    const dy = touch.clientY - touchY;
    touchX = null;
    touchY = null;
    if (Math.abs(dx) > LIGHTBOX_SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      step(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  document.body.append($dialog);
  pushTopLayer();
  $dialog.showModal();
  lightboxOpen = true;
  $close.focus({ preventScroll: true });
  render();
  if (typeof options.loadFull === "function") loadFullCover();
}

/* ------------------------------------------------------------------------- */
/* standalone ?edit / ?view page                                             */
/* ------------------------------------------------------------------------- */

async function setupEditorPage() {
  const url = baseUrl();
  const filePath = pathFromUrl(url);
  const fileName = basePathName(filePath);

  $editorName.textContent = fileName;
  $editorSub.textContent = DATA.kind === "Edit" ? t("Text editor") : t("Preview");
  $editorIcon.innerHTML = getPathSvg("File", fileName);

  $editorDownload.href = url;
  $editorDownload.title = t("Download file");
  $editorDownload.classList.add("dlwt");
  $editorDownload.classList.remove("hidden");

  if (DATA.kind === "Edit") {
    setupStandaloneActions(url, filePath, fileName);
  } else if (DATA.editable && DATA.allow_upload) {
    $editFileBtn.classList.remove("hidden");
    $editFileBtn.addEventListener("click", () => {
      location.href = url + "?edit";
    });
  }

  if (DATA.editable) {
    $editor.classList.remove("hidden");
    $editor.readOnly = DATA.kind !== "Edit";
    try {
      $editor.value = await fetchText(url);
      state.editorOriginal = $editor.value;
    } catch (err) {
      toastRequestError(t("Failed to get “{name}”", { name: fileName }), err);
    }
    if (DATA.kind === "Edit") {
      $saveBtn.classList.remove("hidden");
      $editorFoot.classList.remove("hidden");
      $saveBtn.addEventListener("click", saveStandalone);
      $editor.addEventListener("input", updateStandaloneDirty);
      setEditorStatus(t("No changes"), "");
      $saveBtn.disabled = true;
      document.addEventListener("keydown", event => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
        if (document.querySelector("dialog[open]")) return;
        event.preventDefault();
        if (state.editorDirty) saveStandalone();
      });
    }
    return;
  }

  const preview = formatInfoFor(fileName).preview;
  if (preview === "pdf") {
    $editorFrame.append(el("iframe", { src: url, title: fileName, loading: "lazy" }));
    $editorFrame.classList.remove("hidden");
  } else if (preview === "audio" || preview === "video") {
    $editorFrame.append(el(preview, {
      class: `editor-media editor-${preview}`,
      src: url,
      controls: true,
      preload: "metadata",
      playsinline: preview === "video" ? true : undefined,
    }));
    $editorFrame.classList.remove("hidden");
  } else {
    $notEditable.classList.remove("hidden");
    $notEditable.textContent = t("This file cannot be shown here because it is binary or too large. Use Download to open it locally.");
  }
}

function setupStandaloneActions(url, filePath, fileName) {
  $renameFileBtn.classList.remove("hidden");
  $moveFileBtn.classList.remove("hidden");
  if (filePath !== "/") $deleteFileBtn.classList.remove("hidden");

  $renameFileBtn.addEventListener("click", async () => {
    const newName = await promptRename(fileName, false);
    if (newName === null || newName === fileName) return;
    const destUrl = urlFromPath(joinPath(parentPath(filePath), newName));
    if (await performMove(url, destUrl, { name: fileName })) {
      queueToast(t("Renamed “{from}” to “{to}”", { from: fileName, to: newName }), "success");
      location.href = destUrl + location.search;
    }
  });

  $moveFileBtn.addEventListener("click", async () => {
    const result = await openMovePicker([{ name: fileName, path_type: "File", url }]);
    if (!result) return;
    queueToast(t("Moved “{name}” to {path}", { name: fileName, path: displayPath(result.dir) }), "success");
    location.href = urlFromPath(joinPath(result.dir, fileName)) + location.search;
  });

  $deleteFileBtn.addEventListener("click", async () => {
    if (filePath === "/") return;
    const choice = await confirmDelete([{ name: fileName, path_type: "File", size: 0, url }]);
    if (!choice.confirmed) return;
    try {
      await checkAuth();
      const res = await fetch(url, { method: "DELETE" });
      await assertResOK(res);
      queueToast(t("Deleted “{name}”", { name: fileName }), "success");
      location.href = dirUrlFromPath(parentPath(filePath));
    } catch (err) {
      toastRequestError(t("Cannot delete “{name}”", { name: fileName }), err);
    }
  });
}

async function saveStandalone() {
  if (state.savingStandalone || !state.editorDirty) return;
  state.savingStandalone = true;
  $saveBtn.disabled = true;
  try {
    const res = await fetch(baseUrl(), { method: "PUT", body: $editor.value });
    await assertResOK(res);
    state.editorOriginal = $editor.value;
    state.editorDirty = false;
    setEditorStatus(t("Saved"), "saved");
    showToast(t("Saved"), { type: "success" });
  } catch (err) {
    toastRequestError(t("Failed to save file"), err);
    updateStandaloneDirty();
  } finally {
    state.savingStandalone = false;
    if (state.editorDirty) $saveBtn.disabled = false;
  }
}

function updateStandaloneDirty() {
  const dirty = $editor.value !== state.editorOriginal;
  state.editorDirty = dirty;
  $saveBtn.disabled = !dirty;
  setEditorStatus(dirty ? t("Unsaved changes") : t("No changes"), dirty ? "dirty" : "");
}

function setEditorStatus(text, className) {
  $editorStatus.textContent = text;
  $editorStatus.className = "editor-status" + (className ? " " + className : "");
}

/* ------------------------------------------------------------------------- */
/* uploads                                                                   */
/* ------------------------------------------------------------------------- */

const failUploaders = new Map();
let transfersHideTimer = null;
let listingRefreshTimer = null;

class Uploader {
  constructor(file, pathParts) {
    this.name = [...pathParts, file.name].join("/");
    this.idx = Uploader.globalIdx++;
    this.file = file;
    this.url = newUrl(this.name);

    this.startTime = 0;
    this.speedRecords = 0;
    this.speedAmounts = [];
    this.speedTimes = [];
    this.currentSpeed = 0;
    this.uploadOffset = 0;
    this.uploadedSize = 0;
    this.lastUptime = 0;
    this.retrying = false;
    this.done = false;
    this.state = "queued";
    this.runningSlot = false;
    this.needsResume = false;

    this.$row = null;
    this.$status = null;
    this.$size = null;
    this.$speed = null;
    this.$eta = null;
    this.$error = null;
    this.$retry = null;
    this.$fill = null;
    this.$bar = null;
    this.$dismiss = null;
  }

  upload() {
    this.state = "queued";
    Uploader.all.push(this);

    clearTimeout(transfersHideTimer);
    $transfers.classList.remove("hidden");
    Uploader.queues.push(this);
    updateTransfersUI();
    Uploader.runQueue();
  }

  createRow() {
    const { idx, name } = this;
    this.$name = el("div", { class: "transfer-name", text: name, title: name });
    this.$status = el("span", { class: "transfer-status", text: t("Queued") });
    this.$size = el("span");
    this.$speed = el("span");
    this.$eta = el("span");
    this.$error = el("span", { class: "transfer-error" });
    this.$retry = el("button", { type: "button", class: "transfer-retry hidden", text: t("Retry") });
    this.$retry.addEventListener("click", () => this.retry());
    this.$dismiss = el("button", {
      type: "button",
      class: "transfer-dismiss hidden",
      "aria-label": t("Dismiss"),
      title: t("Dismiss"),
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>`,
    });
    this.$dismiss.addEventListener("click", () => this.dismiss());
    this.$fill = el("div", { class: "transfer-bar-fill" });
    this.$bar = el("div", {
      class: "transfer-bar",
      role: "progressbar",
      "aria-label": t("Upload progress for {name}", { name }),
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": "0",
    }, this.$fill);

    this.$row = el("div", { class: "transfer", id: `upload${idx}` },
      el("div", { class: "transfer-top" }, this.$name, this.$status),
      el("div", { class: "transfer-meta" }, this.$size, this.$speed, this.$eta, this.$error, this.$retry, this.$dismiss),
      this.$bar,
    );

    $transfersActive.prepend(this.$row);
    this.setProgress(0, formatUploadSize(0, this.file.size));
  }

  setProgress(percent, sizeText, speedText, etaText) {
    const clamped = Math.max(0, Math.min(100, percent));
    this.$fill.style.width = `${clamped}%`;
    this.$bar.setAttribute("aria-valuenow", String(Math.round(clamped)));
    if (sizeText !== undefined) this.$size.textContent = sizeText;
    if (speedText !== undefined) this.$speed.textContent = speedText;
    if (etaText !== undefined) this.$eta.textContent = etaText;
  }

  async start() {
    this.runningSlot = true;
    this.state = "uploading";
    this.createRow();
    this.$status.textContent = t("Uploading…");
    updateTransfersUI();

    if (this.needsResume) {
      this.needsResume = false;
      this.state = "checking";
      this.$status.textContent = t("Checking…");
      updateTransfersUI();
      try {
        const res = await fetch(this.url, { method: "HEAD" });
        this.uploadOffset = res.status === 200 ? (parseInt(res.headers.get("content-length"), 10) || 0) : 0;
        this.uploadedSize = this.uploadOffset;
      } catch (err) {
        this.fail(err.message || t("Network error"));
        return;
      }
      const percent = this.file.size > 0 ? (this.uploadOffset / this.file.size) * 100 : 0;
      this.setProgress(percent, formatUploadSize(this.uploadOffset, this.file.size));
      this.state = "uploading";
      this.$status.textContent = t("Uploading…");
      updateTransfersUI();
    }

    this.ajax();
  }

  ajax() {
    const { url } = this;
    this.done = false;
    this.startTime = Date.now();
    this.lastUptime = this.startTime;
    this.speedRecords = 1;
    this.speedAmounts = [0];
    this.speedTimes = [0];
    this.currentSpeed = 0;
    this.$status.textContent = t("Uploading…");
    this.$error.textContent = "";
    this.$retry.classList.add("hidden");

    const ajax = new XMLHttpRequest();
    ajax.upload.addEventListener("progress", event => this.progress(event), false);
    ajax.addEventListener("readystatechange", () => {
      if (ajax.readyState === 4) {
        if (ajax.status >= 200 && ajax.status < 300) {
          this.complete();
        } else if (ajax.status !== 0) {
          this.fail(`${ajax.status} ${ajax.statusText}`);
        }
      }
    });
    ajax.addEventListener("error", () => this.fail(t("Network error")), false);
    ajax.addEventListener("abort", () => this.fail(t("Upload aborted")), false);
    if (this.uploadOffset > 0) {
      ajax.open("PATCH", url);
      ajax.setRequestHeader("X-Update-Range", "append");
      ajax.send(this.file.slice(this.uploadOffset));
    } else {
      ajax.open("PUT", url);
      ajax.send(this.file);
    }
  }

  retry() {
    if (this.retrying) return;
    this.retrying = true;
    this.done = false;
    this.needsResume = true;
    this.state = "queued";
    failUploaders.delete(this.idx);
    if (this.$row) {
      this.$row.remove();
      this.$row = null;
    }
    Uploader.queues.unshift(this);
    updateTransfersUI();
    Uploader.runQueue();
    this.retrying = false;
  }

  progress(event) {
    const now = Date.now();
    this.calcSpeed(now - this.startTime, event.loaded);
    const uploadedSize = event.loaded + this.uploadOffset;
    this.uploadedSize = uploadedSize;
    const percent = this.file.size > 0 ? (uploadedSize / this.file.size) * 100 : 100;
    this.setProgress(percent, formatUploadSize(uploadedSize, this.file.size),
      `${formatFileSize(this.currentSpeed).join(" ")}/s`,
      formatDuration(this.currentSpeed > 0 ? (event.total - event.loaded) / this.currentSpeed : Infinity));
    updateTransfersProgress();
    if (now - this.lastUptime < 300) return;
    this.lastUptime = now;
  }

  calcSpeed(elapsed, amount) {
    const records = 6;
    const iNext = this.speedRecords % records;
    let iLatest = iNext > 0 ? iNext - 1 : records - 1;
    if (elapsed - this.speedTimes[iLatest] < 1000) return;
    this.speedRecords++;
    iLatest = iNext;
    this.speedAmounts[iLatest] = amount;
    this.speedTimes[iLatest] = elapsed;
    const iOldest = this.speedRecords < records ? 0 : (iLatest + 1) % records;
    const duration = this.speedTimes[iLatest] - this.speedTimes[iOldest];
    const delta = this.speedAmounts[iLatest] - this.speedAmounts[iOldest];
    this.currentSpeed = duration > 0 ? delta / duration * 1000 : 0;
  }

  complete() {
    if (this.done) return;
    this.done = true;
    this.retrying = false;
    this.state = "done";
    this.uploadedSize = this.file.size;
    this.$status.textContent = t("Done");
    this.$row.classList.add("is-done");
    this.$row.classList.remove("is-failed");
    this.setProgress(100, formatUploadSize(this.file.size, this.file.size), "", "");
    this.$error.textContent = "";
    this.$retry.classList.add("hidden");
    this.$dismiss.classList.add("hidden");
    failUploaders.delete(this.idx);
    releaseRunningSlot(this);
    Uploader.runQueue();
    updateTransfersUI();
    scheduleRowRemoval(this);
    scheduleTransfersHide();
    scheduleListingRefresh();
  }

  fail(reason = "") {
    if (this.done) return;
    this.done = true;
    this.retrying = false;
    this.state = "failed";
    this.$status.textContent = t("Failed");
    this.$row.classList.add("is-failed");
    this.$row.classList.remove("is-done", "is-leaving");
    this.$speed.textContent = "";
    this.$eta.textContent = "";
    this.$error.textContent = reason || t("Failed");
    this.$error.title = reason || "";
    this.$retry.classList.remove("hidden");
    this.$dismiss.classList.remove("hidden");
    $transfersFailed.append(this.$row);
    failUploaders.set(this.idx, this);
    releaseRunningSlot(this);
    Uploader.runQueue();
    updateTransfersUI();
    showToast(
      reason
        ? t("Upload failed: {name} ({reason})", { name: this.name, reason })
        : t("Upload failed: {name}", { name: this.name }),
      { type: "error", duration: 0 },
    );
  }

  dismiss() {
    failUploaders.delete(this.idx);
    this.state = "dismissed";
    this.done = true;
    Uploader.all = Uploader.all.filter(uploader => uploader !== this);
    this.$row.remove();
    updateTransfersUI();
    scheduleTransfersHide();
  }
}

Uploader.globalIdx = 0;
Uploader.runnings = 0;
Uploader.auth = false;
Uploader.queues = [];
Uploader.all = [];

const QUEUE_PREVIEW_LIMIT = 100;
let transfersQueueExpanded = false;

function releaseRunningSlot(uploader) {
  if (!uploader.runningSlot) return;
  uploader.runningSlot = false;
  Uploader.runnings = Math.max(0, Uploader.runnings - 1);
}

Uploader.runQueue = async () => {
  if (Uploader.runnings >= DUFS_MAX_UPLOADINGS) return;
  if (Uploader.queues.length === 0) return;
  Uploader.runnings++;
  const uploader = Uploader.queues.shift();
  uploader.state = "checking";
  updateTransfersUI();
  if (!Uploader.auth) {
    Uploader.auth = true;
    try {
      await checkAuth();
    } catch (err) {
      Uploader.auth = false;
    }
  }
  uploader.start();
};

function updateTransfersUI() {
  const queued = Uploader.queues;
  const total = Uploader.all.length;
  const active = Uploader.all.filter(uploader => uploader.state === "uploading" || uploader.state === "checking").length;
  const failed = failUploaders.size;
  const done = Math.max(0, total - active - queued.length - failed);

  if (active > 0) {
    $transfersStatus.textContent = t("{done} of {total} uploaded", { done, total });
  } else if (failed > 0) {
    $transfersStatus.textContent = tn("failedCount", failed, { count: failed });
  } else if (done > 0) {
    $transfersStatus.textContent = tn("uploadedCount", done, { count: done });
  } else {
    $transfersStatus.textContent = "";
  }

  $transfersFailed.classList.toggle("hidden", failed === 0);
  $transfersQueue.classList.toggle("hidden", queued.length === 0);
  if (queued.length > 0) {
    let bytes = 0;
    for (const uploader of queued) bytes += uploader.file.size;
    const label = tn("queuedCount", queued.length, { count: queued.length });
    $transfersQueueLabel.textContent = bytes > 0
      ? `${label} · ${formatFileSize(bytes).join(" ")}`
      : label;
  }
  renderTransfersQueue();
  updateTransfersProgress();
}

function renderTransfersQueue() {
  if (!transfersQueueExpanded) {
    $transfersQueueList.replaceChildren();
    return;
  }
  const queued = Uploader.queues;
  const fragment = document.createDocumentFragment();
  for (const uploader of queued.slice(0, QUEUE_PREVIEW_LIMIT)) {
    fragment.append(el("div", { class: "transfers-queue-item" },
      el("span", { class: "transfers-queue-name", text: uploader.name, title: uploader.name }),
      el("span", { class: "transfers-queue-size", text: formatFileSize(uploader.file.size).join(" ") }),
    ));
  }
  const hidden = queued.length - QUEUE_PREVIEW_LIMIT;
  if (hidden > 0) {
    fragment.append(el("div", { class: "transfers-queue-more", text: tn("moreQueued", hidden, { count: hidden }) }));
  }
  $transfersQueueList.replaceChildren(fragment);
}

function updateTransfersProgress() {
  let totalBytes = 0;
  let processedBytes = 0;
  let remaining = 0;
  for (const uploader of Uploader.all) {
    totalBytes += uploader.file.size;
    if (uploader.state === "done") {
      processedBytes += uploader.file.size;
    } else if (uploader.state === "failed") {
      processedBytes += Math.min(uploader.file.size, uploader.uploadedSize);
    } else if (uploader.state === "uploading" || uploader.state === "checking") {
      processedBytes += Math.min(uploader.file.size, uploader.uploadedSize);
      remaining++;
    } else if (uploader.state === "queued") {
      processedBytes += Math.min(uploader.file.size, uploader.uploadedSize);
      remaining++;
    }
  }
  const complete = remaining === 0 && failUploaders.size === 0 && Uploader.all.length > 0;
  const percent = totalBytes > 0 ? (processedBytes / totalBytes) * 100 : (complete ? 100 : 0);
  const clamped = Math.max(0, Math.min(100, percent));
  $transfersProgressFill.style.width = `${clamped}%`;
  $transfersProgress.setAttribute("aria-valuenow", String(Math.round(clamped)));
  $transfersProgressFill.classList.toggle("is-complete", complete);
}

function scheduleRowRemoval(uploader) {
  const row = uploader.$row;
  if (!row) return;
  // Keep at most one completed row visible: with many small files the rows
  // would otherwise pile up faster than they fade out and bury the queue.
  for (const other of $transfersActive.querySelectorAll(".transfer.is-done")) {
    if (other !== row) other.remove();
  }
  window.setTimeout(() => {
    if (!row.isConnected) return;
    row.classList.add("is-leaving");
    window.setTimeout(() => row.remove(), 200);
  }, 900);
}

function scheduleTransfersHide() {
  clearTimeout(transfersHideTimer);
  if (Uploader.runnings > 0 || Uploader.queues.length > 0 || failUploaders.size > 0) return;
  transfersHideTimer = window.setTimeout(() => {
    if (Uploader.runnings === 0 && Uploader.queues.length === 0 && failUploaders.size === 0) {
      resetTransfersUI();
    }
  }, 3200);
}

function resetTransfersUI() {
  $transfers.classList.add("hidden");
  $transfersActive.replaceChildren();
  $transfersFailed.replaceChildren();
  $transfersQueueList.replaceChildren();
  $transfersFailed.classList.add("hidden");
  $transfersQueue.classList.add("hidden");
  $transfersQueueToggle.setAttribute("aria-expanded", "false");
  $transfersQueueList.classList.add("hidden");
  transfersQueueExpanded = false;
  $transfersStatus.textContent = "";
  $transfersProgressFill.style.width = "0%";
  $transfersProgressFill.classList.remove("is-complete");
  $transfersProgress.setAttribute("aria-valuenow", "0");
  Uploader.all = [];
}

function setupTransfers() {
  $transfersQueueToggle.addEventListener("click", () => {
    transfersQueueExpanded = !transfersQueueExpanded;
    $transfersQueueToggle.setAttribute("aria-expanded", String(transfersQueueExpanded));
    $transfersQueueList.classList.toggle("hidden", !transfersQueueExpanded);
    renderTransfersQueue();
  });
}

async function findExistingUploads(targets) {
  try {
    await checkAuth();
  } catch (err) {
    return [];
  }
  const existing = [];
  let next = 0;
  const workers = Math.min(6, targets.length);
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++];
      try {
        const res = await fetch(target.url, { method: "HEAD", cache: "no-store" });
        if (res.status !== 200) continue;
        const length = parseInt(res.headers.get("content-length"), 10);
        // An empty file has nothing to lose, and dufs allows replacing it
        // without delete permission.
        if (!Number.isFinite(length) || length > 0) existing.push(target);
      } catch (err) { }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return existing;
}

async function queueUploads(entries) {
  if (entries.length === 0) return;
  const targets = entries.map(({ file, dirs }) => ({
    file,
    dirs,
    url: newUrl([...dirs, file.name].join("/")),
  }));

  const $checking = targets.length > 10
    ? showToast(t("Checking existing files…"), { duration: 0 })
    : null;
  const existing = await findExistingUploads(targets);
  if ($checking) dismissToast($checking);

  let toUpload = targets;
  if (existing.length > 0) {
    const replace = await confirmDialog({
      title: t("Replace existing files?"),
      description: t("Some files already exist: {count} of {total}. Replace them, or skip them and upload the rest?", { count: existing.length, total: targets.length }),
      confirmText: t("Replace all"),
      cancelText: t("Skip all"),
      danger: true,
    });
    if (!replace) {
      const existingUrls = new Set(existing.map(target => target.url));
      toUpload = targets.filter(target => !existingUrls.has(target.url));
      showToast(tn("skippedExistingCount", existing.length, { count: existing.length }));
    }
  }

  for (const target of toUpload) new Uploader(target.file, target.dirs).upload();
}

function scheduleListingRefresh() {
  if (DATA.kind !== "Index") return;
  clearTimeout(listingRefreshTimer);
  listingRefreshTimer = window.setTimeout(() => {
    if (Uploader.runnings === 0 && Uploader.queues.length === 0) refreshListing();
  }, 600);
}

/* ------------------------------------------------------------------------- */
/* drag and drop upload                                                      */
/* ------------------------------------------------------------------------- */

function canDrop() {
  return DATA.kind === "Index" && !!DATA.allow_upload;
}

function hasFiles(event) {
  return !!(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files"));
}

function setupDropzone() {
  let dragDepth = 0;

  // Dragging an <img> would also populate dataTransfer.types with "Files" and
  // make the upload overlay look like an external file drop.
  document.addEventListener("dragstart", event => {
    if (event.target instanceof HTMLImageElement) event.preventDefault();
  }, true);

  document.addEventListener("dragenter", event => {
    if (!canDrop() || !hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    if (dragDepth === 1) $dropzone.classList.remove("hidden");
  });

  document.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (canDrop() && event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  document.addEventListener("dragleave", () => {
    if (!canDrop()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $dropzone.classList.add("hidden");
  });

  document.addEventListener("dragend", () => {
    dragDepth = 0;
    $dropzone.classList.add("hidden");
  });

  document.addEventListener("drop", async event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    $dropzone.classList.add("hidden");
    if (!canDrop()) return;
    const dt = event.dataTransfer;
    const items = Array.from(dt.items || []);
    if (items.length && items[0].webkitGetAsEntry) {
      const entries = items.map(item => item.webkitGetAsEntry()).filter(Boolean);
      queueUploads(await collectFileEntries(entries, []));
    } else {
      const files = Array.from(dt.files || []).filter(file => file.size > 0);
      queueUploads(files.map(file => ({ file, dirs: [] })));
    }
  });
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntryDirectory(entry) {
  return new Promise(resolve => {
    const reader = entry.createReader();
    const children = [];
    const readBatch = () => {
      reader.readEntries(batch => {
        if (batch.length === 0) {
          resolve(children);
          return;
        }
        children.push(...batch);
        readBatch();
      }, () => resolve(children));
    };
    readBatch();
  });
}

async function collectFileEntries(entries, dirs, collected = []) {
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.isFile) {
      try {
        collected.push({ file: await readEntryFile(entry), dirs });
      } catch (err) { }
    } else if (entry.isDirectory) {
      const children = await readEntryDirectory(entry);
      await collectFileEntries(children, [...dirs, entry.name], collected);
    }
  }
  return collected;
}
