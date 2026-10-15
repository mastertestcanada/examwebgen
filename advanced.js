// MasterTest Web, MasterTest Generator in the browser: builds the form from the program's own option list, sends the
// chosen files to the worker (which runs the Python program in memory) and offers the result.
"use strict";

const $ = (id) => document.getElementById(id);
const worker = new Worker("worker.js");
const controls = [];            // every option control: {name, args(), set(value), changed(), file?}
const fileFor = new Map();      // option name -> File
const kindOf = new Map();       // option name -> kind from the program's option list
let ready = false;
let running = false;
let exportFile = null;
let downloadUrl = null;

// ------------------------------------------------------------------ worker messages

worker.onmessage = ({ data }) => {
  if (data.type === "status") {
    $("engine-detail").textContent = data.text;
  } else if (data.type === "ready") {
    ready = true;
    $("engine-state").textContent = "Ready";
    $("engine-detail").textContent = `Loaded in ${data.seconds.toFixed(0)} s`;
    $("version-line").textContent = `MasterTest Web ${data.spec.version}: MasterTest Generator running in your browser.`;
    buildForm(data.spec);
    update();
  } else if (data.type === "error") {
    $("engine-state").textContent = "Could not start";
    $("engine-detail").textContent = data.text;
  } else if (data.type === "log") {
    appendLog(data.text, data.stream);
  } else if (data.type === "done") {
    finish(true, data);
  } else if (data.type === "failed") {
    finish(false, data);
  }
};

function appendLog(text, stream) {
  const line = document.createElement("span");
  if (stream === "stderr" && /^(ERROR|Traceback)/.test(text)) line.className = "err";
  line.textContent = text + "\n";
  $("log").appendChild(line);
  $("log").scrollTop = $("log").scrollHeight;
}

// ------------------------------------------------------------------ form

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

