// MasterTest Web: the step-by-step page. Step 1 collects the quiz export, an optional class list,
// the question pool, paper size and layout, variants and blank cards; Create Exam Packet asks for an optional
// answer-key password, runs MasterTest Builder in the worker (in this tab's memory) and step 2
// hands over the zip and the exam configuration (an options file that the command line reads
// too, and that "Load Previous Exam Config" reads back)..
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
    id: "booklet", name: () => tr("Booklet + Answer Card"), size: ["letter", "a4"],
    desc: (p) => tr("Questions in a printed booklet, answers on a separate full-page card. Up to 100 answers per card. {prints}", p),
    pic: svg(page(14, 6, 38, 52) + [14, 20, 26, 34, 40, 46].map((y, i) => line(19, y, i % 3 === 2 ? 18 : 27)).join("") +
      page(46, 12, 38, 52) + [20, 27, 34, 41, 48, 55].map((y, i) => bubbles(52, y, 4, (i * 3) % 4) + bubbles(71, y, 3, i % 3)).join("")),
  },
  {
    id: "single", name: () => tr("Single Page Quiz"), size: ["letter-single-page", "a4-single-page"],
    desc: (p) => tr("A short quiz on one {sheet}: the answer area at the top, the questions below.", p),
    pic: svg(page(30, 4, 40, 60) + [11, 16].map((y, i) => bubbles(35, y, 4, i + 1) + bubbles(54, y, 3, i)).join("") +
      `<path d="M34 21h32" stroke="currentColor" stroke-width=".8"/>` + [27, 32, 39, 44, 51, 56].map((y, i) => line(35, y, i % 2 ? 20 : 28)).join("")),
  },
  {
    id: "merged1", name: () => tr("Merged One Column"), size: ["letter-merged", "a4-merged"], columns: 1,
    desc: (p) => tr("Each answer beside its question, in one full-width column. Room for wide written answers. {prints}", p),
    pic: svg(page(28, 4, 44, 60) + [14, 23, 32, 41, 50].map((y, i) => line(32, y, 18) +
      (i % 2 ? cell(54, y, 14) : bubbles(55.5, y, 4, (i + 2) % 4))).join("")),
  },
  {
    id: "merged2", name: () => tr("Merged Two Column"), size: ["letter-merged", "a4-merged"],
    desc: (p) => tr("Each answer beside its question, in two columns. About 30 short questions per page. {prints}", p),
    pic: svg(page(28, 4, 44, 60) + `<path d="M50 10v50" stroke="currentColor" stroke-width=".6" opacity=".5"/>` +
      [14, 22, 30, 38, 46, 54].map((y, i) => line(31, y, 7) + (i === 2 ? cell(39.5, y, 9) : bubbles(40.2, y, 2, i % 2)) +
        line(52, y, 7) + (i === 4 ? cell(60.5, y, 9) : bubbles(61.2, y, 2, (i + 1) % 2))).join("")),
  },
  {
    id: "tabloid", name: (p) => tr("{big} Booklet", p), size: ["tabloid-booklet", "a3-booklet"],
    desc: (p) => tr("{bigSheets} printed on both sides and folded into {booklet}, with a folded answer card.", p),
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
// the paper's words in the page's language
const paperText = () => Object.fromEntries(Object.entries(PAPER[paper]).map(([k, v]) => [k, tr(v)]));
const text = (v) => (typeof v === "function" ? v(paperText()) : v);
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
    $(stateId).textContent = f ? `${f.name} (${f.size < 1024 * 1024 ? Math.max(1, Math.round(f.size / 1024)) + (uiLang === "fr" ? " Ko" : " KB") : (f.size / 1048576).toFixed(1) + (uiLang === "fr" ? " Mo" : " MB")})` : empty();
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

const clearExport = filePicker("export", "export-drop", "export-state", () => tr("Choose or drop the .zip or .docx file"), (f) => {
  exportFile = f;
  cjkRegion = null;     // a new export: follow its text again
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
  worker.postMessage({ type: "inspect", name: f.name, data, lang: uiLang }, [data]);
}

async function requestSummary(number) {
  Object.assign(quiz, { state: "loading", number, summary: null });
  showQuiz();
  const data = await exportFile.arrayBuffer();
  worker.postMessage({ type: "summary", name: exportFile.name, number, data, lang: uiLang }, [data]);
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

// the summary's messages again, in the page's new language, keeping every choice made
async function refreshSummary() {
  const data = await exportFile.arrayBuffer();
  worker.postMessage({ type: "summary", name: exportFile.name, number: quiz.number, data, lang: uiLang, refresh: true }, [data]);
}

function onSummary(data) {
  if (!exportFile || data.name !== exportFile.name || data.number !== quiz.number) return;
  const r = data.result;
  if (data.refresh) {
    if (quiz.state === "ready" && !r.error) { quiz.summary.warnings = r.warnings; quiz.summary.omitted_notes = r.omitted_notes; showQuiz(); }
    return;
  }
  if (r.error) Object.assign(quiz, { state: "error", message: r.error });
  else Object.assign(quiz, { state: "ready", summary: r });
  setMergedAvailable(r.error ? null : r);
  if (!r.error) resetPool(r);
  showPrintDefaults();
  showQuiz();
}

function showQuiz() {
  $("quiz").hidden = quiz.state === "none";
  const status = $("quiz-status");
  status.className = "quiz-status" + (quiz.state === "error" ? " bad" : "");
  status.textContent = { reading: ready ? tr("Reading the export…") : tr("The export will be read once the exam maker has loaded."),
    loading: tr("Reading the quiz…"), error: quiz.message }[quiz.state] || "";
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
    $("sum-unit").textContent = trn(s.questions, "question", "questions");
    $("sum-title").textContent = s.title;
    $("sum-kinds").textContent = Object.entries(s.kinds).map(([k, n]) => tr("{n} " + k, { n })).join(", ");
    const notes = [];
    if (s.pick_rules.length)
      notes.push(tr("Each exam gets {per} of them: the quiz's item banks pick some of their questions (“pick N”). Alter the question pool to change this.", { per: s.per_exam_with_banks }));
    if (s.omitted) notes.push(trn(s.omitted, "{n} question was left out because it cannot be printed: {list}", "{n} questions were left out because they cannot be printed: {list}",
      { list: (s.omitted_notes || []).join("; ") }));
    if (!s.merged1_ok) notes.push(tr("At least one question has {n} options, so the Merged One Column and Merged Two Column Layouts are not available. If you want to use them make sure multiple-choice questions have no more than 6 options (4 for Merged Two Column).", { n: s.max_options }));
    else if (!s.merged_ok) notes.push(tr("At least one question has {n} options, so the Merged Two Column Layout is not available. If you want to use this layout make sure multiple-choice questions have no more than 4 options.", { n: s.max_options }));
    $("sum-note").textContent = notes.join(" ");
    $("sum-note").hidden = !notes.length;
    // a Word document is read by guessing at its layout: what was read, to check against it
    $("sum-read").hidden = !s.read;
    if (s.read) {
      $("sum-read").open = true;
      $("sum-read-list").replaceChildren(...s.read.map((q) => {
        const li = document.createElement("li");
        li.value = q.number;
        li.innerHTML = '<span class="k"></span> <span class="ans"></span> <span class="pts"></span> <span class="t"></span>';
        li.querySelector(".k").textContent = tr(q.kind) + ":";
        li.querySelector(".ans").textContent = q.answer ? q.answer : tr("(marked by hand)");
        li.querySelector(".pts").textContent = "(" + trn(Number(q.points), "{n} point", "{n} points", { n: uiLang === "fr" ? q.points.replace(".", ",") : q.points }) + ")";
        li.querySelector(".t").textContent = "– " + q.text;
        return li;
      }));
    }
  }
  showCjk();
  update();
}

// ------------------------------------------------------------------ Chinese, Japanese and Korean text

// A quiz with CJK text prints it in one region's writing style, with that region's Noto Sans CJK
// font, which the worker downloads from this site the first time it is needed.
const CJK_NAMES = { sc: "Simplified Chinese", tc: "Traditional Chinese", jp: "Japanese", kr: "Korean" };
let cjkFonts = {};        // region -> {file, bytes}: the fonts this site has (build.json)
let cjkRegion = null;     // the region chosen, or null to follow the quiz
const quizCjk = () => (quiz.state === "ready" && quiz.summary ? quiz.summary.cjk : null);
const cjkChosen = () => cjkRegion || quizCjk();
// a region's name inside a sentence (lower case in French)
const cjkName = (r) => (uiLang === "fr" ? tr(CJK_NAMES[r]).toLowerCase() : CJK_NAMES[r]);

function showCjk() {
  const found = quizCjk();
  $("cjk-row").hidden = !found;
  if (!found) return;
  const r = cjkChosen();
  for (const radio of document.querySelectorAll('input[name="cjk"]')) radio.checked = radio.value === r;
  const font = cjkFonts[r];
  $("cjk-hint").textContent = !font
    ? tr("This copy of MasterTest Web has no {region} font, so these characters will print as “?”.", { region: cjkName(r) })
    : tr("This quiz has {found} text", { found: cjkName(found) }) + (r === found ? "" : tr("; it will be printed in the {region} style", { region: cjkName(r) })) +
      tr(". English and other text stays in the font you choose. The {region} font ({mb} MB) is downloaded when you generate, the first time only.",
        { region: cjkName(r), mb: Math.round(font.bytes / 1e6) });
}
for (const radio of document.querySelectorAll('input[name="cjk"]'))
  radio.addEventListener("change", () => { if (radio.checked) { cjkRegion = radio.value; showCjk(); update(); } });

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
      note.textContent = ok ? "" : tr("Not for this quiz: a question has {n} options, and this layout shows at most {most}.", { n: summary.max_options, most }) +
        (l.id === "merged2" && summary.merged1_ok ? tr(" Merged One Column can.") : "");
    }
  }
  if (layout.unavailable) selectLayout(LAYOUTS[0].id, false);
}
const clearClass = filePicker("classlist", "class-drop", "class-state", () => tr("Choose or drop the class list"), (f) => {
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
  worker.postMessage({ type: "classlist", name: f.name, data, id: cls.id, qr: csvJoin(cls.qr), ask: classAsked, lang: uiLang }, [data]);
}

function onClasslist(data) {
  if (!classFile || data.name !== classFile.name) return;
  const r = data.result;
  const notes = [];
  // options that do not fit this class list
  if (r.columns && r.columns.length) {
    const has = (c) => r.columns.some((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "") === c.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (cls.id && !has(cls.id)) { notes.push(tr("it has no column “{c}”, so the student ID column is found automatically", { c: cls.id })); cls.id = ""; }
    const gone = cls.qr.filter((c) => !has(c));
    if (gone.length) { notes.push(tr("it has no {list} column for the QR code", { list: gone.map((g) => `“${g}”`).join(", ") })); cls.qr = cls.qr.filter(has); }
    if (notes.length) { inspectClass(); showConfigNote(tr("For this class list: {notes}.", { notes: notes.join("; ") })); return; }
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
  st.textContent = cls.state === "reading" ? (ready ? tr("Reading the class list…") : tr("The class list will be read once the exam maker has loaded."))
    : cls.state === "error" ? cls.message : "";
  st.hidden = !st.textContent;
  const usable = r && r.columns && r.columns.length;
  // the grey box: the details once read, and the options (also after an error they can fix,
  // such as no student-number column)
  $("class-box").hidden = !usable;
  $("class-summary").hidden = !(cls.state === "ready");
  if (cls.state === "ready") {
    $("cls-n").textContent = r.students;
    $("cls-unit").textContent = trn(r.students, "student", "students");
    $("cls-title").textContent = classFile.name;
    $("cls-id").textContent = r.number_column;
    $("cls-id-how").textContent = cls.id ? tr("(chosen in Class list options)") : tr("(found automatically)");
    $("cls-qr").textContent = r.qr_fields.map((f) => (f === "Card serial" ? tr("card serial") : f)).join(", ");
    $("cls-cols").textContent = r.columns.join(", ");
    const notes = [];
    if (r.skipped) notes.push(trn(r.skipped, "{n} row was skipped because its student ID is empty (such as Canvas's Test Student or Points Possible rows).",
      "{n} rows were skipped because their student ID is empty (such as Canvas's Test Student or Points Possible rows)."));
    if (r.seat_column && !cls.randomize) notes.push(r.seats_in_list === 0 ? tr("The “{c}” column is empty: tick Randomize seats to give everyone a seat.", { c: r.seat_column })
      : r.seats_in_list < r.students ? trn(r.students - r.seats_in_list, "Seats come from the “{c}” column ({n} student has none).", "Seats come from the “{c}” column ({n} students have none).", { c: r.seat_column })
      : tr("Seats come from the “{c}” column.", { c: r.seat_column }));
    const other = r.notes || [];
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
  $("seat-n").textContent = n ? String(n) : tr("the number of students");
  $("randomize").checked = cls.randomize;
  const labels = seatLabels();
  $("randomize-sub").textContent = labels.length
    ? trn(labels.length, "Each student gets a random seat from your {n} seat label, printed on their card and the attendance sheet.",
      "Each student gets a random seat from your {n} seat labels, printed on their card and the attendance sheet.")
    : r.seat_column ? tr("Each student gets a random seat from 1 to {n}, printed on their card and the attendance sheet (in place of the “{c}” column).", { n, c: r.seat_column })
    : tr("Each student gets a random seat from 1 to {n}, printed on their card and the attendance sheet.", { n });
  const count = $("seat-count");
  count.hidden = !labels.length;
  if (labels.length) {
    const short = r.students && labels.length < r.students;
    count.classList.toggle("bad", !!short);
    count.textContent = short ? tr("{n} seats for {students} students: add {more} more.", { n: labels.length, students: r.students, more: r.students - labels.length })
      : r.students && labels.length > r.students
        ? trn(labels.length - r.students, "{n} seats for {students} students ({empty} stays empty).", "{n} seats for {students} students ({empty} stay empty).",
          { n: labels.length, students: r.students, empty: labels.length - r.students })
        : tr("{n} seats for {students} students.", { n: labels.length, students: r.students || "" });
  }
  // student ID column
  const sel = $("id-col");
  const want = cls.id || "";
  sel.replaceChildren(...[["", r.detected_number_column ? tr("Found automatically: {c}", { c: r.detected_number_column }) : tr("Found automatically (none found)")],
    ...r.columns.filter((c) => c !== r.name_column).map((c) => [c, c])].map(([v, t]) => new Option(t, v, false, v === want)));
  $("id-default").textContent = r.detected_number_column ? tr("Default: {c}", { c: r.detected_number_column }) : tr("No column has a student-number heading: choose one.");
  // QR fields
  $("qr-fixed").replaceChildren(...[r.name_column || tr("Student name"), idNow, tr("card serial")].filter(Boolean).map((t) => chip(t, tr("always"))));
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
  add.replaceChildren(...addable.map((c) => new Option(tr("{c} (from the class list)", { c }), c)), new Option(tr("A blank column to fill in…"), "\u0000blank"));
  if ([...add.options].some((o) => o.value === keep)) add.value = keep;
  $("att-blank").hidden = add.value !== "\u0000blank";
  // sort
  const sort = $("att-sort");
  const sortable = [...cols.filter((c) => c.sortable).map((c) => c.label),
    ...r.columns.filter((c) => !cols.some((x) => sameKey(x.label, c)) && c !== r.name_column && !sameKey(c, idNow))];
  const groups = [new Option(tr("Class list order"), "")];
  for (const c of sortable) groups.push(new Option(tr(c), c));
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
  const cols = [{ label: "Student Name", why: tr("always"), sortable: true },
    { label: "Student Number", why: tr("always: {c}", { c: idNow }), sortable: true }];
  const seatAdded = cls.att.some((a) => ["seat", "seatnumber", "seatno"].includes(a.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (cls.randomize && !seatAdded) cols.push({ label: "Seat", why: tr("seats are randomized"), sortable: true });
  for (const a of cls.att) {
    if (["studentname", "name", "fullname", "studentnumber"].includes(a.toLowerCase().replace(/[^a-z0-9]/g, "")) || sameKey(a, idNow)) continue;
    const inList = r.columns.some((c) => sameKey(c, a));
    cols.push({ label: a, why: inList ? "" : tr("blank"), removable: true, sortable: inList || ["seat", "seatnumber", "seatno"].includes(a.toLowerCase().replace(/[^a-z0-9]/g, "")) });
  }
  cols.push({ label: "Signature", why: tr("always"), sortable: false });
  return cols;
}

function chip(text, why, remove) {
  const li = document.createElement("li");
  li.className = "chip" + (remove ? "" : " locked");
  const t = document.createElement("span");
  t.textContent = tr(text);     // the program's own column names are translated; class-list ones stay
  li.append(t);
  if (why) { const w = document.createElement("span"); w.className = "why"; w.textContent = why; li.append(w); }
  if (remove) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", tr("Remove {c}", { c: text }));
    b.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2 2 10" stroke="currentColor" stroke-width="1.8"/></svg>';
    b.addEventListener("click", remove);
    li.append(b);
  }
  return li;
}

function classProblem() {
  if (!classFile) return "";
  if (cls.state === "reading") return tr("Reading the class list…");
  if (cls.state === "error") return tr("Fix the class list, or choose its student ID column under Class list options.");
  if (cls.randomize) {
    const labels = seatLabels();
    if (labels.length && cls.summary && labels.length < cls.summary.students)
      return tr("Add seat labels: {n} for {students} students.", { n: labels.length, students: cls.summary.students });
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
  fontSize: ["po-font-size", "--font-size"],
  spacing: ["po-spacing", "--question-spacing"],
  optionSize: ["po-option-size", "--option-font-size"], calc: ["po-calc", "--calculated-instructions"],
  fill: ["po-fill", "--fill-blank-instructions"], blank: ["po-blank", "--fill-blank-text"],
  width: ["po-width", "--answer-width"], shading: ["po-shading", "--cell-shading"],
};
const SIDES = ["left", "right", "top", "bottom"];
const marginMode = () => document.querySelector('input[name="po-margin-mode"]:checked').value;
const aciMode = () => document.querySelector('input[name="po-aci"]:checked').value;
let aciFiles = [];      // the answer-card instructions file and its images
const PO_FLAGS = { "po-points": "--show-points", "po-noinstr": "--no-quiz-instructions" };
// ------------------------------------------------------------------ print language and decimal mark

// --print-language: the language of the printed instructions, headings and labels (the quiz is
// printed as written); --decimal-mark: point or comma, by default the language's (French: comma).
let printLang = uiLang;          // follows the page's language until chosen
let printLangChosen = false;
let decimalChosen = null;    // "point" | "comma" when chosen on the page, else follow the language
const langDecimal = () => (printLang === "fr" ? "comma" : "point");
const decimalMark = () => decimalChosen || langDecimal();
const STANDARD = {
  calc: {
    en: (comma) => `Write your answer in the boxes on the answer card: one digit, minus sign or ${comma ? "decimal comma" : "decimal point"} per box.`,
    fr: (comma) => `Écrivez votre réponse dans les cases de la carte-réponse : un chiffre, un signe moins ou ${comma ? "une virgule" : "un point décimal"} par case.`,
  },
  fill: { en: () => "Write your answer in the box on the answer card.", fr: () => "Écrivez votre réponse dans la case de la carte-réponse." },
};
const standardText = (which) => STANDARD[which][printLang](decimalMark() === "comma");

function langArgs() {
  const a = [];
  if (printLang !== "en") a.push("--print-language", printLang);
  if (decimalMark() !== langDecimal()) a.push("--decimal-mark", decimalMark());
  return a;
}

function showLanguage() {
  for (const r of document.querySelectorAll('input[name="plang"]')) r.checked = r.value === printLang;
  for (const r of document.querySelectorAll('input[name="po-decimal"]')) r.checked = r.value === decimalMark();
  for (const r of document.querySelectorAll('input[name="adv-csv"]')) r.checked = r.value === csvSeparator();
  $("po-decimal-point-sub").textContent = tr(langDecimal() === "point" ? "point (default)" : "point");
  $("po-decimal-comma-sub").textContent = tr(langDecimal() === "comma" ? "comma (default)" : "comma");
  if (typeof showPrintDefaults === "function" && layout) showPrintDefaults();
}
for (const r of document.querySelectorAll('input[name="plang"]'))
  r.addEventListener("change", () => { if (r.checked) { printLang = r.value; printLangChosen = true; showLanguage(); update(); } });
for (const r of document.querySelectorAll('input[name="po-decimal"]'))
  r.addEventListener("change", () => { if (r.checked) { decimalChosen = r.value === langDecimal() ? null : r.value; showLanguage(); update(); } });

function printArgs(run) {
  const a = [...fontArgs(run)];
  if (marginMode() === "all") { if ($("po-margin").value.trim()) a.push("--margin", $("po-margin").value.trim()); }
  else for (const side of SIDES) { const v = $("po-margin-" + side).value.trim(); if (v) a.push("--margin-" + side, v); }
  if (aciMode() === "none") a.push("--answer-card-instructions", "none");
  else if (aciMode() === "file" && aciHtml()) a.push("--answer-card-instructions", aciHtml().name);
  for (const [id, opt] of Object.values(PO)) {
    const v = $(id).value.trim();
    if (v) a.push(opt, v);
  }
  if (document.querySelector('input[name="po-marker"]:checked').value === "dot") a.push("--option-dot");   // off by default
  if (!$("po-enclosed").checked) a.push("--option-letters", "plain");          // circled letters are the default
  else if (enclosedStyle() === "filled") a.push("--option-letters", "filled");
  const cols = parseInt($("po-option-columns").value, 10);
  if (cols > 1) a.push("--option-columns", String(cols));
  for (const [id, opt] of Object.entries(PO_FLAGS)) if ($(id).checked) a.push(opt);
  if (!$("po-pad").checked) a.push("--no-option-pad");     // padding is the default from 0.4.3
  return a;
}

// why Generate cannot go ahead with these print options, or ""
function printProblem() {
  const fs = $("po-font-size").value.trim(), os = $("po-option-size").value.trim();
  if (fs && !(Number(fs) >= 4 && Number(fs) <= 72)) return tr("Print Options: the font size must be from 4 to 72 points.");
  if (os && !(Number(os) >= 4 && Number(os) <= 72)) return tr("Print Options: the option font size must be from 4 to 72 points.");
  const cols = $("po-option-columns").value.trim();
  if (cols && !(Number.isInteger(Number(cols)) && Number(cols) >= 1 && Number(cols) <= 6)) return tr("Print Options: option columns must be from 1 to 6.");
  const lengths = [["po-spacing", "question spacing"], ["po-width", "answer field width"],
    ...(marginMode() === "all" ? [["po-margin", "margins"]] : SIDES.map((side) => ["po-margin-" + side, side + " margin"]))];
  for (const [id, what] of lengths) {
    const v = $(id).value.trim();
    if (v && !/^\d+(\.\d+)?\s*(in|cm|mm|pt)?$/i.test(v)) return tr("Print Options: write the {what} as a number and a unit, such as 0.75in, 2cm, 20mm or 54pt.", { what: tr(what) });
    if (id.startsWith("po-margin") && /^\d+(\.\d+)?$/.test(v) && Number(v) < 5) return tr("Print Options: a margin of {v} without a unit is {v} points. Did you mean {v}in or {v}cm?", { v });
  }
  const sh = $("po-shading").value.trim();
  if (sh && !(Number(sh) >= 0 && Number(sh) <= 100)) return tr("Print Options: cell shading is a percentage from 0 to 100.");
  if (aciMode() === "file" && !aciHtml()) return tr("Print Options: choose your answer card instructions file (.html), or pick Standard or None.");
  for (const id of FONT_PICKS) {
    const f = fontChoice[id];
    if (f && f.kind === "missing") return tr("Print Options: the font “{f}” from the configuration is not here: choose it from the fonts on this computer, choose its file, or pick another font.", { f: f.label });
  }
  const seed = $("adv-seed").value.trim();
  if (seed && !/^\d{1,10}$/.test(seed)) return tr("Advanced Options: the seed is a whole number.");
  return "";
}

const aciHtml = () => aciFiles.find((f) => /\.html?$/i.test(f.name));
const enclosedStyle = () => document.querySelector('input[name="po-enclosed-style"]:checked').value;

function showEnclosed() {
  const on = $("po-enclosed").checked;
  for (const r of document.querySelectorAll('input[name="po-enclosed-style"]')) r.disabled = !on;
  $("po-enclosed-style").classList.toggle("off", !on);
}
$("po-enclosed").addEventListener("change", () => { showEnclosed(); update(); });

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
  $("po-aci-state").textContent = !aciFiles.length ? tr("An .html file (the same tags as question text); choose its images along with it.")
    : !html ? tr("No .html file among the files chosen.")
    : aciFiles.length > 1 ? trn(aciFiles.length - 1, "{name} and {n} image", "{name} and {n} images", { name: html.name }) : html.name;
  update();
});

// ------------------------------------------------------------------ fonts

// Fonts for the questions (--font) and the option letters (--option-font): the three fonts every
// PDF reader has, the fonts supplied with MasterTest Builder, the fonts installed on this computer
// (in browsers that can list them: Chrome and Edge) or font files the user chooses. Installed fonts
// and font files are sent to the program with the run, under fonts/.
const FONT_PICKS = ["po-font", "po-option-font"];
const FONT_OPT = { "po-font": "--font", "po-option-font": "--option-font" };
const BUILT_IN = ["Helvetica", "Times", "Courier"];
const SUPPLIED = { "Open Sans": "many alphabets", "Source Code Pro": "for code", "DejaVu Sans": "" };
const fontDefault = (id) => ($(id).dataset.default === "same" ? "same" : "named:" + $(id).dataset.default);
const fontDefaultChoice = (id) => ({ kind: "named", label: $(id).dataset.default, value: fontDefault(id) });
const fontChoice = {};     // id -> {kind: "named" | "local" | "file" | "missing", label, value, files}
let localFamilies = null;  // family -> [FontData], once the browser has listed them

const fontSlug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

function fontMenu(id) {
  const sel = $(id), keep = sel.value;
  const optionFont = id === "po-option-font";
  sel.textContent = "";
  const group = (label, items) => {
    const g = document.createElement("optgroup");
    g.label = label;
    for (const [value, text] of items) g.append(new Option(text, value));
    sel.append(g);
  };
  const dflt = (f) => (f === sel.dataset.default ? tr("{f} (default)", { f }) : f);
  if (optionFont) sel.append(new Option(tr(sel.dataset.default === "same" ? "Same as the questions (default)" : "Same as the questions"), "same"));
  group(tr("Built into every PDF reader"), BUILT_IN.map((f) => ["named:" + f, dflt(f)]));
  group(tr("Supplied with MasterTest"), Object.entries(SUPPLIED).map(([f, d]) => ["named:" + f, dflt(f + (d ? ` – ${tr(d)}` : ""))]));
  if (localFamilies) group(tr("On this computer"), [...localFamilies.keys()].map((f) => ["local:" + f, f]));
  else sel.append(new Option(tr("Fonts on this computer…"), "ask-local"));
  const f = fontChoice[id];
  if (f && f.kind === "file") group(tr("Font file"), [["file", f.label]]);
  if (f && f.kind === "missing") group(tr("From the configuration"), [["missing", tr("{f} (not available here)", { f: f.label })]]);
  sel.append(new Option(tr("Choose a font file…"), "ask-file"));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : fontDefault(id);
}

const fontNotes = {};     // the note shown beside each font list, for redrawing in another language
function fontState(id, text) {
  fontNotes[id] = text || "";
  $(id + "-state").textContent = text || (id === "po-option-font" ? tr("for the option letters A, B, C…") : "");
}

function fontPicked(id) {
  const v = $(id).value, prev = fontChoice[id];
  const back = () => { $(id).value = prev ? prev.value : fontDefault(id); };
  if (v === "ask-file") { back(); $(id + "-file").click(); return; }
  if (v === "ask-local") { back(); listLocalFonts(id); return; }
  if (v === "same") fontChoice[id] = { kind: "named", label: "same", value: v };
  else if (v.startsWith("named:")) fontChoice[id] = { kind: "named", label: v.slice(6), value: v };
  else if (v.startsWith("local:")) fontChoice[id] = { kind: "local", label: v.slice(6), value: v };
  fontState(id, v.startsWith("local:") ? tr("installed on this computer; sent with the exam to the program") : "");
  update();
}

async function listLocalFonts(id) {
  if (!("queryLocalFonts" in window)) {
    fontState(id, tr("This browser cannot list the fonts on this computer (Chrome and Edge can). Choose a font file instead."));
    return;
  }
  try {
    const all = await window.queryLocalFonts();
    localFamilies = new Map();
    for (const f of all) {
      if (!localFamilies.has(f.family)) localFamilies.set(f.family, []);
      localFamilies.get(f.family).push(f);
    }
    localFamilies = new Map([...localFamilies.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  } catch (err) {
    fontState(id, tr("The browser did not allow listing the fonts on this computer. Choose a font file instead."));
    return;
  }
  if (!localFamilies.size) { localFamilies = null; fontState(id, tr("No fonts were found on this computer. Choose a font file instead.")); return; }
  for (const other of FONT_PICKS) {
    fontMenu(other);
    const f = fontChoice[other];   // a font named in a configuration may now be found
    if (f && f.kind === "missing" && localFamilies.has(f.label)) { fontChoice[other] = { kind: "local", label: f.label, value: "local:" + f.label }; fontMenu(other); $(other).value = "local:" + f.label; }
  }
  fontState(id, tr("{n} font families on this computer are now in the list.", { n: localFamilies.size }));
  $(id).focus();
  update();
}

for (const id of FONT_PICKS) {
  fontMenu(id);
  fontChoice[id] = fontDefaultChoice(id);
  $(id).addEventListener("change", () => fontPicked(id));
  $(id + "-file").addEventListener("change", () => {
    const files = [...$(id + "-file").files];
    $(id + "-file").value = "";
    if (!files.length) return;
    // several files: the faces of one family (regular, bold, italic); the first is the font chosen
    const regular = files.find((f) => !/bold|italic|oblique/i.test(f.name)) || files[0];
    fontChoice[id] = { kind: "file", label: regular.name + (files.length > 1 ? ` (+${files.length - 1})` : ""), value: "file",
      files: [regular, ...files.filter((f) => f !== regular)] };
    fontMenu(id);
    $(id).value = "file";
    fontState(id, tr("a font file you chose; sent with the exam to the program"));
    update();
  });
}

// the font as the program is given it. A run gets the file paths under fonts/; a saved configuration
// gets the name (an installed family, or the file name), which the desktop program also understands.
function fontArg(id, run) {
  const f = fontChoice[id];
  if (!f) return "";
  if (f.kind === "named") return f.label;
  if (f.kind === "missing") return f.label;
  if (f.kind === "file") return run ? `fonts/${fontSlug(id)}/${fontSlug(f.files[0].name)}` : f.files[0].name;
  if (f.kind === "local") return run ? f.runPath : f.label;   // runPath: set by fontFiles(), just before the run
  return "";
}

function fontArgs(run) {
  const a = [];
  for (const id of FONT_PICKS) {
    const v = fontArg(id, run);
    if (v && v !== $(id).dataset.default) a.push(FONT_OPT[id], v);
  }
  return a;
}

// installed fonts: up to four faces of the family (regular, bold, italic, bold italic), each in a
// file of its own; a font collection (.ttc) once
async function localFaces(family) {
  const faces = localFamilies.get(family) || [];
  const rank = (f) => ["regular", "normal", "roman", "book"].includes(f.style.toLowerCase()) ? 0 : 1;
  const want = faces.filter((f) => /^(regular|normal|roman|book|bold|italic|oblique|bold italic|bold oblique)$/i.test(f.style));
  const pick = (want.length ? want : faces.slice(0, 1)).sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  const out = [], seen = new Set();
  for (const f of pick) {
    const data = await (await f.blob()).arrayBuffer();
    const head = new Uint8Array(data, 0, 4);
    const tag = String.fromCharCode(...head);
    const key = data.byteLength + ":" + tag;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ext: tag === "ttcf" ? ".ttc" : tag === "OTTO" ? ".otf" : ".ttf", data });
  }
  return out;
}

async function fontFiles() {
  const files = [];
  for (const id of FONT_PICKS) {
    const f = fontChoice[id];
    if (!f) continue;
    if (f.kind === "file") {
      for (const file of f.files) files.push({ name: `fonts/${fontSlug(id)}/${fontSlug(file.name)}`, data: await file.arrayBuffer() });
    } else if (f.kind === "local") {
      // the first face is written under the name the program is given; the rest beside it with the
      // same start, so the program finds the bold and italic faces
      const faces = await localFaces(f.label);
      faces.forEach((face, i) => files.push({ name: `fonts/${fontSlug(id)}/${fontSlug(f.label)}${i ? "-" + i : ""}${face.ext}`, data: face.data }));
      if (!faces.length) throw new Error(tr("The font “{f}” could not be read from this computer.", { f: f.label }));
      f.runPath = files.find((x) => x.name.startsWith(`fonts/${fontSlug(id)}/`)).name;
    }
  }
  return files;
}

// a font named in a loaded configuration
function setFont(id, v) {
  if (v === undefined || v === "") { fontChoice[id] = fontDefaultChoice(id); fontMenu(id); $(id).value = fontChoice[id].value; fontState(id); return false; }
  const name = v.split(/[\\/]/).pop();
  const lower = v.toLowerCase();
  const named = id === "po-option-font" && lower === "same" ? "same"
    : [...BUILT_IN, ...Object.keys(SUPPLIED)].find((f) => f.toLowerCase() === lower || (lower === "times-roman" && f === "Times"));
  if (named) fontChoice[id] = { kind: "named", label: named, value: named === "same" ? "same" : "named:" + named };
  else if (localFamilies && localFamilies.has(v)) fontChoice[id] = { kind: "local", label: v, value: "local:" + v };
  else if (fontChoice[id] && fontChoice[id].kind === "file" && fontChoice[id].files[0].name === name) { /* the same file is already chosen */ }
  else fontChoice[id] = { kind: "missing", label: name, value: "missing" };
  fontMenu(id);
  $(id).value = fontChoice[id].value;
  fontState(id, fontChoice[id].kind === "missing" ? tr("The configuration used “{f}”: choose it from the fonts on this computer or as a file.", { f: name }) : "");
  return v.toLowerCase() !== $(id).dataset.default.toLowerCase();
}

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
    const raw = PAGE_DESC[box.dataset.po][kind];
    const d = typeof raw === "string" ? tr(raw) : raw;
    let off = d === null || d === false;
    let text = d === null ? tr("Not for this layout: the questions and answers start on the first page.")
      : d === false ? tr("Not needed: folded booklets and cards are always padded.") : d;
    if (kind === "duplex" && box.dataset.po === "collate-title-pages") text = tr("Not for folded booklets: the title page is always the booklet's first page.");
    if (box.dataset.po === "title-page" && kind === "duplex") { box.checked = true; off = true; }
    else if (box.dataset.po === "title-page" && box.disabled && !off) box.checked = false;
    if (box.dataset.po === "pad-title-page" && kind === "booklet" && !titles) { off = true; }
    box.disabled = off;
    box.closest("label").classList.toggle("off", off);
    box.closest("label").querySelector("[data-desc]").textContent = text;
  }
  $("pg-layout-note").textContent = tr("For the {layout} layout.", { layout: layoutName(layout) }) +
    (kind === "single" ? tr(" The quiz and its answers are on the same pages, so the exam and answer-card options mean the same.") : "");
}
function pageArgs() {
  const on = [...document.querySelectorAll("#page-opts input")].filter((b) => b.checked && !b.disabled).map((b) => b.dataset.po);
  return on.length ? ["--page-options", on.join(",")] : [];
}
for (const box of document.querySelectorAll("#page-opts input")) box.addEventListener("change", () => { showPageOptions(); update(); });

// answer_key.csv's separator: by default semicolons for French (--csv-separator)
let csvChosen = null;
const langCsv = () => (printLang === "fr" ? "semicolon" : "comma");
const csvSeparator = () => csvChosen || langCsv();
for (const r of document.querySelectorAll('input[name="adv-csv"]'))
  r.addEventListener("change", () => { if (r.checked) { csvChosen = r.value === langCsv() ? null : r.value; showLanguage(); update(); } });

function advArgs() {
  const a = [];
  if (csvSeparator() !== langCsv()) a.push("--csv-separator", csvSeparator());
  if ($("adv-qr").value) a.push("--qr-quality", $("adv-qr").value);
  if ($("adv-seed").value.trim()) a.push("--seed", $("adv-seed").value.trim());
  return a;
}
for (const el of ["adv-qr", "adv-seed"]) { $(el).addEventListener("input", update); $(el).addEventListener("change", update); }
function showPrintDefaults() {
  const merged = layout.id.startsWith("merged");
  $("po-font-size").placeholder = merged ? "9" : "11";
  $("po-font-size-hint").textContent = tr(merged ? "points (default 9 on merged sheets)" : "points (default 11)");
  $("po-calc").placeholder = merged ? tr("(none on merged sheets: the header says how to answer)") : standardText("calc");
  $("po-fill").placeholder = merged ? tr("(none on merged sheets: the header says how to answer)") : standardText("fill");
  const iso = paper === "iso";
  const w = layout.id === "merged1" ? "180pt" : layout.id === "merged2" ? "90pt" : iso ? "91pt" : "95pt";
  $("po-width").placeholder = w;
  $("po-width-hint").textContent = tr("width of the written-answer boxes; bubbles and number cells scale with it (default {w} for this layout; {range})",
    { w, range: layout.id === "merged1" ? "60–255pt" : layout.id === "merged2" ? `60–${iso ? 139 : 148}pt` : tr("50pt up") });
  showPageOptions();
  $("po-pad").closest("label").querySelector(".sub").textContent = quiz.summary && quiz.summary.max_options
    ? tr("Every multiple-choice question gets as many bubbles as the quiz's question with the most options ({n} for this quiz), so every row looks the same (the default). Untick to print one bubble per option.", { n: quiz.summary.max_options })
    : tr("Every multiple-choice question gets as many bubbles as the quiz's question with the most options, so every row looks the same (the default). Untick to print one bubble per option.");
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
    $(id).value = v;
    any = true;
  }
  for (const r of document.querySelectorAll('input[name="po-marker"]')) r.checked = r.value === (got["--option-dot"] ? "dot" : "nodot");
  for (const id of FONT_PICKS) if (setFont(id, got[FONT_OPT[id]])) any = true;
  const letters = (got["--option-letters"] || "circled").toLowerCase();
  $("po-enclosed").checked = letters !== "plain";
  for (const r of document.querySelectorAll('input[name="po-enclosed-style"]')) r.checked = r.value === (letters === "filled" ? "filled" : "circled");
  showEnclosed();
  any = any || letters !== "circled";
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
    $("po-aci-state").textContent = tr("The configuration used {f}: choose it (and its images) again.", { f: aci });
  }
  any = any || aciWant !== "standard";
  $("po-option-columns").value = got["--option-columns"] || "1";
  for (const [id, opt] of Object.entries(PO_FLAGS)) $(id).checked = !!got[opt];
  $("po-pad").checked = !got["--no-option-pad"];
  any = any || got["--no-option-pad"] || got["--option-dot"] || got["--option-columns"] || Object.values(PO_FLAGS).some((o) => got[o]);
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
  $("exams-hint").textContent = hasClass ? "" : tr("A unique exam for each student and variants need a class list.");
  $("exams-hint").hidden = hasClass;
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
  $("why").textContent = !exportFile ? tr("Choose the quiz export to continue.")
    : !ready ? tr("Create Exam Packet is ready once the exam maker has loaded.")
    : quiz.state === "error" ? tr("Choose a Canvas quiz export (.zip) or a Word document (.docx) to continue.")
    : quiz.state === "choose" ? tr("Choose which quiz to print.")
    : !quizReady ? tr("Reading the quiz…")
    : !(hasClass || b > 0) ? tr("Choose a class list or at least one blank card.")
    : poolProblem || classIssue;
}

