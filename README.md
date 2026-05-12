# revara-costaplanner-mcp

Structural engineering MCP server for Costa Rica. Bridges any **Model Context Protocol** client (Claude Desktop, Cursor, Cline, Continue, Zed, or anything else that speaks MCP) to the deployed [Costaplanner](https://costaplanner.vercel.app) design engine.

19 tools covering CSCR-10 Rev. 2014 + ACI 318-14 + INTE C85:2017 — the only MCP server in the AEC ecosystem that ships **production-grade structural code design** out of the box.

```
your AI agent  →  stdio (MCP)  →  this server  →  HTTPS  →  costaplanner.vercel.app
                                                                ↓
                                                          CSCR-10 / ACI 318 calc engine
                                                                ↓
                                                          memo + checks + reinforcement
```

## Tools

| Tool | Purpose |
|---|---|
| `size_beam` | Beam design (simple or ductile) per CSCR-10 §8 + ACI 318 §9 |
| `size_column` | Rectangular/circular column design |
| `design_footing` | Isolated footing per CSCR-10 §3.5 + ACI 318 §13 |
| `size_strip_footing` | Continuous footing under wall |
| `size_slab_one_way` | One-way slab |
| `size_slab_two_way` | Two-way slab (9 boundary cases) |
| `size_tie_beam` | Tie beam between footings |
| `size_lintel` | Window/door lintel |
| `size_shear_wall` | Reinforced concrete shear wall |
| `size_stair` | Stair slab |
| `analyze_soil_profile` | SPT correlations → φ, c_u, E_s + CSCR-10 §2.4 soil class S1–S4 |
| `size_footing_with_settlement` | Sweeps B in 10cm increments, Meyerhof bearing (FS=3) + Boussinesq elastic settlement (limit 25 mm) |
| `optimize_rebar` | Bar selection across designed elements |
| `compare_designs` | Side-by-side variant comparison |
| `embodied_carbon_estimate` | Concrete + steel embodied carbon (kgCO₂e) |
| `check_seismic` | Standalone CSCR-10 seismic provisions check |
| `design_whole_building` | Pipeline for a full (arch, struct) JSON pair |
| `generate_calc_report` | Markdown memorando in CR Spanish |
| `costaplanner_health` | Probe upstream service |

## Why this exists

- **Costa Rica engineers** need a CFIA-stampable structural memo. Generic ACI 318 calculators don't get you a permit there. This does.
- **AI agents** can now drive structural design with a CSCR-10-aware tool, not generic Python.
- **AEC firms** outside CR can still use it as a high-quality reference for ACI 318 design (CSCR-10 inherits the international code stack).
- **It's portable.** This server is a vanilla MCP implementation. It works with any client that speaks the protocol.

## Compatible clients (verified MCP protocol)

| Client | Config file | Status |
|---|---|---|
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` | ✓ tested |
| **Cursor** | `~/.cursor/mcp.json` or `.cursor/mcp.json` in workspace | ✓ protocol-compliant |
| **Cline** (VS Code) | Extension settings → MCP servers | ✓ protocol-compliant |
| **Continue** | `~/.continue/config.json` → `mcpServers` | ✓ protocol-compliant |
| **Zed** | `~/.config/zed/settings.json` → `context_servers` | ✓ protocol-compliant |
| **Any other MCP client** | Per its docs | ✓ standard stdio transport |

The MCP protocol is an open standard. This server is not bound to any specific vendor.

## Install

```bash
# clone
git clone https://github.com/cappellaadrian/revara-costaplanner-mcp.git
cd revara-costaplanner-mcp

# install
npm install

# the entry is src/index.js — runs on stdio
node src/index.js
```

## Configure your client

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "revara-costaplanner": {
      "command": "node",
      "args": ["/absolute/path/to/revara-costaplanner-mcp/src/index.js"]
    }
  }
}
```

Restart Claude Desktop. The 19 tools appear in the tool list.

### Cursor

Create `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "revara-costaplanner": {
      "command": "node",
      "args": ["/absolute/path/to/revara-costaplanner-mcp/src/index.js"]
    }
  }
}
```

### Cline (VS Code)

Open the Cline extension settings → MCP Servers → Add Server. Configure with the same command + args pattern as Claude Desktop.

### Continue

In `~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "revara-costaplanner",
      "command": "node",
      "args": ["/absolute/path/to/revara-costaplanner-mcp/src/index.js"]
    }
  ]
}
```

### Zed

In `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "revara-costaplanner": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/revara-costaplanner-mcp/src/index.js"]
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `COSTAPLANNER_BASE_URL` | `https://costaplanner.vercel.app` | Override if you self-host the calc engine |

## Quick smoke test

Once configured, in your agent:

> "Design a 30×60 cm beam, 6.25 m span, zone III. Loads: CP 3.10 ton/m, CT 3.50 ton/m, Mu- 22.3 ton-m, Mu+ 15.0 ton-m, Vu 12.5 ton. Use A706."

The agent will call `size_beam` and return a CSCR-10 memorando with all 10 verifications, reinforcement spec (longitudinal + stirrups), and a pass/review verdict.

## Codes implemented

- **CSCR-10 Rev. 2014** — Código Sísmico de Costa Rica (seismic + RC design)
- **ACI 318-14** — referenced by CSCR-10 for concrete
- **INTE C85:2017** — concrete class by seismic zone
- **ASTM A615 / A706 Gr. 60** — rebar (fy = 4200 kg/cm²)

## Strategic context

This MCP is part of [REVARA](https://revara-ruby.vercel.app), the AI-native AEC platform for Costa Rica and Latin America. Other MCPs in the stack (Revit, Rhino, Blender, ArchiCAD, SketchUp) cover the BIM/CAD side. **All of them speak the same open MCP protocol — no vendor lock-in.**

If you want to bridge structural design with live BIM (Revit ↔ design ↔ write-back), see [REVARA](https://revara-ruby.vercel.app) for the full closed loop.

## Contributing

Issues + PRs welcome. The calc engine is a separate service — schema docs at https://costaplanner.vercel.app/schema.

For new tools that wrap additional Costaplanner endpoints, follow the existing pattern: define a Zod schema with engineering-friendly units (cm/m/ton/ton-m), convert to the costaplanner schema (mm/Roman-numeral zones) inside the handler.

## License

MIT — see [LICENSE](LICENSE).
