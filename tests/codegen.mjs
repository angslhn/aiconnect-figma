#!/usr/bin/env bun
/**
 * Unit tests for the local design-to-code layer (src/aiconnect_mcp/codegen.ts).
 * Pure mapping assertions across the tailwind/css/inline modes.
 * Run: bun tests/codegen.mjs
 */
import { exportNodeToCode } from "../src/aiconnect_mcp/codegen.ts";

const tree = {
  id: "1:1", name: "Card", type: "FRAME",
  absoluteBoundingBox: { x: 64, y: 200, width: 300, height: 160 },
  fills: [{ type: "SOLID", color: "#ffffff", opacity: 1 }], cornerRadius: 12,
  children: [
    {
      id: "1:2", name: "Title", type: "TEXT", characters: "Hello {name}",
      absoluteBoundingBox: { x: 80, y: 216, width: 200, height: 24 },
      fills: [{ type: "SOLID", color: "#111111" }],
      style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16, textAlignHorizontal: "LEFT" },
    },
    {
      id: "1:3", name: "Dot", type: "ELLIPSE",
      absoluteBoundingBox: { x: 80, y: 250, width: 24, height: 24 },
      fills: [{ type: "SOLID", color: "#ff0000" }],
    },
    { id: "1:4", name: "Vec", type: "VECTOR" },
  ],
};

let failed = 0;
const has = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failed++;
};

const tw = exportNodeToCode(structuredClone(tree), { styling: "tailwind" });
const t = tw.files[0].content;
has(t.includes("export function Card()"), "tailwind: component name from layer");
has(t.includes("bg-[#ffffff]") && t.includes("rounded-[12px]"), "tailwind: fill + radius");
has(t.includes("text-[16px]") && t.includes("font-bold"), "tailwind: text size + weight");
has(t.includes("Hello &#123;name&#125;"), "tailwind: braces escaped");
has(t.includes("rounded-full"), "tailwind: ellipse round");
has(tw.assumptions.some((a) => a.startsWith("skip-VECTOR")), "tailwind: vector omission disclosed");
has(tw.stats.nodes === 3 && tw.stats.textNodes === 1 && tw.stats.skipped === 1, "tailwind: stats");

const css = exportNodeToCode(structuredClone(tree), { styling: "css" });
has(css.files.length === 2 && css.files[1].path === "Card.css", "css: companion stylesheet emitted");
has(css.files[1].content.includes("background-color: #ffffff"), "css: declarations");

const inl = exportNodeToCode(structuredClone(tree), { styling: "inline" });
has(inl.files.length === 1 && inl.files[0].content.includes('backgroundColor: "#ffffff"'), "inline: style object");

if (failed) { console.log(`\nCODEGEN FAILED ✗ (${failed})`); process.exit(1); }
console.log("\nCODEGEN ✅");
process.exit(0);
