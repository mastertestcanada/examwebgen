// Runs MasterTest Builder (Python) inside the browser with Pyodide. Everything happens in this
// worker's memory: the files the page sends are written to an in-memory file system, the
// program runs, and the result comes back as a zip. Nothing is sent anywhere.
"use strict";

let py = null;
let build = null;
const cjkFonts = {};   // region -> font bytes, downloaded once per visit

function post(type, data = {}) {
  self.postMessage({ type, ...data });
}

async function load() {
  const t0 = performance.now();
  build = await (await fetch("build.json", { cache: "no-cache" })).json();
  post("status", { text: "Loading Python…" });
  const base = new URL(build.pyodide, self.location.href).href;
  importScripts(base + "pyodide.js");
  py = await self.loadPyodide({ indexURL: base });
  post("status", { text: "Loading PDF and image libraries…" });
  const wheels = build.wheels.map((w) => new URL("wheels/" + w, self.location.href).href);
  await py.loadPackage([...build.packages, ...wheels], { messageCallback: () => {}, errorCallback: (m) => post("log", { text: m, stream: "stderr" }) });
  post("status", { text: "Loading MasterTest Builder…" });
  const app = await (await fetch(build.app)).arrayBuffer();
  py.unpackArchive(app, "zip", { extractDir: "/app" });
  py.runPython("import sys; sys.path.insert(0, '/app')");
  const spec = JSON.parse(py.runPython("from mtbuilder import web_runner; web_runner.version()"));
  post("ready", { spec, cjk: build.cjk || {}, seconds: (performance.now() - t0) / 1000 });
}

// The Chinese, Japanese or Korean font for a region: fetched from the site the first time a quiz
// needs it (about 11 MB, gzipped), then kept for the rest of the visit.
async function cjkFont(region) {
  if (cjkFonts[region]) return cjkFonts[region];
  const entry = (build.cjk || {})[region];
  if (!entry) return null;
  const names = { sc: "Simplified Chinese", tc: "Traditional Chinese", jp: "Japanese", kr: "Korean" };
  post("progress", { region, mb: Math.round(entry.bytes / 1e6), text: `Downloading the ${names[region]} font (${Math.round(entry.bytes / 1e6)} MB; only the first time)…` });
  const response = await fetch(entry.file);
  if (!response.ok) throw new Error(`The ${names[region]} font could not be downloaded (${response.status}).`);
  let data = new Uint8Array(await response.arrayBuffer());
  if (data[0] === 0x1f && data[1] === 0x8b) {   // still gzipped (the server did not unpack it)
    data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }
  post("progress", { text: "Making your exam…" });
  cjkFonts[region] = data;
  return data;
}

// PBKDF2-HMAC-SHA256 as qr_payload._aes_key: 600,000 iterations, the header as salt, 32 bytes (hex)
async function deriveKey(password, headerHex) {
  const salt = new Uint8Array(headerHex.match(/../g).map((h) => parseInt(h, 16)));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 }, base, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function run({ files, argv, password, cjk }) {
  const t0 = performance.now();
  const font = cjk ? await cjkFont(cjk) : null;
  // fontTools only for an uploaded OpenType (PostScript outlines) font or font collection, which are converted
  if (build.lazy_packages && files.some((f) => /\.(otf|ttc)$/i.test(f.name))) {
    post("progress", { text: "Loading the font converter…" });
    await py.loadPackage(build.lazy_packages, { messageCallback: () => {} });
  }
  py.setStdout({ batched: (text) => post("log", { text, stream: "stdout" }) });
  py.setStderr({ batched: (text) => post("log", { text, stream: "stderr" }) });
  py.runPython("from mtbuilder import web_runner; web_runner.reset()");
  for (const f of files) {
    const path = "/work/in/" + f.name;
    if (f.unzip) {
      py.FS.mkdirTree(path);
      py.unpackArchive(f.data, "zip", { extractDir: path });
    } else {
      py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));   // fonts/... go in folders of their own
      py.FS.writeFile(path, new Uint8Array(f.data));
    }
  }
  if (font) {
    const path = `/work/in/fonts/cjk/NotoSansCJK-${cjk}.ttf`;
    py.FS.mkdirTree("/work/in/fonts/cjk");
    py.FS.writeFile(path, font);
    argv = [...argv, "--cjk-font", path];
  }
  py.globals.set("web_argv", py.toPy(argv));
  py.globals.set("web_password", password || "");
  // with a password the first attempt stops early to have the key derived (below): its messages are
  // held back, so that they are not shown twice
  const held = [];
  if (password) {
    py.setStdout({ batched: (text) => held.push({ text, stream: "stdout" }) });
    py.setStderr({ batched: (text) => held.push({ text, stream: "stderr" }) });
  }
  let rc = py.runPython("web_runner.run(web_argv, web_password)");
  py.setStdout({ batched: (text) => post("log", { text, stream: "stdout" }) });
  py.setStderr({ batched: (text) => post("log", { text, stream: "stderr" }) });
  if (typeof rc !== "string") for (const line of held) post("log", line);
  if (typeof rc === "string") {
    // --password: the answer key's AES key, derived here with the browser's PBKDF2 (Python in the
    // browser has none), then the run again with it
    post("progress", { text: "Protecting the answer key…" });
    const key = await deriveKey(password, rc);
    py.runPython("web_runner.reset()");
    for (const f of files) {
      const path = "/work/in/" + f.name;
      if (f.unzip) { py.FS.mkdirTree(path); py.unpackArchive(f.data, "zip", { extractDir: path }); }
      else { py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/"))); py.FS.writeFile(path, new Uint8Array(f.data)); }
    }
    if (font) { py.FS.mkdirTree("/work/in/fonts/cjk"); py.FS.writeFile(`/work/in/fonts/cjk/NotoSansCJK-${cjk}.ttf`, font); }
    py.globals.set("web_derived", py.toPy({ [rc]: key }));
    rc = py.runPython("web_runner.run(web_argv, web_password, web_derived)");
  }
  const seconds = (performance.now() - t0) / 1000;
  if (rc !== 0) {
    py.runPython("web_runner.reset()");
    post("failed", { seconds });
    return;
  }
  const result = py.runPython("web_runner.output_zip()").toJs();
  const name = result[0];
  const bytes = result[1];
  const seed = result[2];
  py.runPython("web_runner.reset()");   // drop the student data from memory straight away
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  self.postMessage({ type: "done", name, zip: buffer, seed, seconds }, [buffer]);
}

