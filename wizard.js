// MasterTest Web: the step-by-step page. Step 1 collects the quiz export, an optional class list,
// the question pool, paper size and layout, variants and blank cards; Generate asks for an optional
// answer-key password, runs MasterTest Generator in the worker (in this tab's memory) and step 2
// hands over the zip and the exam configuration (an options file that the command line reads
// too, and that "Load Previous Exam Config" reads back). The full set of options is on advanced.html.
"use strict";

const $ = (id) => document.getElementById(id);
const worker = new Worker("worker.js");
let ready = false;
let running = false;
let exportFile = null;
let classFile = null;
let downloadUrl = null;
// the quiz in the export: reading -> (choose) -> loading -> ready, or error
const quiz = { state: "none", list: [], number: null, summary: null, message: "" };
let paper = "traditional";      // traditional: letter and tabloid; iso: A4 and A3
let extras = [];                // options from a loaded configuration that the page has no control for
let pending = null;             // settings from a loaded configuration still waiting for the export: {quiz, maxItems, titleMap}
let configName = "";
let lastArgs = null;            // the options of the last run, for the configuration download
let configUrl = null;

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
    id: "booklet", name: "Booklet + Answer Card", size: ["letter", "a4"],
    desc: (p) => `Questions in a printed booklet, answers on a separate full-page card. Up to 100 answers per card. ${p.prints}`,
    pic: svg(page(14, 6, 38, 52) + [14, 20, 26, 34, 40, 46].map((y, i) => line(19, y, i % 3 === 2 ? 18 : 27)).join("") +
      page(46, 12, 38, 52) + [20, 27, 34, 41, 48, 55].map((y, i) => bubbles(52, y, 4, (i * 3) % 4) + bubbles(71, y, 3, i % 3)).join("")),
  },
  {
    id: "single", name: "Single Page Quiz", size: ["letter-single-page", "a4-single-page"],
    desc: (p) => `A short quiz on one ${p.sheet}: the answer area at the top, the questions below.`,
    pic: svg(page(30, 4, 40, 60) + [11, 16].map((y, i) => bubbles(35, y, 4, i + 1) + bubbles(54, y, 3, i)).join("") +
      `<path d="M34 21h32" stroke="currentColor" stroke-width=".8"/>` + [27, 32, 39, 44, 51, 56].map((y, i) => line(35, y, i % 2 ? 20 : 28)).join("")),
  },
  {
    id: "merged1", name: "Merged One Column", size: ["letter-merged", "a4-merged"], columns: 1,
    desc: (p) => `Each answer beside its question, in one full-width column. Room for wide written answers. ${p.prints}`,
    pic: svg(page(28, 4, 44, 60) + [14, 23, 32, 41, 50].map((y, i) => line(32, y, 18) +
      (i % 2 ? cell(54, y, 14) : bubbles(55.5, y, 4, (i + 2) % 4))).join("")),
  },
  {
    id: "merged2", name: "Merged Two Column", size: ["letter-merged", "a4-merged"],
    desc: (p) => `Each answer beside its question, in two columns. About 30 short questions per page. ${p.prints}`,
    pic: svg(page(28, 4, 44, 60) + `<path d="M50 10v50" stroke="currentColor" stroke-width=".6" opacity=".5"/>` +
      [14, 22, 30, 38, 46, 54].map((y, i) => line(31, y, 7) + (i === 2 ? cell(39.5, y, 9) : bubbles(40.2, y, 2, i % 2)) +
        line(52, y, 7) + (i === 4 ? cell(60.5, y, 9) : bubbles(61.2, y, 2, (i + 1) % 2))).join("")),
  },
  {
    id: "tabloid", name: (p) => p.big + " Booklet", size: ["tabloid-booklet", "a3-booklet"],
    desc: (p) => `${p.bigSheets} printed on both sides and folded into ${p.booklet}, with a folded answer card.`,
    pic: svg(page(8, 12, 84, 50) + `<path d="M50 12v50" stroke="currentColor" stroke-width="1" stroke-dasharray="2.5 2"/>` +
      [20, 26, 32, 38, 44, 50].map((y, i) => line(13, y, i % 3 === 2 ? 20 : 30) + line(55, y, i % 3 === 1 ? 22 : 31)).join("")),
  },
];
let layout = LAYOUTS[0];

const PAPER = {
  traditional: { prints: "Prints on letter paper (8.5 × 11 in).", sheet: "letter-size sheet (8.5 × 11 in)", big: "Tabloid",
    bigSheets: "Tabloid sheets (11 × 17 in)", booklet: "a letter-size booklet" },
  iso: { prints: "Prints on A4 paper.", sheet: "A4 sheet", big: "A3",
    bigSheets: "A3 sheets", booklet: "an A4 booklet" },
};
const text = (v) => (typeof v === "function" ? v(PAPER[paper]) : v);
const layoutName = (l) => text(l.name);
const layoutArgs = (l) => ["--page-size", l.size[paper === "iso" ? 1 : 0], ...(l.columns === 1 ? ["--columns", "1"] : [])];

function setPaper(value) {
  paper = value;
  for (const r of document.querySelectorAll('input[name="paper"]')) r.checked = r.value === value;
  for (const b of $("layouts").children) {
    const l = LAYOUTS.find((x) => x.id === b.dataset.id);
    b.querySelector(".name").textContent = layoutName(l);
    b.querySelector(".desc").textContent = text(l.desc);
  }
  setMergedAvailable(quiz.state === "ready" ? quiz.summary : null);
  showPrintDefaults();
}
for (const r of document.querySelectorAll('input[name="paper"]')) r.addEventListener("change", () => { if (r.checked) setPaper(r.value); });

