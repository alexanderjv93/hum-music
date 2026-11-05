"use strict";

const $ = (id) => document.getElementById(id);
const POLL_MS = 5000;
const GIVE_UP_MS = 15 * 60 * 1000;
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const FAILED = {
  CREATE_TASK_FAILED: "The song couldn't be started. Please try again.",
  GENERATE_AUDIO_FAILED: "The song couldn't be generated. Please try again.",
  GENERATE_LYRICS_FAILED: "The lyrics couldn't be generated. Please try again.",
  CALLBACK_EXCEPTION: "Something went wrong while finishing the song. Please try again.",
  SENSITIVE_WORD_ERROR: "That request includes words the service doesn't allow. Try rewording it.",
};
const PROGRESS = {
  PENDING: "Getting started",
  TEXT_SUCCESS: "Writing done, recording now",
  FIRST_SUCCESS: "First version is ready, finishing the second",
};
const IDEAS = [
  "Dreamy synth-pop about driving home at 3am",
  "Upbeat ska song about a very bad haircut",
  "Sparse piano and cello for a rainy morning",
  "Nineties hip-hop beat with a jazzy horn loop",
];

/* ---------- storage: the browser may refuse it, so never let that break the app ---------- */

function load(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Songs still work for this visit. */
  }
}

let library = load("hum.library", []);
library = Array.isArray(library)
  ? library.filter((task) => Date.now() - task.createdAt < EXPIRY_MS)
  : [];
let mode = "simple";

/* ---------- api ---------- */

