#!/usr/bin/env node
/**
 * REVARA Costaplanner MCP
 *
 * Bridges Claude Desktop to costaplanner.vercel.app — the deployed
 * Costa Rica structural engineering service (CSCR-10 + ACI 318).
 *
 * Architecture: Claude -> stdio (MCP) -> this server -> HTTPS -> costaplanner.vercel.app
 *
 * Each tool builds the canonical building-v0.1.json + structural overlay
 * and POSTs to /design/structural. The agent does not have to know the schema;
 * each tool exposes engineering-friendly inputs (b, h, span, loads, fc, etc.)
 * that this server converts internally.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PATCH_VERSION = "2026-05-11-geotech-week1";
const BASE_URL = process.env.COSTAPLANNER_BASE_URL || "https://costaplanner-api.vercel.app";

console.error(`[REVARA costaplanner] starting -- patch ${PATCH_VERSION} -- base=${BASE_URL}`);

const server = new McpServer({
    name: "revara-costaplanner",
    version: "0.1.0",
    instructions: `REVARA Costaplanner MCP -- Costa Rica structural design (CSCR-10 Rev. 2014 + ACI 318-14).

Use these tools when the user asks to size, design, or code-check structural elements
in a Costa Rican project. All inputs use engineering-friendly units (cm, m, ton, ton-m).
This server converts to the costaplanner schema (mm + Roman seismic zones) internally.

Element types: beams, columns, isolated/strip footings, one-way/two-way slabs, tie beams,
shear walls, stair slabs, lintels.

Material defaults: fc per CSCR-10 zone (Z2=210, Z3=245, Z4=280 kg/cm^2),
fy=4200 (Grade 60), A706 obligatorio en zona >= 3.

When source='claude_estimate' is passed, the result is flagged requires_review=true.
Always cite CSCR-10/ACI articles + always quantify required vs available.`,
});


// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function fcDefaultForZone(zona) {
    if (zona <= 1) return 175;
    if (zona === 2) return 210;
    if (zona === 3) return 245;
    return 280;
}

function zoneToRoman(z) {
    const map = { 1: "II", 2: "II", 3: "III", 4: "IV" };
    return map[z] ?? "III";
}

function buildArchSkeleton({ name, canton, zona_sismica, occupancy_type }) {
    return {
        schema_version: "0.1.0",
        project: {
            name: name ?? "REVARA quick design",
            occupancy_type: occupancy_type ?? "vivienda_unifamiliar",
            location: {
                province: "San Jose",
                canton: canton ?? "Escazu",
                district: "San Rafael",
                seismic_zone: zoneToRoman(zona_sismica ?? 3),
                soil_type: "S3",
            },
        },
        units: { length: "m", force: "kN" },
        levels: [
            { id: "L0", name: "Nivel 0", elevation_m: 0, floor_to_floor_mm: 3000 },
            { id: "L1", name: "Nivel 1", elevation_m: 3.0, floor_to_floor_mm: 3000 },
        ],
        elements: { beams: [], columns: [], stairs: [], walls: [], slabs: [], doors: [], windows: [], rooms: [] },
    };
}

function archBeam({ id, b_cm, h_cm, L_libre_m, level_id }) {
    const span_mm = Math.round(L_libre_m * 1000);
    return {
        id,
        section: { width_mm: Math.round(b_cm * 10), depth_mm: Math.round(h_cm * 10) },
        start: [0, 0],
        end: [span_mm, 0],
        level_id: level_id ?? "L1",
    };
}

function archColumn({ id, b_cm, h_cm, level_id }) {
    return {
        id,
        section: { shape: "rectangular", width_mm: Math.round(b_cm * 10), depth_mm: Math.round(h_cm * 10) },
        location: [0, 0],
        level_id: level_id ?? "L0",
    };
}

async function callCostaplanner(arch, struct) {
    const res = await fetch(`${BASE_URL}/design/structural`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arch, struct }),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`costaplanner ${res.status}: ${text.slice(0, 800)}`);
    }
    try { return JSON.parse(text); }
    catch { return { raw: text }; }
}

function ok(data) { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }; }
function fail(err) {
    return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2) }],
        isError: true,
    };
}


// ─────────────────────────────────────────────────────────────────────────
// 1. SIZE BEAM
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_beam",
    `Design a reinforced concrete beam per CSCR-10 + ACI 318. Returns required dimensions,
flexural reinforcement, shear stirrups, all required code checks (capacity, ductility,
minimum dimensions, anchorage). Loads in ton-m for moments, ton for shear, m for spans.`,
    {
        elementId: z.string().describe("Element ID, e.g. 'V-1'"),
        b_cm: z.number(),
        h_cm: z.number(),
        L_libre_m: z.number().describe("Clear span between column faces in meters"),
        Mu_pos_tonm: z.number(),
        Mu_neg_tonm: z.number(),
        Vu_ton: z.number(),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        ductile: z.boolean().optional().default(true),
        bc_left_cm: z.number().optional(),
        bc_right_cm: z.number().optional(),
        source: z.enum(["sap2000", "etabs", "excel_engineer", "claude_estimate", "manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
        projectName: z.string().optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({
                name: args.projectName ?? `REVARA quick design ${args.elementId}`,
                canton: args.canton, zona_sismica: args.zona_sismica,
            });
            arch.elements.beams.push(archBeam({
                id: args.elementId, b_cm: args.b_cm, h_cm: args.h_cm, L_libre_m: args.L_libre_m,
            }));
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        CS: {
                            Mu_pos_izq: args.Mu_pos_tonm, Mu_pos_der: args.Mu_pos_tonm,
                            Mu_neg_izq: args.Mu_neg_tonm, Mu_neg_der: args.Mu_neg_tonm,
                        },
                        CP: 0, CT: 0,
                        Vu_ton: args.Vu_ton,
                        reinforcement: {
                            tipo: args.ductile ? "ductil" : "simple",
                            ...(args.bc_left_cm ? { bc_columna_izq: args.bc_left_cm } : {}),
                            ...(args.bc_right_cm ? { bc_columna_der: args.bc_right_cm } : {}),
                            with_seismic: true,
                        },
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 2. SIZE COLUMN
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_column",
    `Design a reinforced concrete column per CSCR-10 + ACI 318. Returns required cross-section,
longitudinal reinforcement, confinement stirrups, all code checks. Loads in ton (Pu) and ton-m (Mu).`,
    {
        elementId: z.string(),
        b_cm: z.number(),
        h_cm: z.number(),
        H_libre_m: z.number().describe("Clear height between floor faces, m"),
        Pu_ton: z.number(),
        Mu_tonm: z.number(),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        ductile: z.boolean().optional().default(true),
        source: z.enum(["sap2000", "etabs", "excel_engineer", "claude_estimate", "manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
        projectName: z.string().optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({
                name: args.projectName ?? `REVARA column ${args.elementId}`,
                canton: args.canton, zona_sismica: args.zona_sismica,
            });
            // Set the floor-to-floor on L0 to match H_libre
            arch.levels[0].floor_to_floor_mm = Math.round(args.H_libre_m * 1000);
            arch.elements.columns.push(archColumn({
                id: args.elementId, b_cm: args.b_cm, h_cm: args.h_cm, level_id: "L0",
            }));
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        Pu_ton: args.Pu_ton,
                        Mu_tonm: args.Mu_tonm,
                        CP: 0, CT: 0,
                        reinforcement: { tipo: args.ductile ? "ductil" : "simple", with_seismic: true },
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 3. DESIGN ISOLATED FOOTING
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "design_footing",
    `Design an isolated reinforced concrete footing per CSCR-10 + ACI 318. Returns plan
dimensions B x L, depth h, reinforcement, soil pressure check, punching + one-way shear.`,
    {
        elementId: z.string(),
        Pu_ton: z.number(),
        P_ton: z.number().describe("Service axial load (unfactored), ton"),
        Mu_tonm: z.number().optional().default(0),
        soil_bearing_tonm2: z.number(),
        column_b_cm: z.number(),
        column_h_cm: z.number(),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000", "etabs", "excel_engineer", "claude_estimate", "manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
        projectName: z.string().optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({
                name: args.projectName ?? `REVARA footing ${args.elementId}`,
                canton: args.canton, zona_sismica: args.zona_sismica,
            });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "isolated_footing",
                    geometry: {
                        column_b_cm: args.column_b_cm,
                        column_h_cm: args.column_h_cm,
                        soil_bearing_tonm2: args.soil_bearing_tonm2,
                    },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        Pu_ton: args.Pu_ton,
                        P_ton: args.P_ton,
                        Mu_tonm: args.Mu_tonm ?? 0,
                        CP: 0, CT: 0,
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 4. CHECK SEISMIC -- full-building CSCR-10 design
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "check_seismic",
    `Run CSCR-10 seismic design on the entire building. Pass the full arch (building-v0.1.json)
and struct overlay. Returns per-element results + project-level seismic summary.`,
    {
        archJson: z.any().describe("Full building-v0.1.json object"),
        structJson: z.any().describe("Full building-v0.1.structural.json overlay"),
    },
    async (args) => {
        try {
            const result = await callCostaplanner(args.archJson, args.structJson);
            const summary = result.summary ?? {};
            return ok({
                project: result.project,
                seismic_summary: {
                    zona_sismica: result.project?.zona_sismica,
                    total_elements: summary.total_elements,
                    passing: summary.passing,
                    requires_review: summary.requires_review,
                    with_errors: summary.with_errors,
                },
                results: result.results,
            });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 5. OPTIMIZE REBAR / SECTION -- sweep depth for minimum concrete volume
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "optimize_rebar",
    `Find the minimum-section beam depth that satisfies a given factored moment envelope +
CSCR-10 ductil detailing. Sweeps h_cm in steps and returns the optimal passing trial plus
all attempts.`,
    {
        elementId: z.string(),
        b_cm: z.number(),
        h_min_cm: z.number().optional().default(30),
        h_max_cm: z.number().optional().default(80),
        h_step_cm: z.number().optional().default(5),
        L_libre_m: z.number(),
        Mu_pos_tonm: z.number(),
        Mu_neg_tonm: z.number(),
        Vu_ton: z.number(),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const trials = [];
            for (let h = args.h_min_cm ?? 30; h <= (args.h_max_cm ?? 80); h += (args.h_step_cm ?? 5)) {
                const arch = buildArchSkeleton({
                    name: `REVARA optimize ${args.elementId}`, canton: "Escazu", zona_sismica: args.zona_sismica,
                });
                arch.elements.beams.push(archBeam({
                    id: args.elementId, b_cm: args.b_cm, h_cm: h, L_libre_m: args.L_libre_m,
                }));
                const struct = {
                    building_ref: "inline",
                    materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                    loads_by_element: {
                        [args.elementId]: {
                            source: "manual",
                            CS: { Mu_pos_izq: args.Mu_pos_tonm, Mu_pos_der: args.Mu_pos_tonm, Mu_neg_izq: args.Mu_neg_tonm, Mu_neg_der: args.Mu_neg_tonm },
                            CP: 0, CT: 0,
                            Vu_ton: args.Vu_ton,
                            reinforcement: { tipo: "ductil", with_seismic: true },
                        },
                    },
                };
                try {
                    const r = await callCostaplanner(arch, struct);
                    const res = (r.results ?? [])[0];
                    if (res) {
                        const passing = !res.errors || res.errors.length === 0;
                        const concrete_volume_m3 = (args.b_cm / 100) * (h / 100) * args.L_libre_m;
                        trials.push({ h_cm: h, passing, requires_review: res.requires_review, concrete_volume_m3, summary: res });
                    } else {
                        trials.push({ h_cm: h, passing: false, error: "no_result" });
                    }
                } catch (e) {
                    trials.push({ h_cm: h, passing: false, error: e.message });
                }
            }
            const passing = trials.filter((t) => t.passing);
            const optimal = passing.length > 0
                ? passing.reduce((min, t) => (t.concrete_volume_m3 < min.concrete_volume_m3 ? t : min))
                : null;
            return ok({
                element_id: args.elementId,
                trials_count: trials.length,
                passing_count: passing.length,
                optimal,
                all_trials: trials.map(({ h_cm, passing, concrete_volume_m3, error }) =>
                    ({ h_cm, passing, concrete_volume_m3, error })),
            });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 6. GENERATE CALC REPORT
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "generate_calc_report",
    `Run a full structural design and return the complete Spanish memorando (Markdown) ready
for permit submittal to el colegio de ingenieros. Each element's checks, references to
CSCR-10 / ACI 318 articles, materials, loads, and verdict are included.`,
    {
        archJson: z.any().describe("Full building-v0.1.json"),
        structJson: z.any().describe("Full building-v0.1.structural.json"),
        format: z.enum(["markdown", "json", "both"]).optional().default("both"),
    },
    async (args) => {
        try {
            const result = await callCostaplanner(args.archJson, args.structJson);
            const memos = (result.results ?? []).map((r) => {
                const memo = r.memorando_md ?? r.memorando ?? "";
                return `## ${r.element_id} -- ${r.element_type}\n\n${memo}`;
            }).join("\n\n---\n\n");
            const fullReport =
                `# Memorando de calculo estructural\n\n` +
                `**Proyecto:** ${result.project?.name ?? "(sin nombre)"}\n` +
                `**Canton:** ${result.project?.canton ?? "(sin definir)"}\n` +
                `**Zona sismica:** ${result.project?.zona_sismica ?? "?"}\n` +
                `**Concreto f'c:** ${result.materials?.fc} kg/cm^2\n` +
                `**Acero:** ${result.materials?.acero_norma} fy=${result.materials?.fy} kg/cm^2\n\n` +
                `## Resumen\n` +
                `- Elementos disenados: ${result.summary?.total_elements ?? 0}\n` +
                `- Cumpliendo: ${result.summary?.passing ?? 0}\n` +
                `- Requieren revision: ${result.summary?.requires_review ?? 0}\n` +
                `- Con errores: ${result.summary?.with_errors ?? 0}\n\n` +
                `${memos}\n`;

            if (args.format === "markdown") return ok({ memorando_md: fullReport });
            if (args.format === "json") return ok(result);
            return ok({ memorando_md: fullReport, raw: result });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 7. SIZE ONE-WAY SLAB
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_slab_one_way",
    `Design a one-way reinforced concrete slab per CSCR-10 + ACI 318. Returns thickness check,
flexural reinforcement (top + bottom), shrinkage steel, deflection check. Inputs in metric.
condicion controls the moment coefficient table (interior_span_pos, interior_span_neg,
exterior_span_pos, etc.).`,
    {
        elementId: z.string(),
        Lx_m: z.number().describe("Span in the working direction, m"),
        thickness_cm: z.number().describe("Slab thickness, cm"),
        CP_tonm2: z.number().describe("Permanent load, ton/m^2 (includes self weight)"),
        CT_tonm2: z.number().describe("Live load, ton/m^2"),
        condicion: z.enum(["interior_span_pos","interior_span_neg","exterior_span_pos","exterior_span_neg","interior_support","exterior_support"]).optional().default("interior_span_pos"),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000","etabs","excel_engineer","claude_estimate","manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA slab1way ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "one_way_slab",
                    geometry: { Lx_m: args.Lx_m, thickness_cm: args.thickness_cm },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        CP: args.CP_tonm2, CT: args.CT_tonm2,
                        reinforcement: { condicion: args.condicion },
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 8. SIZE TWO-WAY SLAB
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_slab_two_way",
    `Design a two-way reinforced concrete slab per CSCR-10 + ACI 318 using the moment-coefficient
method. caso 1-9 picks the boundary condition table (1=interior, 2-9=edge/corner combinations).
Returns thickness, top/bottom reinforcement in both directions.`,
    {
        elementId: z.string(),
        Lx_m: z.number().describe("Short span, m"),
        Ly_m: z.number().describe("Long span, m"),
        thickness_cm: z.number(),
        CP_tonm2: z.number(),
        CT_tonm2: z.number(),
        caso: z.number().int().min(1).max(9).optional().default(1).describe("1=interior, 2=one short edge discontinuous, ... 9=four edges discontinuous"),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000","etabs","excel_engineer","claude_estimate","manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA slab2way ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "two_way_slab",
                    geometry: { Lx_m: args.Lx_m, Ly_m: args.Ly_m, thickness_cm: args.thickness_cm },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        CP: args.CP_tonm2, CT: args.CT_tonm2,
                        reinforcement: { caso: args.caso ?? 1 },
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 9. SIZE TIE BEAM (viga de amarre)
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_tie_beam",
    `Design a viga de amarre (tie beam between footings) per CSCR-10. Tie beams resist 10% of
the maximum connected footing axial load as required by §6.5. Pu_zapata_max is the largest
factored axial load among the connected footings.`,
    {
        elementId: z.string(),
        b_cm: z.number(),
        h_cm: z.number(),
        L_libre_m: z.number().describe("Clear length between connected footings, m"),
        Pu_zapata_max_ton: z.number().describe("Largest Pu among connected footings, ton"),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000","etabs","excel_engineer","claude_estimate","manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA tiebeam ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "tie_beam",
                    geometry: { b_cm: args.b_cm, h_cm: args.h_cm, L_libre_m: args.L_libre_m },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        CP: 0, CT: 0,
                        reinforcement: { Pu_zapata_max: args.Pu_zapata_max_ton, with_seismic: true },
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 10. SIZE LINTEL
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_lintel",
    `Design a reinforced concrete lintel above an opening per ACI 318. Returns required b x h,
flexural reinforcement, shear reinforcement, bearing length each side. Loads are usually
masonry above + any tributary slab.`,
    {
        elementId: z.string(),
        opening_width_m: z.number().describe("Clear width of the opening, m"),
        b_cm: z.number(),
        h_cm: z.number(),
        bearing_cm: z.number().optional().default(20).describe("Bearing length each side, cm"),
        CP_tonm: z.number().describe("Distributed permanent load, ton/m"),
        CT_tonm: z.number().describe("Distributed live load, ton/m"),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000","etabs","excel_engineer","claude_estimate","manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA lintel ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "lintel",
                    geometry: { opening_width_m: args.opening_width_m, b_cm: args.b_cm, h_cm: args.h_cm, bearing_cm: args.bearing_cm ?? 20 },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        CP: args.CP_tonm, CT: args.CT_tonm,
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 11. SIZE SHEAR WALL
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_shear_wall",
    `Design a reinforced concrete shear wall (muro de cortante) per CSCR-10 + ACI 318. Returns
boundary element check, web reinforcement, flexural reinforcement, and combined axial-flexure
+ shear capacity. Loads: Pu axial, Vu shear, Mu overturning.`,
    {
        elementId: z.string(),
        L_m: z.number().describe("Wall length in plan, m"),
        H_m: z.number().describe("Wall height, m"),
        thickness_cm: z.number(),
        Pu_ton: z.number(),
        Vu_ton: z.number(),
        Mu_tonm: z.number(),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000","etabs","excel_engineer","claude_estimate","manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA shearwall ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "shear_wall",
                    geometry: { L_m: args.L_m, H_m: args.H_m, thickness_cm: args.thickness_cm },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        Pu_ton: args.Pu_ton, Vu_ton: args.Vu_ton, Mu_tonm: args.Mu_tonm,
                        CP: 0, CT: 0,
                        reinforcement: { with_seismic: true },
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 12. SIZE STAIR SLAB
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_stair",
    `Design a reinforced concrete stair (escalera) slab per ACI 318. Treats stair as inclined
one-way slab. Returns thickness, flexural reinforcement, and detailing for landing zones.
Pass tread, riser, span (horizontal projection), and live load.`,
    {
        elementId: z.string(),
        tread_cm: z.number().describe("Huella, cm"),
        riser_cm: z.number().describe("Contrahuella, cm"),
        span_m: z.number().describe("Horizontal span between supports, m"),
        thickness_cm: z.number().describe("Slab thickness measured perpendicular to inclined surface"),
        CT_tonm2: z.number().optional().default(0.5).describe("Live load (residential 0.20, public 0.50, escapes 0.50 ton/m^2)"),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000","etabs","excel_engineer","claude_estimate","manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA stair ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "stair_slab",
                    geometry: { tread_cm: args.tread_cm, riser_cm: args.riser_cm, span_m: args.span_m, thickness_cm: args.thickness_cm },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        CP: 0, CT: args.CT_tonm2 ?? 0.5,
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// GEOTECH HELPERS — SPT correlations, Meyerhof bearing, Boussinesq settlement.
// All units SI (kPa, kN, m) internally; tools convert to/from engineering
// units (ton, ton/m², cm, m) at the boundary.
// ─────────────────────────────────────────────────────────────────────────

const GEO_CONST = {
    g: 9.81,                       // m/s² (used for unit conversions)
    nu_sand: 0.30, nu_clay: 0.40,  // Poisson ratio
    I_p_square_center_rigid: 0.82, // Bowles, rigid square footing center
    I_p_rect_avg: 0.95,            // average for flexible rectangular
};

// SPT N -> friction angle (Peck, Hanson, Thornburn 1974). For non-cohesive soils.
function sptToPhi(N) {
    const phi = 27.1 + 0.3 * N - 0.00054 * N * N;
    return Math.max(28, Math.min(45, phi)); // clamp to engineering-reasonable range
}

// SPT N -> undrained cohesion c_u (Stroud 1974), kPa. For cohesive soils.
function sptToCohesion(N) {
    return Math.max(0, 6.25 * N);
}

// SPT N -> elastic modulus E_s (kPa). Bowles correlations.
function sptToEs(N, soilType) {
    if (soilType === "clay") return Math.max(2000, 250 * sptToCohesion(N) * 1.0); // 250-500 c_u, use 250 conservative
    // Sand / silty sand: E_s ≈ 0.5 * (N + 15) MPa
    return Math.max(5000, 500 * (N + 15)); // kPa
}

// SPT N -> bulk unit weight γ (kN/m³). Rough engineering estimate.
function sptToGamma(N, soilType) {
    if (soilType === "clay") return 17 + Math.min(N / 30, 0.2) * 4;     // 17-21 kN/m³
    return 16.5 + Math.min(N / 50, 1.0) * 5.5;                          // 16.5-22 kN/m³
}

// CSCR-10 §2.4 soil classification (simplified, by average SPT in upper 30m).
function cscrSoilClass(avgN) {
    if (avgN >= 50) return "S2";   // dense soil / soft rock (use S1 only for hard rock)
    if (avgN >= 15) return "S3";   // medium soils — most CR projects fall here
    return "S4";                   // soft soils — more demanding seismic design
}

// Meyerhof bearing capacity factors.
function meyerhofN(phi_deg) {
    const phi = phi_deg * Math.PI / 180;
    const Nq = Math.exp(Math.PI * Math.tan(phi)) * Math.pow(Math.tan(Math.PI / 4 + phi / 2), 2);
    const Nc = phi_deg > 0 ? (Nq - 1) / Math.tan(phi) : 5.14;
    const Ngamma = (Nq - 1) * Math.tan(1.4 * phi);
    return { Nc, Nq, Ngamma };
}

// Meyerhof bearing capacity for shallow footing (square/rectangular).
// q_ult in kPa. B, L in m. D_f embedment depth in m.
function bearingCapacityMeyerhof({ c_kpa, phi_deg, gamma_kNm3, B_m, L_m, D_f_m, gwt_m }) {
    const { Nc, Nq, Ngamma } = meyerhofN(phi_deg);
    // Shape factors (Meyerhof)
    const Kp = Math.pow(Math.tan(Math.PI / 4 + phi_deg * Math.PI / 360), 2);
    const sc = 1 + 0.2 * Kp * (B_m / L_m);
    const sq = phi_deg >= 10 ? 1 + 0.1 * Kp * (B_m / L_m) : 1;
    const sgamma = sq;
    // Depth factors
    const dc = 1 + 0.2 * Math.sqrt(Kp) * (D_f_m / B_m);
    const dq = phi_deg >= 10 ? 1 + 0.1 * Math.sqrt(Kp) * (D_f_m / B_m) : 1;
    const dgamma = dq;
    // Effective overburden q at footing base
    let q_overburden = gamma_kNm3 * D_f_m;
    // Reduce gamma for groundwater
    let gamma_eff = gamma_kNm3;
    if (gwt_m !== null && gwt_m !== undefined && gwt_m < D_f_m + B_m) {
        if (gwt_m <= D_f_m) {
            q_overburden = gamma_kNm3 * gwt_m + (gamma_kNm3 - 9.81) * (D_f_m - gwt_m);
            gamma_eff = gamma_kNm3 - 9.81;
        } else {
            const depthBelow = gwt_m - D_f_m;
            const factor = depthBelow / B_m;
            gamma_eff = gamma_kNm3 - 9.81 * (1 - factor);
        }
    }
    const q_ult = c_kpa * Nc * sc * dc
                + q_overburden * Nq * sq * dq
                + 0.5 * gamma_eff * B_m * Ngamma * sgamma * dgamma;
    return { q_ult_kpa: q_ult, Nc, Nq, Ngamma, sc, sq, sgamma, dc, dq, dgamma, q_overburden_kpa: q_overburden };
}

// Boussinesq elastic settlement (single homogeneous layer, square footing).
// q_net in kPa, B in m, E_s in kPa. Returns settlement in mm.
function boussinesqSettlement({ q_net_kpa, B_m, E_s_kpa, nu, I_p }) {
    const rho_m = (q_net_kpa * B_m * (1 - nu * nu) / E_s_kpa) * I_p;
    return rho_m * 1000; // mm
}

// Composite soil profile -> single equivalent layer at footing depth.
// Uses weighted average within influence zone (2B below footing).
function averageProfile(layers, D_f_m, B_m, defaultSoilType) {
    const z_top = D_f_m;
    const z_bot = D_f_m + 2 * B_m;
    let weighted = { phi: 0, c: 0, gamma: 0, E_s: 0, weight: 0, N_total: 0, n_layers: 0 };
    for (const L of layers) {
        const L_top = L.depth_top_m;
        const L_bot = L_top + L.thickness_m;
        const overlap_top = Math.max(z_top, L_top);
        const overlap_bot = Math.min(z_bot, L_bot);
        const overlap = Math.max(0, overlap_bot - overlap_top);
        if (overlap <= 0) continue;
        const soilType = L.soil_type ?? defaultSoilType;
        const N = L.N_spt ?? 10;
        const phi = L.phi_deg ?? (soilType === "clay" ? 0 : sptToPhi(N));
        const c   = L.c_kpa   ?? (soilType === "clay" ? sptToCohesion(N) : 0);
        const gamma = L.gamma_kNm3 ?? sptToGamma(N, soilType);
        const E_s = L.E_s_kpa ?? sptToEs(N, soilType);
        weighted.phi   += phi   * overlap;
        weighted.c     += c     * overlap;
        weighted.gamma += gamma * overlap;
        weighted.E_s   += E_s   * overlap;
        weighted.N_total += N * overlap;
        weighted.weight += overlap;
        weighted.n_layers += 1;
    }
    if (weighted.weight === 0) {
        // Fallback: just use the layer the footing sits on
        const L = layers.find(l => l.depth_top_m <= D_f_m && (l.depth_top_m + l.thickness_m) > D_f_m) ?? layers[0];
        const soilType = L.soil_type ?? defaultSoilType;
        const N = L.N_spt ?? 10;
        return {
            phi_deg: L.phi_deg ?? sptToPhi(N),
            c_kpa: L.c_kpa ?? (soilType === "clay" ? sptToCohesion(N) : 0),
            gamma_kNm3: L.gamma_kNm3 ?? sptToGamma(N, soilType),
            E_s_kpa: L.E_s_kpa ?? sptToEs(N, soilType),
            N_avg: N,
            soil_type: soilType,
            note: "fallback: footing depth outside any layer overlap",
        };
    }
    return {
        phi_deg: weighted.phi / weighted.weight,
        c_kpa: weighted.c / weighted.weight,
        gamma_kNm3: weighted.gamma / weighted.weight,
        E_s_kpa: weighted.E_s / weighted.weight,
        N_avg: weighted.N_total / weighted.weight,
        soil_type: defaultSoilType,
    };
}


// ─────────────────────────────────────────────────────────────────────────
// 14. ANALYZE SOIL PROFILE
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "analyze_soil_profile",
    `Analyze a soil profile from SPT data per CSCR-10 §2.4 + Meyerhof bearing capacity.
Returns per-layer effective properties (φ, c, γ, E_s), CSCR-10 soil class (S1-S4),
overburden pressure at foundation depth, and allowable bearing capacity for a square
footing at the specified depth+width (Meyerhof bearing, FS=3 per CSCR-10 §3.5).
Layers can be defined either by SPT N-values (typical CR practice from a ${"sondeo"})
or by explicit φ/c/γ if a lab report is available.`,
    {
        layers: z.array(z.object({
            depth_top_m: z.number().describe("Depth to top of layer from ground surface, m"),
            thickness_m: z.number().describe("Layer thickness, m"),
            soil_type: z.enum(["sand", "silty_sand", "clay", "silty_clay", "gravel", "fill"]).describe("Soil type — drives whether c or φ governs"),
            N_spt: z.number().int().optional().describe("SPT blow count (corrected if available). Used if c/φ not provided."),
            phi_deg: z.number().optional().describe("Friction angle, degrees. Overrides SPT-derived value."),
            c_kpa: z.number().optional().describe("Cohesion, kPa. Overrides SPT-derived value."),
            gamma_kNm3: z.number().optional().describe("Bulk unit weight, kN/m³. Overrides SPT-derived value."),
            E_s_kpa: z.number().optional().describe("Elastic modulus, kPa. Overrides SPT-derived value."),
        })).min(1),
        groundwater_depth_m: z.number().optional().describe("Depth to groundwater table from surface. Omit if dry."),
        foundation_depth_m: z.number().describe("Embedment depth of footing base from surface, m. Typical 1.0-1.5m for residential, 1.5-2.5m for commercial."),
        foundation_width_m: z.number().describe("Trial footing width B, m. Used for bearing capacity calc. Pass 1.0 if unknown — tool will report q_allow at that width."),
        foundation_length_m: z.number().optional().describe("Footing length L, m. Default = B (square). Pass 2*B for strip footing."),
        FS_static: z.number().optional().default(3).describe("Factor of safety on bearing. CSCR-10 §3.5 = 3 static, 2 seismic."),
    },
    async (args) => {
        try {
            const default_soil = args.layers[0].soil_type;
            const avg = averageProfile(args.layers, args.foundation_depth_m, args.foundation_width_m, default_soil);
            const L_m = args.foundation_length_m ?? args.foundation_width_m;
            const bearing = bearingCapacityMeyerhof({
                c_kpa: avg.c_kpa,
                phi_deg: avg.phi_deg,
                gamma_kNm3: avg.gamma_kNm3,
                B_m: args.foundation_width_m,
                L_m,
                D_f_m: args.foundation_depth_m,
                gwt_m: args.groundwater_depth_m ?? null,
            });
            const FS = args.FS_static ?? 3;
            const q_allow_kpa = bearing.q_ult_kpa / FS;
            const q_allow_tonm2 = q_allow_kpa / 9.81;

            // Average SPT for soil classification
            const avgN = args.layers.length === 0 ? 0 : args.layers.reduce((s, L) => s + (L.N_spt ?? 0) * L.thickness_m, 0) / args.layers.reduce((s, L) => s + L.thickness_m, 0);
            const soilClass = cscrSoilClass(avgN);

            return ok({
                project: { foundation_depth_m: args.foundation_depth_m, foundation_width_m: args.foundation_width_m, L_m, FS },
                averaged_properties_in_influence_zone: {
                    phi_deg: Math.round(avg.phi_deg * 10) / 10,
                    c_kpa: Math.round(avg.c_kpa),
                    gamma_kNm3: Math.round(avg.gamma_kNm3 * 10) / 10,
                    E_s_kpa: Math.round(avg.E_s_kpa),
                    E_s_MPa: Math.round(avg.E_s_kpa / 1000 * 10) / 10,
                    avg_SPT_N: Math.round(avg.N_avg),
                    influence_zone_m: `${args.foundation_depth_m.toFixed(2)} to ${(args.foundation_depth_m + 2 * args.foundation_width_m).toFixed(2)}`,
                },
                cscr_soil_class: {
                    class: soilClass,
                    avg_N_top30: Math.round(avgN),
                    reference: "CSCR-10 §2.4",
                    note: soilClass === "S4" ? "Soft soil — increased seismic demand. Consider Plaxis 2D for stability if more than 2 stories." :
                          soilClass === "S3" ? "Medium soil — typical CR site. Standard CSCR-10 spectrum applies." :
                          soilClass === "S2" ? "Dense soil — moderate seismic amplification." : "Hard ground — minimal site amplification.",
                },
                bearing_capacity: {
                    q_ult_kpa: Math.round(bearing.q_ult_kpa),
                    q_ult_tonm2: Math.round(bearing.q_ult_kpa / 9.81 * 10) / 10,
                    q_allow_kpa: Math.round(q_allow_kpa),
                    q_allow_tonm2: Math.round(q_allow_tonm2 * 10) / 10,
                    FS_used: FS,
                    factors: {
                        Nc: Math.round(bearing.Nc * 10) / 10,
                        Nq: Math.round(bearing.Nq * 10) / 10,
                        Ngamma: Math.round(bearing.Ngamma * 10) / 10,
                    },
                    method: "Meyerhof (1963) general bearing capacity equation with shape + depth factors",
                    reference: "ACI 318 §13; CSCR-10 §3.5 (FS=3 static, FS=2 seismic)",
                },
                input_summary: {
                    layer_count: args.layers.length,
                    groundwater: args.groundwater_depth_m ? `at ${args.groundwater_depth_m} m` : "dry / not reported",
                },
            });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 15. SIZE FOOTING WITH SETTLEMENT
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_footing_with_settlement",
    `Design an isolated reinforced concrete footing with BOTH bearing capacity AND settlement
checks. Auto-sizes B = L (square) starting from a minimum and increasing until both checks
pass. Uses Meyerhof bearing (FS=3 per CSCR-10 §3.5) + Boussinesq elastic settlement (limit
25 mm per CSCR-10 §3.5). After geotechnical sizing, delegates to costaplanner's
/design/structural for reinforcement design per ACI 318. Loads in ton.`,
    {
        elementId: z.string().describe("Footing id, e.g. 'Z-1'"),
        Pu_ton: z.number().describe("Factored axial load, ton"),
        P_service_ton: z.number().describe("Service axial load (unfactored), ton"),
        Mu_tonm: z.number().optional().default(0).describe("Factored moment, ton-m (eccentric loading)"),
        column_b_cm: z.number().describe("Supported column width, cm"),
        column_h_cm: z.number().describe("Supported column depth, cm"),
        soil_profile: z.object({
            layers: z.array(z.object({
                depth_top_m: z.number(),
                thickness_m: z.number(),
                soil_type: z.enum(["sand", "silty_sand", "clay", "silty_clay", "gravel", "fill"]),
                N_spt: z.number().int().optional(),
                phi_deg: z.number().optional(),
                c_kpa: z.number().optional(),
                gamma_kNm3: z.number().optional(),
                E_s_kpa: z.number().optional(),
            })).min(1),
            groundwater_depth_m: z.number().optional(),
        }),
        foundation_depth_m: z.number().default(1.5).describe("Embedment depth, m. Default 1.5 typical CR residential."),
        allowable_settlement_mm: z.number().optional().default(25).describe("Max settlement, mm. CSCR-10 §3.5 = 25 mm isolated footings."),
        B_min_m: z.number().optional().default(0.8).describe("Minimum trial footing width, m"),
        B_max_m: z.number().optional().default(4.0).describe("Maximum search width, m"),
        B_step_m: z.number().optional().default(0.1).describe("Search increment, m"),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
    },
    async (args) => {
        try {
            const default_soil = args.soil_profile.layers[0].soil_type;
            const allowable_settlement = args.allowable_settlement_mm ?? 25;
            const trials = [];
            let optimal = null;

            for (let B = args.B_min_m; B <= args.B_max_m + 1e-9; B += args.B_step_m) {
                B = Math.round(B * 100) / 100; // 1cm increments
                const avg = averageProfile(args.soil_profile.layers, args.foundation_depth_m, B, default_soil);
                const bearing = bearingCapacityMeyerhof({
                    c_kpa: avg.c_kpa, phi_deg: avg.phi_deg, gamma_kNm3: avg.gamma_kNm3,
                    B_m: B, L_m: B, D_f_m: args.foundation_depth_m,
                    gwt_m: args.soil_profile.groundwater_depth_m ?? null,
                });
                const q_allow_kpa = bearing.q_ult_kpa / 3;
                const q_allow_tonm2 = q_allow_kpa / 9.81;
                const q_applied_tonm2 = args.P_service_ton / (B * B);
                const q_applied_kpa = q_applied_tonm2 * 9.81;
                const bearing_ok = q_applied_tonm2 <= q_allow_tonm2;

                // Settlement: net stress increase = q_applied - overburden
                const q_net_kpa = Math.max(0, q_applied_kpa - bearing.q_overburden_kpa);
                const nu = default_soil.includes("clay") ? GEO_CONST.nu_clay : GEO_CONST.nu_sand;
                const settlement_mm = boussinesqSettlement({
                    q_net_kpa, B_m: B, E_s_kpa: avg.E_s_kpa, nu,
                    I_p: GEO_CONST.I_p_square_center_rigid,
                });
                const settlement_ok = settlement_mm <= allowable_settlement;

                const trial = {
                    B_m: B,
                    q_applied_tonm2: Math.round(q_applied_tonm2 * 10) / 10,
                    q_allow_tonm2: Math.round(q_allow_tonm2 * 10) / 10,
                    bearing_utilization: Math.round(q_applied_tonm2 / q_allow_tonm2 * 100) / 100,
                    settlement_mm: Math.round(settlement_mm * 10) / 10,
                    settlement_allowable_mm: allowable_settlement,
                    bearing_ok, settlement_ok,
                    passing: bearing_ok && settlement_ok,
                };
                trials.push(trial);
                if (trial.passing && !optimal) optimal = { ...trial, soil_avg: avg };
            }

            if (!optimal) {
                return ok({
                    ok: false,
                    error: "no_passing_size_found",
                    suggestion: "Either increase B_max_m, use deeper foundation (foundation_depth_m), or consider improved bearing strata (e.g. piles, vibroflotation)",
                    trials_summary: { count: trials.length, last_attempt: trials[trials.length - 1] },
                });
            }

            // Now delegate to costaplanner /design/structural for reinforcement design
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA footing+settlement ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "isolated_footing",
                    geometry: {
                        B_m: optimal.B_m,
                        L_m: optimal.B_m,
                        column_b_cm: args.column_b_cm,
                        column_h_cm: args.column_h_cm,
                        soil_bearing_tonm2: optimal.q_allow_tonm2,
                    },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: "manual",
                        Pu_ton: args.Pu_ton,
                        P_ton: args.P_service_ton,
                        Mu_tonm: args.Mu_tonm ?? 0,
                        CP: 0, CT: 0,
                    },
                },
            };
            let reinforcement = null;
            try {
                reinforcement = await callCostaplanner(arch, struct);
            } catch (e) {
                reinforcement = { error: "costaplanner_call_failed", message: e.message };
            }

            return ok({
                ok: true,
                element_id: args.elementId,
                geotech_design: {
                    B_chosen_m: optimal.B_m,
                    L_chosen_m: optimal.B_m,
                    foundation_depth_m: args.foundation_depth_m,
                    q_applied_tonm2: optimal.q_applied_tonm2,
                    q_allow_tonm2: optimal.q_allow_tonm2,
                    bearing_utilization: optimal.bearing_utilization,
                    settlement_mm: optimal.settlement_mm,
                    settlement_allowable_mm: optimal.settlement_allowable_mm,
                    bearing_check: optimal.bearing_ok ? "PASS" : "FAIL",
                    settlement_check: optimal.settlement_ok ? "PASS" : "FAIL",
                    soil_used: {
                        phi_deg: Math.round(optimal.soil_avg.phi_deg * 10) / 10,
                        c_kpa: Math.round(optimal.soil_avg.c_kpa),
                        gamma_kNm3: Math.round(optimal.soil_avg.gamma_kNm3 * 10) / 10,
                        E_s_MPa: Math.round(optimal.soil_avg.E_s_kpa / 1000 * 10) / 10,
                    },
                    methods: {
                        bearing: "Meyerhof (1963), FS=3 per CSCR-10 §3.5",
                        settlement: "Boussinesq elastic, I_p=0.82 (rigid square center), limit 25 mm per CSCR-10 §3.5",
                    },
                    trials_count: trials.length,
                    first_passing_index: trials.findIndex(t => t.passing),
                },
                structural_design: reinforcement,
                summary_line: `${args.elementId}: ${optimal.B_m}×${optimal.B_m}m footing at ${args.foundation_depth_m}m depth. q=${optimal.q_applied_tonm2}/${optimal.q_allow_tonm2} t/m², settlement ${optimal.settlement_mm}/${optimal.settlement_allowable_mm} mm.`,
            });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 13a. SIZE STRIP FOOTING (zapata corrida)
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "size_strip_footing",
    `Design a continuous strip footing (zapata corrida) per CSCR-10 + ACI 318. Used under
perimeter walls and load-bearing partition walls. Returns required width, depth, transverse
reinforcement, longitudinal reinforcement, soil pressure check.`,
    {
        elementId: z.string(),
        wall_thickness_cm: z.number().describe("Thickness of the wall the footing supports, cm"),
        length_m: z.number().describe("Run length of the strip footing, m"),
        soil_bearing_tonm2: z.number(),
        Pu_lineal_tonm: z.number().describe("Factored axial load per linear meter, ton/m"),
        P_lineal_tonm: z.number().describe("Service axial load per linear meter (unfactored), ton/m"),
        canton: z.string().optional().default("Escazu"),
        zona_sismica: z.number().int().min(1).max(4).optional().default(3),
        fc_kgcm2: z.number().optional(),
        fy_kgcm2: z.number().optional().default(4200),
        source: z.enum(["sap2000","etabs","excel_engineer","claude_estimate","manual"]).optional().default("manual"),
        confidence: z.number().min(0).max(1).optional(),
    },
    async (args) => {
        try {
            const fc = args.fc_kgcm2 ?? fcDefaultForZone(args.zona_sismica ?? 3);
            const arch = buildArchSkeleton({ name: `REVARA strip footing ${args.elementId}`, canton: args.canton, zona_sismica: args.zona_sismica });
            const struct = {
                building_ref: "inline",
                materials: { fc, fy: args.fy_kgcm2 ?? 4200, acero_norma: (args.zona_sismica ?? 3) >= 3 ? "A706" : "A615" },
                structural_elements: [{
                    id: args.elementId,
                    type: "strip_footing",
                    geometry: {
                        wall_thickness_cm: args.wall_thickness_cm,
                        length_m: args.length_m,
                        soil_bearing_tonm2: args.soil_bearing_tonm2,
                    },
                }],
                loads_by_element: {
                    [args.elementId]: {
                        source: args.source,
                        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
                        Pu_ton: args.Pu_lineal_tonm * args.length_m,
                        P_ton: args.P_lineal_tonm * args.length_m,
                        CP: 0, CT: 0,
                    },
                },
            };
            return ok(await callCostaplanner(arch, struct));
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 13b. COMPARE DESIGNS (side-by-side)
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "compare_designs",
    `Side-by-side comparison of two design results. Useful for client cost discussions
("what does it cost to upgrade from f'c=210 to f'c=280?") or seismic-zone studies
("what changes between zona III and zona IV?"). Pass two design results (full /design/structural
responses or single results[]) and a label for each. Returns delta on key metrics: concrete
volume, rebar mass estimate, passing/failing checks, requires_review flags.`,
    {
        labelA: z.string().describe("Label for design A (e.g. 'fc=210, A615')"),
        designA: z.any().describe("First design result"),
        labelB: z.string().describe("Label for design B"),
        designB: z.any().describe("Second design result"),
    },
    async (args) => {
        try {
            const extract = (d) => {
                const r = (d && Array.isArray(d.results)) ? d.results[0] : d;
                if (!r || !r.inputs_usados) return null;
                const inp = r.inputs_usados;
                const checks = r.checks ?? [];
                const passing = !r.errors || r.errors.length === 0;
                const failed = checks.filter((c) => c.cumple === false).map((c) => c.nombre);
                const concreteVolM3 = (inp.b ?? 0) / 100 * (inp.h ?? 0) / 100 * (inp.L ?? inp.L_libre_m * 100 ?? 0) / 100;
                return {
                    element_id: r.element_id,
                    element_type: r.element_type,
                    b_cm: inp.b, h_cm: inp.h,
                    fc: inp.fc, fy: inp.fy, zona: inp.zona,
                    Mu_pos: inp.Mu_pos, Mu_neg: inp.Mu_neg, Vu: inp.Vu,
                    passing, requires_review: r.requires_review === true,
                    failed_checks_count: failed.length,
                    failed_checks: failed,
                    concrete_volume_m3: concreteVolM3,
                };
            };
            const a = extract(args.designA);
            const b = extract(args.designB);
            if (!a || !b) {
                return fail(new Error("designA or designB missing inputs_usados — pass full /design/structural responses or single results[]"));
            }
            const delta = {
                fc_delta: (b.fc ?? 0) - (a.fc ?? 0),
                concrete_volume_delta_m3: (b.concrete_volume_m3 ?? 0) - (a.concrete_volume_m3 ?? 0),
                concrete_volume_delta_pct: a.concrete_volume_m3 > 0
                    ? ((b.concrete_volume_m3 - a.concrete_volume_m3) / a.concrete_volume_m3) * 100
                    : 0,
                checks_difference: b.failed_checks_count - a.failed_checks_count,
                both_passing: a.passing && b.passing,
                only_A_passing: a.passing && !b.passing,
                only_B_passing: !a.passing && b.passing,
            };
            return ok({
                A: { label: args.labelA, ...a },
                B: { label: args.labelB, ...b },
                delta,
                summary: a.passing === b.passing
                    ? `Both designs ${a.passing ? "PASS" : "FAIL"}; concrete delta=${delta.concrete_volume_delta_pct.toFixed(1)}%`
                    : (a.passing ? `A passes, B fails. ${b.failed_checks.length} checks failed in B.` : `B passes, A fails. ${a.failed_checks.length} checks failed in A.`),
            });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 13c. EMBODIED CARBON ESTIMATE (ICE database)
// ─────────────────────────────────────────────────────────────────────────
const ICE_FACTORS = {
    // kgCO2e per kg material. ICE v3.0 (Bath, 2019) — averaged values.
    concrete_fc175: 0.124,
    concrete_fc210: 0.134,
    concrete_fc245: 0.145,
    concrete_fc280: 0.156,
    concrete_fc315: 0.168,
    concrete_density_kgm3: 2400,
    rebar_a615_virgin: 1.99,
    rebar_a706_recycled: 0.89,  // higher recycled content
    rebar_density_kgm3: 7850,
    cement_kgm3: 350,  // typical for fc=245
};

server.tool(
    "embodied_carbon_estimate",
    `Estimate embodied carbon (kgCO2e) for a structural design result using ICE database v3.0
factors (Bath University, 2019). Currently estimates from concrete volume + rebar mass.
For accurate Whole Life Carbon, integrate with One Click LCA or EPDs from your supplier.
Pass a design result; returns kgCO2e for concrete + steel + total + intensity per m^2 if floor area given.`,
    {
        designResult: z.any().describe("A costaplanner /design/structural response or single results[]"),
        floor_area_m2: z.number().optional().describe("Building floor area for intensity calc (kgCO2e/m^2)"),
        rebar_grade: z.enum(["a615_virgin", "a706_recycled"]).optional().default("a706_recycled"),
        custom_factors: z.record(z.number()).optional().describe("Override default ICE factors per material key"),
    },
    async (args) => {
        try {
            const dr = args.designResult;
            const results = (dr && Array.isArray(dr.results)) ? dr.results : [dr];
            const factors = { ...ICE_FACTORS, ...(args.custom_factors ?? {}) };
            let totalConcreteM3 = 0;
            let totalRebarKg = 0;
            const perElement = [];

            for (const r of results) {
                if (!r || !r.inputs_usados) continue;
                const inp = r.inputs_usados;
                let concreteM3 = 0;
                if (r.element_type === "beam") {
                    concreteM3 = (inp.b / 100) * (inp.h / 100) * ((inp.L ?? inp.L_libre_m * 100) / 100);
                } else if (r.element_type === "column") {
                    concreteM3 = (inp.b / 100) * (inp.h / 100) * (inp.H_libre_m ?? 3);
                } else if (r.element_type === "isolated_footing") {
                    const B = (inp.B ?? inp.B_cm ?? 100) / 100;
                    const L = (inp.L ?? inp.L_cm ?? 100) / 100;
                    const h = (inp.h ?? inp.h_cm ?? 50) / 100;
                    concreteM3 = B * L * h;
                } else if (r.element_type === "one_way_slab" || r.element_type === "two_way_slab") {
                    const Lx = inp.Lcorto ?? inp.Lx_m ?? 0;
                    const Ly = inp.Llargo ?? inp.Ly_m ?? Lx;
                    const t = (inp.h ?? inp.thickness_cm ?? 12) / 100;
                    concreteM3 = Lx * Ly * t;
                } else if (r.element_type === "shear_wall") {
                    concreteM3 = (inp.L_m ?? 0) * (inp.H_m ?? 0) * ((inp.thickness_cm ?? 15) / 100);
                }

                // Rebar mass — engineering rule of thumb 80-120 kg/m^3 for residential, 150-200 commercial
                const rebarRatio_kgm3 = r.element_type === "beam" || r.element_type === "column" ? 130
                    : r.element_type === "isolated_footing" ? 80
                    : 90;
                const rebarKg = concreteM3 * rebarRatio_kgm3;

                const fcKey = `concrete_fc${Math.round(inp.fc ?? 245)}`;
                const concreteFactor = factors[fcKey] ?? factors.concrete_fc245;
                const rebarFactor = factors[`rebar_${args.rebar_grade ?? "a706_recycled"}`] ?? factors.rebar_a706_recycled;

                const concreteCO2 = concreteM3 * factors.concrete_density_kgm3 * concreteFactor;
                const rebarCO2 = rebarKg * rebarFactor;

                totalConcreteM3 += concreteM3;
                totalRebarKg += rebarKg;

                perElement.push({
                    element_id: r.element_id,
                    element_type: r.element_type,
                    concrete_m3: Math.round(concreteM3 * 1000) / 1000,
                    rebar_kg: Math.round(rebarKg),
                    concrete_kgCO2e: Math.round(concreteCO2),
                    rebar_kgCO2e: Math.round(rebarCO2),
                    total_kgCO2e: Math.round(concreteCO2 + rebarCO2),
                });
            }
            const totalConcreteCO2 = totalConcreteM3 * factors.concrete_density_kgm3 * factors.concrete_fc245;
            const totalRebarCO2 = totalRebarKg * factors[`rebar_${args.rebar_grade ?? "a706_recycled"}`];
            const totalCO2 = perElement.reduce((s, e) => s + e.total_kgCO2e, 0);

            return ok({
                methodology: "ICE database v3.0 (Bath University, 2019). Concrete factor varies by f'c (0.124-0.168 kgCO2e/kg). Rebar A706 (recycled, 0.89) or A615 (virgin, 1.99). Rebar mass estimated from concrete volume × 80-130 kg/m^3 rule-of-thumb. Replace with EPDs from your supplier or a One Click LCA run for a stamped figure.",
                rebar_grade_used: args.rebar_grade ?? "a706_recycled",
                totals: {
                    concrete_volume_m3: Math.round(totalConcreteM3 * 1000) / 1000,
                    rebar_mass_kg: Math.round(totalRebarKg),
                    concrete_kgCO2e: Math.round(totalConcreteCO2),
                    rebar_kgCO2e: Math.round(totalRebarCO2),
                    total_kgCO2e: totalCO2,
                    intensity_kgCO2e_per_m2: args.floor_area_m2 ? Math.round(totalCO2 / args.floor_area_m2) : null,
                },
                per_element: perElement,
                benchmarks: {
                    typical_residential_kgCO2e_per_m2: "300-500",
                    typical_office_kgCO2e_per_m2: "500-800",
                    leed_low_carbon_target: "<300",
                    note: "Structural-only embodied carbon. Add envelope + finishes + MEP for whole-building.",
                },
            });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// 13. DESIGN WHOLE BUILDING (one-step from pair)
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "design_whole_building",
    `One-step whole-building design. Pass the (arch, struct) JSON pair produced by
extract_loads_to_costaplanner_pair (or any other valid pair) and get back: every element
designed per CSCR-10 + ACI 318, full Spanish memorando_md ready for permit submittal,
project-level summary (passing / requires_review / errors), and a compact per-element
breakdown. The natural pair to extract_loads_to_costaplanner_pair.`,
    {
        archJson: z.any().describe("Full building-v0.1.json"),
        structJson: z.any().describe("Full building-v0.1.structural.json"),
        format: z.enum(["full", "memorando_only", "summary_only"]).optional().default("full"),
    },
    async (args) => {
        try {
            const result = await callCostaplanner(args.archJson, args.structJson);
            const summary = result.summary ?? {};
            const memos = (result.results ?? []).map((r) => {
                const memo = r.memorando_md ?? r.memorando ?? "";
                return `## ${r.element_id} -- ${r.element_type}\n\n${memo}`;
            }).join("\n\n---\n\n");
            const fullReport =
                `# Memorando de calculo estructural\n\n` +
                `**Proyecto:** ${result.project?.name ?? "(sin nombre)"}\n` +
                `**Canton:** ${result.project?.canton ?? "(sin definir)"}\n` +
                `**Zona sismica:** ${result.project?.zona_sismica ?? "?"}\n` +
                `**Concreto f'c:** ${result.materials?.fc} kg/cm^2\n` +
                `**Acero:** ${result.materials?.acero_norma} fy=${result.materials?.fy} kg/cm^2\n\n` +
                `## Resumen\n` +
                `- Elementos disenados: ${summary.total_elements ?? 0}\n` +
                `- Cumpliendo: ${summary.passing ?? 0}\n` +
                `- Requieren revision: ${summary.requires_review ?? 0}\n` +
                `- Con errores: ${summary.with_errors ?? 0}\n\n` +
                `${memos}\n`;

            const perElement = (result.results ?? []).map((r) => ({
                element_id: r.element_id,
                element_type: r.element_type,
                passing: !r.errors || r.errors.length === 0,
                requires_review: r.requires_review === true,
                errors: r.errors ?? [],
                first_failed_check: (r.checks ?? []).find((c) => c.cumple === false)?.nombre ?? null,
            }));

            if (args.format === "memorando_only") return ok({ memorando_md: fullReport });
            if (args.format === "summary_only") {
                return ok({
                    project: result.project,
                    materials: result.materials,
                    summary,
                    per_element: perElement,
                });
            }
            return ok({
                memorando_md: fullReport,
                project: result.project,
                materials: result.materials,
                summary,
                per_element: perElement,
                raw: result,
            });
        } catch (e) { return fail(e); }
    }
);


// ─────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────
server.tool(
    "costaplanner_health",
    `Probe costaplanner deployment to confirm reachability + skill loaded.`,
    {},
    async () => {
        try {
            const res = await fetch(`${BASE_URL}/`, { method: "GET" });
            const body = await res.json();
            return ok({ ok: res.ok, base_url: BASE_URL, response: body });
        } catch (e) { return fail(e); }
    }
);


async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[REVARA costaplanner] MCP server start success -- patch ${PATCH_VERSION}`);
}
main().catch((e) => { console.error("[REVARA costaplanner] startup error:", e); process.exit(1); });