function title(text) {
  // option help starts in lower case; the form shows it as a sentence
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

const LABELS = {
  "--class-list": "Class list (CSV)",
  "--blank-cards": "Blank cards",
  "--no-quiz-instructions": "Leave out the quiz instructions",
  "--max-items": "A random selection of questions",
  "--ignore-item-banks": "Print every question of the item banks (ignore their \"pick N\" rules)",
  "--title-map": "Choose questions by title (title map)",
};

function label(o) {
  if (LABELS[o.name]) return LABELS[o.name];
  const words = o.name.replace(/^--/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function filePicker(o, onChange) {
  const id = "f" + o.name.replace(/[^a-z0-9]/gi, "");
  const input = el("input", { type: "file", id });
  const chosen = el("span", { class: "chosen", text: "No file chosen" });
  const clear = el("button", { type: "button", class: "clear", text: "Remove", hidden: true });
  input.addEventListener("change", () => {
    const f = input.files[0];
    if (f) fileFor.set(o.name, f); else fileFor.delete(o.name);
    chosen.textContent = f ? f.name : "No file chosen";
    clear.hidden = !f;
    onChange();
  });
  clear.addEventListener("click", () => {
    input.value = ""; fileFor.delete(o.name); chosen.textContent = "No file chosen"; clear.hidden = true; onChange();
  });
  const box = el("span", { class: "file" }, input, el("label", { class: "pick", for: id, text: "Choose file" }), chosen, clear);
  return { box, chosen };
}

function control(o) {
  const nameTag = el("span", { class: "opt-name", text: o.name });
  const help = el("span", { class: "help", text: title(o.help) });
  let c;
  if (o.kind === "flag" || o.kind === "bool") {
    const input = el("input", { type: "checkbox" });
    input.checked = o.kind === "bool" ? !!o.default : false;
    const node = el("label", { class: "bubble" }, input,
      el("span", {}, el("span", { class: "name" }, label(o), nameTag), help));
    c = {
      node,
      args: () => (o.kind === "flag" ? (input.checked ? [o.name] : [])
        : (input.checked === !!o.default ? [] : [input.checked ? o.name : o.name.replace(/^--/, "--no-")])),
      set: (v) => { input.checked = v !== false; },
      changed: () => (o.kind === "flag" ? input.checked : input.checked !== !!o.default),
      input,
    };
  } else if (o.kind === "file") {
    const picker = filePicker(o, update);
    const node = el("div", { class: "field" },
      el("label", { class: "field" }, el("span", { class: "name" }, label(o), nameTag), help), picker.box);
    c = {
      node,
      args: () => (fileFor.has(o.name) ? [o.name, fileFor.get(o.name).name] : []),
      set: (v) => { picker.chosen.textContent = `Choose ${v} again`; },
      changed: () => fileFor.has(o.name),
      file: true,
    };
  } else {
    let input;
    if (o.kind === "choice") {
      input = el("select", {});
      for (const ch of o.choices) {
        const opt = el("option", { value: ch, text: ch });
        if (String(o.default) === ch) opt.selected = true;
        input.append(opt);
      }
    } else {
      input = el("input", { type: o.kind === "number" ? "number" : "text",
        placeholder: o.default !== null && o.default !== "" && o.default !== 0 ? String(o.default) : "" });
      if (o.kind === "number") input.step = "any";
    }
    input.addEventListener("input", update);
    const def = o.default === null || o.default === undefined ? "" : String(o.default);
    const node = el("label", { class: "field" }, el("span", { class: "name" }, label(o), nameTag), help, input);
    c = {
      node,
      args: () => {
        const v = input.value.trim();
        return v === "" || v === def ? [] : [o.name, v];
      },
      set: (v) => { input.value = v; },
      changed: () => { const v = input.value.trim(); return v !== "" && v !== def; },
      input,
    };
  }
  c.name = o.name;
  return c;
}

// mutually exclusive options (question selection): one bubble each, plus "none of them"
function exclusiveSet(options, noneLabel) {
  const name = "x" + options[0].name;
  const wrap = el("div", { class: "choices", role: "radiogroup" });
  const parts = [];
  const none = el("input", { type: "radio", name, checked: true });
  none.addEventListener("change", update);
  wrap.append(el("label", { class: "bubble" }, none, el("span", { class: "name", text: noneLabel })));
  const details = el("div", {});
  for (const o of options) {
    const radio = el("input", { type: "radio", name });
    const inner = o.kind === "flag" ? null : control(o);
    radio.addEventListener("change", () => { for (const p of parts) if (p.inner) p.inner.node.hidden = !p.radio.checked; update(); });
    wrap.append(el("label", { class: "bubble" }, radio, el("span", {}, el("span", { class: "name" }, label(o), el("span", { class: "opt-name", text: o.name })))));
    if (inner) { inner.node.hidden = true; details.append(inner.node); }
    parts.push({ o, radio, inner });
  }
  const c = {
    node: el("div", {}, wrap, details),
    args: () => {
      const p = parts.find((x) => x.radio.checked);
      if (!p) return [];
      return p.inner ? p.inner.args() : [p.o.name];
    },
    set: (v, optName) => {
      const p = parts.find((x) => x.o.name === optName);
      if (!p) return;
      p.radio.checked = true;
      for (const q of parts) if (q.inner) q.inner.node.hidden = q !== p;
      if (p.inner) p.inner.set(v);
    },
    changed: () => !none.checked,
    names: options.map((o) => o.name),
  };
  return c;
}

const STUDENT_OPTIONS = ["--class-list", "--blank-cards"];

function buildForm(spec) {
  const groups = $("groups");
  for (const g of spec.groups) for (const o of g.options) kindOf.set(o.name, o.kind);
  for (const g of spec.groups) {
    const body = el("div", {});
    const exclusive = new Map();
    for (const o of g.options) {
      if (o.exclusive !== null && o.exclusive !== undefined) {
        if (!exclusive.has(o.exclusive)) exclusive.set(o.exclusive, []);
        exclusive.get(o.exclusive).push(o);
        continue;
      }
      const c = control(o);
      controls.push(c);
      if (STUDENT_OPTIONS.includes(o.name)) $("students").append(c.node);
      else body.append(c.node);
    }
    for (const opts of exclusive.values()) {
      const c = exclusiveSet(opts, "Every question");
      controls.push(c);
      body.prepend(c.node);
    }
    if (!body.childElementCount) continue;
    const count = el("span", { class: "count" });
    const summary = el("summary", {}, el("span", { text: title(g.title) }), count);
    const details = el("details", { class: "group" }, summary, body);
    details.dataset.count = "";
    groups.append(details);
    controls.filter((c) => body.contains(c.node)).forEach((c) => { c.counter = count; });
  }
  const pw = el("input", { type: "checkbox", id: "use-password" });
  const pwText = el("input", { type: "password", id: "password", autocomplete: "new-password", placeholder: "A long passphrase", hidden: true });
  pw.addEventListener("change", () => { pwText.hidden = !pw.checked; update(); });
  pwText.addEventListener("input", update);
  $("password-box").append(
    el("label", { class: "bubble" }, pw, el("span", {},
      el("span", { class: "name" }, "Protect the answer key with a password", el("span", { class: "opt-name", text: "--password" })),
      el("span", { class: "help", text: "MasterTest Marker asks for it when it scans the key. Use four or more random words." }))),
    pwText);
}

function allArgs() {
  return controls.flatMap((c) => c.args());
}

function update() {
  for (const d of document.querySelectorAll("details.group")) {
    const n = controls.filter((c) => d.contains(c.node) && c.changed()).length;
    d.querySelector(".count").textContent = n ? `${n} set` : "";
  }
  const classList = fileFor.has("--class-list");
  const blanks = Number((controls.find((c) => c.name === "--blank-cards") || { input: { value: 0 } }).input.value || 0);
  $("step-export").classList.toggle("done", !!exportFile);
  $("step-students").classList.toggle("done", classList || blanks > 0);
  const usePw = $("use-password") && $("use-password").checked;
  const pwOk = !usePw || $("password").value.length > 0;
  $("make").disabled = !(ready && !running && exportFile && (classList || blanks > 0) && pwOk);
  $("make").title = !ready ? "MasterTest Web is still loading" : !exportFile ? "Choose a quiz export first"
    : !(classList || blanks > 0) ? "Choose a class list or a number of blank cards" : !pwOk ? "Type the password" : "";
}

// ------------------------------------------------------------------ run

$("export").addEventListener("change", () => {
  exportFile = $("export").files[0] || null;
  $("export-name").textContent = exportFile ? exportFile.name : "No file chosen";
  update();
});

$("extra-files").addEventListener("change", () => {
  const names = [...$("extra-files").files].map((f) => f.name);
  $("extra-files-name").textContent = names.length ? names.join(", ") : "None";
});

$("make").addEventListener("click", async () => {
  running = true;
  update();
  $("log").textContent = "";
  $("result").textContent = "Working…";
  $("result").className = "";
  $("download").hidden = true;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  const files = [];
  const add = async (f) => { files.push({ name: f.name, data: await f.arrayBuffer() }); };
  await add(exportFile);
  for (const f of fileFor.values()) await add(f);
  for (const f of $("extra-files").files) await add(f);
  const usePw = $("use-password").checked;
  const argv = [exportFile.name, ...allArgs(), ...(usePw ? ["--password"] : [])];
  appendLog("exam_generator.py " + argv.map(quote).join(" "), "stdout");
  worker.postMessage({ type: "run", files, argv, password: usePw ? $("password").value : "" },
    files.map((f) => f.data));
});

function finish(ok, data) {
  running = false;
  update();
  if (!ok) {
    $("result").textContent = "Nothing was made. The messages below say what to change.";
    $("result").className = "bad";
    return;
  }
  downloadUrl = URL.createObjectURL(new Blob([data.zip], { type: "application/zip" }));
  const a = $("download");
  a.href = downloadUrl;
  a.download = data.name;
  a.textContent = `Download ${data.name}`;
  a.hidden = false;
  $("result").textContent = `Made in ${data.seconds.toFixed(1)} s.`;
  $("result").className = "ok";
  a.click();
}

// ------------------------------------------------------------------ save and load options

function quote(v) {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : '"' + v.replace(/(["\\])/g, "\\$1") + '"';
}

function splitLine(line) {
  const out = [];
  let cur = null, q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === "\\" && q === '"' && i + 1 < line.length) { cur += line[++i]; }
      else if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") { q = ch; cur = cur ?? ""; }
    else if (/\s/.test(ch)) { if (cur !== null) { out.push(cur); cur = null; } }
    else cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

$("save-options").addEventListener("click", () => {
  const args = allArgs();
  const lines = ["# MasterTest Generator options (use with the desktop program as @options.txt)"];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      lines.push(`${args[i]} ${quote(args[i + 1])}`); i++;
    } else lines.push(args[i]);
  }
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }));
  const a = el("a", { href: url, download: "options.txt" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("load-options").addEventListener("change", async () => {
  const f = $("load-options").files[0];
  if (!f) return;
  const words = (await f.text()).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).flatMap(splitLine);
  const unknown = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) continue;
    let [name, inline] = w.includes("=") ? [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)] : [w, null];
    const negated = name.startsWith("--no-") && !controls.some((c) => c.name === name);
    const key = negated ? "--" + name.slice(5) : name;
    const c = controls.find((x) => x.name === key || (x.names && x.names.includes(key)));
    if (!c) { unknown.push(name); continue; }
    const takesValue = !["flag", "bool"].includes(kindOf.get(key));
    let value = true;
    if (negated) value = false;
    else if (inline !== null) value = inline;
    else if (takesValue && i + 1 < words.length && !words[i + 1].startsWith("--")) value = words[++i];
    c.set(value, key);
  }
  $("load-options").value = "";
  update();
  appendLog(`Loaded options from ${f.name}.` + (unknown.length ? ` Not recognised: ${unknown.join(", ")}.` : ""), "stdout");
});
