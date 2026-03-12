import { useState, useRef, useCallback, useEffect } from "react";

// ─── Datasets ────────────────────────────────────────────────────────────────
const MOCK_DATASETS = {
  "mixed":           [-85, -42, -18, -61, 3, 27, 54, 78, -5, 91, -33, 12, 66, -77, 44, 19, -9, 38, -120, 105],
  "mostly-positive": [5, 12, 18, 34, 45, 56, 67, 78, 89, 95, -3, -8, 23, 41, 72, 88, -1, 63, 150, -5],
  "negative-heavy":  [-92, -74, -55, -38, -19, -7, -81, -44, -63, 8, -29, 15, -50, -12, -68, 3, -33, -16, -110, 12],
};

// ─── Stats ───────────────────────────────────────────────────────────────────
function calcStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const inliers = sorted.filter(v => v >= lo && v <= hi);
  return {
    suggested: { min: Math.min(...inliers), max: Math.max(...inliers) },
    dataExtent: { min: sorted[0], max: sorted[n - 1] },
    outliers: values.filter(v => v < lo || v > hi),
  };
}

// ─── Histogram ───────────────────────────────────────────────────────────────
function buildHist(values, absMin, absMax, sugMin, sugMax, bins = 14) {
  const range = absMax - absMin || 1;
  const counts = Array(bins).fill(0);
  values.forEach(v => {
    const idx = Math.min(bins - 1, Math.floor(((v - absMin) / range) * bins));
    if (idx >= 0) counts[idx]++;
  });
  const peak = Math.max(...counts, 1);
  return counts.map((c, i) => {
    const x = absMin + (i / bins) * range;
    return { x, height: c / peak, count: c, isOutlier: x < sugMin || x > sugMax };
  });
}

// ─── Scale helpers ────────────────────────────────────────────────────────────
// Linear: value → 0..1 within [min, max]
function linearNorm(v, min, max) {
  return (v - min) / (max - min || 1);
}

// Symmetric log: handles negatives gracefully via sign-preserving log1p
// maps value → 0..1 within [min, max] on a log scale
function logNorm(v, min, max) {
  const sign = (x) => (x >= 0 ? 1 : -1);
  const logAbs = (x) => sign(x) * Math.log1p(Math.abs(x));
  const lMin = logAbs(min), lMax = logAbs(max);
  return (logAbs(v) - lMin) / (lMax - lMin || 1);
}

function normValue(v, min, max, useLog) {
  return useLog ? logNorm(v, min, max) : linearNorm(v, min, max);
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
function Tip({ children, label }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", flex: 1 }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 5px)", left: "50%",
          transform: "translateX(-50%)", background: "#1e293b", color: "#94a3b8",
          fontSize: 10, padding: "4px 8px", borderRadius: 4, whiteSpace: "nowrap",
          border: "1px solid #334155", pointerEvents: "none", zIndex: 9999,
          fontFamily: "monospace",
        }}>{label}</span>
      )}
    </span>
  );
}

