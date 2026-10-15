// Runs MasterTest Builder (Python) inside the browser with Pyodide. Everything happens in this
// worker's memory: the files the page sends are written to an in-memory file system, the
// program runs, and the result comes back as a zip. Nothing is sent anywhere.
"use strict";

let py = null;

function post(type, data = {}) {
  self.postMessage({ type, ...data });
}

async function load() {
  const t0 = performance.now();
  const build = await (await fetch("build.json", { cache: "no-cache" })).json();
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
  post("ready", { spec, seconds: (performance.now() - t0) / 1000 });
}

async function run({ files, argv, password }) {
  const t0 = performance.now();
  py.setStdout({ batched: (text) => post("log", { text, stream: "stdout" }) });
  py.setStderr({ batched: (text) => post("log", { text, stream: "stderr" }) });
  py.runPython("from mtbuilder import web_runner; web_runner.reset()");
  for (const f of files) {
    const path = "/work/in/" + f.name;
    if (f.unzip) {
      py.FS.mkdirTree(path);
      py.unpackArchive(f.data, "zip", { extractDir: path });
    } else {
      py.FS.writeFile(path, new Uint8Array(f.data));
    }
  }
  py.globals.set("web_argv", py.toPy(argv));
  py.globals.set("web_password", password || "");
  const rc = py.runPython("web_runner.run(web_argv, web_password)");
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
function inspect({ name, data }) {
  py.runPython("from mtbuilder import web_runner; web_runner.reset()");
  py.FS.writeFile("/work/in/" + name, new Uint8Array(data));
  py.globals.set("web_name", name);
  post("quizzes", { name, result: JSON.parse(py.runPython("web_runner.quizzes(web_name)")) });
}

function summary({ name, number, data }) {
  // the export may have been cleared by a run since it was inspected
  if (data && !py.FS.analyzePath("/work/in/" + name).exists) {
    py.runPython("from mtbuilder import web_runner; web_runner.reset()");
    py.FS.writeFile("/work/in/" + name, new Uint8Array(data));
  }
  py.globals.set("web_name", name);
  py.globals.set("web_number", number);
  post("summary", { name, number, result: JSON.parse(py.runPython("web_runner.summary(web_name, web_number)")) });
}

// Reads a class list as soon as it is chosen, with the page's class-list options. The file is
// written to a folder of its own and deleted straight after (the run gets its own copy).
function classlist({ name, data, id, qr }) {
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