// the options for a run, without the files: the configuration that can be saved and loaded
function options(run = false) {
  const a = [...layoutArgs(layout)];
  if (quizCjk()) a.push("--cjk-region", cjkChosen());
  a.push(...langArgs());
  if (quiz.list.length > 1) a.push("--quiz", String(quiz.number));
  if (classFile && mode() === "variants") a.push("--variants", String(clamp($("variants"), parseInt($("variants").value, 10) || 1)));
  a.push(...classArgs());
  a.push(...printArgs(run));
  a.push(...pageArgs());
  a.push(...advArgs());
  if (blanks() > 0) a.push("--blank-cards", String(blanks()));
  a.push(...poolArgs());
  return [...a, ...extras];
}

function argv(password) {
  return [exportFile.name, ...(classFile ? ["--class-list", classFile.name] : []), ...options(true), ...(password ? ["--password"] : []),
    "--messages-language", uiLang];
}

// ------------------------------------------------------------------ the question pool

// --max-items (a number of questions drawn from the whole quiz) or --title-map (questions with the
// same name form a bank; a number drawn from each). The program allows one of them at a time.
const pool = { total: 0, titles: [], classic: false, picks: [], perExam: 0 };
// the number of questions an exam gets when the pool is not altered
const poolDefault = () => (pool.picks.length && !$("ignore-banks").checked ? pool.perExam : pool.total);