// ─── NumInput: small inline editable number ───────────────────────────────────
function NumInput({ value, onChange, color, align = "left" }) {
  const [editing, setEditing] = useState(false);
  const [tmp, setTmp] = useState("");
  const commit = () => {
    const n = parseFloat(tmp);
    if (!isNaN(n)) onChange(n);
    setEditing(false);
  };
  if (editing) return (
    <input autoFocus type="number" value={tmp}
      onChange={e => setTmp(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
      style={{ width: 58, background: "#0f172a", border: `1px solid ${color}`, borderRadius: 5, padding: "5px 7px", color, fontFamily: "'DM Mono', monospace", fontSize: 12, outline: "none", textAlign: align, boxSizing: "border-box" }}
    />
  );
  return (
    <div onClick={() => { setTmp(String(value)); setEditing(true); }} style={{
      width: 58, padding: "5px 7px", background: "#0f172a",
      border: "1px dashed #1e293b", borderRadius: 5,
      color, fontFamily: "'DM Mono', monospace", fontSize: 12,
      cursor: "text", textAlign: align, boxSizing: "border-box",
      transition: "border-color 0.15s",
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = color + "88"}
      onMouseLeave={e => e.currentTarget.style.borderColor = "#1e293b"}
    >{value}</div>
  );
}

// ─── DataBar cell ─────────────────────────────────────────────────────────────
// mode: "diverging" | "ltr" | "rtl"
// LTR: bar always grows left→right, origin at leftmost point (rMin)
//      positive values fill right, negative values also fill right (just less)
//      The "zero" anchor line is placed at normValue(0, rMin, rMax)
// RTL: mirror of LTR — bar grows right→left from rMax
// Diverging: bar grows outward from mid point in both directions
function DataBarCell({ value, mode, rMin, rMax, mid, useLog }) {
  const isOutlier = value < rMin || value > rMax;
  const clamped = Math.max(rMin, Math.min(rMax, value));

  // Normalised positions [0..1] within the display range
  const normV    = normValue(clamped, rMin, rMax, useLog);
  const normMid  = normValue(mid, rMin, rMax, useLog);
  const normZero = (0 >= rMin && 0 <= rMax) ? normValue(0, rMin, rMax, useLog) : null;

  let barLeft, barWidth, barBg, anchorPct;

  if (mode === "diverging") {
    // Grows outward from mid
    anchorPct = normMid * 100;
    const isPos = clamped >= mid;
    const barPct = Math.abs(normV - normMid) * 100;
    barLeft  = isPos ? `${anchorPct}%` : `${anchorPct - barPct}%`;
    barWidth = `${barPct}%`;
    barBg    = isPos ? "#22d3ee" : "#f472b8";
  } else if (mode === "ltr") {
    // Fills from left. Anchor line = position of rMin (left edge = 0%)
    // For LTR: bar always starts at 0% and fills to normV * 100%
    anchorPct = 0;
    barLeft  = "0%";
    barWidth = `${Math.max(0, normV * 100)}%`;
    barBg    = value >= 0 ? "#22d3ee" : "#f472b8";
  } else {
    // RTL: bar starts at right edge (100%) and fills leftward
    anchorPct = 100;
    const fillPct = (1 - normV) * 100;
    barLeft  = `${100 - fillPct}%`;
    barWidth = `${Math.max(0, fillPct)}%`;
    barBg    = value <= 0 ? "#f472b8" : "#22d3ee";
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
      <span style={{
        width: 40, textAlign: "right", fontSize: 11, flexShrink: 0,
        color: isOutlier ? "#fb923c" : "#64748b",
        fontFamily: "monospace", fontWeight: isOutlier ? 700 : 400,
      }}>{value}</span>
      <div style={{ flex: 1, height: 14, background: "#0f172a", borderRadius: 2, position: "relative", overflow: "hidden" }}>
        <div style={{
          position: "absolute", top: 0, height: "100%",
          left: barLeft, width: barWidth,
          background: barBg, opacity: 0.82,
          borderRadius: 2,
          transition: "left 0.2s, width 0.2s",
        }} />
        {/* Anchor tick */}
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${anchorPct}%`, width: 1, background: "#334155" }} />
        {/* Zero line (if in range and diverging) */}
        {mode === "diverging" && normZero !== null && normZero !== normMid && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${normZero * 100}%`, width: 1, background: "#1e3a5f" }} />
        )}
      </div>
    </div>
  );
}