function buildLayouts() {
  const track = $("layouts");
  for (const l of LAYOUTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "layout";
    b.setAttribute("role", "radio");
    b.dataset.id = l.id;
    b.innerHTML = `<span class="pic">${l.pic}</span><span class="name"></span><span class="desc"></span>`;
    b.querySelector(".name").textContent = layoutName(l);
    b.querySelector(".desc").textContent = text(l.desc);
    b.addEventListener("click", () => { if (b.getAttribute("aria-disabled") !== "true") selectLayout(l.id, false); });
    b.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      const usable = LAYOUTS.filter((x) => !x.unavailable);
      let to;
      if (e.key === "Home") to = usable[0];
      else if (e.key === "End") to = usable[usable.length - 1];
      else if (step) {
        let i = LAYOUTS.indexOf(l);
        do { i = (i + step + LAYOUTS.length) % LAYOUTS.length; } while (LAYOUTS[i].unavailable);
        to = LAYOUTS[i];
      }
      if (!to) return;
      e.preventDefault();
      selectLayout(to.id, true);
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
  if (typeof showPrintDefaults === "function" && $("po-calc")) showPrintDefaults();
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

const clearExport = filePicker("export", "export-drop", "export-state", "Choose or drop the .zip file", (f) => {
  exportFile = f;
  Object.assign(quiz, { state: f ? "reading" : "none", list: [], number: null, summary: null, message: "" });
  setMergedAvailable(null);
  showQuiz();
  if (f && ready) inspectExport();
});

// ------------------------------------------------------------------ the quiz in the export

async function inspectExport() {
  const f = exportFile;
  const data = await f.arrayBuffer();
  if (f !== exportFile) return;            // another file was chosen meanwhile
  worker.postMessage({ type: "inspect", name: f.name, data }, [data]);
}

async function requestSummary(number) {
  Object.assign(quiz, { state: "loading", number, summary: null });
  showQuiz();
  const data = await exportFile.arrayBuffer();
  worker.postMessage({ type: "summary", name: exportFile.name, number, data }, [data]);
}

function onQuizzes(data) {
  if (!exportFile || data.name !== exportFile.name) return;
  const r = data.result;
  if (r.error) {
    Object.assign(quiz, { state: "error", message: r.error });
  } else {
    quiz.list = r.quizzes;
    if (r.quizzes.length === 1) { requestSummary(1); return; }
    Object.assign(quiz, { state: "choose", number: null });
    const wanted = pending && pending.quiz;
    if (wanted && wanted <= r.quizzes.length) {
      showQuiz();
      const radio = document.querySelector(`#quiz-list input[value="${wanted}"]`);
      if (radio) radio.checked = true;
      requestSummary(wanted);
      return;
    }
  }
  showQuiz();
}

function onSummary(data) {
  if (!exportFile || data.name !== exportFile.name || data.number !== quiz.number) return;
  const r = data.result;
  if (r.error) Object.assign(quiz, { state: "error", message: r.error });
  else Object.assign(quiz, { state: "ready", summary: r });
  setMergedAvailable(r.error ? null : r);
  if (!r.error) resetPool(r);
  showQuiz();
}

function showQuiz() {
  $("quiz").hidden = quiz.state === "none";
  const status = $("quiz-status");
  status.className = "quiz-status" + (quiz.state === "error" ? " bad" : "");
  status.textContent = { reading: ready ? "Reading the export…" : "The export will be read once the exam maker has loaded.",
    loading: "Reading the quiz…", error: quiz.message }[quiz.state] || "";
  status.hidden = !status.textContent;
  // the list of quizzes, when there is more than one
  const many = quiz.list.length > 1 && quiz.state !== "error";
  $("quiz-choice").hidden = !many;
  if (many && $("quiz-list").dataset.for !== exportFile.name) {
    $("quiz-list").dataset.for = exportFile.name;
    $("quiz-count").textContent = quiz.list.length;
    $("quiz-list").replaceChildren(...quiz.list.map((q) => {
      const label = document.createElement("label");
      label.className = "bubble";
      label.innerHTML = `<input type="radio" name="quiz" value="${q.number}"><span class="label"></span>`;
      label.querySelector(".label").textContent = q.title;
      label.querySelector("input").addEventListener("change", () => requestSummary(q.number));
      return label;
    }));
  }
  if (!many) $("quiz-list").dataset.for = "";
  // what the chosen quiz holds
  const s = quiz.summary;
  $("quiz-summary").hidden = !(quiz.state === "ready" && s);
  $("pool").hidden = !(quiz.state === "ready" && s);
  if (quiz.state === "ready" && s) {
    $("sum-n").textContent = s.questions;
    $("sum-unit").textContent = s.questions === 1 ? "question" : "questions";
    $("sum-title").textContent = s.title;
    $("sum-kinds").textContent = Object.entries(s.kinds).map(([k, n]) => `${n} ${k}`).join(", ");
    const notes = [];
    if (s.per_exam_with_banks !== null && s.per_exam_with_banks !== s.questions)
      notes.push(`The quiz draws ${s.per_exam_with_banks} of them from question groups; every question is printed unless you alter the question pool.`);
    if (s.omitted) notes.push(`${s.omitted} question${s.omitted === 1 ? " was" : "s were"} left out because ${s.omitted === 1 ? "it" : "they"} cannot be printed: ` +
      s.warnings.filter((w) => w.includes("omitted")).map((w) => w.replace(/^Question /, "")).join("; "));
    if (!s.merged1_ok) notes.push(`At least one question has ${s.max_options} options, so the Merged One Column and Merged Two Column Layouts are not available. ` +
      "If you want to use them make sure multiple-choice questions have no more than 6 options (4 for Merged Two Column).");
    else if (!s.merged_ok) notes.push(`At least one question has ${s.max_options} options, so the Merged Two Column Layout is not available. ` +
      "If you want to use this layout make sure multiple-choice questions have no more than 4 options.");
    $("sum-note").textContent = notes.join(" ");
    $("sum-note").hidden = !notes.length;
  }
  update();
}

// merged sheets print at most six options (A-F) per question in one column, four (A-D) in two
const MERGED_LIMIT = { merged1: ["merged1_ok", 6], merged2: ["merged_ok", 4] };
function setMergedAvailable(summary) {
  for (const l of LAYOUTS) {
    if (!MERGED_LIMIT[l.id]) continue;
    const [key, most] = MERGED_LIMIT[l.id];
    const ok = !summary || summary[key];
    l.unavailable = !ok;
    const b = document.querySelector(`.layout[data-id="${l.id}"]`);
    if (!b) continue;
    b.setAttribute("aria-disabled", String(!ok));
    let note = b.querySelector(".why-not");
    if (!ok && !note) { note = document.createElement("span"); note.className = "why-not"; b.append(note); }
    if (note) {
      note.hidden = ok;
      note.textContent = ok ? "" : `Not for this quiz: a question has ${summary.max_options} options, and this layout shows at most ${most}.` +
        (l.id === "merged2" && summary.merged1_ok ? " Merged One Column can." : "");
    }
  }
  if (layout.unavailable) selectLayout(LAYOUTS[0].id, false);
}
const clearClass = filePicker("classlist", "class-drop", "class-state", "Choose or drop the class list", (f) => {
  classFile = f;
  $("class-clear").hidden = !f;
  Object.assign(cls, { state: f ? "reading" : "none", summary: null, message: "" });
  showClass();
  if (f && ready) inspectClass();
});
$("class-clear").addEventListener("click", (e) => { e.preventDefault(); clearClass(); });

// ------------------------------------------------------------------ the class list

// what the class list holds (read by the worker) and the page's class-list options
const cls = {
  state: "none", summary: null, message: "",
  id: "",                 // --student-id-column; "" = the column the program finds
  qr: [],                 // --add-qr-field
  randomize: false,       // --randomize-seats, or --seat-labels when labels are given
  att: [],                // --add-attendance-field
  sort: "", desc: false,  // --attendance-sort
  orient: "portrait",     // --attendance-orientation
};
let classAsked = 0;

// comma-separated values as the program reads them (double quotes protect commas)
function csvSplit(text) {
  const out = [];
  let cur = "", q = false, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"' && !cur.trim()) { q = true; cur = ""; started = true; }
    else if (c === ",") { out.push(cur.trim()); cur = ""; started = false; }
    else { cur += c; started = true; }
  }
  if (started || cur.trim()) out.push(cur.trim());
  return out.filter((x) => x);
}
const csvJoin = (items) => items.map((v) => (/[",]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v)).join(",");

// seat labels: one per line when there are several lines, otherwise comma-separated
function seatLabels() {
  const lines = $("seat-labels").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const all = lines.length > 1 ? lines : csvSplit(lines[0] || "");
  return [...new Set(all)];
}

async function inspectClass() {
  const f = classFile;
  const data = await f.arrayBuffer();
  if (f !== classFile) return;
  classAsked++;
  worker.postMessage({ type: "classlist", name: f.name, data, id: cls.id, qr: csvJoin(cls.qr), ask: classAsked }, [data]);
}

function onClasslist(data) {
  if (!classFile || data.name !== classFile.name) return;
  const r = data.result;
  const notes = [];
  // options that do not fit this class list
  if (r.columns && r.columns.length) {
    const has = (c) => r.columns.some((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "") === c.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (cls.id && !has(cls.id)) { notes.push(`it has no column “${cls.id}”, so the student ID column is found automatically`); cls.id = ""; }
    const gone = cls.qr.filter((c) => !has(c));
    if (gone.length) { notes.push(`it has no ${gone.map((g) => `“${g}”`).join(", ")} column for the QR code`); cls.qr = cls.qr.filter(has); }
    if (notes.length) { inspectClass(); showConfigNote("For this class list: " + notes.join("; ") + "."); return; }
  }
  cls.summary = r;
  cls.state = r.error ? "error" : "ready";
  cls.message = r.error || "";
  showClass();
}

function showClass() {
  const on = cls.state !== "none";
  $("classinfo").hidden = !on;
  const r = cls.summary;
  const st = $("class-status");
  st.className = "quiz-status" + (cls.state === "error" ? " bad" : "");
  st.textContent = cls.state === "reading" ? (ready ? "Reading the class list…" : "The class list will be read once the exam maker has loaded.")
    : cls.state === "error" ? cls.message : "";
  st.hidden = !st.textContent;
  const usable = r && r.columns && r.columns.length;
  // the grey box: the details once read, and the options (also after an error they can fix,
  // such as no student-number column)
  $("class-box").hidden = !usable;
  $("class-summary").hidden = !(cls.state === "ready");
  if (cls.state === "ready") {
    $("cls-n").textContent = r.students;
    $("cls-unit").textContent = r.students === 1 ? "student" : "students";
    $("cls-title").textContent = classFile.name;
    $("cls-id").textContent = r.number_column;
    $("cls-id-how").textContent = cls.id ? "(chosen in Class list options)" : "(found automatically)";
    $("cls-qr").textContent = r.qr_fields.map((f) => (f === "Card serial" ? "card serial" : f)).join(", ");
    $("cls-cols").textContent = r.columns.join(", ");
    const notes = [];
    if (r.skipped) notes.push(`${r.skipped} row${r.skipped === 1 ? " was" : "s were"} skipped because ${r.skipped === 1 ? "its" : "their"} student ID is empty (such as Canvas's Test Student or Points Possible rows).`);
    if (r.seat_column && !cls.randomize) notes.push(r.seats_in_list === 0 ? `The “${r.seat_column}” column is empty: tick Randomize seats to give everyone a seat.`
      : `Seats come from the “${r.seat_column}” column${r.seats_in_list < r.students ? ` (${r.students - r.seats_in_list} student${r.students - r.seats_in_list === 1 ? " has" : "s have"} none)` : ""}.`);
    const other = r.warnings.filter((w) => !w.includes("was skipped"));
    if (other.length) notes.push(other.join(" "));
    $("cls-note").textContent = notes.join(" ");
    $("cls-note").hidden = !notes.length;
  }
  if (usable) showClassOptions();
  update();
}

const sameKey = (a, b) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

function showClassOptions() {
  const r = cls.summary;
  const idNow = cls.id || r.number_column || r.detected_number_column || "";
  const n = r.students || r.rows;
  // seats
  $("randomize").checked = cls.randomize;
  const labels = seatLabels();
  $("randomize-sub").textContent = labels.length
    ? `Each student gets a random seat from your ${labels.length} seat label${labels.length === 1 ? "" : "s"}, printed on their card and the attendance sheet.`
    : `Each student gets a random seat from 1 to ${n}, printed on their card and the attendance sheet` +
      (r.seat_column ? ` (in place of the “${r.seat_column}” column).` : ".");
  const count = $("seat-count");
  count.hidden = !labels.length;
  if (labels.length) {
    const short = r.students && labels.length < r.students;
    count.classList.toggle("bad", !!short);
    count.textContent = short ? `${labels.length} seat${labels.length === 1 ? "" : "s"} for ${r.students} students: add ${r.students - labels.length} more.`
      : `${labels.length} seats for ${r.students || "the"} students` + (r.students && labels.length > r.students ? ` (${labels.length - r.students} ${labels.length - r.students === 1 ? "stays" : "stay"} empty).` : ".");
  }
  // student ID column
  const sel = $("id-col");
  const want = cls.id || "";
  sel.replaceChildren(...[["", `Found automatically${r.detected_number_column ? `: ${r.detected_number_column}` : " (none found)"}`],
    ...r.columns.filter((c) => c !== r.name_column).map((c) => [c, c])].map(([v, t]) => new Option(t, v, false, v === want)));
  $("id-default").textContent = r.detected_number_column ? `Default: ${r.detected_number_column}` : "No column has a student-number heading: choose one.";
  // QR fields
  $("qr-fixed").replaceChildren(...[r.name_column || "Student name", idNow, "Card serial"].filter(Boolean).map((t) => chip(t, "always")));
  const extra = r.columns.filter((c) => c !== r.name_column && !sameKey(c, idNow) && !(r.name_column || "").includes(c));
  $("qr-extra").replaceChildren(...extra.map((c) => {
    const l = document.createElement("label");
    l.className = "check";
    l.innerHTML = `<input type="checkbox"><span class="label"></span>`;
    l.querySelector(".label").textContent = c;
    const box = l.querySelector("input");
    box.checked = cls.qr.some((q) => sameKey(q, c));
    box.addEventListener("change", () => {
      cls.qr = extra.filter((x) => (x === c ? box.checked : cls.qr.some((q) => sameKey(q, x))));
      cls.state = "reading"; showClass(); inspectClass();
    });
    return l;
  }));
  // attendance sheet
  const cols = attendanceColumns();
  $("att-cols").replaceChildren(...cols.map((c) => {
    const li = chip(c.label, c.why, c.removable ? () => { cls.att = cls.att.filter((a) => !sameKey(a, c.label)); showClassOptions(); update(); } : null);
    return li;
  }));
  const addable = r.columns.filter((c) => !cols.some((x) => sameKey(x.label, c)) && c !== r.name_column && !sameKey(c, idNow));
  const add = $("att-add");
  const keep = add.value;
  add.replaceChildren(...addable.map((c) => new Option(`${c} (from the class list)`, c)), new Option("A blank column to fill in…", "\u0000blank"));
  if ([...add.options].some((o) => o.value === keep)) add.value = keep;
  $("att-blank").hidden = add.value !== "\u0000blank";
  // sort
  const sort = $("att-sort");
  const sortable = [...cols.filter((c) => c.sortable).map((c) => c.label),
    ...r.columns.filter((c) => !cols.some((x) => sameKey(x.label, c)) && c !== r.name_column && !sameKey(c, idNow))];
  const groups = [new Option("Class list order", "")];
  for (const c of sortable) groups.push(new Option(c, c));
  sort.replaceChildren(...groups);
  const match = sortable.find((c) => cls.sort && sameKey(c, cls.sort));
  if (cls.sort && !match) sort.append(new Option(cls.sort, cls.sort));   // from a configuration
  sort.value = match || cls.sort || "";
  $("att-dir").value = cls.desc ? "desc" : "asc";
  $("att-dir").disabled = !sort.value;
  for (const o of document.querySelectorAll('input[name="orient"]')) o.checked = o.value === cls.orient;
}

// the attendance sheet's columns as the program makes them
function attendanceColumns() {
  const r = cls.summary;
  const idNow = cls.id || r.number_column || r.detected_number_column || "student ID";
  const cols = [{ label: "Student Name", why: "always", sortable: true },
    { label: "Student Number", why: `always: ${idNow}`, sortable: true }];
  const seatAdded = cls.att.some((a) => ["seat", "seatnumber", "seatno"].includes(a.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (cls.randomize && !seatAdded) cols.push({ label: "Seat", why: "seats are randomized", sortable: true });
  for (const a of cls.att) {
    if (["studentname", "name", "fullname", "studentnumber"].includes(a.toLowerCase().replace(/[^a-z0-9]/g, "")) || sameKey(a, idNow)) continue;
    const inList = r.columns.some((c) => sameKey(c, a));
    cols.push({ label: a, why: inList ? "" : "blank", removable: true, sortable: inList || ["seat", "seatnumber", "seatno"].includes(a.toLowerCase().replace(/[^a-z0-9]/g, "")) });
  }
  cols.push({ label: "Signature", why: "always", sortable: false });
  return cols;
}

function chip(text, why, remove) {
  const li = document.createElement("li");
  li.className = "chip" + (remove ? "" : " locked");
  const t = document.createElement("span");
  t.textContent = text;
  li.append(t);
  if (why) { const w = document.createElement("span"); w.className = "why"; w.textContent = why; li.append(w); }
  if (remove) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", `Remove ${text}`);
    b.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2 2 10" stroke="currentColor" stroke-width="1.8"/></svg>';
    b.addEventListener("click", remove);
    li.append(b);
  }
  return li;
}

function classProblem() {
  if (!classFile) return "";
  if (cls.state === "reading") return "Reading the class list…";
  if (cls.state === "error") return "Fix the class list, or choose its student ID column under Class list options.";
  if (cls.randomize) {
    const labels = seatLabels();
    if (labels.length && cls.summary && labels.length < cls.summary.students)
      return `Add seat labels: ${labels.length} for ${cls.summary.students} students.`;
  }
  return "";
}

function classArgs() {
  if (!classFile) return [];
  const a = [];
  if (cls.id) a.push("--student-id-column", cls.id);
  if (cls.qr.length) a.push("--add-qr-field", csvJoin(cls.qr));
  if (cls.randomize) {
    const labels = seatLabels();
    if (labels.length) a.push("--seat-labels", csvJoin(labels));
    else a.push("--randomize-seats");
  }
  if (cls.att.length) a.push("--add-attendance-field", csvJoin(cls.att));
  if (cls.sort) a.push("--attendance-sort", csvJoin([cls.sort + (cls.desc ? " desc" : "")]));
  if (cls.orient !== "portrait") a.push("--attendance-orientation", cls.orient);
  return a;
}

$("randomize").addEventListener("change", () => { cls.randomize = $("randomize").checked; showClass(); });
$("seat-labels").addEventListener("input", () => {
  if ($("seat-labels").value.trim() && !cls.randomize) cls.randomize = true;
  showClassOptions(); update();
});
$("id-col").addEventListener("change", () => { cls.id = $("id-col").value; cls.state = "reading"; showClass(); inspectClass(); });
$("att-add").addEventListener("change", () => { $("att-blank").hidden = $("att-add").value !== "\u0000blank"; if (!$("att-blank").hidden) $("att-blank").focus(); });
function addAttendance() {
  const v = $("att-add").value === "\u0000blank" ? $("att-blank").value.trim() : $("att-add").value;
  if (!v || attendanceColumns().some((c) => sameKey(c.label, v))) { $("att-blank").focus(); return; }
  cls.att.push(v);
  $("att-blank").value = "";
  showClassOptions(); update();
}
$("att-add-btn").addEventListener("click", addAttendance);
$("att-blank").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addAttendance(); } });
$("att-sort").addEventListener("change", () => { cls.sort = $("att-sort").value; $("att-dir").disabled = !cls.sort; update(); });
$("att-dir").addEventListener("change", () => { cls.desc = $("att-dir").value === "desc"; update(); });
for (const o of document.querySelectorAll('input[name="orient"]')) o.addEventListener("change", () => { if (o.checked) cls.orient = o.value; update(); });

// ------------------------------------------------------------------ print options

const PO = {
  font: ["po-font", "--font"], fontSize: ["po-font-size", "--font-size"],
  spacing: ["po-spacing", "--question-spacing"], optionFont: ["po-option-font", "--option-font"],
  optionSize: ["po-option-size", "--option-font-size"], calc: ["po-calc", "--calculated-instructions"],
  fill: ["po-fill", "--fill-blank-instructions"], blank: ["po-blank", "--fill-blank-text"],
  width: ["po-width", "--answer-width"], shading: ["po-shading", "--cell-shading"],
};
const SIDES = ["left", "right", "top", "bottom"];
const marginMode = () => document.querySelector('input[name="po-margin-mode"]:checked').value;
const aciMode = () => document.querySelector('input[name="po-aci"]:checked').value;
let aciFiles = [];      // the answer-card instructions file and its images
const PO_FLAGS = { "po-pad": "--pad-options", "po-points": "--show-points", "po-noinstr": "--no-quiz-instructions" };
const STANDARD_CALC = "Write your answer in the boxes on the answer card: one digit, minus sign or decimal point per box.";
const STANDARD_FILL = "Write your answer in the box on the answer card.";

function printArgs() {
  const a = [];
  if (marginMode() === "all") { if ($("po-margin").value.trim()) a.push("--margin", $("po-margin").value.trim()); }
  else for (const side of SIDES) { const v = $("po-margin-" + side).value.trim(); if (v) a.push("--margin-" + side, v); }
  if (aciMode() === "none") a.push("--answer-card-instructions", "none");
  else if (aciMode() === "file" && aciHtml()) a.push("--answer-card-instructions", aciHtml().name);
  for (const [id, opt] of Object.values(PO)) {
    const v = $(id).value.trim();
    if (v) a.push(opt, v);
  }
  if (document.querySelector('input[name="po-marker"]:checked').value === "nodot") a.push("--no-option-dot");
  const cols = parseInt($("po-option-columns").value, 10);
  if (cols > 1) a.push("--option-columns", String(cols));
  for (const [id, opt] of Object.entries(PO_FLAGS)) if ($(id).checked) a.push(opt);
  return a;
}

// why Generate cannot go ahead with these print options, or ""
function printProblem() {
  const fs = $("po-font-size").value.trim(), os = $("po-option-size").value.trim();
  if (fs && !(Number(fs) >= 4 && Number(fs) <= 72)) return "Print Options: the font size must be from 4 to 72 points.";
  if (os && !(Number(os) >= 4 && Number(os) <= 72)) return "Print Options: the option font size must be from 4 to 72 points.";
  const cols = $("po-option-columns").value.trim();
  if (cols && !(Number.isInteger(Number(cols)) && Number(cols) >= 1 && Number(cols) <= 6)) return "Print Options: option columns must be from 1 to 6.";
  const lengths = [["po-spacing", "question spacing"], ["po-width", "answer field width"],
    ...(marginMode() === "all" ? [["po-margin", "margins"]] : SIDES.map((side) => ["po-margin-" + side, side + " margin"]))];
  for (const [id, what] of lengths) {
    const v = $(id).value.trim();
    if (v && !/^\d+(\.\d+)?\s*(in|cm|mm|pt)?$/i.test(v)) return `Print Options: write the ${what} as a number and a unit, such as 0.75in, 2cm, 20mm or 54pt.`;
    if (id.startsWith("po-margin") && /^\d+(\.\d+)?$/.test(v) && Number(v) < 5) return `Print Options: a margin of ${v} without a unit is ${v} points. Did you mean ${v}in or ${v}cm?`;
  }
  const sh = $("po-shading").value.trim();
  if (sh && !(Number(sh) >= 0 && Number(sh) <= 100)) return "Print Options: cell shading is a percentage from 0 to 100.";
  if (aciMode() === "file" && !aciHtml()) return "Print Options: choose your answer card instructions file (.html), or pick Standard or None.";
  const seed = $("adv-seed").value.trim();
  if (seed && !/^\d{1,10}$/.test(seed)) return "Advanced Options: the seed is a whole number.";
  return "";
}

const aciHtml = () => aciFiles.find((f) => /\.html?$/i.test(f.name));

function showMargins() {
  const each = marginMode() === "each";
  $("po-margin-all").hidden = each;
  $("po-margin-each").hidden = !each;
  // a value typed for all sides is the starting point for each side
  if (each && $("po-margin").value.trim()) for (const side of SIDES) if (!$("po-margin-" + side).value) $("po-margin-" + side).value = $("po-margin").value.trim();
}
for (const r of document.querySelectorAll('input[name="po-margin-mode"]')) r.addEventListener("change", () => { showMargins(); update(); });
for (const r of document.querySelectorAll('input[name="po-aci"]')) r.addEventListener("change", () => { $("po-aci-file-row").hidden = aciMode() !== "file"; update(); });
$("po-aci-file").addEventListener("change", () => {
  aciFiles = [...$("po-aci-file").files];
  const html = aciHtml();
  $("po-aci-state").textContent = !aciFiles.length ? "An .html file (the same tags as question text); choose its images along with it."
    : !html ? "No .html file among the files chosen."
    : `${html.name}` + (aciFiles.length > 1 ? ` and ${aciFiles.length - 1} image${aciFiles.length === 2 ? "" : "s"}` : "");
  update();
});

// ------------------------------------------------------------------ page options and advanced options

const PAGE_DESC = {
  "collate-exams": { booklet: "All exam booklets in one file, exams.pdf, instead of one file per student.",
    single: "All quizzes in one file, quizzes.pdf (the same as Collate answer cards for this layout).",
    duplex: "All folded booklets in one file, exams.pdf." },
  "collate-answer-cards": { booklet: "All answer cards in one file, answer_cards.pdf, instead of one file per student.",
    single: "All quizzes in one file, quizzes.pdf (the same as Collate exams for this layout).",
    duplex: "All folded answer cards in one file, answer_cards.pdf." },
  "title-page": { booklet: "Each booklet starts with a title page: the quiz title and the student's name, number and seat.",
    single: null, duplex: "Always on for folded booklets: page 1 is the title page." },
  "collate-title-pages": { booklet: "Title pages are printed separately, all in one file, title_pages.pdf, and the booklets start at question 1. Useful with variants: every student still gets a personal title page.",
    single: null, duplex: null },
  "pad-title-page": { booklet: "A blank page after the title page, so the questions start on a new sheet when printed double-sided. Needs Title page or Collate title pages.",
    single: null, duplex: "Leaves page 2 of the booklet blank, so the questions start on a right-hand page." },
  "pad-exam": { booklet: "Blank pages after each booklet, so the next student's booklet starts on a new sheet when printed double-sided.",
    single: "A blank page after each quiz, so each starts on a new sheet when printed double-sided (the same as Pad answer cards here).",
    duplex: false },
  "pad-answer-cards": { booklet: "A blank page after every answer card, so each card is on its own sheet when printed double-sided.",
    single: "A blank page after each quiz, so each starts on a new sheet when printed double-sided (the same as Pad exam here).",
    duplex: false },
};
const layoutKind = () => (layout.id === "tabloid" ? "duplex" : layout.id === "booklet" ? "booklet" : "single");

function showPageOptions() {
  const kind = layoutKind();
  const titles = [...document.querySelectorAll("#page-opts input")].filter((b) => ["title-page", "collate-title-pages"].includes(b.dataset.po) && b.checked && !b.disabled).length;
  for (const box of document.querySelectorAll("#page-opts input")) {
    const d = PAGE_DESC[box.dataset.po][kind];
    let off = d === null || d === false;
    let text = d === null ? "Not for this layout: the questions and answers start on the first page." + (kind === "duplex" ? "" : "")
      : d === false ? "Not needed: folded booklets and cards are always padded." : d;
    if (kind === "duplex" && box.dataset.po === "collate-title-pages") text = "Not for folded booklets: the title page is always the booklet's first page.";
    if (box.dataset.po === "title-page" && kind === "duplex") { box.checked = true; off = true; }
    else if (box.dataset.po === "title-page" && box.disabled && !off) box.checked = false;
    if (box.dataset.po === "pad-title-page" && kind === "booklet" && !titles) { off = true; }
    box.disabled = off;
    box.closest("label").classList.toggle("off", off);
    box.closest("label").querySelector("[data-desc]").textContent = text;
  }
  $("pg-layout-note").textContent = `For the ${layoutName(layout)} layout.` +
    (kind === "single" ? " The quiz and its answers are on the same pages, so the exam and answer-card options mean the same." : "");
}
function pageArgs() {
  const on = [...document.querySelectorAll("#page-opts input")].filter((b) => b.checked && !b.disabled).map((b) => b.dataset.po);
  return on.length ? ["--page-options", on.join(",")] : [];
}
for (const box of document.querySelectorAll("#page-opts input")) box.addEventListener("change", () => { showPageOptions(); update(); });

function advArgs() {
  const a = [];
  if ($("adv-qr").value) a.push("--qr-quality", $("adv-qr").value);
  if ($("adv-seed").value.trim()) a.push("--seed", $("adv-seed").value.trim());
  return a;
}
for (const el of ["adv-qr", "adv-seed"]) { $(el).addEventListener("input", update); $(el).addEventListener("change", update); }
function showPrintDefaults() {
  const merged = layout.id.startsWith("merged");
  $("po-font-size").placeholder = merged ? "9" : "11";
  $("po-font-size-hint").textContent = `points (default ${merged ? "9 on merged sheets" : "11"})`;
  $("po-calc").placeholder = merged ? "(none on merged sheets: the header says how to answer)" : STANDARD_CALC;
  $("po-fill").placeholder = merged ? "(none on merged sheets: the header says how to answer)" : STANDARD_FILL;
  const iso = paper === "iso";
  const w = layout.id === "merged1" ? "180pt" : layout.id === "merged2" ? "90pt" : iso ? "91pt" : "95pt";
  $("po-width").placeholder = w;
  $("po-width-hint").textContent = `width of the written-answer boxes; bubbles and number cells scale with it (default ${w} for this layout; ` +
    (layout.id === "merged1" ? "60–255pt)" : layout.id === "merged2" ? `60–${iso ? 139 : 148}pt)` : "50pt up)");
  showPageOptions();
  $("po-pad").closest("label").querySelector(".sub").textContent = merged
    ? "Merged sheets print four bubbles (A–D) for every multiple-choice question, six (A–F) for questions with five or six options."
    : "Answer cards print six bubbles (A–F) for every multiple-choice question, not one per printed option.";
}

for (const el of document.querySelectorAll("#print-details input, #print-details select")) {
  el.addEventListener("input", update);
  el.addEventListener("change", update);
}

function setPrintOptions(got) {
  let any = false;
  for (const [id, opt] of Object.values(PO)) {
    if (!(opt in got)) { $(id).value = ""; continue; }
    let v = got[opt] === "" ? "none" : got[opt];
    if (id === "po-shading") v = v.toLowerCase() === "none" ? "0" : v.replace(/%$/, "");
    if (id === "po-font" || id === "po-option-font") {
      const m = [...$(id).options].find((o) => o.value.toLowerCase() === v.toLowerCase() || o.text.toLowerCase() === v.toLowerCase());
      if (m) v = m.value; else { $(id).append(new Option(v, v)); }   // a font file or name from the desktop
      if (id === "po-font" && v.toLowerCase() === "helvetica") v = "";
    }
    $(id).value = v;
    any = true;
  }
  for (const r of document.querySelectorAll('input[name="po-marker"]')) r.checked = r.value === (got["--no-option-dot"] ? "nodot" : "dot");
  // margins: all sides, or each side when a side is given
  const sides = SIDES.filter((side) => got["--margin-" + side]);
  for (const r of document.querySelectorAll('input[name="po-margin-mode"]')) r.checked = r.value === (sides.length ? "each" : "all");
  $("po-margin").value = got["--margin"] || "";
  for (const side of SIDES) $("po-margin-" + side).value = got["--margin-" + side] || (sides.length && got["--margin"]) || "";
  showMargins();
  any = any || !!got["--margin"] || sides.length > 0;
  // answer card instructions
  const aci = got["--answer-card-instructions"];
  const aciWant = aci === undefined ? "standard" : (aci === "" || aci.toLowerCase() === "none") ? "none" : "file";
  for (const r of document.querySelectorAll('input[name="po-aci"]')) r.checked = r.value === aciWant;
  $("po-aci-file-row").hidden = aciWant !== "file";
  if (aciWant === "file" && !(aciHtml() && aciHtml().name === aci.split(/[\\/]/).pop())) {
    aciFiles = []; $("po-aci-file").value = "";
    $("po-aci-state").textContent = `The configuration used ${aci}: choose it (and its images) again.`;
  }
  any = any || aciWant !== "standard";
  $("po-option-columns").value = got["--option-columns"] || "1";
  for (const [id, opt] of Object.entries(PO_FLAGS)) $(id).checked = !!got[opt];
  any = any || got["--no-option-dot"] || got["--option-columns"] || Object.values(PO_FLAGS).some((o) => got[o]);
  if (any) $("print-details").open = true;
  return any;
}

// ------------------------------------------------------------------ options

for (const b of document.querySelectorAll("[data-step]")) {
  b.addEventListener("click", () => {
    const input = $(b.dataset.step);
    const v = clamp(input, (parseInt(input.value, 10) || 0) + Number(b.dataset.by));
    input.value = v;
    update();
  });
}
for (const id of ["blanks", "variants", "limit"]) {
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
  const quizReady = quiz.state === "ready";
  const poolProblem = quizReady ? showPool() : "";
  const classIssue = classProblem() || printProblem();
  const ok = ready && !running && exportFile && quizReady && (hasClass || b > 0) && !poolProblem && !classIssue;
  $("generate").disabled = !ok;
  $("why").textContent = !exportFile ? "Choose the quiz export to continue."
    : !ready ? "Generate is ready once the exam maker has loaded."
    : quiz.state === "error" ? "Choose a Canvas quiz export (.zip) to continue."
    : quiz.state === "choose" ? "Choose which quiz to print."
    : !quizReady ? "Reading the quiz…"
    : !(hasClass || b > 0) ? "Choose a class list or at least one blank card."
    : poolProblem || classIssue;
}

// the options for a run, without the files: the configuration that can be saved and loaded
function options() {
  const a = [...layoutArgs(layout)];
  if (quiz.list.length > 1) a.push("--quiz", String(quiz.number));
  if (classFile && mode() === "variants") a.push("--variants", String(clamp($("variants"), parseInt($("variants").value, 10) || 1)));
  a.push(...classArgs());
  a.push(...printArgs());
  a.push(...pageArgs());
  a.push(...advArgs());
  if (blanks() > 0) a.push("--blank-cards", String(blanks()));
  if (!extras.includes("--use-item-banks")) a.push(...poolArgs());
  return [...a, ...extras];
}

function argv(password) {
  return [exportFile.name, ...(classFile ? ["--class-list", classFile.name] : []), ...options(), ...(password ? ["--password"] : [])];
}

// ------------------------------------------------------------------ the question pool

// --max-items (a number of questions drawn from the whole quiz) or --title-map (questions with the
// same name form a bank; a number drawn from each). The program allows one of them at a time.
const pool = { total: 0, titles: [], classic: false };

function resetPool(s) {
  pool.total = s.questions;
  pool.titles = s.titles;
  pool.classic = s.engine === "classic";
  $("limit").max = String(s.questions);
  $("limit").value = String(s.questions);
  $("limit-of").textContent = `of ${s.questions} question${s.questions === 1 ? "" : "s"} (default: all ${s.questions})`;
  $("simulate").checked = false;
  $("simulate").disabled = !pool.classic;
  $("simulate-sub").textContent = pool.classic
    ? "Questions with the same name form a bank. Choose how many questions each exam draws from each name."
    : "Only for Classic Quizzes exports: New Quizzes do not keep question names in their exports.";
  $("titles").replaceChildren(...s.titles.map((t, i) => {
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `<span class="t"></span><input type="number" min="0" max="${t.count}" step="1" value="${t.count}" inputmode="numeric"><span class="of">of ${t.count}</span>`;
    const name = row.querySelector(".t");
    name.textContent = t.title || "(no name)";
    name.classList.toggle("none", !t.title);
    const input = row.querySelector("input");
    input.dataset.index = String(i);
    input.setAttribute("aria-label", `Questions named ${t.title || "(no name)"}, at most ${t.count}`);
    input.addEventListener("input", update);
    return row;
  }));
  if (pending) applyPendingPool();
}

function counts() {
  return [...$("titles").querySelectorAll("input")].map((i) => i.value.trim() === "" ? NaN : Number(i.value));
}

// shows the state of the pool controls; returns why Generate cannot go ahead, or ""
function showPool() {
  const sim = $("simulate").checked;
  const banks = extras.includes("--use-item-banks");
  $("limit-row").classList.toggle("off", sim || banks);
  for (const el of [$("limit"), ...document.querySelectorAll('[data-step="limit"]')]) el.disabled = sim || banks;
  $("banks").classList.toggle("off", !pool.classic);
  $("titles").classList.toggle("off", !sim);
  for (const i of $("titles").querySelectorAll("input")) i.disabled = !sim;
  $("limit-hint").textContent = banks ? "The loaded configuration uses --use-item-banks: the quiz's own question groups decide."
    : sim ? "Not used while question banks are simulated."
    : "Each exam gets this many questions, drawn at random from the whole quiz.";
  const total = $("banks-total");
  total.hidden = !sim;
  if (sim) {
    const c = counts();
    const bad = c.findIndex((n, i) => !Number.isInteger(n) || n < 0 || n > pool.titles[i].count);
    const sum = c.reduce((a, n) => a + (Number.isInteger(n) ? n : 0), 0);
    const used = c.filter((n) => n > 0).length;
    total.classList.toggle("bad", bad >= 0 || sum === 0);
    if (bad >= 0) {
      const t = pool.titles[bad];
      total.textContent = `“${t.title || "(no name)"}” takes a whole number from 0 to ${t.count}.`;
      return `Fix the number of questions for “${t.title || "(no name)"}”.`;
    }
    if (sum === 0) { total.textContent = "Choose at least one question."; return "Choose at least one question for the exam."; }
    total.textContent = `Each exam: ${sum} question${sum === 1 ? "" : "s"} from ${used} of ${pool.titles.length} name${pool.titles.length === 1 ? "" : "s"}.`;
    return "";
  }
  if (banks) return "";
  const n = Number($("limit").value);
  if (!Number.isInteger(n) || n < 1 || n > pool.total) return `Limit the test to a number of questions from 1 to ${pool.total}.`;
  return "";
}

function poolArgs() {
  if (quiz.state !== "ready" || !quiz.summary) return [];
  if ($("simulate").checked) {
    const c = counts();
    const map = pool.titles.map((t, i) => [t.title, c[i]]).filter(([, n]) => n > 0)
      .map(([t, n]) => `${t.replace(/;/g, "\\;")}=${n}`).join("; ");
    return ["--title-map", map];
  }
  const n = Number($("limit").value);
  return Number.isInteger(n) && n >= 1 && n < pool.total ? ["--max-items", String(n)] : [];
}

$("simulate").addEventListener("change", update);

// ------------------------------------------------------------------ exam configurations

// an options file: one option per line, values quoted as the command line reads them
function quote(v) {
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}

function configText(seed) {
  const lines = [], o = lastArgs.options;
  for (let i = 0; i < o.length; i++) {
    if (o[i].startsWith("-") || !lines.length) lines.push(quote(o[i]));
    else lines[lines.length - 1] += " " + quote(o[i]);
  }
  const head = [
    `# MasterTest exam configuration, saved by ${$("version-line").textContent} on ${new Date().toISOString().slice(0, 10)}`,
    `# Quiz: ${lastArgs.title}` + (lastArgs.quiz ? ` (quiz ${lastArgs.quiz.number} of ${lastArgs.quiz.of} in ${lastArgs.quiz.file})` : ""),
    "# To use it again: Load Previous Exam Config in MasterTest Web, or on a computer:",
    `#   python exam_generator.py <quiz export.zip>${lastArgs.classList ? " --class-list <class list.csv>" : ""} @<this file>`,
  ];
  if (seed && !o.includes("--seed")) head.push(`# This run used --seed ${seed}; add that line to print exactly the same exams again.`);
  return head.join("\n") + "\n\n" + lines.join("\n") + "\n";
}

function offerConfig(data) {
  if (configUrl) URL.revokeObjectURL(configUrl);
  configUrl = URL.createObjectURL(new Blob([configText(data.seed)], { type: "text/plain" }));
  const a = $("config-download");
  a.href = configUrl;
  a.download = data.name.replace(/\.zip$/i, "") + "_config.txt";
  $("config-link").hidden = false;
}

// splits a line the way the command line does (POSIX shell quoting)
function splitLine(line) {
  const out = [];
  let cur = "", has = false, q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; }
    else if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (q) throw new Error(`a quotation mark is not closed in: ${line}`);
  if (has || cur) out.push(cur);
  return out;
}

const LAYOUT_OF = (size, columns) => {
  const s = size.toLowerCase();
  if (s.includes("single")) return "single";
  if (s.includes("merged")) return columns === "1" ? "merged1" : "merged2";
  if (s.includes("tabloid") || s.startsWith("a3")) return "tabloid";
  return "booklet";
};

function loadConfig(name, textIn) {
  const tokens = [];
  for (const raw of textIn.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("#")) tokens.push(...splitLine(line));
  }
  // --name=value -> --name value
  const t = tokens.flatMap((x) => (x.startsWith("--") && x.includes("=") ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : [x]));
  const got = {}, rest = [], ignored = [];
  const takes = new Set(["--page-size", "--columns", "--quiz", "--variants", "--blank-cards", "--max-items", "--title-map", "--class-list", "--output", "-o",
    "--student-id-column", "--add-qr-field", "--seat-labels", "--add-attendance-field", "--attendance-sort", "--attendance-orientation",
    "--margin", "--font", "--font-size", "--question-spacing", "--option-font", "--option-font-size", "--option-columns",
    "--calculated-instructions", "--fill-blank-instructions", "--fill-blank-text",
    "--margin-left", "--margin-right", "--margin-top", "--margin-bottom", "--answer-width", "--cell-shading",
    "--answer-card-instructions", "--page-options", "--qr-quality", "--seed"]);
  for (let i = 0; i < t.length; i++) {
    const o = t[i];
    if (takes.has(o)) { got[o] = t[i + 1] !== undefined ? t[++i] : ""; continue; }
    if (["--password", "--randomize-seats", "--pad-options", "--show-points", "--no-quiz-instructions", "--no-option-dot"].includes(o)) { got[o] = true; continue; }
    if (o === "--option-dot") continue;   // the default
    if (o.startsWith("@")) { ignored.push(o); continue; }
    if (!o.startsWith("-")) { if (!rest.length) { ignored.push(o); continue; } rest.push(o); continue; }  // a stray value: the export
    rest.push(o);
    while (i + 1 < t.length && !t[i + 1].startsWith("-")) rest.push(t[++i]);
  }
  for (const o of ["--class-list", "--output", "-o"]) if (o in got) ignored.push(o);
  // apply what the page has controls for
  const size = got["--page-size"] || "letter";
  const iso = /^a[34]/i.test(size);
  setPaper(iso ? "iso" : "traditional");
  const id = LAYOUT_OF(size, got["--columns"]);
  if (!LAYOUTS.find((l) => l.id === id).unavailable) selectLayout(id, false);
  else selectLayout(id === "merged2" && !LAYOUTS[2].unavailable ? "merged1" : "booklet", false);
  const v = got["--variants"];
  const variants = v && /^\d+$/.test(v);
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === (variants ? "variants" : "unique");
  if (variants) $("variants").value = clamp($("variants"), Number(v));
  $("blanks").value = clamp($("blanks"), Number(got["--blank-cards"] || 0) || 0);
  extras = rest;
  // class-list options (checked against the class list once it is read)
  cls.id = got["--student-id-column"] || "";
  cls.qr = csvSplit(got["--add-qr-field"] || "");
  cls.randomize = !!got["--randomize-seats"] || "--seat-labels" in got;
  $("seat-labels").value = csvSplit(got["--seat-labels"] || "").join("\n");
  cls.att = csvSplit(got["--add-attendance-field"] || "");
  const sortBy = csvSplit(got["--attendance-sort"] || "");
  const sm = (sortBy[0] || "").match(/^(-)?\s*(.*?)(?:\s+(desc|descending|asc|ascending))?$/i);
  cls.sort = sm ? sm[2] : "";
  cls.desc = !!sm && (!!sm[1] || /^desc/i.test(sm[3] || ""));
  cls.orient = (got["--attendance-orientation"] || "portrait").toLowerCase() === "landscape" ? "landscape" : "portrait";
  if ($("seat-labels").value) $("seat-details").open = true;
  pending = { quiz: got["--quiz"] ? Number(got["--quiz"]) : null, maxItems: got["--max-items"] || null, titleMap: got["--title-map"] || null };
  configName = name;
  // say what was loaded
  const parts = [`${layoutName(LAYOUTS.find((l) => l.id === layout.id))} on ${iso ? "A4/A3" : "letter/tabloid"} paper`];
  if (variants) parts.push(`${v} variants`);
  if (Number(got["--blank-cards"]) > 0) parts.push(`${got["--blank-cards"]} blank card${got["--blank-cards"] === "1" ? "" : "s"}`);
  if (pending.maxItems) parts.push(`${pending.maxItems} questions per exam`);
  if (pending.titleMap) parts.push("simulated question banks");
  if (pending.quiz) parts.push(`quiz ${pending.quiz} of the export`);
  if (cls.randomize) parts.push($("seat-labels").value ? "seats from seat labels" : "randomized seats");
  if (cls.id || cls.qr.length) parts.push("class list options");
  if (cls.att.length || cls.sort || cls.orient !== "portrait") parts.push("attendance sheet options");
  if (setPrintOptions(got)) parts.push("print options");
  // page options (old spellings too) and advanced options
  const canon = (v) => v.toLowerCase().replace(/[^a-z]/g, "");
  const wanted = csvSplit(got["--page-options"] || "").map(canon);
  for (const box of document.querySelectorAll("#page-opts input")) box.checked = wanted.includes(canon(box.dataset.po));
  const unknownPages = wanted.filter((w) => ![...document.querySelectorAll("#page-opts input")].some((b) => canon(b.dataset.po) === w));
  if (unknownPages.length) extras.push("--page-options", unknownPages.join(","));   // the program explains them
  showPageOptions();
  if (wanted.length) { $("page-details").open = true; parts.push("page options"); }
  $("adv-qr").value = ["L", "Q", "H"].includes((got["--qr-quality"] || "").toUpperCase()) ? got["--qr-quality"].toUpperCase() : "";
  $("adv-seed").value = got["--seed"] || "";
  if (got["--qr-quality"] || got["--seed"]) { $("adv-details").open = true; parts.push(got["--seed"] ? `seed ${got["--seed"]}` : "QR code quality"); }
  if (sortBy.length > 1) parts.push(`sorted by ${sortBy[0]} only (the page sorts by one column)`);
  let msg = `Loaded ${name}: ${parts.join(", ")}.`;
  if (extras.length) msg += ` Also used when generating: ${extras.join(" ")}.`;
  if (got["--password"]) msg += " The answer key was password protected; you are asked for a password when you generate.";
  if (ignored.length) msg += ` Not used here (choose the files on this page): ${ignored.join(", ")}.`;
  showConfigState(msg, false);
  if (classFile) { cls.state = "reading"; showClass(); if (ready) inspectClass(); }
  // the export may already be open
  if (quiz.state === "choose" && pending.quiz && pending.quiz <= quiz.list.length) {
    const radio = document.querySelector(`#quiz-list input[value="${pending.quiz}"]`);
    if (radio) radio.checked = true;
    requestSummary(pending.quiz);
  } else if (quiz.state === "ready" && (!pending.quiz || pending.quiz === quiz.number || quiz.list.length <= 1)) {
    resetPool(quiz.summary);
  } else if (quiz.state === "ready" && pending.quiz <= quiz.list.length) {
    const radio = document.querySelector(`#quiz-list input[value="${pending.quiz}"]`);
    if (radio) radio.checked = true;
    requestSummary(pending.quiz);
  }
  update();
}

// the question pool from a loaded configuration, once the quiz is known
function applyPendingPool() {
  const p = pending;
  pending = null;
  const problems = [];
  if (p.titleMap) {
    if (!pool.classic) problems.push("its simulated question banks are only for Classic Quizzes exports");
    else {
      const map = new Map();
      for (const part of p.titleMap.split(/(?<!\\);/)) {
        const s = part.replace(/\\;/g, ";").trim();
        if (!s) continue;
        const at = s.lastIndexOf("=");
        if (at < 0) { problems.push(`“${s}” in its title map has no =count`); continue; }
        map.set(s.slice(0, at).trim(), Number(s.slice(at + 1).trim()));
      }
      if (map.size) {
        $("simulate").checked = true;
        const inputs = $("titles").querySelectorAll("input");
        pool.titles.forEach((t, i) => { inputs[i].value = String(map.has(t.title) ? map.get(t.title) : 0); });
        const missing = [...map.keys()].filter((k) => !pool.titles.some((t) => t.title === k));
        if (missing.length) problems.push(`this quiz has no questions named ${missing.map((m) => `“${m}”`).join(", ")}`);
      } else if (!/=/.test(p.titleMap)) problems.push(`its title map is a file (${p.titleMap}); set the numbers here instead`);
    }
  } else if (p.maxItems) {
    const n = Number(p.maxItems);
    if (Number.isInteger(n) && n >= 1 && n <= pool.total) $("limit").value = String(n);
    else problems.push(`it limits the test to ${p.maxItems} questions, but this quiz has ${pool.total}`);
  }
  if (problems.length) showConfigState($("config-text").textContent + " Check the question pool: " + problems.join("; ") + ".", true);
  if (p.titleMap || p.maxItems) $("pool").open = true;
}

function showConfigNote(note) {
  if ($("config-state").hidden) showConfigState(note, true);
  else if (!$("config-text").textContent.includes(note)) showConfigState($("config-text").textContent + " " + note, true);
}

function showConfigState(msg, bad) {
  $("config-text").textContent = msg;
  $("config-state").classList.toggle("bad", bad);
  $("config-state").hidden = false;
}

$("config-file").addEventListener("change", async () => {
  const f = $("config-file").files[0];
  $("config-file").value = "";
  if (!f) return;
  try {
    if (f.size > 100000) throw new Error("this is not an exam configuration (too large)");
    loadConfig(f.name, await f.text());
  } catch (err) {
    showConfigState(`${f.name} could not be loaded: ${err.message}.`, true);
  }
});
$("config-forget").addEventListener("click", () => {
  extras = []; pending = null; configName = "";
  Object.assign(cls, { id: "", qr: [], randomize: false, att: [], sort: "", desc: false, orient: "portrait" });
  setPrintOptions({});
  $("print-details").open = false;
  for (const box of document.querySelectorAll("#page-opts input")) box.checked = false;
  showPageOptions();
  $("adv-qr").value = ""; $("adv-seed").value = "";
  $("seat-labels").value = "";
  if (classFile) { cls.state = "reading"; showClass(); if (ready) inspectClass(); }
  $("config-state").hidden = true;
  update();
});

// ------------------------------------------------------------------ the answer-key password

const COMMON = ["password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon", "sunshine",
  "football", "baseball", "master", "mastertest", "exam", "test", "teacher", "student", "school", "canvas", "abc123", "123456"];

// a rough estimate of how hard the password is to guess
function strength(pw) {
  if (!pw) return { level: "none", label: "No password", pct: 4 };
  let set = 0;
  if (/[a-z]/.test(pw)) set += 26;
  if (/[A-Z]/.test(pw)) set += 26;
  if (/\d/.test(pw)) set += 10;
  if (/[^A-Za-z0-9]/.test(pw)) set += 33;
  let bits = pw.length * Math.log2(Math.max(set, 2));
  bits *= Math.min(1, (new Set(pw).size * 2) / pw.length);           // aaaaaaaa, abababab
  const lower = pw.toLowerCase();
  if (COMMON.includes(lower.replace(/[^a-z]/g, "")) || COMMON.includes(lower)) bits = Math.min(bits, 24);
  else if (COMMON.some((w) => w.length > 3 && lower.includes(w))) bits -= 12;
  if (/0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv/.test(lower)) bits -= 10;
  const pct = Math.max(10, Math.min(100, (bits / 80) * 100));
  if (bits < 40) return { level: "low", label: "Low strength", pct };
  if (bits < 60) return { level: "medium", label: "Medium strength", pct };
  return { level: "strong", label: "Strong password", pct };
}

function showStrength() {
  const s = strength($("pw").value);
  const bar = $("pw-bar");
  bar.style.width = s.pct + "%";
  bar.style.background = `var(--${s.level === "medium" ? "medium" : s.level === "strong" ? "strong" : "weak"})`;
  $("pw-strength").textContent = s.label;
  $("pw-strength").dataset.level = s.level;
  $("pw-accept").textContent = $("pw").value ? "Accept password" : "Continue without a password";
}

function openPassword() {
  $("pw").value = "";
  $("pw").type = "password";
  $("pw-show").textContent = "Show";
  $("pw-show").setAttribute("aria-pressed", "false");
  showStrength();
  $("pw-dialog").showModal();
  $("pw").focus();
}
$("pw").addEventListener("input", showStrength);
$("pw-show").addEventListener("click", () => {
  const show = $("pw").type === "password";
  $("pw").type = show ? "text" : "password";
  $("pw-show").textContent = show ? "Hide" : "Show";
  $("pw-show").setAttribute("aria-pressed", String(show));
  $("pw").focus();
});
$("pw-cancel").addEventListener("click", () => $("pw-dialog").close());
$("pw-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const pw = $("pw").value;
  $("pw").value = "";
  $("pw-dialog").close();
  generate(pw);
});

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