function resetPool(s) {
  pool.total = s.questions;
  pool.titles = s.titles;
  pool.classic = s.engine === "classic";
  pool.picks = s.pick_rules;
  pool.perExam = s.per_exam_with_banks || s.questions;
  $("ignore-banks").checked = false;
  $("limit").max = String(s.questions);
  $("limit").value = String(poolDefault());
  showLimitDefault();
  $("simulate").checked = false;
  $("simulate").disabled = !pool.classic;
  showPoolTexts();
  $("titles").replaceChildren(...s.titles.map((t, i) => {
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `<span class="t"></span><input type="number" min="0" max="${t.count}" step="1" value="${t.count}" inputmode="numeric"><span class="of"></span>`;
    row.querySelector(".of").textContent = tr("of {n}", { n: t.count });
    const name = row.querySelector(".t");
    name.textContent = t.title || tr("(no name)");
    name.classList.toggle("none", !t.title);
    const input = row.querySelector("input");
    input.dataset.index = String(i);
    input.setAttribute("aria-label", tr("Questions named {t}, at most {n}", { t: t.title || tr("(no name)"), n: t.count }));
    input.addEventListener("input", update);
    return row;
  }));
  if (pending) applyPendingPool();
}

// the pool's texts that depend on the quiz, also redrawn when the page's language changes
function showPoolTexts() {
  $("simulate-sub").textContent = pool.classic
    ? tr("Questions with the same name form a bank. Choose how many questions each exam draws from each name.")
    : tr("Only for Classic Quizzes exports: New Quizzes do not keep question names in their exports.");
  pool.titles.forEach((t, i) => {
    const row = $("titles").children[i];
    if (!row) return;
    row.querySelector(".of").textContent = tr("of {n}", { n: t.count });
    if (!t.title) row.querySelector(".t").textContent = tr("(no name)");
    row.querySelector("input").setAttribute("aria-label", tr("Questions named {t}, at most {n}", { t: t.title || tr("(no name)"), n: t.count }));
  });
}

