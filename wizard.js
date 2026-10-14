// MasterTest Web: the step-by-step page. Step 1 collects the quiz export, an optional class list,
// the layout, variants and blank cards; Generate runs MasterTest Generator in the worker (in this
// tab's memory) and step 2 hands over the zip. The full set of options is on advanced.html.
"use strict";

const $ = (id) => document.getElementById(id);
const worker = new Worker("worker.js");
let ready = false;
let running = false;
let exportFile = null;
let classFile = null;
let downloadUrl = null;

// ------------------------------------------------------------------ layouts

// small pictures of each layout: pages in outline, text as lines, answers as bubbles and cells
const page = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" fill="var(--paper)" stroke="currentColor" stroke-width="1.6"/>`;
const line = (x, y, w) => `<path d="M${x} ${y}h${w}" stroke="currentColor" stroke-width="1.4" opacity=".55"/>`;
const bub = (x, y, filled) => `<circle cx="${x}" cy="${y}" r="1.7" fill="${filled ? "var(--accent)" : "none"}" stroke="currentColor" stroke-width=".9"/>`;
const bubbles = (x, y, n, fill) => Array.from({ length: n }, (_, i) => bub(x + i * 4.4, y, i === fill)).join("");
const cell = (x, y, w) => `<rect x="${x}" y="${y - 1.8}" width="${w}" height="3.6" fill="currentColor" opacity=".22"/>`;
const svg = (body, vb = "0 0 100 70") => `<svg viewBox="${vb}" aria-hidden="true">${body}</svg>`;

const LAYOUTS = [
  {
    id: "booklet", name: "Booklet + Answer Card", args: ["--page-size", "letter"],
    desc: "Questions in a printed booklet, answers on a separate full-page card. Up to 100 answers per card.",
    pic: svg(page(14, 6, 38, 52) + [14, 20, 26, 34, 40, 46].map((y, i) => line(19, y, i % 3 === 2 ? 18 : 27)).join("") +
      page(46, 12, 38, 52) + [20, 27, 34, 41, 48, 55].map((y, i) => bubbles(52, y, 4, (i * 3) % 4) + bubbles(71, y, 3, i % 3)).join("")),
  },
  {
    id: "single", name: "Single Page Quiz", args: ["--page-size", "letter-single-page"],
    desc: "A short quiz on one sheet: the answer area at the top, the questions below.",
    pic: svg(page(30, 4, 40, 60) + [11, 16].map((y, i) => bubbles(35, y, 4, i + 1) + bubbles(54, y, 3, i)).join("") +
      `<path d="M34 21h32" stroke="currentColor" stroke-width=".8"/>` + [27, 32, 39, 44, 51, 56].map((y, i) => line(35, y, i % 2 ? 20 : 28)).join("")),
  },
  {
    id: "merged1", name: "Merged One Column", args: ["--page-size", "letter-merged", "--columns", "1"],
    desc: "Each answer beside its question, in one full-width column. Room for wide written answers.",
    pic: svg(page(28, 4, 44, 60) + [14, 23, 32, 41, 50].map((y, i) => line(32, y, 18) +
      (i % 2 ? cell(54, y, 14) : bubbles(55.5, y, 4, (i + 2) % 4))).join("")),
  },
  {
    id: "merged2", name: "Merged Two Column", args: ["--page-size", "letter-merged"],
    desc: "Each answer beside its question, in two columns. About 30 short questions per page.",
    pic: svg(page(28, 4, 44, 60) + `<path d="M50 10v50" stroke="currentColor" stroke-width=".6" opacity=".5"/>` +
      [14, 22, 30, 38, 46, 54].map((y, i) => line(31, y, 7) + (i === 2 ? cell(39.5, y, 9) : bubbles(40.2, y, 2, i % 2)) +
        line(52, y, 7) + (i === 4 ? cell(60.5, y, 9) : bubbles(61.2, y, 2, (i + 1) % 2))).join("")),
  },
  {
    id: "tabloid", name: "Tabloid Booklet", args: ["--page-size", "tabloid-booklet"],
    desc: "Tabloid sheets printed on both sides and folded into a booklet, with a folded answer card.",
    pic: svg(page(8, 12, 84, 50) + `<path d="M50 12v50" stroke="currentColor" stroke-width="1" stroke-dasharray="2.5 2"/>` +
      [20, 26, 32, 38, 44, 50].map((y, i) => line(13, y, i % 3 === 2 ? 20 : 30) + line(55, y, i % 3 === 1 ? 22 : 31)).join("")),
  },
];
let layout = LAYOUTS[0];