// Reads an export as soon as it is chosen: which quizzes it holds, then what one of them holds.
function setLang(lang) {
  py.globals.set("web_lang", lang || "en");
  py.runPython("from mtbuilder import web_runner; web_runner.set_language(web_lang)");
}

function inspect({ name, data, lang }) {
  setLang(lang);
  py.runPython("from mtbuilder import web_runner; web_runner.reset()");
  py.FS.writeFile("/work/in/" + name, new Uint8Array(data));
  py.globals.set("web_name", name);
  post("quizzes", { name, result: JSON.parse(py.runPython("web_runner.quizzes(web_name)")) });
}

function summary({ name, number, data, lang, refresh }) {
  setLang(lang);
  // the export may have been cleared by a run since it was inspected
  if (data && !py.FS.analyzePath("/work/in/" + name).exists) {
    py.runPython("from mtbuilder import web_runner; web_runner.reset()");
    py.FS.writeFile("/work/in/" + name, new Uint8Array(data));
  }
  py.globals.set("web_name", name);
  py.globals.set("web_number", number);
  post("summary", { name, number, refresh: !!refresh, result: JSON.parse(py.runPython("web_runner.summary(web_name, web_number)")) });
}

// Reads a class list as soon as it is chosen, with the page's class-list options. The file is
// written to a folder of its own and deleted straight after (the run gets its own copy).
function classlist({ name, data, id, qr, lang }) {
  setLang(lang);
  const dir = "/work/classcheck";
  py.FS.mkdirTree(dir);
  const path = dir + "/" + name;
  py.FS.writeFile(path, new Uint8Array(data));
  try {
    py.globals.set("web_path", path);
    py.globals.set("web_id", id || "");
    py.globals.set("web_qr", qr || "");
    post("classlist", { name, result: JSON.parse(py.runPython("from mtbuilder import web_runner; web_runner.classlist(web_path, web_id, web_qr)")) });
  } finally {
    py.FS.unlink(path);
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "inspect") inspect(msg);
    else if (msg.type === "summary") summary(msg);
    else if (msg.type === "classlist") classlist(msg);
    else if (msg.type === "run") await run(msg);
  } catch (err) {
    const text = String(err && err.message ? err.message : err);
    if (msg.type === "classlist") {
      post("classlist", { name: msg.name, result: { error: "This file could not be read: " + text.split("\n").filter(Boolean).pop(), columns: [] } });
      return;
    }
    if (msg.type === "inspect" || msg.type === "summary") {
      post(msg.type === "inspect" ? "quizzes" : "summary",
        { name: msg.name, number: msg.number, result: { error: "This file could not be read: " + text.split("\n").filter(Boolean).pop() } });
      return;
    }
    post("log", { text, stream: "stderr" });
    post("failed", { seconds: 0 });
  }
};

load().catch((err) => post("error", { text: String(err && err.message ? err.message : err) }));