function counts() {
  return [...$("titles").querySelectorAll("input")].map((i) => i.value.trim() === "" ? NaN : Number(i.value));
}

function showLimitDefault() {
  const d = poolDefault();
  $("limit-of").textContent = d === pool.total
    ? trn(pool.total, "of {n} question (default: all {n})", "of {n} questions (default: all {n})")
    : trn(pool.total, "of {n} question (default: {d}, following the item banks)", "of {n} questions (default: {d}, following the item banks)", { d });
}

$("ignore-banks").addEventListener("change", () => {
  // the limit follows the default it was showing
  const before = $("ignore-banks").checked ? pool.perExam : pool.total;
  if (Number($("limit").value) === before) $("limit").value = String(poolDefault());
  showLimitDefault();
  update();
});

// shows the state of the pool controls; returns why Generate cannot go ahead, or ""
function showPool() {
  const sim = $("simulate").checked;
  const limited = !sim && Number($("limit").value) !== poolDefault();
  // ignoring item banks: only when the quiz has "pick N" rules, and not while another choice replaces them
  const picks = pool.picks;
  const ignoreOff = !picks.length || sim || limited;
  $("ignore-banks").disabled = ignoreOff;
  $("ignore-row").classList.toggle("off", ignoreOff);
  const rules = picks.slice(0, 4).map((r) => tr("“{name}” picks {pick} of {of}", r)).join("; ") + (picks.length > 4 ? tr("; and {n} more", { n: picks.length - 4 }) : "");
  $("ignore-sub").textContent = !picks.length
    ? tr("For quizzes whose item banks or question groups pick some of their questions (“pick N”). This quiz has none, so every question is used.")
    : (sim ? tr("Not used while question banks are simulated: the names decide. ")
      : limited ? tr("Not used while the test is limited: the questions are drawn from the whole quiz. ")
      : "") +
      tr("By default each exam follows the quiz's item banks ({rules}), giving {per} questions per exam. Tick to print every question of the banks instead ({total} per exam).",
        { rules, per: pool.perExam, total: pool.total });
  $("limit-row").classList.toggle("off", sim);
  for (const el of [$("limit"), ...document.querySelectorAll('[data-step="limit"]')]) el.disabled = sim;
  $("banks").classList.toggle("off", !pool.classic);
  $("titles").classList.toggle("off", !sim);
  for (const i of $("titles").querySelectorAll("input")) i.disabled = !sim;
  $("limit-hint").textContent = sim ? tr("Not used while question banks are simulated.")
    : pool.picks.length && !$("ignore-banks").checked ? tr("Each exam gets this many questions. Changing the number draws them at random from the whole quiz instead of following the item banks.")
    : tr("Each exam gets this many questions, drawn at random from the whole quiz.");
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
      total.textContent = tr("“{t}” takes a whole number from 0 to {n}.", { t: t.title || tr("(no name)"), n: t.count });
      return tr("Fix the number of questions for “{t}”.", { t: t.title || tr("(no name)") });
    }
    if (sum === 0) { total.textContent = tr("Choose at least one question."); return tr("Choose at least one question for the exam."); }
    total.textContent = trn(sum, "Each exam: {n} question from {used} of {names} names.", "Each exam: {n} questions from {used} of {names} names.", { used, names: pool.titles.length });
    return "";
  }
  const n = Number($("limit").value);
  if (!Number.isInteger(n) || n < 1 || n > pool.total) return tr("Limit the test to a number of questions from 1 to {n}.", { n: pool.total });
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
  if (Number.isInteger(n) && n >= 1 && n <= pool.total && n !== poolDefault()) return ["--max-items", String(n)];
  return pool.picks.length && $("ignore-banks").checked ? ["--ignore-item-banks"] : [];
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
    `#   python mastertest_builder.py <quiz export.zip>${lastArgs.classList ? " --class-list <class list.csv>" : ""} @<this file>`,
  ];
  if (seed && !o.includes("--seed")) head.push(`# This run used --seed ${seed}; add that line to print exactly the same exams again.`);
  return head.join("\n") + "\n\n" + lines.join("\n") + "\n";
}