function buildLayouts() {
  const track = $("layouts");
  for (const l of LAYOUTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "layout";
    b.setAttribute("role", "radio");
    b.dataset.id = l.id;
    b.innerHTML = `<span class="pic">${l.pic}</span><span class="name">${l.name}</span><span class="desc">${l.desc}</span>`;
    b.addEventListener("click", () => selectLayout(l.id, false));
    b.addEventListener("keydown", (e) => {
      const i = LAYOUTS.indexOf(l);
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: LAYOUTS.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      selectLayout(LAYOUTS[(to + LAYOUTS.length) % LAYOUTS.length].id, true);
    });
    track.append(b);
  }
  selectLayout(layout.id, false);
  track.addEventListener("scroll", updateNav, { passive: true });
  window.addEventListener("resize", updateNav);
  $("prev").addEventListener("click", () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: smooth() }));
  $("next").addEventListener("click", () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: smooth() }));
  updateNav();
}

function smooth() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function selectLayout(id, focus) {
  layout = LAYOUTS.find((l) => l.id === id);
  for (const b of $("layouts").children) {
    const on = b.dataset.id === id;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) { b.focus(); b.scrollIntoView({ block: "nearest", inline: "nearest", behavior: smooth() }); }
  }
}

function updateNav() {
  const t = $("layouts");
  $("prev").disabled = t.scrollLeft <= 2;
  $("next").disabled = t.scrollLeft + t.clientWidth >= t.scrollWidth - 2;
  $("prev").parentElement.hidden = t.scrollWidth <= t.clientWidth + 2;
}

// ------------------------------------------------------------------ files

function filePicker(inputId, dropId, stateId, empty, onFile) {
  const input = $(inputId), drop = $(dropId);
  const show = (f) => {
    drop.classList.toggle("chosen", !!f);
    $(stateId).textContent = f ? `${f.name} (${f.size < 1024 * 1024 ? Math.max(1, Math.round(f.size / 1024)) + " KB" : (f.size / 1048576).toFixed(1) + " MB"})` : empty;
    onFile(f);
    update();
  };
  input.addEventListener("change", () => show(input.files[0] || null));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (f) show(f);
  });
  return () => { input.value = ""; show(null); };
}

const clearExport = filePicker("export", "export-drop", "export-state", "Choose or drop the .zip file", (f) => { exportFile = f; });
const clearClass = filePicker("classlist", "class-drop", "class-state", "Choose or drop the class list", (f) => {
  classFile = f;
  $("class-clear").hidden = !f;
});
$("class-clear").addEventListener("click", (e) => { e.preventDefault(); clearClass(); });

// ------------------------------------------------------------------ options

for (const b of document.querySelectorAll("[data-step]")) {
  b.addEventListener("click", () => {
    const input = $(b.dataset.step);
    const v = clamp(input, (parseInt(input.value, 10) || 0) + Number(b.dataset.by));
    input.value = v;
    update();
  });
}
for (const id of ["blanks", "variants"]) {
  $(id).addEventListener("input", update);
  $(id).addEventListener("change", () => { $(id).value = clamp($(id), parseInt($(id).value, 10) || 0); update(); });
}
for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", update);

function clamp(input, v) {
  return Math.max(Number(input.min), Math.min(Number(input.max), v));
}

const blanks = () => Math.max(0, parseInt($("blanks").value, 10) || 0);
const mode = () => document.querySelector('input[name="mode"]:checked').value;

function update() {
  const hasClass = !!classFile;
  $("mode").disabled = !hasClass;
  $("exams-hint").textContent = hasClass ? "How the exams for the students on the class list differ."
    : "Choose a class list to use these.";
  const variantsOn = hasClass && mode() === "variants";
  $("variants").disabled = !variantsOn;
  for (const b of document.querySelectorAll('[data-step="variants"]')) b.disabled = !variantsOn;
  const b = blanks();
  document.querySelector('[data-step="blanks"][data-by="-1"]').disabled = b <= 0;
  const ok = ready && !running && exportFile && (hasClass || b > 0);
  $("generate").disabled = !ok;
  $("why").textContent = !exportFile ? "Choose the quiz export to continue."
    : !(hasClass || b > 0) ? "Choose a class list or at least one blank card."
    : !ready ? "Generate is ready once the exam maker has loaded." : "";
}

