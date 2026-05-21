/* ==========================================================
   Parrot Slot — game logic with bonus games
   - 5x3 reels, 20 paylines
   - localStorage credit persistence
   - Hi-Lo gamble bonus (double-or-nothing) on every win
   - Free Spins bonus when 3+ butterflies hit
   ========================================================== */

const STORAGE_KEY = "parrot-slot-v3";
const STARTING_CREDIT = 500;

const FREE_SPIN_MULTIPLIER = 3;
const MAX_GAMBLE_ROUNDS = 5;
const FREE_SPIN_CAP = 20; // safety cap to avoid runaway retriggers

const symbols = {
  wild:      { label: "PARROT",    icon: "🦜", img: "assets/symbols/parrot.png",    weight: 2,  pays: [0, 0, 0,  0,   0],   cls: "wild" },
  scatter:   { label: "FISH",      icon: "🐟", img: "assets/symbols/fish.png",      weight: 3,  pays: [0, 0, 2,  10,  50],  cls: "scatter" },
  butterfly: { label: "BUTTERFLY", icon: "🦋", img: "assets/symbols/butterfly.png", weight: 7,  pays: [0, 2, 20, 50,  100], cls: "butterfly" },
  leopard:   { label: "LEOPARD",   icon: "🐆", img: "assets/symbols/leopard.png",   weight: 8,  pays: [0, 5, 50, 150, 250], cls: "leopard" },
  crocodile: { label: "CROC",      icon: "🐊", img: "assets/symbols/crocodile.png", weight: 9,  pays: [0, 2, 30, 75,  150], cls: "crocodile" },
  woman:     { label: "DANCER",    icon: "💃", img: "assets/symbols/woman.png",     weight: 9,  pays: [0, 3, 40, 100, 200], cls: "woman" },
  k:         { label: "K",  icon: "K",  img: "assets/symbols/k.png",    weight: 12, pays: [0, 0, 15, 40, 80], cls: "card", color: "#f0a07c" },
  q:         { label: "Q",  icon: "Q",  img: "assets/symbols/q.png",    weight: 12, pays: [0, 0, 10, 30, 75], cls: "card", color: "#7ac4a3" },
  j:         { label: "J",  icon: "J",  img: "assets/symbols/j.png",    weight: 13, pays: [0, 0, 5,  20, 60], cls: "card", color: "#7eaedd" },
  ten:       { label: "10", icon: "10", img: "assets/symbols/ten.png",  weight: 14, pays: [0, 0, 5,  20, 50], cls: "card", color: "#d98aa9" },
  nine:      { label: "9",  icon: "9",  img: "assets/symbols/nine.png", weight: 15, pays: [0, 0, 5,  10, 50], cls: "card", color: "#b8a4e0" }
};

const payLines = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 1, 1, 1, 0],
  [2, 1, 1, 1, 2],
  [1, 0, 1, 2, 1],
  [1, 2, 1, 0, 1],
  [0, 1, 0, 1, 0],
  [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1],
  [1, 1, 2, 1, 1],
  [0, 2, 0, 2, 0],
  [2, 0, 2, 0, 2],
  [0, 2, 2, 2, 0]
];

const lineColors = [
  "#ff8b94", "#a8e6cf", "#c8b6ff", "#b5d8f7", "#ffd3b6",
  "#ffc8dd", "#a2d2ff", "#cdb4db", "#ffafcc", "#bde0fe"
];

// Each of the 20 paylines gets a fixed slot in either the left (1..10)
// or right (11..20) side column. Within a side, lines are grouped by
// the row their leftmost cell sits in (top → middle → bottom), then
// sorted by line number — so line 1 (a middle horizontal) lands in the
// middle slot of the left column, line 14 (top zigzag) lands at the
// very top of the right column, etc.
const LINE_SLOTS = (() => {
  const slots = new Array(20);
  for (let sideIdx = 0; sideIdx < 2; sideIdx += 1) {
    const start = sideIdx * 10;
    const lineIndices = [];
    for (let i = start; i < start + 10; i += 1) lineIndices.push(i);
    const grouped = [[], [], []];
    lineIndices.forEach((i) => grouped[payLines[i][0]].push(i));
    grouped.forEach((arr) => arr.sort((a, b) => a - b));
    let slot = 0;
    grouped.forEach((arr) => {
      arr.forEach((i) => {
        slots[i] = { side: sideIdx === 0 ? "left" : "right", slot };
        slot += 1;
      });
    });
  }
  return slots;
})();

// Spin lifecycle phases — IDLE waits for SPIN, LOOPING is the fast
// continuous reel scroll (a second SPIN press stops it), STOPPING is
// the sequential deceleration when no input can interrupt.
const SPIN_PHASE = {
  IDLE: "idle",
  LOOPING: "looping",
  STOPPING: "stopping",
};

const state = {
  credit: STARTING_CREDIT,
  lines: 20,        // active paylines (1..20). spin cost = lines × 1 credit
  win: 0,           // pending win (settled into credit after bonus decisions)
  bonusWin: 0,      // accumulated win during a free-spins session
  spinning: false,
  spinPhase: SPIN_PHASE.IDLE,
  auto: false,
  sound: true,
  grid: [],
  inFreeSpins: false,
  freeSpinsLeft: 0,
  freeSpinsTotal: 0,
  multiplier: 1
};

let stopSignalFn = null;
function triggerStopSignal() {
  if (stopSignalFn) {
    const fn = stopSignalFn;
    stopSignalFn = null;
    fn();
  }
}

function updateSpinBtnText() {
  const text = els.spinBtn && els.spinBtn.querySelector(".spin-text");
  if (!text) return;
  const looping = state.spinPhase === SPIN_PHASE.LOOPING;
  text.textContent = looping ? "STOP" : "SPIN";
  els.spinBtn.classList.toggle("stop-mode", looping);
}

