/* SPDX-License-Identifier: AGPL-3.0-only */

/**
 * Lazy EPUB/CBZ covers for the grid view.
 *
 * EPUB and CBZ are ZIP archives. Downloading every book to show its cover
 * would be wasteful on an e-reader, so this module reads the ZIP central
 * directory, the EPUB package document (or the first CBZ image) and the cover
 * image through HTTP Range requests. Parsing and image decoding happen in the
 * browser; dufs only serves the requested byte ranges. Extracted JPEG
 * thumbnails are cached under the path supplied by UI_PATHS (KOReader's
 * cache/dufs when available).
 */

"use strict";

const EpubCovers = (() => {
  const MAX_CONCURRENT = 2;
  const TAIL_BYTES = 128 * 1024;
  const MAX_CENTRAL_DIRECTORY = 4 * 1024 * 1024;
  const MAX_ENTRY_SIZE = 8 * 1024 * 1024;
  const LOCAL_PADDING = 1024;
  const COVER_DOWNSCALE_TIMEOUT = 1500;
  const COVER_CACHE_DIR = ".dufs/covers";
  const COVER_CACHE_VERSION = "v1";
  const PDFJS_VERSION = "6.5.438";

  const EOCD_SIG = 0x06054b50;
  const CENTRAL_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;
  const ZIP64_MARKER_16 = 0xffff;
  const ZIP64_MARKER_32 = 0xffffffff;

  const IMAGE_EXTENSIONS = [
    ".jpg", ".jpeg", ".jfif", ".png", ".gif", ".webp", ".svg", ".bmp", ".avif",
  ];

  const done = new Map();
  const loads = new Map();
  const queue = [];
  let running = 0;
  let observer = null;
  let observed = new WeakMap();
  let cacheDirPromise = null;
  let pdfjsPromise = null;

  const supported = typeof window.fetch === "function"
    && typeof window.DOMParser === "function";
  const zipSupported = supported
    && typeof window.DecompressionStream === "function";

  /**
   * Attach a lazy cover to a grid tile. The tile keeps its normal file icon
   * until the cover has decoded, and on any error simply stays unchanged.
   */
  function coverRequest(item, url) {
    if (!supported || !item) return null;
    const size = Number(item.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    const name = String(item.name).toLowerCase();
    const format = name.endsWith(".cbz") ? "cbz" : name.endsWith(".pdf") ? "pdf" : "epub";
    if (format !== "pdf" && !zipSupported) return null;
    return {
      key: `${url}\n${size}\n${item.mtime || 0}${format === "pdf" ? `\npdfjs:${PDFJS_VERSION}` : ""}`,
      url,
      size,
      format,
    };
  }

  function attach($icon, item, url) {
    if (!$icon) return;
    const request = coverRequest(item, url);
    if (!request) return;
    const { key } = request;
    if (done.has(key)) {
      const coverUrl = done.get(key);
      if (coverUrl) applyCover($icon, coverUrl);
      return;
    }
    if (loads.has(key)) {
      loads.get(key).then(coverUrl => {
        if (coverUrl) applyCover($icon, coverUrl);
      });
      return;
    }

    observe($icon, () => {
      ensureLoad(request.key, request.url, request.size, request.format).then(coverUrl => {
        if (coverUrl) applyCover($icon, coverUrl);
      });
    });
  }

  function load(item, url) {
    const request = coverRequest(item, url);
    if (!request) return Promise.resolve(null);
    return ensureLoad(request.key, request.url, request.size, request.format);
  }

  function loadFull(item, url) {
    const request = coverRequest(item, url);
    if (!request) return Promise.resolve(null);
    return extractCover(request.url, request.size, true, request.format)
      .then(blob => blob ? URL.createObjectURL(blob) : null)
      .catch(() => null);
  }

  function observe($icon, callback) {
    if (typeof window.IntersectionObserver !== "function") {
      callback();
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          const run = observed.get(entry.target);
          observed.delete(entry.target);
          if (run) run();
        }
      }, { rootMargin: "160px 0px" });
    }
    observed.set($icon, callback);
    observer.observe($icon);
  }

  function reset() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    observed = new WeakMap();
  }

  function ensureLoad(key, url, size, format) {
    if (done.has(key)) return Promise.resolve(done.get(key));
    if (loads.has(key)) return loads.get(key);

    const promise = new Promise((resolve, reject) => {
      queue.push({ key, url, size, format, resolve, reject });
      pump();
    }).then(blob => {
      const coverUrl = blob ? URL.createObjectURL(blob) : null;
      done.set(key, coverUrl);
      return coverUrl;
    }, () => {
      done.set(key, null);
      return null;
    });

    loads.set(key, promise);
    return promise;
  }

  function pump() {
    while (running < MAX_CONCURRENT && queue.length > 0) {
      const task = queue.shift();
      running++;
      loadCoverBlob(task.key, task.url, task.size, task.format)
        .then(task.resolve, task.reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  async function loadCoverBlob(key, url, size, format) {
    const cacheUrl = coverCacheUrl(key);
    if (cacheUrl) {
      const cached = await readCachedCover(cacheUrl);
      if (cached) return cached;
    }
    const blob = await extractCover(url, size, false, format);
    if (blob && cacheUrl) cacheCover(cacheUrl, blob).catch(() => { });
    return blob;
  }

  function cacheRootUrl() {
    const prefix = (window.DATA && window.DATA.uri_prefix) || "/";
    const root = new URL(prefix.endsWith("/") ? prefix : prefix + "/", location.origin);
    const cachePath = (window.DUFS_UI_PATHS && window.DUFS_UI_PATHS.cache)
      || `${COVER_CACHE_DIR}/`;
    return new URL(cachePath, root).toString();
  }

  function coverCacheUrl(key) {
    return new URL(
      `${hashString(`${COVER_CACHE_VERSION}\n${key}`)}.jpg`,
      cacheRootUrl(),
    ).toString();
  }

  function hashString(value) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return (first >>> 0).toString(16).padStart(8, "0")
      + (second >>> 0).toString(16).padStart(8, "0");
  }

  async function readCachedCover(url) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob.size > 0 && blob.type.startsWith("image/") ? blob : null;
    } catch {
      return null;
    }
  }

  function cacheCover(url, blob) {
    if (!window.DATA || !window.DATA.allow_upload || blob.type !== "image/jpeg") {
      return Promise.resolve();
    }
    return ensureCacheDir()
      .then(() => fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
        credentials: "same-origin",
      }))
      .catch(() => { });
  }

  function ensureCacheDir() {
    if (!cacheDirPromise) {
      cacheDirPromise = fetch(cacheRootUrl(), {
        method: "MKCOL",
        credentials: "same-origin",
      }).catch(() => { });
    }
    return cacheDirPromise;
  }

  function applyCover($icon, coverUrl) {
    if ($icon.classList.contains("has-cover") || $icon.classList.contains("is-cover-loading")) return;

    const $img = document.createElement("img");
    $img.className = "thumb is-cover";
    $img.alt = "";
    $img.loading = "lazy";
    $img.decoding = "async";
    $img.draggable = false;
    $img.addEventListener("load", () => {
      $icon.replaceChildren($img);
      $icon.classList.remove("is-cover-loading");
      $icon.classList.add("has-cover");
    }, { once: true });
    $img.addEventListener("error", () => {
      $img.remove();
      $icon.classList.remove("is-cover-loading");
    }, { once: true });
    $icon.classList.add("is-cover-loading");
    $icon.append($img);
    $img.src = coverUrl;
  }

  /* ----------------------------------------------------------------------- */
  /* PDF covers via PDF.js                                                   */
  /* ----------------------------------------------------------------------- */

  function assetBaseUrl() {
    const prefix = document.querySelector('meta[name="dufs-assets-prefix"]')?.content || "/";
    const base = new URL(prefix || "/", location.origin);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return base;
  }

  function pdfjsAssetUrl(file, versioned = true) {
    const suffix = versioned ? `?v=${PDFJS_VERSION}` : "";
    return new URL(`pdfjs/${file}${suffix}`, assetBaseUrl()).href;
  }

  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(pdfjsAssetUrl("pdf.min.mjs")).then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfjsAssetUrl("pdf.worker.min.mjs");
        return pdfjs;
      }).catch(err => {
        pdfjsPromise = null;
        throw err;
      });
    }
    return pdfjsPromise;
  }

  async function renderPdfCover(url, full) {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      url,
      withCredentials: true,
      rangeChunkSize: 65536,
      disableAutoFetch: true,
      standardFontDataUrl: pdfjsAssetUrl("standard_fonts/", false),
      cMapUrl: pdfjsAssetUrl("cmaps/", false),
      cMapPacked: true,
    });
    let pdf = null;
    try {
      pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const maxSide = full ? 1600 : 320;
      const scale = Math.min(full ? 3 : 2, maxSide / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas 2D is unavailable");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();
      return await canvasBlob(canvas, "image/jpeg", full ? 0.9 : 0.82);
    } finally {
      try {
        await loadingTask.destroy();
      } catch (err) { }
    }
  }

  /* ----------------------------------------------------------------------- */
  /* EPUB / CBZ / ZIP parsing                                                */
  /* ----------------------------------------------------------------------- */

  async function extractCover(url, size, full = false, format = "epub") {
    if (format === "pdf") return renderPdfCover(url, full);

    const entries = await readCentralDirectory(url, size);
    if (format === "cbz") {
      const cover = findCbzCover(entries);
      if (!cover) throw new Error("CBZ has no image pages");
      const data = await readEntry(url, size, entries, cover.path);
      const type = mimeFromName(cover.path) || "image/jpeg";
      return makeCoverBlob(data, type, full);
    }

    const containerBytes = await readEntry(url, size, entries, "META-INF/container.xml");
    const containerDoc = parseXml(decodeUtf8(containerBytes));
    const rootfile = elements(containerDoc, "rootfile")[0];
    const opfHref = rootfile && rootfile.getAttribute("full-path");
    if (!opfHref) throw new Error("EPUB has no package document");

    const opfPath = normalizeZipPath(decodeHref(opfHref));
    const opfDoc = parseXml(decodeUtf8(await readEntry(url, size, entries, opfPath)));
    const cover = findCover(opfDoc, opfPath, entries);
    if (!cover) throw new Error("EPUB has no cover image");

    const data = await readEntry(url, size, entries, cover.path);
    const type = cover.mediaType || mimeFromName(cover.path) || "image/jpeg";
    return makeCoverBlob(data, type, full);
  }

  function findCbzCover(entries) {
    const images = [];
    const seen = new Set();
    for (const [name, entry] of entries) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (!isImageName(name)) continue;
      if (name.toLowerCase().startsWith("__macosx/")) continue;
      if (name.split("/").some(part => part.startsWith("."))) continue;
      images.push({ path: name });
    }
    if (!images.length) return null;

    const compare = (a, b) => a.path.localeCompare(b.path, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    const named = images.filter(item => /(^|\/)cover\.[^/]+$/i.test(item.path)).sort(compare);
    if (named.length) return named[0];
    images.sort(compare);
    return images[0];
  }

  async function makeCoverBlob(data, type, full = false) {
    const blob = new Blob([data], { type });
    if (full || type === "image/svg+xml" || typeof window.createImageBitmap !== "function") {
      return blob;
    }

    const scaled = await withTimeout(
      downscaleCover(blob).catch(() => null),
      COVER_DOWNSCALE_TIMEOUT,
    );
    return scaled || blob;
  }

  function withTimeout(promise, ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), ms);
      promise.then(value => {
        clearTimeout(timer);
        resolve(value);
      }, () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  async function downscaleCover(blob) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        bitmap.close();
        return null;
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      bitmap = null;

      return await canvasBlob(canvas, "image/jpeg");
    } catch {
      if (bitmap) bitmap.close();
      return null;
    }
  }

  function canvasBlob(canvas, type, quality = 0.82) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }

  async function readCentralDirectory(url, size) {
    const tailLength = Math.min(size, TAIL_BYTES);
    const tailStart = size - tailLength;
    const tail = await fetchRange(url, tailStart, size - 1);
    const eocd = findEndOfCentralDirectory(tail);
    if (eocd < 0) throw new Error("ZIP end record not found");

    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const entriesCount = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (entriesCount === ZIP64_MARKER_16
      || centralSize === ZIP64_MARKER_32
      || centralOffset === ZIP64_MARKER_32) {
      throw new Error("ZIP64 archives are not supported");
    }
    if (centralSize === 0 || centralSize > MAX_CENTRAL_DIRECTORY) {
      throw new Error("Invalid ZIP central directory");
    }
    if (centralOffset + centralSize > size) {
      throw new Error("ZIP central directory is out of bounds");
    }

    let central;
    const inTail = centralOffset - tailStart;
    if (inTail >= 0 && inTail + centralSize <= tail.length) {
      central = tail.subarray(inTail, inTail + centralSize);
    } else {
      central = await fetchRange(url, centralOffset, centralOffset + centralSize - 1);
    }
    return parseCentralDirectory(central);
  }

  function findEndOfCentralDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const min = Math.max(0, bytes.length - (22 + 0xffff));
    for (let offset = bytes.length - 22; offset >= min; offset--) {
      if (view.getUint32(offset, true) !== EOCD_SIG) continue;
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength <= bytes.length) return offset;
    }
    return -1;
  }

  function parseCentralDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder("utf-8");
    const entries = new Map();
    let offset = 0;

    while (offset + 46 <= bytes.length) {
      if (view.getUint32(offset, true) !== CENTRAL_SIG) break;

      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > bytes.length) break;

      if (compressedSize === ZIP64_MARKER_32
        || uncompressedSize === ZIP64_MARKER_32
        || localOffset === ZIP64_MARKER_32) {
        throw new Error("ZIP64 archives are not supported");
      }

      const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
      if (name && !name.endsWith("/")) {
        const entry = { flags, method, compressedSize, uncompressedSize, localOffset };
        entries.set(name, entry);
        const normalized = normalizeZipPath(name);
        if (normalized !== name) entries.set(normalized, entry);
      }
      offset = nameEnd + extraLength + commentLength;
    }

    if (entries.size === 0) throw new Error("ZIP has no entries");
    return entries;
  }

  async function readEntry(url, size, entries, path) {
    const entry = findEntry(entries, path);
    if (!entry) throw new Error(`ZIP entry not found: ${path}`);
    if (entry.flags & 1) throw new Error("Encrypted ZIP entries are not supported");
    if (entry.compressedSize > MAX_ENTRY_SIZE || entry.uncompressedSize > MAX_ENTRY_SIZE) {
      throw new Error("ZIP entry is too large");
    }

    const localStart = entry.localOffset;
    if (localStart + 30 > size) throw new Error("Invalid ZIP entry offset");
    const paddedEnd = Math.min(size - 1, localStart + 30 + LOCAL_PADDING + entry.compressedSize);
    const local = await fetchRange(url, localStart, paddedEnd);
    const view = new DataView(local.buffer, local.byteOffset, local.byteLength);
    if (view.getUint32(0, true) !== LOCAL_SIG) throw new Error("Invalid ZIP local header");

    const localMethod = view.getUint16(8, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const dataStart = 30 + nameLength + extraLength;
    let compressed;

    if (dataStart + entry.compressedSize <= local.length) {
      compressed = local.subarray(dataStart, dataStart + entry.compressedSize);
    } else {
      const dataEnd = localStart + dataStart + entry.compressedSize;
      if (dataEnd > size) throw new Error("ZIP entry is out of bounds");
      compressed = entry.compressedSize > 0
        ? await fetchRange(url, localStart + dataStart, dataEnd - 1)
        : new Uint8Array();
    }

    if (entry.compressedSize === 0) return new Uint8Array();
    return await inflateEntry(compressed, localMethod);
  }

  function findEntry(entries, path) {
    if (entries.has(path)) return entries.get(path);
    const lower = path.toLowerCase();
    for (const [name, entry] of entries) {
      if (name.toLowerCase() === lower) return entry;
    }
    return null;
  }

  async function inflateEntry(data, method) {
    if (method === 0) return data;
    if (method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}`);
    if (typeof window.DecompressionStream !== "function") {
      throw new Error("Deflate decompression is not supported");
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* ----------------------------------------------------------------------- */
  /* EPUB package helpers                                                    */
  /* ----------------------------------------------------------------------- */

  function elements(root, name) {
    const direct = root.getElementsByTagName(name);
    if (direct.length > 0) return Array.from(direct);
    return Array.from(root.getElementsByTagNameNS("*", name));
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (!doc || elements(doc, "parsererror").length > 0) {
      throw new Error("Invalid EPUB XML");
    }
    return doc;
  }

  function findCover(doc, opfPath, entries) {
    const items = elements(doc, "item").map(item => ({
      id: item.getAttribute("id") || "",
      href: item.getAttribute("href") || "",
      mediaType: item.getAttribute("media-type") || "",
      properties: item.getAttribute("properties") || "",
    }));
    const byId = new Map();
    const imageItems = [];
    for (const item of items) {
      if (item.id) byId.set(item.id, item);
      if (isImageItem(item)) imageItems.push(item);
    }

    const candidates = [];
    const $meta = elements(doc, "meta")
      .find(meta => meta.getAttribute("name") === "cover");
    if ($meta) {
      const item = byId.get($meta.getAttribute("content"));
      if (item) candidates.push(item);
    }
    for (const item of items) {
      if (item.properties.split(/\s+/).includes("cover-image")) candidates.push(item);
    }
    const $guide = elements(doc, "reference")
      .find(ref => (ref.getAttribute("type") || "").toLowerCase() === "cover");
    if ($guide) {
      const href = $guide.getAttribute("href");
      if (href) {
        const path = resolveZipPath(dirname(opfPath), href);
        if (isImageName(path) && findEntry(entries, path)) {
          candidates.push({ href, mediaType: "" });
        }
      }
    }
    for (const item of imageItems) {
      if (/cover/i.test(item.id) || /cover/i.test(item.href)) candidates.push(item);
    }
    candidates.push(...imageItems);

    const seen = new Set();
    for (const item of candidates) {
      if (!item.href) continue;
      const path = resolveZipPath(dirname(opfPath), item.href);
      if (seen.has(path)) continue;
      seen.add(path);
      if (!item.mediaType.toLowerCase().startsWith("image/") && !isImageName(path)) continue;
      if (!findEntry(entries, path)) continue;
      return { path, mediaType: item.mediaType };
    }
    return null;
  }

  function isImageItem(item) {
    return item.mediaType.toLowerCase().startsWith("image/") || isImageName(item.href);
  }

  function isImageName(name) {
    const lower = name.toLowerCase();
    return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  function mimeFromName(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".bmp")) return "image/bmp";
    if (lower.endsWith(".avif")) return "image/avif";
    if (lower.endsWith(".jfif")) return "image/jpeg";
    return "image/jpeg";
  }

  function dirname(path) {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
  }

  function decodeHref(href) {
    try {
      return decodeURIComponent(href);
    } catch {
      return href;
    }
  }

  function resolveZipPath(baseDir, href) {
    const clean = decodeHref(href.split("#")[0].split("?")[0]).replace(/\\/g, "/");
    if (clean.startsWith("/")) return normalizeZipPath(clean);
    return normalizeZipPath(baseDir ? `${baseDir}/${clean}` : clean);
  }

  function normalizeZipPath(path) {
    const parts = [];
    for (const part of path.replace(/\\/g, "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  }

  function decodeUtf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  /* ----------------------------------------------------------------------- */
  /* HTTP                                                                    */
  /* ----------------------------------------------------------------------- */

  async function fetchRange(url, start, end) {
    if (start < 0 || end < start) throw new Error("Invalid byte range");
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      credentials: "same-origin",
    });
    if (res.status === 206) {
      return new Uint8Array(await res.arrayBuffer());
    }
    if (res.status === 200) {
      // The server ignored Range. Do not pull a whole book into memory.
      if (res.body) res.body.cancel().catch(() => { });
      throw new Error("Server does not support byte ranges");
    }
    throw new Error(`Range request failed: ${res.status}`);
  }

  return { attach, load, loadFull, reset };
})();

window.EpubCovers = EpubCovers;