function argv() {
  const a = [exportFile.name, ...layout.args];
  if (classFile) {
    a.push("--class-list", classFile.name);
    if (mode() === "variants") a.push("--variants", String(clamp($("variants"), parseInt($("variants").value, 10) || 1)));
  }
  if (blanks() > 0) a.push("--blank-cards", String(blanks()));
  return a;
}

// ------------------------------------------------------------------ run

function showStep(n) {
  $("step1").hidden = n !== 1;
  $("step2").hidden = n !== 2;
  $("step1-tab").toggleAttribute("aria-current", n === 1);
  if (n === 1) $("step1-tab").setAttribute("aria-current", "step");
  $("step2-tab").toggleAttribute("aria-current", n === 2);
  if (n === 2) $("step2-tab").setAttribute("aria-current", "step");
  $("step1-tab").classList.toggle("done", n === 2);
  window.scrollTo({ top: 0, behavior: "auto" });
}

$("generate").addEventListener("click", async () => {
  running = true;
  update();
  showStep(2);
  $("big").className = "big-bubble working";
  $("big").textContent = "";
  $("result-title").textContent = "Making your exam…";
  $("result-text").textContent = "This takes a few seconds for a class, longer for large exams.";
  $("download").hidden = true;
  $("back").hidden = true;
  $("log").hidden = true;
  $("log").textContent = "";
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  const files = [{ name: exportFile.name, data: await exportFile.arrayBuffer() }];
  if (classFile) files.push({ name: classFile.name, data: await classFile.arrayBuffer() });
  worker.postMessage({ type: "run", files, argv: argv(), password: "" }, files.map((f) => f.data));
});

$("back").addEventListener("click", () => { showStep(1); $("generate").focus(); });

function finish(ok, data) {
  running = false;
  update();
  $("back").hidden = false;
  if (!ok) {
    $("big").className = "big-bubble bad";
    $("big").innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4"/></svg>';
    $("result-title").textContent = "The exam could not be made";
    $("result-text").textContent = "The message below says what to change. Go back, adjust your choices and generate again.";
    const errors = $("log").textContent.split("\n").filter((l) => l.startsWith("ERROR"));
    $("log").textContent = errors.length ? errors.join("\n").replace(/^ERROR: /gm, "") : $("log").textContent;
    $("log").hidden = false;
    $("back").textContent = "Back to step 1";
    $("result-title").focus();
    return;
  }
  downloadUrl = URL.createObjectURL(new Blob([data.zip], { type: "application/zip" }));
  const a = $("download");
  a.href = downloadUrl;
  a.download = data.name;
  a.textContent = `Download ${data.name} again`;
  a.hidden = false;
  $("big").className = "big-bubble ok";
  $("big").innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6"/></svg>';
  $("result-title").textContent = "Your exam is now downloading";
  $("result-text").textContent = `${data.name} holds the exams, answer cards and answer key, ready to print. ` +
    "Scan the answer key with MasterTest Marker first, then the cards.";
  $("back").textContent = "Make another exam";
  $("result-title").focus();
  a.click();
}

worker.onmessage = ({ data }) => {
  if (data.type === "status") {
    $("engine-detail").textContent = "· " + data.text.replace(/…$/, "");
  } else if (data.type === "ready") {
    ready = true;
    $("engine-state").textContent = "Ready";
    $("engine-detail").textContent = `· loaded in ${data.seconds.toFixed(0)} s`;
    $("version-line").textContent = `MasterTest Web ${data.spec.version}`;
    update();
  } else if (data.type === "error") {
    $("engine-state").textContent = "Could not start";
    $("engine-detail").textContent = "· " + data.text;
  } else if (data.type === "log") {
    $("log").textContent += data.text + "\n";
  } else if (data.type === "done") {
    finish(true, data);
  } else if (data.type === "failed") {
    finish(false, data);
  }
};

buildLayouts();
update();