/* ===================== Persistence ===================== */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.credit === "number" && data.credit >= 0) {
      state.credit = data.credit;
    }
    if (typeof data.lines === "number" && data.lines >= 1 && data.lines <= 20) {
      state.lines = data.lines;
    }
  } catch (err) { /* ignore */ }
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ credit: state.credit, lines: state.lines })
    );
  } catch (err) { /* ignore */ }
}

/* ===================== Element refs ===================== */

const els = {
  credit: document.getElementById("credit"),
  bet: document.getElementById("bet"),
  win: document.getElementById("win"),
  message: document.getElementById("message"),
  reels: document.getElementById("reels"),
  paylines: document.getElementById("paylines"),
  coinLayer: document.getElementById("coinLayer"),
  board: document.querySelector(".board"),
  leftBadges: document.getElementById("leftBadges"),
  rightBadges: document.getElementById("rightBadges"),
  spinBtn: document.getElementById("spinBtn"),
  betUp: document.getElementById("betUp"),
  betDown: document.getElementById("betDown"),
  autoBtn: document.getElementById("autoBtn"),
  soundBtn: document.getElementById("soundBtn"),
  restartBtn: document.getElementById("restartBtn"),
  linesResetBtn: document.getElementById("linesResetBtn"),

  resetModal: document.getElementById("resetModal"),
  cancelReset: document.getElementById("cancelReset"),
  confirmReset: document.getElementById("confirmReset"),
  rulesBtn: document.getElementById("rulesBtn"),
  rulesModal: document.getElementById("rulesModal"),
  closeRulesBtn: document.getElementById("closeRulesBtn"),

  bonusPill: document.getElementById("bonusPill"),
  bonusPillCount: document.getElementById("bonusPillCount"),
  bonusPillMulti: document.getElementById("bonusPillMulti"),

  freeSpinsModal: document.getElementById("freeSpinsModal"),
  freeSpinsModalCount: document.getElementById("freeSpinsModalCount"),
  freeSpinsModalMulti: document.getElementById("freeSpinsModalMulti"),
  startFreeSpinsBtn: document.getElementById("startFreeSpinsBtn"),

  freeSpinsSummary: document.getElementById("freeSpinsSummary"),
  bonusTotalWin: document.getElementById("bonusTotalWin"),
  closeFreeSpinsSummary: document.getElementById("closeFreeSpinsSummary"),

  playUI: document.getElementById("playUI"),
  gambleInline: document.getElementById("gambleInline"),
  gambleTitle: document.getElementById("gambleTitle"),
  gambleAmount: document.getElementById("gambleAmount"),
  hiloPrevCard: document.getElementById("hiloPrevCard"),
  hiloPrevRank: document.getElementById("hiloPrevRank"),
  hiloPrevSuit: document.getElementById("hiloPrevSuit"),
  hiloNextCard: document.getElementById("hiloNextCard"),
  hiloNextRank: document.getElementById("hiloNextRank"),
  hiloNextSuit: document.getElementById("hiloNextSuit"),
  hiloHint: document.getElementById("hiloHint"),
  hiloChoices: document.getElementById("hiloChoices"),
  hiloHigher: document.getElementById("hiloHigher"),
  hiloLower: document.getElementById("hiloLower"),
  gambleActions: document.getElementById("gambleActions"),
  takeWinBtn: document.getElementById("takeWinBtn"),
  startGambleBtn: document.getElementById("startGambleBtn")
};

/* ===================== Asset preload ===================== */

const assetPromises = Object.values(symbols).map((symbol) => {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener("load", () => { symbol.ready = true; resolve(); }, { once: true });
    img.addEventListener("error", () => { symbol.ready = false; resolve(); }, { once: true });
    img.src = symbol.img;
  });
});

