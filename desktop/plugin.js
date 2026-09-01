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
  const info = useSessionInfo();
  const composerModel = useValue(host.state.model);
  const model = info?.model || (usage && usage.model) || composerModel || "";
  const fmt = fmtTok;
  return h("div", {
    className: "flex w-56 flex-col gap-0.5 p-1",
    children: [
      h(Row, { key: "model", label: "Model", value: model.split("/").pop() || null }),
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
      // Cost row disabled: the gateway's _get_usage (tui_gateway/server.py)
      // never streams cost_usd into focusedUsage, so this always rendered "—".
      // Re-enable once the backend adds usage["cost_usd"].
      // h(Row, {
      //   key: "cost",
      //   label: "Cost",
      //   value: usage?.cost_usd != null ? `$${Number(usage.cost_usd).toFixed(4)}` : null,
      //   source: "live",
      // }),
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
      h("div", {
        key: "update",
        className: "flex items-center justify-end border-t border-(--border) pt-1",
        children: h(UpdateButton, { notify: null }),
      }),
    ],
  });
}

// ---------- chip ----------
// "cost" dropped from the cycle: gateway never streams cost_usd (see
// commented Cost row in StatsPanel). Add it back when the backend does.
const FORMATS = ["tok/s", "total"];
function DshChip({ storage }) {
  const { rate, usage } = useTokPerSec();
  // Persistent update watcher — runs on the chip so the badge shows even
  // with the popover closed (UpdateButton re-uses the same throttled check).
  const update = useUpdateCheck(null);
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
              h("span", {
                key: "pulse-wrap",
                className: "relative flex items-center",
                children: [
                  h(Codicon, { name: "pulse", size: 12 }),
                  update.state === "behind" && update.behind > 0
                    ? h("span", {
                        className:
                          "absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-(--accent,#7c9cff)",
                      })
                    : null,
                ],
              }),
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

// ---------- self-update (check + pull via gateway shell.exec) ----------
// The plugin lives in a git clone, so updates are plain git. DIR is derived at
// runtime from the fact that shell.exec runs with the gateway's cwd (the user's
// home): the plugin resolves its own absolute directory by asking git where the
// clone containing this file is — portable across machines, no hardcoded path.
let _dirPromise = null;
function pluginDir() {
  if (!_dirPromise) {
    _dirPromise = host
      .request("shell.exec", {
        command: 'd="$HOME/.hermes/plugins/' + ID + '"; [ -d "$d/.git" ] && echo "$d"',
      })
      .then((r) => (r && r.code === 0 ? String(r.stdout || "").trim() : ""))
      .catch(() => "");
  }
  return _dirPromise;
}

function sh(cmd) {
  return host
    .request("shell.exec", { command: cmd })
    .then((r) => ({ code: r?.code, out: String(r?.stdout || ""), err: String(r?.stderr || "") }))
    .catch((e) => ({ code: -1, out: "", err: String(e) }));
}

async function checkForUpdate() {
  const dir = await pluginDir();
  if (!dir) return { status: "no-git" };
  await sh(`git -C "${dir}" fetch origin --quiet`);
  const behind = await sh(`git -C "${dir}" rev-list HEAD..origin/main --count`);
  const n = parseInt(String(behind.out).trim(), 10);
  if (!Number.isFinite(n)) return { status: "error", detail: behind.err };
  return { status: n > 0 ? "behind" : "current", behind: n };
}

async function applyUpdate() {
  const dir = await pluginDir();
  if (!dir) return { status: "no-git" };
  const pull = await sh(`git -C "${dir}" pull --ff-only origin main`);
  if (pull.code !== 0) return { status: "error", detail: pull.err || pull.out };
  return { status: "updated" };
}

function useUpdateCheck(notify) {
  const [state, setState] = useState("idle"); // idle | checking | current | behind | updated | error | no-git
  const [behind, setBehind] = useState(0);
  const [detail, setDetail] = useState("");
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const run = async (apply) => {
    setState("checking");
    const r = apply ? await applyUpdate() : await checkForUpdate();
    if (r.status === "behind") setBehind(r.behind);
    if (r.status === "error") setDetail(r.detail || "");
    setState(r.status);
    if (apply && r.status === "updated" && notify)
      notify({ kind: "success", message: "h-stats updated — hot reload applies it in a moment" });
    if (apply && r.status === "error" && notify)
      notify({ kind: "error", message: "h-stats update failed: " + (r.detail || "unknown") });
    return r;
  };
  // Throttled auto-check: at most once an hour, persisted per install.
  useEffect(() => {
    if (!_storage?.get) return;
    let cancelled = false;
    const last = Number(_storage.get(ID + ":last-check") || 0);
    if (Date.now() - last < 3600_000) return;
    _storage.set?.(ID + ":last-check", String(Date.now()));
    checkForUpdate().then((r) => {
      if (cancelled) return;
      if (r.status === "behind") {
        setBehind(r.behind);
        // Update DROPPED — announce it even though the popover is closed.
        notifyRef.current?.({
          kind: "info",
          title: "h-stats",
          message: `Update available — ${r.behind} new commit${r.behind > 1 ? "s" : ""}. Open the stats popover and click the sync button to update.`,
        });
      }
      setState(r.status);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { state, behind, detail, run };
}

function UpdateButton({ notify }) {
  const { state, behind, detail, run } = useUpdateCheck(notify);
  if (state === "no-git") return null; // not a git clone — nothing to update
  const behindNow = state === "behind" && behind > 0;
  return h(
    "button",
    {
      title:
        state === "behind"
          ? `${behind} update${behind > 1 ? "s" : ""} available — click to pull`
          : state === "checking"
            ? "checking…"
            : state === "error"
              ? `check failed: ${detail} — click to retry`
              : "check for updates",
      onClick: () => run(behindNow),
      className: cn(
        "flex items-center gap-1 rounded px-1 text-[10px]",
        behindNow ? "text-(--accent,#7c9cff)" : "text-(--ui-text-quaternary)",
      ),
    },
    h(Codicon, { name: behindNow ? "cloud-download" : "sync", size: 12 }),
    behindNow ? String(behind) : null,
  );
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
