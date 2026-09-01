# h-stats

<div align="center">

**Live model stats, right in your Hermes status bar.**

One chip: what's running, how fast it's streaming, what it costs. Click it and
every number is there — tokens, context, cache, latency, cost — all live, all
from the session you're looking at.

<sub>POWERED BY <a href="https://github.com/NousResearch/hermes-agent">HERMES AGENT</a> &nbsp;·&nbsp; COMMUNITY PLUGIN</sub>

<br />

[Install](#install) &nbsp;·&nbsp; [What's on the chip](#whats-on-the-chip) &nbsp;·&nbsp; [Where the numbers come from](#where-the-numbers-come-from)

</div>

## What's on the chip

The status bar shows `{model} · {stat}`. Right-click the chip to cycle the
stat: **tok/s** → **total tokens** → **cost**. Your choice is remembered.

Click the chip for the full popover:

| Row | What it shows |
| --- | --- |
| Model · Provider | The focused session's live model and its provider prefix (`zai/glm-5.3-flash` → provider `zai`). Bare slugs show "—". |
| In / Out | Input and output tokens for the focused session |
| Context | Percent used of the context window |
| Cache hit | Rolling cache-read ratio |
| Avg latency | Mean API latency over the last 10 calls |
| Avg tok/s | Gateway-computed throughput |
| Cost | Session cost in USD |
| tok/s trend | Live sparkline of the last 30 samples |

Everything follows tile focus — switch sessions, the numbers switch with you.

## Where the numbers come from

```text
Hermes gateway  →  host.state.focusedUsage  →  the chip
```

- **Throughput** prefers the gateway-native `avg_tps`: output tokens ÷ API
  latency over a 10-call window, so tool time and thinking pauses don't smear
  the number.
- When an engine reports no latency history (e.g. Codex app-server), the chip
  falls back to output-token delta ÷ wall-clock between usage emissions.
- Tokens, cost, context, cache, latency — all streamed live by the gateway per
  focused session.

No HTTP backend, no log parsing, no extra processes. One uncompiled
`plugin.js`. Nothing leaves your machine.

## Install

Clone into your Hermes plugins root:

```sh
git clone https://github.com/PiyushDuggal-source/h-stats \
  ~/.hermes/plugins/h-stats
```

Then open (or reload) the Hermes desktop app — `Cmd/Ctrl+K` → **Reload
desktop plugins** if it's already running. `plugin.js` hot-reloads on save; no
config flags, no restart needed.

> Requires the Hermes desktop app. The chip lives in the status bar's right
> area — look for the pulse icon.

## Layout

```
h-stats/
├── desktop/plugin.js     # statusbar chip + popover (the whole plugin)
├── docs/SPEC.md          # design decisions
└── tests/mount-gate.mjs  # mount + reconciliation stability test
```

Run the test:

```sh
node tests/mount-gate.mjs
```

## License

MIT

---

> **Community project**
>
> h-stats is an independent community plugin. It is not affiliated with,
> endorsed by, or officially associated with [Nous
> Research](https://github.com/NousResearch) or the [Hermes Agent
> project](https://github.com/NousResearch/hermes-agent).