/* ===================== Utility ===================== */

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openModal(modal) {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal(modal) {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

// One inline slot at the bottom of the screen — only one of these panels
// is visible at a time. The board (with win highlights) stays visible above.
const BOTTOM_PANELS = ["playUI", "gambleInline", "freeSpinsModal", "freeSpinsSummary"];

function showBottomPanel(name) {
  BOTTOM_PANELS.forEach((p) => {
    const el = els[p];
    if (!el) return;
    el.classList.toggle("hidden", p !== name);
  });
}

function showGamblePanel() { showBottomPanel("gambleInline"); }
function hideGamblePanel() { showBottomPanel("playUI"); }

/* ===================== Symbol picking ===================== */

function weightedPick(reelIndex) {
  const entries = Object.entries(symbols).filter(
    ([key]) => !(key === "wild" && reelIndex === 0)
  );
  const total = entries.reduce((sum, [, sym]) => sum + sym.weight, 0);
  let roll = Math.random() * total;
  for (const [key, sym] of entries) {
    roll -= sym.weight;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

/* ===================== DOM construction ===================== */

function createSymbol(key) {
  const symbol = symbols[key];
  const wrap = document.createElement("div");
  wrap.className = `symbol ${symbol.cls} sym-${key}`;
  if (symbol.color) wrap.style.color = symbol.color;

  if (symbol.ready) {
    const img = document.createElement("img");
    img.className = "symbol-img";
    img.alt = symbol.label;
    img.src = symbol.img;
    wrap.appendChild(img);
  } else {
    const span = document.createElement("span");
    span.className = "symbol-fallback";
    span.textContent = symbol.icon;
    wrap.appendChild(span);
  }
  return wrap;
}

function createCell(key, col, row) {
  const cell = document.createElement("div");
  cell.className = "cell";
  if (col !== undefined && row !== undefined) {
    cell.dataset.col = String(col);
    cell.dataset.row = String(row);
  }
  cell.appendChild(createSymbol(key));
  return cell;
}

function renderGrid() {
  els.reels.innerHTML = "";
  for (let col = 0; col < 5; col += 1) {
    const reel = document.createElement("div");
    reel.className = "reel";
    const strip = document.createElement("div");
    strip.className = "reel-strip";
    for (let row = 0; row < 3; row += 1) {
      strip.appendChild(createCell(state.grid[col][row], col, row));
    }
    reel.appendChild(strip);
    els.reels.appendChild(reel);
  }
}

function seedGrid() {
  state.grid = Array.from({ length: 5 }, (_, col) =>
    Array.from({ length: 3 }, () => weightedPick(col))
  );
  renderGrid();
}

function makeFinalGrid() {
  return Array.from({ length: 5 }, (_, col) =>
    Array.from({ length: 3 }, () => weightedPick(col))
  );
}

/* ===================== Reel animation ===================== */

// Start ONE reel scrolling. The reel speed eases down from FAST to a
// slower cruise over `rampDurationMs`, and the strip auto-extends every
// frame so it can never run out (no white gap). The returned stop
// function splices the predetermined final 3 cells just ahead of where
// the reel is RIGHT NOW and glides to land there at the current speed.
function startReelSpin(reelEl, col, finalColumn) {
  const reelHeight = reelEl.clientHeight;
  const padding = 4;
  const gap = 4;
  const cellHeight = (reelHeight - padding * 2 - gap * 2) / 3;
  const step = cellHeight + gap;

  const strip = document.createElement("div");
  strip.style.position = "absolute";
  strip.style.top = "0";
  strip.style.left = "0";
  strip.style.right = "0";
  strip.style.display = "flex";
  strip.style.flexDirection = "column";
  strip.style.gap = `${gap}px`;
  strip.style.padding = `${padding}px`;
  strip.style.willChange = "transform";

  // Seed with enough cells for the first chunk; the tick loop appends
  // more random fillers as the reel scrolls.
  const initialFillerCount = 30;
  for (let i = 0; i < initialFillerCount; i += 1) {
    const cell = createCell(weightedPick(col));
    cell.style.flex = `0 0 ${cellHeight}px`;
    cell.style.height = `${cellHeight}px`;
    strip.appendChild(cell);
  }

  reelEl.innerHTML = "";
  reelEl.appendChild(strip);

  const ensureCells = (countNeeded) => {
    while (strip.children.length < countNeeded) {
      const filler = createCell(weightedPick(col));
      filler.style.flex = `0 0 ${cellHeight}px`;
      filler.style.height = `${cellHeight}px`;
      strip.appendChild(filler);
    }
  };

  // Ease-out speed ramp: punchy at first, gradually settling.
  const initialSpeedPxPerFrame = 20 + col * 0.5; // ~1200-1320 px/sec
  const finalSpeedPxPerFrame = 9 + col * 0.3;    // ~540-612 px/sec
  const rampDurationMs = 3500;

  let currentOffset = 0;
  let currentSpeedPxPerFrame = initialSpeedPxPerFrame;
  let rafId = null;
  let stopped = false;
  const startTime = performance.now();
  let lastTime = startTime;

  const tick = (now) => {
    if (stopped) return;
    const dt = now - lastTime;
    lastTime = now;

    const elapsed = now - startTime;
    const t = Math.min(1, elapsed / rampDurationMs);
    const eased = 1 - (1 - t) * (1 - t); // ease-out
    currentSpeedPxPerFrame =
      initialSpeedPxPerFrame +
      (finalSpeedPxPerFrame - initialSpeedPxPerFrame) * eased;

    currentOffset += currentSpeedPxPerFrame * (dt / 16.67);

    // Always keep 15 cells beyond the visible window so the strip can
    // never run out and show a white gap.
    const visibleEndIdx = Math.ceil((currentOffset + reelHeight) / step) + 15;
    ensureCells(visibleEndIdx);

    strip.style.transform = `translateY(-${currentOffset}px)`;
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return function stopReel() {
    return new Promise((resolve) => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);

      // Later reels still travel a bit farther for sequential feel,
      // but distances are tighter so STOP responds quickly.
      const cellsAheadByCol = [2, 3, 4, 5, 7];
      const cellsAhead = cellsAheadByCol[col] ?? 4;
      const currentCellIdx = Math.ceil(currentOffset / step);
      const stopCellIdx = currentCellIdx + cellsAhead;
      const finalOffset = stopCellIdx * step;

      // Splice the predetermined final 3 cells into the strip at the
      // landing slot. Extend strip if needed.
      ensureCells(stopCellIdx + finalColumn.length);
      finalColumn.forEach((key, i) => {
        const idx = stopCellIdx + i;
        const newCell = createCell(key);
        newCell.style.flex = `0 0 ${cellHeight}px`;
        newCell.style.height = `${cellHeight}px`;
        strip.replaceChild(newCell, strip.children[idx]);
      });

      // Lock current rendered position before swapping to transition
      strip.style.transition = "none";
      strip.style.transform = `translateY(-${currentOffset}px)`;
      void strip.offsetWidth;

      // Match initial transition velocity to the reel's CURRENT (already
      // partially slowed) speed — no acceleration, no jolt.
      const velocityPxPerSec = currentSpeedPxPerFrame * 60;
      const distance = finalOffset - currentOffset;
      const duration = (2 * distance) / velocityPxPerSec * 1000;

      strip.style.transition =
        `transform ${duration}ms cubic-bezier(0.2, 0.4, 0.4, 1)`;
      strip.style.transform = `translateY(-${finalOffset}px)`;

      setTimeout(resolve, duration + 40);
    });
  };
}

async function spinReels(finalGrid) {
  const reelEls = Array.from(els.reels.children);
  const stopFunctions = reelEls.map((reelEl, col) =>
    startReelSpin(reelEl, col, finalGrid[col])
  );

  // Wait for either a user STOP press OR the auto-stop timer. The
  // manual time is intentionally generous so there's actual suspense
  // before the reels start landing.
  const autoStopMs = state.auto ? 1800 : state.inFreeSpins ? 3200 : 5000;
  await new Promise((resolve) => {
    let resolved = false;
    const doResolve = () => {
      if (resolved) return;
      resolved = true;
      stopSignalFn = null;
      resolve();
    };
    stopSignalFn = doResolve;
    setTimeout(doResolve, autoStopMs);
  });

  // Switch to STOPPING phase — button can't be re-triggered now
  state.spinPhase = SPIN_PHASE.STOPPING;
  updateSpinBtnText();
  updateMeters();

  // Sequential reel stops with a snappier stagger — col 0 → col 1 → …
  // visibly in order but no excessive waiting between reels.
  await Promise.all(
    stopFunctions.map(
      (stopFn, col) =>
        new Promise((resolve) => {
          setTimeout(() => stopFn().then(resolve), col * 250);
        })
    )
  );

  state.grid = finalGrid;
  renderGrid();
}

/* ===================== UI updates ===================== */

function updateMeters() {
  els.credit.textContent = state.credit.toLocaleString();
  els.bet.textContent = state.lines;
  els.win.textContent = state.win > 0 ? `+${state.win}` : "0";
  // SPIN stays clickable during LOOPING (so the player can STOP). It is
  // disabled while reels are decelerating, or when a new spin would be
  // illegal (no active lines / no credit) in IDLE.
  els.spinBtn.disabled =
    state.spinPhase === SPIN_PHASE.STOPPING ||
    state.lines < 1 ||
    (state.spinPhase === SPIN_PHASE.IDLE &&
      !state.inFreeSpins &&
      state.credit < state.lines);
  els.betUp.disabled = state.spinning || state.inFreeSpins;
  els.betDown.disabled = state.spinning || state.inFreeSpins;
  els.autoBtn.classList.toggle("active", state.auto);
  els.soundBtn.classList.toggle("active", state.sound);
  els.spinBtn.classList.toggle("is-spinning", state.spinning);
}

function updateBonusPill() {
  if (state.inFreeSpins && state.freeSpinsTotal > 0) {
    const cur = Math.min(state.freeSpinsTotal - state.freeSpinsLeft + 1, state.freeSpinsTotal);
    els.bonusPillCount.textContent = `${cur}/${state.freeSpinsTotal}`;
    els.bonusPillMulti.textContent = state.multiplier;
    els.bonusPill.classList.remove("hidden");
  } else {
    els.bonusPill.classList.add("hidden");
  }
}

function clearHighlights() {
  document.querySelectorAll(".cell.win").forEach((c) => c.classList.remove("win"));
  els.paylines.innerHTML = "";
  els.coinLayer.innerHTML = "";
  // Keep the persistent 1..20 line tags — only clear the win glow.
  clearWinningHighlights();
}

/* ===================== Evaluation ===================== */

function evaluate() {
  const wins = [];
  let lineWin = 0;
  // Only the first state.lines paylines are active. With bet multiplier
  // implicitly fixed at 1 (one credit per line), line wins equal basePay.
  const activeLines = payLines.slice(0, state.lines);

  activeLines.forEach((line, index) => {
    const keys = line.map((row, col) => state.grid[col][row]);
    const target = keys.find((k) => k !== "wild" && k !== "scatter");
    if (!target) return;

    let count = 0;
    for (const k of keys) {
      if (k === target || k === "wild") count += 1;
      else break;
    }

    const basePay = symbols[target].pays[count - 1] || 0;
    if (basePay > 0) {
      lineWin += basePay;
      wins.push({ index, line, count, pay: basePay, target });
    }
  });

  // Scatter "pays in any position" — multiplied by total credits bet
  // (= number of lines, since each line costs 1 credit at multiplier 1).
  const scatterCount = state.grid.flat().filter((k) => k === "scatter").length;
  const scatterWin =
    scatterCount >= 3
      ? symbols.scatter.pays[Math.min(scatterCount, 5) - 1] * state.lines
      : 0;
  const total = lineWin + scatterWin;

  return { wins, scatterCount, scatterWin, total };
}

/* ===================== Win presentation ===================== */

function drawPayline(win, width, height) {
  const cellW = width / 5;
  const cellH = height / 3;
  // Each of the 20 paylines gets a UNIQUE y offset so overlapping
  // segments fan out into clearly separated parallel tracks.
  const offsetY = (win.index - 9.5) * 1.2;

  // Draw the full 5-cell payline pattern in one uniform stroke.
  const points = win.line
    .map((row, col) => {
      const x = col * cellW + cellW / 2;
      const y = row * cellH + cellH / 2 + offsetY;
      return `${x},${y}`;
    })
    .join(" ");

  const color = lineColors[win.index % lineColors.length];

  const outline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  outline.setAttribute("points", points);
  outline.setAttribute("class", "payline-path-outline");
  els.paylines.appendChild(outline);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  path.setAttribute("points", points);
  path.setAttribute("class", "payline-path");
  path.setAttribute("stroke", color);
  els.paylines.appendChild(path);
}

/* ===================== Active line hints ===================== */

// Draws ALL currently active paylines (1..state.lines) on the board as
// a cumulative preview, and adds one numbered badge on the "top" line
// (the one the player just toggled). Lines auto-fade after ~1.8s via
// the .payline-hint CSS animation; we then strip the SVG nodes.
let hintCleanupTimer = null;

function clearPreviewBadges() {
  if (els.leftBadges) {
    els.leftBadges.querySelectorAll(".preview-badge-row").forEach((n) => n.remove());
  }
  if (els.rightBadges) {
    els.rightBadges.querySelectorAll(".preview-badge-row").forEach((n) => n.remove());
  }
}

// Hide / restore the persistent win badges from a previous spin so the
// preview pills are the only set of numbers shown while -/+ is active.
function hideWinBadges() {
  ["leftBadges", "rightBadges"].forEach((key) => {
    const el = els[key];
    if (!el) return;
    el.querySelectorAll(".line-badge-row:not(.preview-badge-row)").forEach((row) => {
      row.dataset.hiddenForPreview = "1";
      row.style.display = "none";
    });
  });
}

function restoreWinBadges() {
  ["leftBadges", "rightBadges"].forEach((key) => {
    const el = els[key];
    if (!el) return;
    el.querySelectorAll('.line-badge-row[data-hidden-for-preview="1"]').forEach((row) => {
      row.style.display = "";
      delete row.dataset.hiddenForPreview;
    });
  });
}

// Place a pill for EVERY currently active line (1..state.lines) in the
// side columns — lines 1-10 on the left, 11-20 on the right, grouped by
// the starting row of each line. The just-toggled line gets a glow.
function placeAllPreviewBadges(activeCount, highlightIndex, reelsRect) {
  hideWinBadges();

  const slotsPerCol = 10;
  const slotHeight = reelsRect.height / slotsPerCol;

  for (let i = 0; i < activeCount; i += 1) {
    const info = LINE_SLOTS[i];
    if (!info) continue;
    const container = info.side === "left" ? els.leftBadges : els.rightBadges;
    if (!container) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "line-badge-row preview-badge-row";
    wrapper.style.top = `${info.slot * slotHeight}px`;
    wrapper.style.height = `${slotHeight}px`;

    const pill = document.createElement("div");
    pill.className = "line-badge-pill preview";
    if (i === highlightIndex) pill.classList.add("flash");
    pill.style.backgroundColor = lineColors[i % lineColors.length];
    pill.textContent = String(i + 1);
    wrapper.appendChild(pill);
    container.appendChild(wrapper);
  }
}

function flashActiveLines(highlightIndex) {
  if (hintCleanupTimer) {
    clearTimeout(hintCleanupTimer);
    hintCleanupTimer = null;
  }
  // Wipe any previous hint lines AND preview pills in side columns
  els.paylines.querySelectorAll(".payline-hint").forEach((n) => n.remove());
  clearPreviewBadges();

  if (!els.reels.clientWidth) {
    restoreWinBadges();
    return;
  }
  if (state.lines < 1) {
    restoreWinBadges();
    return; // nothing to show
  }

  const reelsRect = els.reels.getBoundingClientRect();
  const w = reelsRect.width;
  const h = reelsRect.height;
  els.paylines.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const cellW = w / 5;
  const cellH = h / 3;
  const activeLines = payLines.slice(0, state.lines);

  // Draw every active line, with a stronger "flash" on the latest one
  activeLines.forEach((line, index) => {
    const points = line
      .map(
        (row, col) =>
          `${col * cellW + cellW / 2},${row * cellH + cellH / 2}`
      )
      .join(" ");
    const polyline = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline"
    );
    polyline.setAttribute("class", "payline-hint");
    if (index === highlightIndex) polyline.classList.add("flash");
    polyline.setAttribute("points", points);
    polyline.setAttribute("stroke", lineColors[index % lineColors.length]);
    els.paylines.appendChild(polyline);
  });

  // Numbered pills OUTSIDE the reels for every active line. Lines 1..10
  // sit in the left column, 11..20 in the right column, each grouped by
  // its starting reel row. Pills never overlap any symbol.
  // The persistent line tags reflect active/inactive based on state.lines,
  // so we just toggle them — no more transient preview pills.
  updateLineBadgeActivity();

  hintCleanupTimer = setTimeout(() => {
    els.paylines.querySelectorAll(".payline-hint").forEach((n) => n.remove());
    clearPreviewBadges();
    restoreWinBadges();
    hintCleanupTimer = null;
  }, 2000);
}

function showWins(result) {
  const reelsRect = els.reels.getBoundingClientRect();
  els.paylines.setAttribute("viewBox", `0 0 ${reelsRect.width} ${reelsRect.height}`);

  const winsToShow = result.wins.slice(0, 8);
  winsToShow.forEach((win) => drawPayline(win, reelsRect.width, reelsRect.height));

  result.wins.forEach((win) => {
    for (let col = 0; col < win.count; col += 1) {
      const row = win.line[col];
      const cell = document.querySelector(`.cell[data-col="${col}"][data-row="${row}"]`);
      if (cell) cell.classList.add("win");
    }
  });

  if (result.scatterCount >= 3) {
    document.querySelectorAll(".cell").forEach((cell) => {
      const col = Number(cell.dataset.col);
      const row = Number(cell.dataset.row);
      if (state.grid[col]?.[row] === "scatter") cell.classList.add("win");
    });
  }

  // Numbered badges live in the side columns OUTSIDE the reels, so they
  // never cover symbols. Lines 1..10 go to the left column, 11..20 to
  // the right, grouped by their starting row.
  markWinningLines(winsToShow);
}

// Build all 20 line-number tags once and stick them in the side columns
// for the whole session. They stay visible all the time; active/inactive
// state reflects state.lines, and `.won` is added when a line pays.
function initLineBadges() {
  if (!els.leftBadges || !els.rightBadges) return;
  els.leftBadges.innerHTML = "";
  els.rightBadges.innerHTML = "";

  if (!els.reels || !els.reels.clientHeight) return;

  const reelsRect = els.reels.getBoundingClientRect();
  const slotsPerCol = 10;
  const slotHeight = reelsRect.height / slotsPerCol;

  for (let i = 0; i < 20; i += 1) {
    const info = LINE_SLOTS[i];
    if (!info) continue;
    const container = info.side === "left" ? els.leftBadges : els.rightBadges;
    if (!container) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "line-badge-row";
    wrapper.style.top = `${info.slot * slotHeight}px`;
    wrapper.style.height = `${slotHeight}px`;

    const pill = document.createElement("div");
    pill.className = "line-badge-pill";
    pill.dataset.lineIdx = String(i);
    pill.style.backgroundColor = lineColors[i % lineColors.length];
    pill.textContent = String(i + 1);
    wrapper.appendChild(pill);
    container.appendChild(wrapper);
  }

  updateLineBadgeActivity();
}

function updateLineBadgeActivity() {
  document.querySelectorAll(".line-badge-pill[data-line-idx]").forEach((pill) => {
    const idx = Number(pill.dataset.lineIdx);
    pill.classList.toggle("active", idx < state.lines);
    pill.classList.toggle("inactive", idx >= state.lines);
  });
}

function markWinningLines(wins) {
  document
    .querySelectorAll(".line-badge-pill.won")
    .forEach((p) => p.classList.remove("won"));
  wins.forEach((win) => {
    const pill = document.querySelector(
      `.line-badge-pill[data-line-idx="${win.index}"]`
    );
    if (pill) pill.classList.add("won");
  });
}

function clearWinningHighlights() {
  document
    .querySelectorAll(".line-badge-pill.won")
    .forEach((p) => p.classList.remove("won"));
}

function showCoinToast(amount) {
  const toast = document.createElement("div");
  toast.className = "coin-toast";
  toast.textContent = `+${amount}`;
  els.coinLayer.appendChild(toast);
  setTimeout(() => toast.remove(), 1300);
}

function showRetriggerToast(added) {
  const toast = document.createElement("div");
  toast.className = "retrigger-toast";
  toast.textContent = `+${added} FREE SPINS!`;
  els.board.appendChild(toast);
  setTimeout(() => toast.remove(), 1600);
}

function setSpinMessage(result, spinWin) {
  els.message.classList.remove("win", "spin");
  if (state.inFreeSpins) {
    if (state.freeSpinsLeft > 0) {
      if (spinWin > 0) {
        els.message.classList.add("win");
        els.message.textContent = `BONUS +${spinWin} · SPIN으로 계속`;
      } else {
        els.message.textContent = "▶ SPIN을 눌러 다음 스핀";
      }
    } else {
      if (spinWin > 0) {
        els.message.classList.add("win");
        els.message.textContent = `BONUS +${spinWin} · 보너스 종료`;
      } else {
        els.message.textContent = "보너스 종료";
      }
    }
    return;
  }
  if (result.scatterCount >= 3) {
    els.message.classList.add("win");
    els.message.textContent = `SCATTER ×${result.scatterCount}  +${result.scatterWin}`;
  } else if (spinWin > 0) {
    els.message.classList.add("win");
    els.message.textContent = `WIN  +${spinWin}`;
  } else if (state.credit < state.lines) {
    els.message.textContent = "잔액 부족 — RESTART를 누르세요";
  } else {
    els.message.textContent = "TRY AGAIN";
  }
}

/* ===================== Free Spins bonus ===================== */

function calcFreeSpinsCount(butterflies) {
  if (butterflies >= 5) return 10;
  if (butterflies === 4) return 8;
  return 5;
}

async function startFreeSpins(butterflies) {
  const spins = calcFreeSpinsCount(butterflies);
  state.inFreeSpins = true;
  state.freeSpinsLeft = spins;
  state.freeSpinsTotal = spins;
  state.multiplier = FREE_SPIN_MULTIPLIER;
  state.bonusWin = 0;

  els.freeSpinsModalCount.textContent = spins;
  els.freeSpinsModalMulti.textContent = FREE_SPIN_MULTIPLIER;
  showBottomPanel("freeSpinsModal");

  await new Promise((resolve) => {
    els.startFreeSpinsBtn.onclick = () => {
      showBottomPanel("playUI");
      resolve();
    };
  });

  updateBonusPill();
  updateMeters();

  // The triggering spin may have set "잔액 부족" before the free-spin
  // detection ran. Override it now so the bonus state is reflected.
  if (els.message) {
    els.message.textContent = "▶ SPIN을 눌러 첫 프리스핀";
    els.message.classList.remove("win", "spin");
  }
}

async function endFreeSpins() {
  els.bonusTotalWin.textContent = `+${state.bonusWin}`;
  showBottomPanel("freeSpinsSummary");

  await new Promise((resolve) => {
    els.closeFreeSpinsSummary.onclick = () => {
      // Clear free-spins state BEFORE swapping back to playUI so the
      // paytable visibility logic sees the updated state and re-appears.
      state.inFreeSpins = false;
      state.multiplier = 1;
      state.freeSpinsTotal = 0;
      state.freeSpinsLeft = 0;
      updateBonusPill();
      showBottomPanel("playUI");
      resolve();
    };
  });
}

/* ===================== Hi-Lo Gamble bonus ===================== */

// Full deck range: 1..13 (1 = A, 11 = J, 12 = Q, 13 = K).
function drawHiloCard() {
  const rank = 1 + Math.floor(Math.random() * 13);
  const suit = ["♥", "♦", "♣", "♠"][Math.floor(Math.random() * 4)];
  return { rank, suit };
}

// Draw a card that is not exactly identical to `prev` (same rank AND
// same suit). Same rank with a different suit is fine — the band rules
// below decide LOW / HIGH / EVEN.
function drawHiloCardDifferentFrom(prev) {
  let next;
  let safety = 0;
  do {
    next = drawHiloCard();
    safety += 1;
    if (safety > 50) break;
  } while (prev && next.rank === prev.rank && next.suit === prev.suit);
  return next;
}

function rankLabel(rank) {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

// LOW 1..6, HIGH 8..13, EVEN exactly 7
function bandOf(rank) {
  if (rank <= 6) return "low";
  if (rank === 7) return "even";
  return "high";
}

function paintCardSlot(side, card, faceUp) {
  const cardEl = side === "prev" ? els.hiloPrevCard : els.hiloNextCard;
  const rankEl = side === "prev" ? els.hiloPrevRank : els.hiloNextRank;
  const suitEl = side === "prev" ? els.hiloPrevSuit : els.hiloNextSuit;

  cardEl.classList.remove("red", "win-card", "lose-card", "back", "push-card");

  if (!faceUp || !card) {
    cardEl.classList.add("back");
    rankEl.textContent = "?";
    suitEl.textContent = "";
    return;
  }

  rankEl.textContent = rankLabel(card.rank);
  suitEl.textContent = card.suit;
  if (card.suit === "♥" || card.suit === "♦") {
    cardEl.classList.add("red");
  }
}

async function offerGamble() {
  return new Promise((resolve) => {
    let currentWin = state.win;
    let currentCard = drawHiloCard();
    let round = 0;

    paintCardSlot("prev", currentCard, true);
    paintCardSlot("next", null, false);
    els.hiloHint.textContent = "맞히면 2배! LOW 1~6 · HIGH 8~13 · 7은 EVEN";
    els.hiloHint.className = "hilo-hint";
    els.gambleAmount.textContent = currentWin;
    els.gambleTitle.textContent = "상금을 2배로?";
    els.hiloChoices.classList.add("hidden");
    els.gambleActions.classList.remove("hidden");
    els.hiloHigher.disabled = false;
    els.hiloLower.disabled = false;
    els.startGambleBtn.disabled = false;
    els.takeWinBtn.disabled = false;

    showGamblePanel();

    const close = (finalWin) => {
      hideGamblePanel();
      state.win = finalWin;
      updateMeters();
      resolve(finalWin);
    };

    els.takeWinBtn.onclick = () => close(currentWin);

    els.startGambleBtn.onclick = () => {
      els.gambleActions.classList.add("hidden");
      els.hiloChoices.classList.remove("hidden");
      els.gambleTitle.textContent = `${round + 1} / ${MAX_GAMBLE_ROUNDS} 도전`;
      els.hiloHint.textContent = "다음 카드 · LOW 1~6 또는 HIGH 8~13?";
    };

    const playRound = async (choice) => {
      els.hiloHigher.disabled = true;
      els.hiloLower.disabled = true;

      // Pull a fresh card that isn't byte-identical to the previous one
      const nextCard = drawHiloCardDifferentFrom(currentCard);

      // Flip the NEXT card slot
      els.hiloNextCard.classList.add("flip");
      await wait(275);
      paintCardSlot("next", nextCard, true);
      await wait(280);
      els.hiloNextCard.classList.remove("flip");

      const band = bandOf(nextCard.rank);

      // 7 — EVEN. No win/no loss. Ask retry or take.
      if (band === "even") {
        els.hiloNextCard.classList.add("push-card");
        els.hiloHint.textContent = `EVEN! ${rankLabel(nextCard.rank)} 등장 · 다시 도전 또는 받기`;
        els.hiloHint.className = "hilo-hint";
        await wait(1000);
        els.hiloNextCard.classList.remove("push-card");

        // Carry the 7 over to the "prev" slot for visual continuity
        currentCard = nextCard;
        paintCardSlot("prev", currentCard, true);
        paintCardSlot("next", null, false);

        // Re-expose the take / retry buttons (same as the initial offer)
        els.hiloChoices.classList.add("hidden");
        els.gambleActions.classList.remove("hidden");
        els.gambleTitle.textContent = "EVEN! 한 번 더 도전?";
        els.hiloHigher.disabled = false;
        els.hiloLower.disabled = false;
        return;
      }

      // Win if the player's band guess matches the drawn band
      const bandLabel = band === "low" ? "LOW" : "HIGH";
      const won = choice === band;
      round += 1;

      if (won) {
        currentWin *= 2;
        els.hiloNextCard.classList.add("win-card");
        els.gambleAmount.textContent = currentWin;
        els.hiloHint.textContent = `정답! ${rankLabel(nextCard.rank)} (${bandLabel})`;
        els.hiloHint.className = "hilo-hint win";
        await wait(1300);
        els.hiloNextCard.classList.remove("win-card");

        currentCard = nextCard;
        paintCardSlot("prev", currentCard, true);
        paintCardSlot("next", null, false);

        if (round >= MAX_GAMBLE_ROUNDS) {
          els.hiloHint.textContent = `최대 ${MAX_GAMBLE_ROUNDS}단 완료! ${currentWin} 받아요`;
          await wait(900);
          close(currentWin);
          return;
        }

        els.hiloChoices.classList.add("hidden");
        els.gambleActions.classList.remove("hidden");
        els.gambleTitle.textContent = `한 번 더? (${round} / ${MAX_GAMBLE_ROUNDS} 성공)`;
        els.hiloHigher.disabled = false;
        els.hiloLower.disabled = false;
      } else {
        els.hiloNextCard.classList.add("lose-card");
        els.hiloHint.textContent = `꽝! ${rankLabel(nextCard.rank)} (${bandLabel})`;
        els.hiloHint.className = "hilo-hint lose";
        await wait(1500);
        close(0);
      }
    };

    els.hiloHigher.onclick = () => playRound("high");
    els.hiloLower.onclick = () => playRound("low");
  });
}

/* ===================== Settlement ===================== */

function settleWin() {
  state.credit += state.win;
  saveState();
  state.win = 0;
  updateMeters();
}

/* ===================== Main spin flow ===================== */

async function spin() {
  // A second SPIN press during the fast loop is a STOP request.
  if (state.spinPhase === SPIN_PHASE.LOOPING) {
    triggerStopSignal();
    return;
  }
  if (state.spinPhase === SPIN_PHASE.STOPPING) return; // can't interrupt
  if (state.spinning) return;
  if (state.lines < 1) return; // no active lines, nothing to play
  if (!state.inFreeSpins && state.credit < state.lines) return;

  state.spinning = true;
  state.spinPhase = SPIN_PHASE.LOOPING;
  updateSpinBtnText();
  clearHighlights();

  if (!state.inFreeSpins) {
    state.win = 0;
    state.credit -= state.lines;
    saveState();
  }

  els.message.classList.remove("win");
  els.message.classList.add("spin");
  if (state.inFreeSpins) {
    const cur = state.freeSpinsTotal - state.freeSpinsLeft + 1;
    els.message.textContent =
      `FREE SPIN ${cur}/${state.freeSpinsTotal} ×${state.multiplier} · STOP으로 정지`;
  } else {
    els.message.textContent = "다시 SPIN을 누르면 정지 ▶";
  }
  updateMeters();

  await spinReels(makeFinalGrid());

  state.spinPhase = SPIN_PHASE.IDLE;
  updateSpinBtnText();

  const result = evaluate();
  const spinWin = result.total * state.multiplier;

  if (state.inFreeSpins) {
    state.freeSpinsLeft -= 1;
    state.win += spinWin;
    state.bonusWin += spinWin;
  } else {
    state.win = spinWin;
  }

  showWins(result);
  if (spinWin > 0) showCoinToast(spinWin);
  setSpinMessage(result, spinWin);

  state.spinning = false;
  updateMeters();

  // ----- Bonus triggers -----

  const butterflyCount = state.grid.flat().filter((k) => k === "butterfly").length;

  // Retrigger free spins while inside free spins
  if (state.inFreeSpins && butterflyCount >= 3 && state.freeSpinsTotal < FREE_SPIN_CAP) {
    const added = 3;
    state.freeSpinsLeft += added;
    state.freeSpinsTotal += added;
    showRetriggerToast(added);
    updateBonusPill();
  }

  // Initial trigger from a normal spin — show intro and wait for the
  // player to start. After the intro, the user manually presses SPIN
  // for each free spin (no auto-chain).
  if (!state.inFreeSpins && butterflyCount >= 3) {
    await wait(700);
    await startFreeSpins(butterflyCount);
    return;
  }

  // Continue free spins or finish them — no auto-spin, the player must
  // press SPIN themselves between each free spin.
  if (state.inFreeSpins) {
    updateBonusPill();
    if (state.freeSpinsLeft > 0) {
      return; // wait for the user's next SPIN tap
    }
    // free spins finished — show summary
    await wait(500);
    await endFreeSpins();
    // state.win still holds the accumulated total; fall through to settlement
  }

  // ----- Settlement -----

  if (state.win > 0) {
    if (state.auto) {
      settleWin();
      if (state.credit >= state.lines) {
        setTimeout(() => { void spin(); }, 1200);
      } else {
        state.auto = false;
        updateMeters();
      }
    } else {
      await wait(450);
      const finalWin = await offerGamble();
      if (finalWin === 0) {
        els.message.textContent = "꽝! 다시 도전하세요";
        els.message.classList.remove("win");
      } else {
        els.message.textContent = `상금 +${finalWin} 받았어요`;
        els.message.classList.add("win");
      }
      settleWin();
      if (state.credit < state.lines) {
        state.auto = false;
        updateMeters();
      }
    }
  } else {
    if (state.auto && state.credit >= state.lines) {
      setTimeout(() => { void spin(); }, 700);
    } else if (state.credit < state.lines) {
      state.auto = false;
      updateMeters();
    }
  }
}

/* ===================== Event wiring ===================== */

els.spinBtn.addEventListener("click", spin);

// −/+ are simple click handlers. The on-board preview shows every line
// from 1..state.lines cumulatively, with the just-toggled (top) line
// flashed. Lines may go all the way down to 0; at 0 SPIN is disabled.

const ZERO_LINES_MSG = "라인을 1개 이상 선택하세요 (+)";

els.betUp.addEventListener("click", () => {
  if (state.spinning || state.inFreeSpins) return;
  if (state.lines >= 20) return;
  const wasZero = state.lines === 0;
  state.lines += 1;
  saveState();
  updateMeters();
  flashActiveLines(state.lines - 1);
  if (wasZero && els.message && els.message.textContent === ZERO_LINES_MSG) {
    els.message.textContent = "GOOD LUCK!";
    els.message.classList.remove("win", "spin");
  }
});

els.betDown.addEventListener("click", () => {
  if (state.spinning || state.inFreeSpins) return;
  if (state.lines <= 0) return;
  state.lines -= 1;
  saveState();
  updateMeters();
  flashActiveLines(state.lines >= 1 ? state.lines - 1 : undefined);
  if (state.lines === 0 && els.message) {
    els.message.textContent = ZERO_LINES_MSG;
    els.message.classList.remove("win", "spin");
  }
});

if (els.linesResetBtn) {
  els.linesResetBtn.addEventListener("click", () => {
    if (state.spinning || state.inFreeSpins) return;
    if (state.lines === 0) return;
    state.lines = 0;
    saveState();
    updateMeters();
    flashActiveLines(); // clears any existing hint paylines
    if (els.message) {
      els.message.textContent = ZERO_LINES_MSG;
      els.message.classList.remove("win", "spin");
    }
  });
}

els.autoBtn.addEventListener("click", () => {
  state.auto = !state.auto;
  updateMeters();
  if (state.auto && !state.spinning && !state.inFreeSpins) spin();
});

els.soundBtn.addEventListener("click", () => {
  state.sound = !state.sound;
  updateMeters();
});

els.restartBtn.addEventListener("click", () => {
  if (state.spinning || state.inFreeSpins) return;
  openModal(els.resetModal);
});

els.cancelReset.addEventListener("click", () => closeModal(els.resetModal));

els.confirmReset.addEventListener("click", () => {
  state.credit = STARTING_CREDIT;
  state.win = 0;
  state.lines = 20;
  state.auto = false;
  saveState();
  updateMeters();
  els.message.textContent = "GOOD LUCK!";
  els.message.classList.remove("win", "spin");
  clearHighlights();
  closeModal(els.resetModal);
});

// Tap outside the reset modal closes it
els.resetModal.addEventListener("click", (e) => {
  if (e.target === els.resetModal) closeModal(els.resetModal);
});

// Rules / paytable modal — toggled from the sub-controls
if (els.rulesBtn) {
  els.rulesBtn.addEventListener("click", () => {
    if (state.spinning) return;
    openModal(els.rulesModal);
  });
}
if (els.closeRulesBtn) {
  els.closeRulesBtn.addEventListener("click", () => closeModal(els.rulesModal));
}
if (els.rulesModal) {
  els.rulesModal.addEventListener("click", (e) => {
    if (e.target === els.rulesModal) closeModal(els.rulesModal);
  });
}

// Prevent iOS rubber-band scroll outside modal regions
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.target.closest(".modal")) return;
    e.preventDefault();
  },
  { passive: false }
);

window.addEventListener("pagehide", saveState);
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveState();
});

/* ===================== Init ===================== */

async function init() {
  loadState();
  await Promise.all(assetPromises);
  seedGrid();
  updateMeters();
  // Paint the persistent 1..20 line tags once the reels have real
  // dimensions. They stay visible for the whole session.
  requestAnimationFrame(() => initLineBadges());
  if (state.lines === 0 && els.message) {
    els.message.textContent = "라인을 1개 이상 선택하세요 (+)";
    els.message.classList.remove("win", "spin");
  }
}

init();