async function api(path, body) {
  const headers = { "content-type": "application/json" };
  const code = $("access").value || load("hum.access", "");
  if (code) headers["x-access-code"] = code;

  let res;
  try {
    res = await fetch(`/api/${path}`, body
      ? { method: "POST", headers, body: JSON.stringify(body) }
      : { headers });
  } catch {
    throw new Error("Couldn't connect. Check your internet and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (data.accessDenied) {
    save("hum.access", "");
    $("access-field").hidden = false;
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  if (code) save("hum.access", code);
  return data;
}

/* ---------- small DOM helpers: text always goes through textContent ---------- */

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}
function safeUrl(url) {
  try {
    return new URL(url).protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}
function clock(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
function fileName(title) {
  return `${(title || "song").replace(/[^\w\- ]+/g, "").trim() || "song"}.mp3`;
}

/* ---------- form ---------- */

function setMode(next) {
  mode = next;
  $("tab-simple").setAttribute("aria-selected", String(mode === "simple"));
  $("tab-custom").setAttribute("aria-selected", String(mode === "custom"));
  document.querySelector(".simple-only").hidden = mode !== "simple";
  document.querySelector(".custom-only").hidden = mode !== "custom";
}

function updateInstrumental() {
  const instrumental = $("instrumental").checked;
  document.querySelectorAll(".vocals-only").forEach((node) => { node.hidden = instrumental; });
}

function collect() {
  const shared = { instrumental: $("instrumental").checked, model: $("model").value };
  if (mode === "simple") {
    return { ...shared, customMode: false, prompt: $("prompt").value };
  }
  return {
    ...shared,
    customMode: true,
    style: $("style").value,
    title: $("title").value,
    lyrics: $("lyrics").value,
    negativeTags: $("negative").value,
    vocalGender: $("voice").value,
    duration: Number($("duration").value),
  };
}

function showError(message) {
  $("form-error").textContent = message;
  $("form-error").hidden = !message;
}

async function submit(event) {
  event.preventDefault();
  showError("");
  const body = collect();
  const label = (mode === "simple" ? body.prompt : body.title || body.style || body.lyrics).trim();

  $("submit").disabled = true;
  $("submit").textContent = "Starting…";
  try {
    const { data } = await api("generate", body);
    library.unshift({
      taskId: data.taskId,
      label: label.slice(0, 140),
      createdAt: Date.now(),
      status: "PENDING",
      instrumental: body.instrumental,
      tracks: [],
    });
    persist();
    render();
    $("library-title").scrollIntoView({ behavior: "smooth", block: "start" });
    poll(library[0]);
  } catch (err) {
    showError(err.message);
  } finally {
    $("submit").disabled = false;
    $("submit").textContent = "Make my song";
  }
}

/* ---------- lyric helper ---------- */

async function writeLyrics() {
  const prompt = $("lyric-prompt").value.trim();
  const status = $("lyric-status");
  const say = (message) => { status.textContent = message; status.hidden = !message; };
  if (!prompt) return say("Tell me what the lyrics should be about.");
  if ($("lyrics").value.trim() && !confirm("Replace the lyrics you've already written?")) return;

  $("lyric-go").disabled = true;
  say("Writing, this usually takes under a minute…");
  try {
    const { data } = await api("lyrics", { prompt });
    const started = Date.now();
    while (Date.now() - started < 3 * 60 * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const { data: info } = await api(`lyrics/${encodeURIComponent(data.taskId)}`);
      if (FAILED[info.status]) throw new Error(FAILED[info.status]);
      const done = info.response?.data?.find((item) => item.status === "complete" && item.text);
      if (info.status === "SUCCESS" && done) {
        $("lyrics").value = done.text;
        if (!$("title").value && done.title) $("title").value = done.title;
        say("");
        $("lyric-helper").hidden = true;
        return;
      }
    }
    throw new Error("That took too long. Please try again.");
  } catch (err) {
    say(err.message);
  } finally {
    $("lyric-go").disabled = false;
  }
}

/* ---------- task polling ---------- */

function persist() {
  save("hum.library", library);
}

function toTrack(raw, instrumental) {
  return {
    id: raw.id,
    title: raw.title || "Untitled",
    tags: raw.tags || "",
    duration: raw.duration || 0,
    // For instrumentals, Suno's `prompt` field isn't lyrics.
    lyrics: instrumental ? "" : raw.prompt || "",
    image: safeUrl(raw.image_url),
    audio: safeUrl(raw.audio_url),
    stream: safeUrl(raw.stream_audio_url),
  };
}

function isActive(task) {
  return !task.error && task.status !== "SUCCESS";
}

async function poll(task) {
  while (isActive(task) && library.includes(task)) {
    if (Date.now() - task.createdAt > GIVE_UP_MS) {
      task.error = "This is taking far longer than usual. Try making it again.";
      break;
    }
    try {
      const { data } = await api(`generate/${encodeURIComponent(task.taskId)}`);
      const tracks = data.response?.sunoData;
      if (Array.isArray(tracks) && tracks.length) task.tracks = tracks.map((raw) => toTrack(raw, task.instrumental));
      if (data.status) task.status = data.status;
      if (FAILED[task.status] && !task.tracks.length) task.error = FAILED[task.status];
      if (FAILED[task.status] && task.tracks.length) task.status = "SUCCESS";
      persist();
      render();
    } catch {
      /* A dropped request isn't a failed song. Try again on the next tick. */
    }
    if (isActive(task)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  persist();
  render();
}

/* ---------- rendering ---------- */

const openLyrics = new Set();

// Browsers ignore the download attribute across origins, so fetch the file and
// save it from a local URL. If that fails, open it in a new tab instead.
async function download(event, track) {
  event.preventDefault();
  const fallback = window.open("", "_blank");
  try {
    const res = await fetch(track.audio);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    el("a", { href: url, download: fileName(track.title) }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    fallback?.close();
  } catch {
    if (fallback) fallback.location = track.audio;
  }
}

function renderTrack(track) {
  const src = track.audio || track.stream;
  const playing = current?.id === track.id && !$("audio").paused;
  const cover = el("button", {
    type: "button",
    className: "cover",
    disabled: !src,
    ariaLabel: `${playing ? "Pause" : "Play"} ${track.title}`,
    onclick: () => toggle(track),
  },
    track.image ? el("img", { src: track.image, alt: "", loading: "lazy" }) : null,
    el("span", { textContent: playing ? "❚❚" : "▶" }));

  const actions = el("div", { className: "track-actions" });
  if (track.audio) {
    actions.append(el("a", {
      href: track.audio,
      download: fileName(track.title),
      target: "_blank",
      rel: "noopener",
      textContent: "Download MP3",
      onclick: (event) => download(event, track),
    }));
  } else {
    actions.append(el("span", { className: "hint", textContent: "Preview, full file on the way" }));
  }
  if (track.lyrics) {
    actions.append(el("button", {
      type: "button",
      className: "text-btn",
      style: "font-size:13px",
      textContent: openLyrics.has(track.id) ? "Hide lyrics" : "Lyrics",
      onclick: () => {
        if (openLyrics.has(track.id)) openLyrics.delete(track.id);
        else openLyrics.add(track.id);
        render();
      },
    }));
  }

  const meta = [track.duration ? clock(track.duration) : "", track.tags].filter(Boolean).join(" · ");
  const row = el("div", { className: "track" }, cover, el("div", { className: "track-body" },
    el("p", { className: "track-title", textContent: track.title }),
    meta ? el("p", { className: "track-meta", textContent: meta, title: track.tags }) : null,
    actions));

  return openLyrics.has(track.id)
    ? el("div", {}, row, el("p", { className: "track-lyrics", textContent: track.lyrics }))
    : row;
}

function renderTask(task) {
  const node = el("article", { className: "task" }, el("div", { className: "task-head" },
    el("p", { className: "task-label", textContent: task.label || "Your song" }),
    el("button", {
      type: "button",
      className: "task-remove",
      textContent: "Remove",
      onclick: () => {
        library = library.filter((item) => item !== task);
        persist();
        render();
      },
    })));

  if (task.error) {
    node.append(el("p", { className: "task-error", textContent: task.error }));
  } else if (isActive(task)) {
    const bars = el("span", { className: "bars", ariaHidden: "true" }, el("i"), el("i"), el("i"));
    node.append(el("div", { className: "task-progress" }, bars,
      el("span", { textContent: PROGRESS[task.status] || "Working on it" })));
  }
  task.tracks.forEach((track) => node.append(renderTrack(track)));
  return node;
}

function render() {
  const root = $("library");
  root.replaceChildren(...(library.length
    ? library.map(renderTask)
    : [el("p", { className: "empty", textContent: "Your songs will show up here." })]));
}

/* ---------- player: one shared <audio>, so re-rendering never interrupts playback ---------- */

let current = null;

function toggle(track) {
  const audio = $("audio");
  if (current?.id === track.id) {
    if (audio.paused) audio.play().catch(playFailed);
    else audio.pause();
    return;
  }
  current = track;
  audio.src = track.audio || track.stream;
  $("player-title").textContent = track.title;
  $("player").hidden = false;
  audio.play().catch(playFailed);
}

function playFailed(err) {
  if (err.name !== "AbortError") $("player-title").textContent = "Couldn't play this song. Try again in a moment.";
}

function setupPlayer() {
  const audio = $("audio");
  const updateButton = () => {
    $("player-toggle").textContent = audio.paused ? "▶" : "❚❚";
    $("player-toggle").ariaLabel = audio.paused ? "Play" : "Pause";
    render();
  };
  audio.addEventListener("play", updateButton);
  audio.addEventListener("pause", updateButton);
  audio.addEventListener("error", () => playFailed(new Error("load")));
  audio.addEventListener("timeupdate", () => {
    const total = Number.isFinite(audio.duration) ? audio.duration : current?.duration || 0;
    $("player-now").textContent = clock(audio.currentTime);
    $("player-total").textContent = clock(total);
    if (total) $("player-seek").value = (audio.currentTime / total) * 100;
  });
  $("player-seek").addEventListener("input", (event) => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (event.target.value / 100) * audio.duration;
  });
  $("player-toggle").addEventListener("click", () => {
    if (audio.paused) audio.play().catch(playFailed);
    else audio.pause();
  });
}

/* ---------- start ---------- */

IDEAS.forEach((idea) => {
  $("ideas").append(el("button", {
    type: "button",
    textContent: idea,
    onclick: () => { $("prompt").value = idea; $("prompt").focus(); },
  }));
});

$("tab-simple").addEventListener("click", () => setMode("simple"));
$("tab-custom").addEventListener("click", () => setMode("custom"));
$("instrumental").addEventListener("change", updateInstrumental);
$("form").addEventListener("submit", submit);
$("duration").addEventListener("input", (event) => {
  $("duration-out").textContent = clock(Number(event.target.value));
});
$("lyrics-toggle").addEventListener("click", () => {
  $("lyric-helper").hidden = !$("lyric-helper").hidden;
  if (!$("lyric-helper").hidden) $("lyric-prompt").focus();
});
$("lyric-go").addEventListener("click", writeLyrics);

setupPlayer();
render();
library.filter(isActive).forEach(poll);

api("config")
  .then(({ accessRequired }) => {
    if (accessRequired && !load("hum.access", "")) $("access-field").hidden = false;
  })
  .catch(() => { /* The form still reports errors when it's submitted. */ });