function offerConfig(data) {
  if (configUrl) URL.revokeObjectURL(configUrl);
  configUrl = URL.createObjectURL(new Blob([configText(data.seed)], { type: "text/plain" }));
  const a = $("config-download");
  a.href = configUrl;
  a.download = data.name.replace(/\.(zip|docx)$/i, "") + "_config.txt";
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
    "--margin", "--font", "--font-size", "--question-spacing", "--option-font", "--option-letters", "--cjk-region", "--print-language", "--decimal-mark", "--csv-separator", "--option-font-size", "--option-columns",
    "--calculated-instructions", "--fill-blank-instructions", "--fill-blank-text",
    "--margin-left", "--margin-right", "--margin-top", "--margin-bottom", "--answer-width", "--cell-shading",
    "--answer-card-instructions", "--page-options", "--qr-quality", "--seed"]);
  for (let i = 0; i < t.length; i++) {
    const o = t[i];
    if (takes.has(o)) { got[o] = t[i + 1] !== undefined ? t[++i] : ""; continue; }
    if (["--password", "--ignore-item-banks", "--randomize-seats", "--no-option-pad", "--show-points", "--no-quiz-instructions", "--option-dot"].includes(o)) { got[o] = true; continue; }
    if (o === "--no-option-dot") continue;   // the default
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
  cjkRegion = got["--cjk-region"] && got["--cjk-region"].toLowerCase() !== "auto" ? got["--cjk-region"].toLowerCase() : null;
  printLang = (got["--print-language"] || "en").toLowerCase() === "fr" ? "fr" : "en";
  printLangChosen = true;
  const mark = (got["--decimal-mark"] || "").toLowerCase();
  decimalChosen = mark === "point" || mark === "comma" ? (mark === langDecimal() ? null : mark) : null;
  const sep = (got["--csv-separator"] || "").toLowerCase();
  csvChosen = sep === "comma" || sep === "semicolon" ? (sep === langCsv() ? null : sep) : null;
  showLanguage();
  showCjk();
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
  pending = { quiz: got["--quiz"] ? Number(got["--quiz"]) : null, maxItems: got["--max-items"] || null, titleMap: got["--title-map"] || null,
    ignore: !!got["--ignore-item-banks"] };
  configName = name;
  // say what was loaded
  const parts = [tr("{layout} on {paper} paper", { layout: layoutName(LAYOUTS.find((l) => l.id === layout.id)), paper: iso ? "A4/A3" : tr("letter/tabloid") })];
  if (variants) parts.push(tr("{n} variants", { n: v }));
  if (Number(got["--blank-cards"]) > 0) parts.push(trn(Number(got["--blank-cards"]), "{n} blank card", "{n} blank cards"));
  if (pending.maxItems) parts.push(tr("{n} questions per exam", { n: pending.maxItems }));
  if (pending.titleMap) parts.push(tr("simulated question banks"));
  if (pending.ignore) parts.push(tr("item banks ignored"));
  if (pending.quiz) parts.push(tr("quiz {n} of the export", { n: pending.quiz }));
  if (cls.randomize) parts.push(tr($("seat-labels").value ? "seats from seat labels" : "randomized seats"));
  if (cls.id || cls.qr.length) parts.push(tr("class list options"));
  if (cls.att.length || cls.sort || cls.orient !== "portrait") parts.push(tr("attendance sheet options"));
  if (setPrintOptions(got)) parts.push(tr("print options"));
  // page options and advanced options
  const canon = (v) => v.trim().toLowerCase();
  const wanted = csvSplit(got["--page-options"] || "").map(canon);
  for (const box of document.querySelectorAll("#page-opts input")) box.checked = wanted.includes(canon(box.dataset.po));
  const unknownPages = wanted.filter((w) => ![...document.querySelectorAll("#page-opts input")].some((b) => canon(b.dataset.po) === w));
  if (unknownPages.length) extras.push("--page-options", unknownPages.join(","));   // the program explains them
  showPageOptions();
  if (wanted.length) { $("page-details").open = true; parts.push(tr("page options")); }
  $("adv-qr").value = ["L", "Q", "H"].includes((got["--qr-quality"] || "").toUpperCase()) ? got["--qr-quality"].toUpperCase() : "";
  $("adv-seed").value = got["--seed"] || "";
  if (got["--qr-quality"] || got["--seed"]) { $("adv-details").open = true; parts.push(got["--seed"] ? tr("seed {n}", { n: got["--seed"] }) : tr("QR code quality")); }
  if (sortBy.length > 1) parts.push(tr("sorted by {c} only (the page sorts by one column)", { c: sortBy[0] }));
  let msg = tr("Loaded {name}: {parts}.", { name, parts: parts.join(", ") });
  if (extras.length) msg += tr(" Also used when generating: {extras}.", { extras: extras.join(" ") });
  if (got["--password"]) msg += tr(" The answer key was password protected; you are asked for a password when you generate.");
  if (ignored.length) msg += tr(" Not used here (choose the files on this page): {list}.", { list: ignored.join(", ") });
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
    if (!pool.classic) problems.push(tr("its simulated question banks are only for Classic Quizzes exports"));
    else {
      const map = new Map();
      for (const part of p.titleMap.split(/(?<!\\);/)) {
        const s = part.replace(/\\;/g, ";").trim();
        if (!s) continue;
        const at = s.lastIndexOf("=");
        if (at < 0) { problems.push(tr("“{s}” in its title map has no =count", { s })); continue; }
        map.set(s.slice(0, at).trim(), Number(s.slice(at + 1).trim()));
      }
      if (map.size) {
        $("simulate").checked = true;
        const inputs = $("titles").querySelectorAll("input");
        pool.titles.forEach((t, i) => { inputs[i].value = String(map.has(t.title) ? map.get(t.title) : 0); });
        const missing = [...map.keys()].filter((k) => !pool.titles.some((t) => t.title === k));
        if (missing.length) problems.push(tr("this quiz has no questions named {list}", { list: missing.map((m) => `“${m}”`).join(", ") }));
      } else if (!/=/.test(p.titleMap)) problems.push(tr("its title map is a file ({f}); set the numbers here instead", { f: p.titleMap }));
    }
  } else if (p.ignore) {
    if (pool.picks.length) { $("ignore-banks").checked = true; $("limit").value = String(poolDefault()); showLimitDefault(); }
    else problems.push(tr("it ignores item banks, but this quiz has no “pick N” rules"));
  }
  if (!p.titleMap && p.maxItems) {
    const n = Number(p.maxItems);
    if (Number.isInteger(n) && n >= 1 && n <= pool.total) $("limit").value = String(n);
    else problems.push(tr("it limits the test to {n} questions, but this quiz has {total}", { n: p.maxItems, total: pool.total }));
  }
  if (problems.length) showConfigState($("config-text").textContent + tr(" Check the question pool: {problems}.", { problems: problems.join("; ") }), true);
  if (p.titleMap || p.maxItems || p.ignore) $("pool").open = true;
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
    if (f.size > 100000) throw new Error(tr("this is not an exam configuration (too large)"));
    loadConfig(f.name, await f.text());
  } catch (err) {
    showConfigState(tr("{name} could not be loaded: {why}.", { name: f.name, why: err.message }), true);
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
  if (!pw) return { level: "none", label: tr("No password"), pct: 4 };
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
  if (bits < 40) return { level: "low", label: tr("Low strength"), pct };
  if (bits < 60) return { level: "medium", label: tr("Medium strength"), pct };
  return { level: "strong", label: tr("Strong password"), pct };
}