$("generate").addEventListener("click", () => openPassword());

async function generate(password) {
  running = true;
  update();
  showStep(2);
  $("big").className = "big-bubble working";
  $("big").textContent = "";
  $("result-title").textContent = "Making your exam…";
  $("result-text").textContent = "This takes a few seconds for a class, longer for large exams.";
  $("download").hidden = true;
  $("config-link").hidden = true;
  $("back").hidden = true;
  $("log").hidden = true;
  $("log").textContent = "";
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  lastArgs = { options: [...options(), ...(password ? ["--password"] : [])], title: quiz.summary.title,
    quiz: quiz.list.length > 1 ? { number: quiz.number, of: quiz.list.length, file: exportFile.name } : null, classList: !!classFile };
  const files = [{ name: exportFile.name, data: await exportFile.arrayBuffer() }];
  if (classFile) files.push({ name: classFile.name, data: await classFile.arrayBuffer() });
  if (aciMode() === "file") for (const f of aciFiles) files.push({ name: f.name, data: await f.arrayBuffer() });
  worker.postMessage({ type: "run", files, argv: argv(password), password }, files.map((f) => f.data));
}

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
  offerConfig(data);
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
    if (exportFile && quiz.state === "reading") { showQuiz(); inspectExport(); }
    if (classFile && cls.state === "reading") { showClass(); inspectClass(); }
    update();
  } else if (data.type === "error") {
    $("engine-state").textContent = "Could not start";
    $("engine-detail").textContent = "· " + data.text;
  } else if (data.type === "quizzes") {
    onQuizzes(data);
  } else if (data.type === "summary") {
    onSummary(data);
  } else if (data.type === "classlist") {
    onClasslist(data);
  } else if (data.type === "log") {
    $("log").textContent += data.text + "\n";
  } else if (data.type === "done") {
    finish(true, data);
  } else if (data.type === "failed") {
    finish(false, data);
  }
};

buildLayouts();
showPrintDefaults();
update();
