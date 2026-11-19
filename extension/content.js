// Bilibili Screenshot - content script (dedicated bilibili.com build, based on the Bilibili Screenshot codebase)
// Capture modes:
//  clean (default): draw the current <video> frame to a canvas at the video's native
//    resolution. No player controls, no subtitles, no letterbox bars (the short side is
//    whatever the video itself is). Silent, and does not pause playback.
//  visible (WYSIWYG): ask the background to take a captureVisibleTab screenshot of the
//    viewport, then crop it to the video element's position. Subtitles on screen are
//    included, but resolution is limited by the screen/window size.
// If clean is blocked by the browser (canvas flagged as cross-origin tainted), it falls
// back to visible automatically.
//
// See CHANGELOG.md for release notes.

(function () {
  "use strict";

  // Each injection gets an instance id. The newest instance in a page takes over; older
  // ones (duplicate injections / orphaned scripts after an extension reload) notice they
  // are stale and tear themselves down, so two copies never fight over the button or
  // messages.
  const INSTANCE = Date.now() + "-" + Math.random().toString(36).slice(2);
  window.__biliInstance = INSTANCE;

  // Dedicated bilibili.com build: SITE is always "bilibili" (kept as a
  // constant because the title lookup and filename fallback branch on it).
  // The frame-capture core is site-agnostic (it draws the largest <video>);
  // only the title lookup and the player-button injection are site-specific.
  const SITE = "bilibili";

  // Localized strings come from lang.js (generated from _locales), so the
  // Settings language override applies in the page too. chrome.i18n is kept
  // as a fallback in case lang.js is missing (e.g. an older injection path).
  let curLang = "en";
  if (typeof biliResolveLang === "function") {
    try {
      curLang = biliResolveLang("auto");
    } catch (e) {}
  }
  function t(key, ...subs) {
    if (typeof biliT === "function") {
      const s = biliT(curLang, key, subs);
      if (s) return s;
    }
    try {
      return chrome.i18n.getMessage(key, subs.map(String)) || key;
    } catch (e) {
      return key; // extension context invalidated (extension was reloaded)
    }
  }

  function refreshButtonLabels() {
    document.querySelectorAll(".bili-capture-btn").forEach((b) => {
      b.title = t("btnTitle");
      b.setAttribute("aria-label", t("btnAria"));
    });
  }

  const DEFAULT_SETTINGS = {
    format: "png", // png | jpeg | webp
    quality: 0.92, // jpeg/webp quality 0.1-1
    afterCapture: "preview", // preview | download | copy
    captureMode: "clean" // clean | visible
  };

  let settings = { ...DEFAULT_SETTINGS };
  let capturing = false;
  let currentPreview = null;
  let toastTimer = null;
  let observer = null;
  let scheduled = null;
  let resizeObserver = null;
  let settleTimer = null;
  let pollTimer = null;

  function contextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function isCurrent() {
    return window.__biliInstance === INSTANCE && contextValid();
  }

  async function loadSettings() {
    if (!contextValid()) return;
    try {
      const data = await chrome.storage.local.get(["settings", "uiLanguage"]);
      settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      if (typeof biliResolveLang === "function") {
        const next = biliResolveLang(data.uiLanguage || "auto");
        if (next !== curLang) {
          curLang = next;
          refreshButtonLabels();
        }
      }
    } catch (e) {}
  }

  // ---------- Helpers ----------
  // A page can have several <video> elements (hover previews, miniplayer, preloaded
  // clips...). Prefer the one that has a picture and the largest visible area.
  function getVideo() {
    const all = Array.from(document.querySelectorAll("video"));
    const ready = all.filter((v) => v.videoWidth > 0 && v.videoHeight > 0);
    const pool = ready.length ? ready : all;
    let best = null;
    let bestScore = -1;
    for (const v of pool) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const score =
        w * h +
        (v.closest && v.closest(".bpx-player-video-wrap, .bilibili-player-video, #bilibili-player") ? 0.5 : 0);
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function timeForName(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h > 0 ? pad(h) + "-" : "") + pad(m) + "-" + pad(s);
  }

  function timeForDisplay(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
  }

  function sanitize(name) {
    return (
      (name || SITE)
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80)
        .trim() || SITE
    );
  }

  function getTitle() {
    const el =
      document.querySelector("h1.video-title") ||
      document.querySelector(".video-title") ||
      document.querySelector(".media-title") ||
      document.querySelector("#viewbox_report h1") ||
      document.querySelector("h1");
    let bt = el && el.textContent ? el.textContent.trim() : "";
    if (!bt) {
      // Tab titles look like "Title_哔哩哔哩_bilibili" or "Title - 哔哩哔哩"
      bt = document.title
        .replace(/^\(\d+\)\s*/, "")
        .replace(/[_\-\s]*哔哩哔哩.*$/, "")
        .replace(/\s*[-_|]\s*bilibili\s*$/i, "")
        .trim();
    }
    return sanitize(bt);
  }

  // The extension follows the format the browser actually encoded (some browsers can't
  // encode WebP and silently fall back to PNG)
  function extFromType(type) {
    if (type === "image/jpeg") return "jpg";
    if (type === "image/webp") return "webp";
    return "png";
  }

  function buildFilename(video, ext) {
    const date = new Date();
    const stamp =
      date.getFullYear() +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      "_" +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds());
    return (
      getTitle() + "_" + timeForName(video ? video.currentTime : 0) + "_" + stamp + "." + ext
    );
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      const type = "image/" + settings.format;
      const q = settings.format === "png" ? undefined : settings.quality;
      try {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("toBlob-null"))),
          type,
          q
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  // Wait n rendered frames. rAF doesn't fire in background/hidden tabs, so there is a
  // timeout fallback.
  function nextFrames(n) {
    return new Promise((resolve) => {
      let left = n;
      const timer = setTimeout(resolve, 150);
      (function step() {
        requestAnimationFrame(() => {
          left -= 1;
          if (left <= 0) {
            clearTimeout(timer);
            resolve();
          } else {
            step();
          }
        });
      })();
    });
  }

  // ---------- Frame capture ----------
  function captureCleanCanvas(video) {
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("video-not-ready");
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // If the video source is treated as cross-origin the canvas is "tainted" and reading
    // pixels throws a SecurityError, which makes the caller fall back to visible mode.
    // Reading a single pixel is enough to detect it. Don't probe with toDataURL: on a 4K
    // frame that encodes a whole PNG just for the test and freezes the main thread.
    ctx.getImageData(0, 0, 1, 1);
    return canvas;
  }

  async function captureVisibleCanvas(video) {
    // Hide any previous toast/preview and wait a frame or two so they don't end up in
    // this screenshot
    const root = document.documentElement;
    root.classList.add("bili-capturing");
    let res;
    let rect;
    try {
      await nextFrames(2);
      rect = video.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) throw new Error("video-not-visible");
      res = await chrome.runtime.sendMessage({ type: "bili-capture-visible" });
    } finally {
      root.classList.remove("bili-capturing");
    }
    if (!res || !res.ok || !res.dataUrl) {
      throw new Error((res && res.error) || "capture-visible-failed");
    }
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = res.dataUrl;
    });
    // The captured image is CSS viewport size x zoom in pixels; scaling by the ratio is
    // the most reliable way to map the video rect onto it
    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;
    const sx = Math.max(0, Math.round(rect.left * scaleX));
    const sy = Math.max(0, Math.round(rect.top * scaleY));
    const sw = Math.min(img.naturalWidth - sx, Math.round(rect.width * scaleX));
    const sh = Math.min(img.naturalHeight - sy, Math.round(rect.height * scaleY));
    if (sw < 2 || sh < 2) throw new Error("video-out-of-viewport");
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  async function captureCanvas(video) {
    if (settings.captureMode === "visible") {
      return { canvas: await captureVisibleCanvas(video), mode: "visible" };
    }
    try {
      return { canvas: captureCleanCanvas(video), mode: "clean" };
    } catch (e) {
      // Fall back to WYSIWYG
      return { canvas: await captureVisibleCanvas(video), mode: "visible-fallback" };
    }
  }

  // ---------- Actions: download / copy / preview ----------
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Clipboard writes require the page document to have focus. When triggered from the
  // toolbar popup, the popup has just closed and focus hasn't returned to the page yet,
  // so a direct write would be rejected. Wait for focus first.
  function waitForFocus(ms) {
    return new Promise((resolve) => {
      if (document.hasFocus()) return resolve(true);
      const done = () => {
        clearTimeout(timer);
        window.removeEventListener("focus", done);
        resolve(document.hasFocus());
      };
      const timer = setTimeout(done, ms);
      window.addEventListener("focus", done);
    });
  }

  async function copyBlob(blob, canvas) {
    await waitForFocus(1500);
    // Chrome's clipboard only reliably supports PNG; if the format isn't PNG, re-encode
    // a PNG copy from the canvas
    let pngBlob = blob;
    if (blob.type !== "image/png") {
      pngBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob-null"))),
          "image/png"
        );
      });
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  }

  // In fullscreen only the fullscreen element's subtree is visible, so anything attached
  // under <html> (toast / preview) would be hidden behind it
  function overlayRoot() {
    const fs = document.fullscreenElement;
    if (fs && !/^(VIDEO|IFRAME|IMG|CANVAS)$/i.test(fs.tagName)) return fs;
    return document.documentElement;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function closePreview() {
    if (currentPreview) {
      const w = currentPreview;
      currentPreview = null;
      if (w._dismiss) w._dismiss();
      else w.remove();
    }
  }

  function showPreview(blob, canvas, filename, metaText) {
    closePreview(); // close the previous preview (the outer function)
    const url = URL.createObjectURL(blob);
    const wrap = document.createElement("div");
    wrap.className = "bili-preview-wrap";
    wrap.innerHTML =
      '<div class="bili-preview-card">' +
      '<div class="bili-preview-head"><span>' +
      escapeHtml(metaText) +
      '</span><button class="bili-dialog-btn bili-close" type="button">' +
      escapeHtml(t("btnClose")) +
      "</button></div>" +
      '<img class="bili-preview-img" alt="' +
      escapeHtml(t("previewAlt")) +
      '">' +
      '<div class="bili-preview-actions">' +
      '<button class="bili-dialog-btn bili-save" type="button">' +
      escapeHtml(t("btnSave")) +
      "</button>" +
      '<button class="bili-dialog-btn bili-copy" type="button">' +
      escapeHtml(t("btnCopy")) +
      "</button>" +
      "</div></div>";
    wrap.querySelector(".bili-preview-img").src = url;

    // Note: this inner function must NOT also be called closePreview. A same-named inner
    // function declaration is hoisted and shadows the outer closePreview, so the call on
    // the first line would touch the not-yet-initialized wrap/url and throw.
    function dismiss() {
      wrap.remove();
      URL.revokeObjectURL(url);
    }
    wrap._dismiss = dismiss;

    wrap.querySelector(".bili-close").addEventListener("click", closePreview);
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) closePreview();
    });
    wrap.querySelector(".bili-save").addEventListener("click", () => {
      downloadBlob(blob, filename);
      toast(t("toastSaved", filename));
    });
    wrap.querySelector(".bili-copy").addEventListener("click", async () => {
      try {
        await copyBlob(blob, canvas);
        toast(t("toastCopied"));
      } catch (e) {
        toast(t("toastCopyDenied"), true);
      }
    });
    overlayRoot().appendChild(wrap);
    currentPreview = wrap;
  }

  function toast(text, isError) {
    let el = document.querySelector(".bili-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "bili-toast";
    }
    const root = overlayRoot();
    if (el.parentNode !== root) root.appendChild(el);
    el.textContent = text;
    el.classList.toggle("bili-toast-error", !!isError);
    el.classList.add("bili-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("bili-toast-show"), 2600);
  }

  // ---------- Main entry ----------
  async function doCapture(videoArg) {
    if (capturing) return { ok: false, error: "busy" };
    const video = videoArg || getVideo();
    if (!video) {
      toast(t("toastNoVideo"), true);
      return { ok: false, error: "no-video" };
    }
    if (!video.videoWidth) {
      toast(t("toastNotReady"), true);
      return { ok: false, error: "video-not-ready" };
    }
    capturing = true;
    try {
      await loadSettings();
      const { canvas, mode } = await captureCanvas(video);
      const blob = await canvasToBlob(canvas);
      const filename = buildFilename(video, extFromType(blob.type));
      const meta =
        getTitle() +
        " · " +
        timeForDisplay(video.currentTime) +
        " · " +
        canvas.width +
        "×" +
        canvas.height +
        " · " + (mode === "clean" ? t("metaNative") : t("metaSubs"));

      if (settings.afterCapture === "download") {
        downloadBlob(blob, filename);
        toast(t("toastScreenshotSaved", filename));
      } else if (settings.afterCapture === "copy") {
        try {
          await copyBlob(blob, canvas);
          toast(t("toastScreenshotCopied", canvas.width, canvas.height));
        } catch (e) {
          // If copying is denied, don't lose the image: open the preview instead
          showPreview(blob, canvas, filename, meta);
          toast(t("toastAutoCopyFailed"), true);
        }
      } else {
        showPreview(blob, canvas, filename, meta);
      }
      return { ok: true, mode, width: canvas.width, height: canvas.height };
    } catch (e) {
      toast(t("toastCaptureFailed", e && e.message ? e.message : e), true);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
      capturing = false;
    }
  }

  // ---------- Inject the player button ----------
  // The artwork: the pink disc is drawn on a 24x24 grid and scaled by 1.5
  // (36x36 viewBox), proportions unchanged. Sizing and centring are NOT
  // left to static markup -- ensureBiliButton() below measures the
  // neighbouring control items at runtime and pins our icon to the same
  // rendered size and centre line. Merely stretching the SVG to fill the
  // button doesn't work: the player's own styles distort it, leaving the
  // disc oversized and sunk below the other icons' centre line.
  const CAMERA_SVG =
    '<svg viewBox="0 0 36 36" width="100%" height="100%" focusable="false" aria-hidden="true"><g transform="scale(1.5)"><circle cx="12" cy="12" r="7.8" fill="#fb7299" stroke="#ffffff" stroke-width="1.5"/><g transform="translate(6.9 6.9) scale(0.425)"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" fill="#ffffff"/><circle cx="12" cy="13" r="4.2" fill="#fb7299"/></g></g></svg>';

  // ---------- Bilibili player button ----------
  // The right-hand control group is .bpx-player-control-bottom-right
  // (older player: .bilibili-player-video-control-bottom-right) and its
  // items are plain divs. We insert our button before the settings item;
  // its size and centre-line alignment are measured from a neighbouring
  // control item at runtime (see ensureBiliButton).
  function createBiliButton(controls) {
    const btn = document.createElement("button");
    btn.className = "bili-capture-btn bili-player-btn";
    btn.type = "button";
    btn.dataset.biliInstance = INSTANCE;
    btn.title = t("btnTitle");
    btn.setAttribute("aria-label", t("btnAria"));
    btn.innerHTML = CAMERA_SVG;
    const forced = {
      background: "none",
      border: "0",
      "border-radius": "0",
      "box-shadow": "none",
      margin: "0",
      padding: "0",
      filter: "none",
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      cursor: "pointer"
    };
    Object.keys(forced).forEach((k) => btn.style.setProperty(k, forced[k], "important"));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const player =
        controls.closest(".bpx-player-container, #bilibili-player, .bilibili-player") ||
        document.querySelector(".bpx-player-container, #bilibili-player");
      doCapture(player ? player.querySelector("video") : null);
    });
    return btn;
  }

  function ensureBiliButton() {
    if (SITE !== "bilibili") return;
    const controls =
      document.querySelector(".bpx-player-control-bottom-right") ||
      document.querySelector(".bilibili-player-video-control-bottom-right");
    if (!controls) return;
    let btn = controls.querySelector(".bili-capture-btn");
    if (btn && btn.dataset.biliInstance !== INSTANCE) {
      btn.remove();
      btn = null;
    }
    if (!btn) {
      btn = createBiliButton(controls);
      // Insert before the settings item (walking up to the direct child of
      // the control group first)
      let anchor =
        controls.querySelector(".bpx-player-ctrl-setting") ||
        controls.querySelector(".bilibili-player-iconfont-setting") ||
        controls.querySelector(".bpx-player-ctrl-full");
      while (anchor && anchor.parentNode && anchor.parentNode !== controls) {
        anchor = anchor.parentNode;
      }
      if (anchor && anchor.parentNode === controls) controls.insertBefore(btn, anchor);
      else controls.appendChild(btn);
    }
    if (resizeObserver) resizeObserver.observe(controls); // re-align when the player resizes
    // Size the button from a neighbouring *icon* item and pin its icon
    // centre to the neighbours' centre line. Copying the height of the
    // first child (often a wide text item such as the quality label) and
    // relying on CSS centring alone is not enough: that leaves the camera
    // icon sunk ~5px below the other controls, because the control group
    // does not centre a foreign <button> the way it centres its own
    // items. The correction below is a closed loop: measure, correct,
    // re-measure, until the centres match.
    const cache = btn._bili || (btn._bili = {});
    const px = (n) => Math.round(n * 100) / 100 + "px";
    const put = (el, key, prop, value) => {
      if (cache[key] !== value) {
        el.style.setProperty(prop, value, "important");
        cache[key] = value;
      }
    };
    const items = [];
    for (const el of Array.from(controls.children)) {
      if (el === btn) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) items.push({ el, r });
    }
    if (!items.length) return; // not laid out yet; retried on the next pass

    // The settings item is the preferred reference: it defines both the
    // centre line and (being an icon button) the box to copy.
    let anchor = items.find(
      ({ el }) =>
        el.classList.contains("bpx-player-ctrl-setting") ||
        !!el.querySelector(".bpx-player-ctrl-setting, .bilibili-player-iconfont-setting")
    );
    // Box reference: a square-ish icon item (settings / fullscreen /
    // volume), never a wide text item (quality / speed labels).
    const boxRef =
      (anchor && anchor.r.width <= 56 ? anchor : null) ||
      items.find(({ r }) => r.width >= 20 && r.width <= 56 && r.height >= 20 && r.height <= 56) ||
      items[0];
    const boxW = boxRef.r.width <= 56 ? boxRef.r.width : boxRef.r.height;
    put(btn, "bw", "width", px(boxW));
    put(btn, "bmw", "min-width", px(boxW));
    put(btn, "bxw", "max-width", px(boxW));
    put(btn, "bh", "height", px(boxRef.r.height));
    put(btn, "bmh", "min-height", px(boxRef.r.height));
    put(btn, "bxh", "max-height", px(boxRef.r.height));

    // Icon size: the reference icon's actual rendered size when it can be
    // measured, else two thirds of the box height.
    const svg = btn.querySelector("svg");
    const refIcon = boxRef.el.querySelector(
      "svg, .bpx-player-ctrl-icon, .bilibili-player-iconfont, i"
    );
    let iconRect = refIcon ? refIcon.getBoundingClientRect() : null;
    if (!iconRect || iconRect.width < 8 || iconRect.height < 8) iconRect = null;
    if (svg) {
      const iw = iconRect ? iconRect.width : Math.max(18, Math.round(boxRef.r.height * 0.66));
      const ih = iconRect ? iconRect.height : Math.max(18, Math.round(boxRef.r.height * 0.66));
      put(svg, "sw", "width", px(iw));
      put(svg, "sh", "height", px(ih));
    }

    // Centre line: land our icon's centre exactly on the reference
    // item's centre (its icon's centre when measurable).
    if (svg) {
      const targetItem = anchor || boxRef;
      let target = targetItem.r.top + targetItem.r.height / 2;
      if (targetItem === boxRef && iconRect) target = iconRect.top + iconRect.height / 2;
      const centerY = () => {
        const r = svg.getBoundingClientRect();
        return r.top + r.height / 2;
      };
      let err = target - centerY();
      for (let i = 0; i < 3 && Math.abs(err) >= 0.5; i++) {
        cache.dy = (cache.dy || 0) + err;
        btn.style.setProperty(
          "transform",
          "translateY(" + Math.round(cache.dy * 100) / 100 + "px)",
          "important"
        );
        err = target - centerY();
      }
    }
  }

  function ensureButton() {
    if (!isCurrent()) {
      teardown();
      return;
    }
    ensureBiliButton();
  }

  // Bilibili's DOM changes extremely often; throttle instead of querying on every change
  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      ensureButton();
    }, 250);
  }

  // The control bar fades and reflows via class changes, which the childList
  // observer above cannot see. Re-check when the pointer enters the player and
  // when its transitions end; a slow timer in Startup is the final backstop.
  function kick() {
    scheduleEnsure();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(scheduleEnsure, 700);
  }

  function onPlayerHover(e) {
    const t = e.target;
    if (t && t.closest && t.closest(".bpx-player-container, #bilibili-player")) kick();
  }

  function onTransitionEnd(e) {
    const t = e.target;
    if (t && t.closest && t.closest(".bpx-player-control-wrap")) scheduleEnsure();
  }

  function teardown() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(scheduled);
    scheduled = null;
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    document.removeEventListener("fullscreenchange", scheduleEnsure);
    window.removeEventListener("resize", scheduleEnsure);
    document.removeEventListener("mouseover", onPlayerHover, true);
    document.removeEventListener("transitionend", onTransitionEnd, true);
    clearInterval(pollTimer);
    clearTimeout(settleTimer);
    document
      .querySelectorAll('.bili-capture-btn[data-bili-instance="' + INSTANCE + '"]')
      .forEach((b) => b.remove());
    closePreview();
  }

  // ---------- Startup ----------
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (isCurrent() && area === "local" && (changes.settings || changes.uiLanguage))
      loadSettings();
  });

  observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Fullscreen / window resizes change the control bar's size without adding
  // or removing nodes, so the mutation observer never fires for them
  document.addEventListener("fullscreenchange", scheduleEnsure);
  window.addEventListener("resize", scheduleEnsure);
  document.addEventListener("mouseover", onPlayerHover, true);
  document.addEventListener("transitionend", onTransitionEnd, true);
  pollTimer = setInterval(() => {
    if (!document.hidden) ensureButton();
  }, 1000);
  if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(scheduleEnsure);
  ensureButton();

  // ---------- Message entry (shortcut / popup) ----------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isCurrent()) return; // stale instances stay silent and leave it to the newest one
    if (message && message.type === "bili-capture") {
      doCapture().then(sendResponse);
      return true;
    }
  });
})();