// ─── Log scale tick marks for display ────────────────────────────────────────
function LogScaleTicks({ rMin, rMax }) {
  const ticks = [];
  const sign = (x) => (x >= 0 ? 1 : -1);
  const logAbs = (x) => sign(x) * Math.log1p(Math.abs(x));
  const lMin = logAbs(rMin), lMax = logAbs(rMax);
  // Generate round tick values
  const range = rMax - rMin;
  const magnitude = Math.floor(Math.log10(Math.abs(range) || 1));
  const step = Math.pow(10, magnitude - 1);
  let t = Math.ceil(rMin / step) * step;
  while (t <= rMax) {
    const pct = ((logAbs(t) - lMin) / (lMax - lMin || 1)) * 100;
    if (pct >= 0 && pct <= 100) ticks.push({ v: t, pct });
    t += step;
    if (ticks.length > 8) break;
  }
  return (
    <div style={{ position: "relative", height: 12, marginTop: 2 }}>
      {ticks.map((tk, i) => (
        <div key={i} style={{ position: "absolute", left: `${tk.pct}%`, transform: "translateX(-50%)", fontSize: 8, color: "#334155", fontFamily: "monospace" }}>
          {tk.v}
        </div>
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [dataset, setDataset]         = useState("mixed");
  const [contextMenu, setContextMenu] = useState(null);
  const [dragging, setDragging]       = useState(null);
  const [mode, setMode]               = useState("diverging");
  const [useLog, setUseLog]           = useState(false);

  // Diverging params: mid + absMax (symmetric: left = mid - absMax, right = mid + absMax)
  const [divMid, setDivMid]     = useState(0);
  const [divAbsMax, setDivAbsMax] = useState(91);

  // LTR params: rMin → rMax (left to right, bar fills from rMin)
  const [ltrMin, setLtrMin] = useState(0);
  const [ltrMax, setLtrMax] = useState(105);

  // RTL params: rMin → rMax (bar fills from rMax rightward to leftward)
  const [rtlMin, setRtlMin] = useState(-120);
  const [rtlMax, setRtlMax] = useState(0);

  const trackRef   = useRef(null);
  const popoverRef = useRef(null);

  const values = MOCK_DATASETS[dataset];
  const { suggested, dataExtent, outliers } = calcStats(values);

  // Derived display range
  const rMin = mode === "diverging" ? divMid - divAbsMax
             : mode === "ltr"       ? ltrMin
             :                        rtlMin;
  const rMax = mode === "diverging" ? divMid + divAbsMax
             : mode === "ltr"       ? ltrMax
             :                        rtlMax;
  const mid  = mode === "diverging" ? divMid : (mode === "ltr" ? rMin : rMax);

  // Slider track bounds = data extent (with a little padding)
  const trackMin = dataExtent.min - Math.abs(dataExtent.min) * 0.1;
  const trackMax = dataExtent.max + Math.abs(dataExtent.max) * 0.1;
  const trackRange = trackMax - trackMin || 1;

  const toP   = useCallback((v) => Math.max(0, Math.min(100, ((v - trackMin) / trackRange) * 100)), [trackMin, trackRange]);
  const fromP = useCallback((p) => trackMin + (p / 100) * trackRange, [trackMin, trackRange]);

  const hist = buildHist(values, dataExtent.min, dataExtent.max, suggested.min, suggested.max);

  // Seed ranges when dataset changes
  useEffect(() => {
    const { suggested: s, dataExtent: de } = calcStats(MOCK_DATASETS[dataset]);
    const absM = Math.max(Math.abs(s.min), Math.abs(s.max));
    setDivMid(0);
    setDivAbsMax(absM);
    setLtrMin(Math.min(0, de.min));
    setLtrMax(de.max);
    setRtlMin(de.min);
    setRtlMax(Math.max(0, de.max));
  }, [dataset]);

  // Close popover on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setContextMenu(null);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [contextMenu]);

  // Drag state via refs to avoid stale closures
  const dragStateRef = useRef({ mode, ltrMin, ltrMax, rtlMin, rtlMax, divMid, divAbsMax });
  useEffect(() => {
    dragStateRef.current = { mode, ltrMin, ltrMax, rtlMin, rtlMax, divMid, divAbsMax };
  });

  // Drag: for LTR/RTL we drag min/max handles; for diverging we drag mid/absMax handles
  const startDrag = useCallback((handle) => (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragging(handle);
    const move = (ev) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      const val = Math.round(fromP(pct));
      const s = dragStateRef.current;
      if (s.mode === "ltr") {
        if (handle === "ltrMin") setLtrMin(Math.min(val, s.ltrMax - 1));
        if (handle === "ltrMax") setLtrMax(Math.max(val, s.ltrMin + 1));
      } else if (s.mode === "rtl") {
        if (handle === "rtlMin") setRtlMin(Math.min(val, s.rtlMax - 1));
        if (handle === "rtlMax") setRtlMax(Math.max(val, s.rtlMin + 1));
      } else {
        // diverging: left handle moves mid, right handle moves absMax
        if (handle === "divLeft")  { /* left extreme = mid - absMax, drag adjusts absMax */ setDivAbsMax(Math.max(1, s.divMid - val)); }
        if (handle === "divMid")   setDivMid(val);
        if (handle === "divRight") setDivAbsMax(Math.max(1, val - s.divMid));
      }
    };
    const up = () => { setDragging(null); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [fromP]);

  const applyPreset = (key) => {
    const { suggested: s, dataExtent: de } = calcStats(values);
    if (mode === "diverging") {
      if (key === "suggested") { const m = Math.max(Math.abs(s.min), Math.abs(s.max)); setDivMid(0); setDivAbsMax(m); }
      if (key === "symmetric") { const m = Math.max(Math.abs(de.min), Math.abs(de.max)); setDivMid(0); setDivAbsMax(m); }
      if (key === "data")      { const m = Math.max(Math.abs(de.min), Math.abs(de.max)); setDivMid(0); setDivAbsMax(m); }
    } else if (mode === "ltr") {
      if (key === "suggested") { setLtrMin(Math.min(0, s.min)); setLtrMax(s.max); }
      if (key === "data")      { setLtrMin(Math.min(0, de.min)); setLtrMax(de.max); }
    } else {
      if (key === "suggested") { setRtlMin(s.min); setRtlMax(Math.max(0, s.max)); }
      if (key === "data")      { setRtlMin(de.min); setRtlMax(Math.max(0, de.max)); }
    }
  };

  const clippedCount = values.filter(v => v < rMin || v > rMax).length;

  // ── Slider handles config per mode ──────────────────────────────────────────
  const handles = mode === "diverging"
    ? [
        { key: "divLeft",  val: divMid - divAbsMax, color: "#f472b8", label: "Left extreme"  },
        { key: "divMid",   val: divMid,              color: "#f59e0b", label: "Midpoint"       },
        { key: "divRight", val: divMid + divAbsMax,  color: "#22d3ee", label: "Right extreme" },
      ]
    : mode === "ltr"
    ? [
        { key: "ltrMin", val: ltrMin, color: "#f472b8", label: "Start (left)"  },
        { key: "ltrMax", val: ltrMax, color: "#22d3ee", label: "End (right)"   },
      ]
    : [
        { key: "rtlMin", val: rtlMin, color: "#f472b8", label: "Start (left)"  },
        { key: "rtlMax", val: rtlMax, color: "#22d3ee", label: "End (right)"   },
      ];

  return (
    <div
      style={{ minHeight: "100vh", background: "#080c14", display: "flex", flexDirection: "column", alignItems: "center", padding: "36px 24px", gap: 22 }}
      onContextMenu={e => e.preventDefault()}
    >
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* Title */}
      <div style={{ textAlign: "center" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#e2e8f0", fontFamily: "'DM Sans', sans-serif", letterSpacing: "-0.02em" }}>
          Databar Calibration <span style={{ color: "#22d3ee" }}>v3</span>
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "#475569", fontFamily: "'DM Sans', sans-serif" }}>
          Right-click <strong style={{ color: "#94a3b8" }}>REVENUE</strong> header · Outlier-aware · Diverging / LTR / RTL · Log scale
        </p>
      </div>

      {/* Dataset switcher */}
      <div style={{ display: "flex", gap: 4, background: "#0f172a", padding: 4, borderRadius: 8, border: "1px solid #1e293b" }}>
        {Object.keys(MOCK_DATASETS).map(k => (
          <button key={k} onClick={() => setDataset(k)} style={{
            padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
            background: dataset === k ? "#22d3ee" : "transparent",
            color: dataset === k ? "#080c14" : "#475569",
            fontSize: 11, fontWeight: dataset === k ? 600 : 400,
            fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
          }}>{k}</button>
        ))}
      </div>

      {/* Grid */}
      <div style={{ width: 480, borderRadius: 10, overflow: "hidden", border: "1px solid #1e293b", boxShadow: "0 8px 40px rgba(0,0,0,0.5)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", background: "#0f172a", borderBottom: "1px solid #1e293b" }}>
          <div style={{ padding: "9px 14px", fontSize: 11, color: "#334155", fontWeight: 600, letterSpacing: "0.06em", borderRight: "1px solid #1e293b" }}>ENTITY</div>
          <div
            onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
            onMouseEnter={e => e.currentTarget.style.background = "#1a2332"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            style={{ padding: "9px 14px", fontSize: 11, color: "#94a3b8", fontWeight: 600, letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 8, cursor: "context-menu", userSelect: "none" }}
          >
            REVENUE
            <span style={{ fontSize: 9, color: "#334155", marginLeft: "auto" }}>right-click ›</span>
            <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#0e3a4a", color: "#22d3ee", border: "1px solid #164e63" }}>
              {mode === "diverging" ? "◀▶ DIV" : mode === "ltr" ? "▶ LTR" : "◀ RTL"}{useLog ? " · LOG" : ""}
            </span>
          </div>
        </div>
        {values.slice(0, 10).map((v, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr", borderBottom: i < 9 ? "1px solid #0a0f1a" : "none", background: i % 2 === 0 ? "#080c14" : "#09101a" }}>
            <div style={{ padding: "2px 14px", fontSize: 11, color: "#1e293b", borderRight: "1px solid #0a0f1a", display: "flex", alignItems: "center" }}>Entity {String.fromCharCode(65 + i)}</div>
            <div style={{ padding: "2px 14px" }}>
              <DataBarCell value={v} mode={mode} rMin={rMin} rMax={rMax} mid={mid} useLog={useLog} />
            </div>
          </div>
        ))}
      </div>

      {outliers.length > 0 && (
        <div style={{ fontSize: 11, color: "#fb923c", fontFamily: "'DM Mono', monospace" }}>
          ⚡ {outliers.length} outlier{outliers.length > 1 ? "s" : ""} ({outliers.join(", ")}) — excluded from suggested range
        </div>
      )}

      {/* ── CONTEXT MENU POPOVER ─────────────────────────────────────────────── */}
      {contextMenu && (
        <div ref={popoverRef} onContextMenu={e => e.preventDefault()} style={{
          position: "fixed",
          top: Math.min(contextMenu.y, window.innerHeight - 600),
          left: Math.min(contextMenu.x, window.innerWidth - 356),
          zIndex: 1000, width: 340,
          background: "#0a0f1a", border: "1px solid #1e3a5f", borderRadius: 14,
          boxShadow: "0 24px 80px rgba(0,0,0,0.85)", padding: 20, color: "#e2e8f0",
          fontFamily: "'DM Sans', sans-serif",
        }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Databar Scale</div>
              <div style={{ fontSize: 10, color: "#334155", marginTop: 2, fontFamily: "'DM Mono', monospace" }}>REVENUE · {values.length} rows</div>
            </div>
            <button onClick={() => setContextMenu(null)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
          </div>

          {/* Bar type */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.07em", marginBottom: 7 }}>BAR TYPE</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
              {[
                { key: "diverging", icon: "◀▶", label: "Diverging",     sub: "symmetric mid" },
                { key: "ltr",       icon: "▶",   label: "Left → Right", sub: "fills rightward" },
                { key: "rtl",       icon: "◀",   label: "Right ← Left", sub: "fills leftward" },
              ].map(({ key, icon, label, sub }) => (
                <button key={key} onClick={() => setMode(key)} style={{
                  padding: "8px 4px", borderRadius: 7, cursor: "pointer",
                  border: `1px solid ${mode === key ? "#22d3ee" : "#1e293b"}`,
                  background: mode === key ? "#0e3a4a" : "#0f172a",
                  color: mode === key ? "#22d3ee" : "#475569",
                  textAlign: "center", transition: "all 0.15s", fontFamily: "'DM Sans', sans-serif",
                }}>
                  <div style={{ fontSize: 13, marginBottom: 2 }}>{icon}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, lineHeight: 1.2 }}>{label}</div>
                  <div style={{ fontSize: 9, color: mode === key ? "#67e8f9" : "#334155", marginTop: 2 }}>{sub}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Scale type (linear / log) */}
          <div style={{ marginBottom: 14, display: "flex", gap: 5 }}>
            {[
              { val: false, label: "Linear", icon: "—" },
              { val: true,  label: "Logarithmic", icon: "∿" },
            ].map(({ val, label, icon }) => (
              <button key={String(val)} onClick={() => setUseLog(val)} style={{
                flex: 1, padding: "7px 8px", borderRadius: 7, cursor: "pointer",
                border: `1px solid ${useLog === val ? "#a78bfa" : "#1e293b"}`,
                background: useLog === val ? "#1a0e3a" : "#0f172a",
                color: useLog === val ? "#a78bfa" : "#475569",
                fontSize: 11, fontWeight: useLog === val ? 600 : 400,
                fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              }}>
                <span style={{ fontSize: 14 }}>{icon}</span>{label}
              </button>
            ))}
          </div>

          {/* Histogram */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.07em", marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
              <span>DISTRIBUTION</span>
              {outliers.length > 0 && <span style={{ color: "#fb923c" }}>⚡ {outliers.length} outlier{outliers.length > 1 ? "s" : ""}</span>}
            </div>
            <div style={{ position: "relative", height: 46, display: "flex", alignItems: "flex-end", gap: 2 }}>
              {hist.map((bar, i) => {
                const inRange = bar.x >= rMin && bar.x <= rMax;
                return (
                  <Tip key={i} label={`~${Math.round(bar.x)}: ${bar.count}`}>
                    <div style={{
                      flex: 1, height: `${Math.max(6, bar.height * 100)}%`,
                      background: bar.isOutlier ? "#fb923c" : inRange ? "#22d3ee" : "#1e3a5f",
                      borderRadius: "2px 2px 0 0",
                      opacity: bar.isOutlier ? 0.55 : inRange ? 0.85 : 0.28,
                      transition: "background 0.2s",
                    }} />
                  </Tip>
                );
              })}
              {/* Zero line */}
              {dataExtent.min < 0 && dataExtent.max > 0 && (
                <div style={{ position: "absolute", bottom: 0, top: 0, left: `${toP(0)}%`, width: 1, background: "#f59e0b", opacity: 0.45, pointerEvents: "none" }} />
              )}
            </div>
          </div>

          {/* Slider track */}
          <div ref={trackRef} style={{ position: "relative", height: 28, margin: "0 6px 8px" }}>
            <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 3, background: "#1e293b", borderRadius: 2, transform: "translateY(-50%)" }} />
            {/* Active range fill */}
            <div style={{
              position: "absolute", top: "50%", height: 3,
              left: `${toP(rMin)}%`, width: `${Math.max(0, toP(rMax) - toP(rMin))}%`,
              background: mode === "diverging"
                ? "linear-gradient(90deg, #f472b8, #f59e0b 50%, #22d3ee)"
                : "linear-gradient(90deg, #f472b8, #22d3ee)",
              transform: "translateY(-50%)", borderRadius: 2, opacity: 0.6,
            }} />
            {/* Drag handles */}
            {handles.map(h => (
              <div key={h.key} onPointerDown={startDrag(h.key)}
                title={h.label}
                style={{
                  position: "absolute", top: "50%", left: `${toP(h.val)}%`,
                  width: h.key === "divMid" ? 12 : 16,
                  height: h.key === "divMid" ? 12 : 16,
                  background: h.color,
                  borderRadius: h.key === "divMid" ? 3 : "50%",
                  transform: `translate(-50%, -50%)${h.key === "divMid" ? " rotate(45deg)" : ""}`,
                  cursor: "ew-resize",
                  boxShadow: dragging === h.key ? `0 0 0 5px ${h.color}33` : "0 0 0 2px #080c14",
                  zIndex: 4, transition: dragging === h.key ? "none" : "box-shadow 0.15s",
                }}
              />
            ))}
          </div>

          {/* ── Diverging controls ──────────────────────────────────────────── */}
          {mode === "diverging" && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.07em", marginBottom: 7 }}>SCALE POINTS</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, alignItems: "end" }}>
                <div>
                  <div style={{ fontSize: 9, color: "#f472b8", marginBottom: 3, fontFamily: "'DM Mono', monospace" }}>LEFT EXTREME</div>
                  <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 5, padding: "5px 7px", color: "#f472b8", fontFamily: "'DM Mono', monospace", fontSize: 12, textAlign: "center" }}>
                    {divMid - divAbsMax}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#f59e0b", marginBottom: 3, fontFamily: "'DM Mono', monospace", textAlign: "center" }}>MIDPOINT</div>
                  <NumInput value={divMid} onChange={setDivMid} color="#f59e0b" align="center" />
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#22d3ee", marginBottom: 3, fontFamily: "'DM Mono', monospace", textAlign: "right" }}>RIGHT EXTREME</div>
                  <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 5, padding: "5px 7px", color: "#22d3ee", fontFamily: "'DM Mono', monospace", fontSize: 12, textAlign: "center" }}>
                    {divMid + divAbsMax}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 9, color: "#475569", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>ABS MAX (each side)</div>
                <NumInput value={divAbsMax} onChange={v => setDivAbsMax(Math.max(1, v))} color="#94a3b8" />
                <div style={{ fontSize: 9, color: "#334155", fontFamily: "'DM Mono', monospace" }}>= ±{divAbsMax} from mid</div>
              </div>
            </div>
          )}

          {/* ── LTR controls ────────────────────────────────────────────────── */}
          {mode === "ltr" && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.07em", marginBottom: 7 }}>RANGE (left → right)</div>
              <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: "#f472b8", marginBottom: 3, fontFamily: "'DM Mono', monospace" }}>FROM</div>
                  <NumInput value={ltrMin} onChange={v => setLtrMin(Math.min(v, ltrMax - 1))} color="#f472b8" />
                </div>
                <div style={{ fontSize: 12, color: "#334155", paddingBottom: 6 }}>→</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: "#22d3ee", marginBottom: 3, fontFamily: "'DM Mono', monospace", textAlign: "right" }}>TO</div>
                  <NumInput value={ltrMax} onChange={v => setLtrMax(Math.max(v, ltrMin + 1))} color="#22d3ee" align="right" />
                </div>
              </div>
              <div style={{ marginTop: 6, fontSize: 10, color: "#334155", fontFamily: "'DM Mono', monospace" }}>Bar fills left→right. Value {ltrMin} = empty, {ltrMax} = full.</div>
            </div>
          )}

          {/* ── RTL controls ────────────────────────────────────────────────── */}
          {mode === "rtl" && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.07em", marginBottom: 7 }}>RANGE (right ← left)</div>
              <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: "#f472b8", marginBottom: 3, fontFamily: "'DM Mono', monospace" }}>FROM</div>
                  <NumInput value={rtlMin} onChange={v => setRtlMin(Math.min(v, rtlMax - 1))} color="#f472b8" />
                </div>
                <div style={{ fontSize: 12, color: "#334155", paddingBottom: 6 }}>←</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: "#22d3ee", marginBottom: 3, fontFamily: "'DM Mono', monospace", textAlign: "right" }}>TO</div>
                  <NumInput value={rtlMax} onChange={v => setRtlMax(Math.max(v, rtlMin + 1))} color="#22d3ee" align="right" />
                </div>
              </div>
              <div style={{ marginTop: 6, fontSize: 10, color: "#334155", fontFamily: "'DM Mono', monospace" }}>Bar fills right→left. Value {rtlMax} = empty, {rtlMin} = full.</div>
            </div>
          )}

          {/* Log scale note */}
          {useLog && (
            <div style={{ marginBottom: 10, padding: "6px 10px", background: "#1a0e3a", borderRadius: 6, border: "1px solid #2e1065", fontSize: 10, color: "#a78bfa", fontFamily: "'DM Mono', monospace" }}>
              ∿ Log scale active — uses sign-preserving log₁₊|x| to handle negatives and zero
            </div>
          )}

          {/* Clip warning */}
          {clippedCount > 0 && (
            <div style={{ marginBottom: 10, fontSize: 10, color: "#fb923c", padding: "5px 9px", background: "#1c0f08", borderRadius: 5, border: "1px solid #431407", fontFamily: "'DM Mono', monospace" }}>
              ⚡ {clippedCount} value{clippedCount > 1 ? "s" : ""} outside range — bars clip at extremities
            </div>
          )}

          {/* Presets */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.07em", marginBottom: 6 }}>QUICK PRESETS</div>
            <div style={{ display: "flex", gap: 5 }}>
              {[
                { key: "suggested", label: "Suggested", tip: `IQR: [${suggested.min}, ${suggested.max}]` },
                ...(mode === "diverging" ? [{ key: "symmetric", label: "±Symmetric", tip: "Max abs from data" }] : []),
                { key: "data",      label: "All data",   tip: `Extent: [${dataExtent.min}, ${dataExtent.max}]` },
              ].map(({ key, label, tip }) => (
                <Tip key={key} label={tip}>
                  <button onClick={() => applyPreset(key)}
                    style={{ width: "100%", padding: "6px 0", background: "#0f172a", border: "1px solid #1e293b", borderRadius: 6, color: "#475569", fontSize: 10, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s" }}
                    onMouseEnter={e => { e.currentTarget.style.color = "#94a3b8"; e.currentTarget.style.borderColor = "#334155"; }}
                    onMouseLeave={e => { e.currentTarget.style.color = "#475569"; e.currentTarget.style.borderColor = "#1e293b"; }}
                  >{label}</button>
                </Tip>
              ))}
            </div>
          </div>

          {/* Live preview */}
          <div style={{ paddingTop: 12, borderTop: "1px solid #1e293b" }}>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.07em", marginBottom: 6 }}>LIVE PREVIEW</div>
            {values.slice(0, 5).map((v, i) => (
              <DataBarCell key={i} value={v} mode={mode} rMin={rMin} rMax={rMax} mid={mid} useLog={useLog} />
            ))}
            {useLog && <LogScaleTicks rMin={rMin} rMax={rMax} />}
          </div>

          <button onClick={() => setContextMenu(null)} style={{
            marginTop: 14, width: "100%", padding: "10px 0",
            background: "linear-gradient(135deg, #0ea5e9, #22d3ee)",
            border: "none", borderRadius: 9, color: "#080c14",
            fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
          }}>Apply Scale →</button>
        </div>
      )}
    </div>
  );
}
