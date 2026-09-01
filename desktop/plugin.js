/**
 * h-stats — live model stats for Hermes.
 *
 * Status-bar chip owns its slot via StatusbarItem.render: `{model} · {tok/s}`.
 * tok/s = gateway-native avg_tps (output ÷ API latency, 10-call window) when
 * present, else focusedUsage.output delta ÷ wall-clock; null usage → "—".
 *
 * ALL numbers come from host.state.focusedUsage — the gateway streams the
 * whole snapshot (tokens, cost, context, model, cache_hit_pct, avg_latency_s,
 * avg_tps) per focused session via session.usage/session.info, so every row
 * follows tile focus and updates live. No HTTP backend, no log parsing.
 */
import {
  STATUSBAR_AREAS,
  Badge,
  Button,
  Codicon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
  host,
  useValue,
} from "@hermes/plugin-sdk";
import { Component, createElement as h, Fragment, useEffect, useRef, useState } from "react";

const ID = "h-stats";

// ---------- error boundary (SPEC gate) ----------
class PanelBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[h-stats] render crash:", error);
  }
  render() {
    if (this.state.error) {
      return h("span", {
        className: "text-xs text-red-400",
        children: [
          "h-stats error: ",
          String(this.state.error?.message || this.state.error),
        ],
      });
    }
    return this.props.children;
  }
}

// ---------- live tok/s from focusedUsage ----------
// Primary: usage.avg_tps — the gateway computes it natively per API call
// (output tokens ÷ API latency, deque(maxlen=10) window, see
// tui_gateway/server.py _get_usage) so it excludes thinking/tool overhead
// the wall-clock delta would smear in. Fallback: output-token delta ÷
// wall-clock between emissions, for engines that report no latency history
// (e.g. Codex app-server).
function useTokPerSec() {
  const usage = useValue(host.state.focusedUsage);
  const prev = useRef(null); // { output, at }
  const [rate, setRate] = useState(null);
  useEffect(() => {
    if (usage?.avg_tps != null) {
      setRate(Math.round(usage.avg_tps));
      prev.current = null; // don't let a later fallback delta bridge the native gap
      return;
    }
    if (!usage || usage.output == null) return;
    const now = performance.now();
    const p = prev.current;
    if (p && usage.output > p.output && now > p.at) {
      const r = (usage.output - p.output) / ((now - p.at) / 1000);
      // 100k tok/s ceiling: guards against a bogus snapshot producing a
      // spuriously huge rate; no real LLM streams anywhere near it.
      if (r >= 0 && r < 100000) setRate(Math.round(r));
    }
    prev.current = { output: usage.output, at: now };
  }, [usage]);
  return { rate, usage };
}

function Sparkline({ values, width = 180, height = 30 }) {
  const pts = values.filter((v) => v != null);
  if (pts.length < 2)
    return h("div", {
      className: "text-[11px] text-(--ui-text-quaternary)",
      children: "collecting…",
    });
  const max = Math.max(...pts),
    min = Math.min(...pts);
  const span = max - min || 1;
  const step = width / (pts.length - 1);
  const d = pts
    .map(
      (v, i) =>
        `${i ? "L" : "M"}${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 4) - 2).toFixed(1)}`,
    )
    .join(" ");
  return h("svg", {
    width,
    height,
    children: h("path", {
      d,
      fill: "none",
      stroke: "var(--accent, #7c9cff)",
      strokeWidth: 1.5,
    }),
  });
}