function showStrength() {
  const s = strength($("pw").value);
  const bar = $("pw-bar");
  bar.style.width = s.pct + "%";
  bar.style.background = `var(--${s.level === "medium" ? "medium" : s.level === "strong" ? "strong" : "weak"})`;
  $("pw-strength").textContent = s.label;
  $("pw-strength").dataset.level = s.level;
  $("pw-accept").textContent = tr($("pw").value ? "Accept password" : "Continue without a password");
}

function openPassword() {
  $("pw").value = "";
  $("pw").type = "password";
  $("pw-show").textContent = tr("Show");
  $("pw-show").setAttribute("aria-pressed", "false");
  showStrength();
  $("pw-dialog").showModal();
  $("pw").focus();
}
$("pw").addEventListener("input", showStrength);
$("pw-show").addEventListener("click", () => {
  const show = $("pw").type === "password";
  $("pw").type = show ? "text" : "password";
  $("pw-show").textContent = tr(show ? "Hide" : "Show");
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
  $("result-title").textContent = tr("Making your exam…");
  $("result-text").textContent = tr("This takes a few seconds for a class, longer for large exams.");
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
  try {
    files.push(...await fontFiles());
  } catch (err) {
    $("log").textContent = "ERROR: " + (err && err.message ? err.message : err) + "\n";
    finish(false);
    return;
  }
  const cjk = quizCjk() && cjkFonts[cjkChosen()] ? cjkChosen() : null;
  worker.postMessage({ type: "run", files, argv: argv(password), password, cjk }, files.map((f) => f.data));
}

$("back").addEventListener("click", () => { showStep(1); $("generate").focus(); });

function finish(ok, data) {
  running = false;
  update();
  $("back").hidden = false;
  if (!ok) {
    $("big").className = "big-bubble bad";
    $("big").innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4"/></svg>';
    $("result-title").textContent = tr("The exam could not be made");
    $("result-text").textContent = tr("The message below says what to change. Go back, adjust your choices and generate again.");
    const errors = $("log").textContent.split("\n").filter((l) => /^(ERROR:|ERREUR :)/.test(l));
    $("log").textContent = errors.length ? errors.join("\n").replace(/^(ERROR: |ERREUR : )/gm, "") : $("log").textContent;
    $("log").hidden = false;
    $("back").textContent = tr("Back to step 1");
    $("result-title").focus();
    return;
  }
  downloadUrl = URL.createObjectURL(new Blob([data.zip], { type: "application/zip" }));
  const a = $("download");
  a.href = downloadUrl;
  a.download = data.name;
  a.textContent = tr("Download {name} again", { name: data.name });
  a.hidden = false;
  offerConfig(data);
  $("big").className = "big-bubble ok";
  $("big").innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6"/></svg>';
  $("result-title").textContent = tr("Your exam is now downloading");
  $("result-text").textContent = tr("{name} holds the exams, answer cards and answer key, ready to print. Scan the answer key with MasterTest Marker first, then the cards.", { name: data.name });
  $("back").textContent = tr("Make another exam");
  $("result-title").focus();
  a.click();
}

worker.onmessage = ({ data }) => {
  if (data.type === "progress") {
    $("result-text").textContent = data.region
      ? tr("Downloading the {region} font ({mb} MB; only the first time)…", { region: cjkName(data.region), mb: data.mb }) : tr(data.text);
  } else if (data.type === "status") {
    $("engine-detail").textContent = "· " + tr(data.text.replace(/…$/, ""));
  } else if (data.type === "ready") {
    ready = true;
    engineSeconds = data.seconds;
    $("engine-state").textContent = tr("Ready");
    $("engine-detail").textContent = tr("· loaded in {s} s", { s: data.seconds.toFixed(0) });
    $("version-line").textContent = `MasterTest Web ${data.spec.version}`;
    $("version-top").textContent = data.spec.version;
    cjkFonts = data.cjk || {};
    showCjk();
    if (exportFile && quiz.state === "reading") { showQuiz(); inspectExport(); }
    if (classFile && cls.state === "reading") { showClass(); inspectClass(); }
    update();
  } else if (data.type === "error") {
    $("engine-state").textContent = tr("Could not start");
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

// the version, at once (the worker reports it again once loaded)
fetch("build.json", { cache: "no-cache" }).then((r) => r.json()).then((b) => {
  $("version-top").textContent = b.version;
  if ($("version-line").textContent === "MasterTest Web") $("version-line").textContent = `MasterTest Web ${b.version}`;
}).catch(() => {});

// ------------------------------------------------------------------ the page's language

let engineSeconds = null;

// Shows the page in English or French (remembered in this browser). Everything the page wrote
// is written again in the new language; the print language follows unless it was chosen.
function setUiLang(lang, first = false) {
  uiLang = lang;
  try { localStorage.setItem("mastertest-ui-lang", lang); } catch (e) { /* no storage */ }
  for (const b of document.querySelectorAll(".ui-lang button")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  if (!printLangChosen) printLang = lang;
  translatePage();
  if (first) return;
  setPaper(paper);
  for (const id of FONT_PICKS) { const keep = $(id).value; fontMenu(id); $(id).value = keep; fontState(id, fontNotes[id]); }
  showLanguage();
  showQuiz();
  if (quiz.state === "ready" && quiz.summary) { setMergedAvailable(quiz.summary); showPoolTexts(); showLimitDefault(); }
  if (cls.state !== "none") showClass();
  // what MasterTest Builder said about the files, again in the new language
  if (ready && exportFile && quiz.number && quiz.state === "ready") refreshSummary();
  if (ready && classFile && cls.state !== "none") { cls.state = "reading"; showClass(); inspectClass(); }
  if (ready) {
    $("engine-state").textContent = tr("Ready");
    if (engineSeconds !== null) $("engine-detail").textContent = tr("· loaded in {s} s", { s: engineSeconds.toFixed(0) });
  }
  showStrength();
  update();
}
for (const b of document.querySelectorAll(".ui-lang button")) b.addEventListener("click", () => { if (b.dataset.lang !== uiLang) setUiLang(b.dataset.lang); });

setUiLang(uiLang, true);
buildLayouts();
showPrintDefaults();
showLanguage();
update();