// DSH-style compact token format: 938 → 938, 12,200 → 12.2K, 5,700,000 → 5.7M
function fmtTok(n) {
  if (n == null) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// ---------- whole-stats popover ----------
// Stable-identity row component (module scope): defining components inside a
// render body gives them a new type every re-render → React remounts the whole
// subtree each emission → reconciliation reads .key off undefined children.
function Row({ label, value, source }) {
  return h(Fragment, {
    children: [
      h("div", {
        key: label,
        className: "flex items-center justify-between gap-3 py-1 text-xs",
        children: [
          h("span", {
            className: "text-(--ui-text-secondary)",
            children: label,
          }),
          h("span", {
            className: "font-medium tabular-nums",
            children: value ?? "—",
          }),
        ],
      }),
      source
        ? h("div", {
            className:
              "-mt-1 text-right text-[9px] text-(--ui-text-quaternary)",
            children: source,
          })
        : null,
    ],
  });
}

function StatsPanel({ tokHistory }) {
  const usage = useValue(host.state.focusedUsage);
  // Live model of the FOCUSED session (streamed by the gateway on every
  // turn) — falls back to the composer slug only while no usage exists yet.
  const composerModel = useValue(host.state.model);
  const model = (usage && usage.model) || composerModel || "";
  // Provider prefix exists only on provider-scoped slugs (`zai/glm-5.3-flash`);
  // a bare slug (e.g. `glm-5.3-flash`) carries no provider, so show "—".
  const provider = model.includes("/") ? model.split("/")[0] : "—";
  const fmt = fmtTok;
  return h("div", {
    className: "flex w-56 flex-col gap-0.5 p-1",
    children: [
      h(Row, { key: "model", label: "Model", value: model.split("/").pop() || null }),
      h(Row, { key: "provider", label: "Provider", value: provider }),
      h(Row, { key: "in", label: "In", value: fmt(usage?.input), source: "live" }),
      h(Row, { key: "out", label: "Out", value: fmt(usage?.output), source: "live" }),
      h(Row, {
        key: "ctx",
        label: "Context",
        value:
          usage?.context_percent != null
            ? `${usage.context_percent}% of ${fmt(usage.context_max)}`
            : null,
      }),
      h(Row, {
        key: "cache",
        label: "Cache hit",
        value: usage?.cache_hit_pct != null ? `${usage.cache_hit_pct}%` : null,
        source: "live",
      }),
      h(Row, {
        key: "lat",
        label: "Avg latency",
        value: usage?.avg_latency_s != null ? `${usage.avg_latency_s}s` : null,
        source: "live",
      }),
      h(Row, {
        key: "tps",
        label: "Avg tok/s",
        value: usage?.avg_tps != null ? `${usage.avg_tps}` : null,
        source: "live",
      }),
      h(Row, {
        key: "cost",
        label: "Cost",
        value: usage?.cost_usd != null ? `$${Number(usage.cost_usd).toFixed(4)}` : null,
        source: "live",
      }),
      h("div", {
        key: "spark",
        className: "mt-2 flex flex-col gap-0.5 border-t border-(--border) pt-2",
        children: [
          h("span", {
            className: "text-[10px] uppercase tracking-wide text-(--ui-text-quaternary)",
            children: "tok/s trend",
          }),
          h(Sparkline, { values: tokHistory }),
        ],
      }),
    ],
  });
}

// ---------- chip ----------
const FORMATS = ["tok/s", "total", "cost"];
function DshChip({ storage }) {
  const { rate, usage } = useTokPerSec();
  // Live model of the focused session wins; composer slug is the cold fallback.
  const composerModel = useValue(host.state.model);
  const model = (usage && usage.model) || composerModel || "";
  const [history, setHistory] = useState([]);
  const [format, setFormat] = useState("tok/s");
  // load persisted pref once (ctx.storage is the session-importer-proven pattern)
  useEffect(() => {
    if (!storage?.get) return
    try {
      const saved = storage.get(ID + ":format")
      if (saved && FORMATS.includes(saved)) setFormat(saved)
    } catch {}
  }, [])
  const cycleFormat = () =>
    setFormat((f) => {
      const next = FORMATS[(FORMATS.indexOf(f) + 1) % FORMATS.length]
      try {
        storage?.set?.(ID + ":format", next)
      } catch {}
      return next
    })
  useEffect(() => {
    if (rate != null) setHistory((h) => [...h.slice(-29), rate]);
  }, [rate]);
  const shortModel = (model || "").split("/").pop() || "—";
  let statText = "—"
  if (format === "tok/s") statText = rate != null ? `${rate} tok/s` : usage ? "idle" : "—"
  else if (format === "total") statText = usage?.total != null ? `${fmtTok(usage.total)} tok` : "—"
  else if (format === "cost") statText = usage?.cost_usd != null ? `$${Number(usage.cost_usd).toFixed(4)}` : "—"
  return h(PanelBoundary, {
    children: h(Popover, {
      children: [
        h(PopoverTrigger, {
          asChild: true,
          children: h("button", {
            onContextMenu: (e) => { e.preventDefault(); cycleFormat() },
            title: `${format} · right-click to change`,
            className: cn(
              "flex items-center gap-1.5 rounded px-1.5 text-xs text-(--ui-text-secondary) hover:text-(--ui-text-primary)",
            ),
            children: [
              h(Codicon, { name: "pulse", size: 12 }),
              h("span", { className: "tabular-nums", children: shortModel }),
              h("span", {
                className: "text-(--ui-text-quaternary)",
                children: "·",
              }),
              h("span", {
                className: "font-medium tabular-nums",
                children: statText,
              }),
            ],
          }),
        }),
        h(PopoverContent, {
          align: "end",
          className: "w-auto",
          children: h(StatsPanel, { tokHistory: history }),
        }),
      ],
    }),
  });
}

let _storage = null;
export default {
  id: ID,
  name: "H Stats",
  description: "Live token stats for the Hermes status bar",
  register(ctx) {
    _storage = ctx.storage;
    ctx.registerMany([
      {
        id: "chip",
        area: STATUSBAR_AREAS.right,
        order: 150,
        render: () => h(DshChip, { storage: _storage }),
      },
    ]);
  },
};
