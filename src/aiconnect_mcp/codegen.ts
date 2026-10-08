// SPDX-License-Identifier: MIT
//
// LOCAL design-to-code: Figma node JSON (as returned by get_node_info) ->
// React TSX. Pure, zero-dep, fully offline. Styling modes: tailwind
// (default), css (companion stylesheet), inline (style={{}}).
//
// V1 scope: static structure + visual styling. No interactivity, no
// responsive breakpoints, VECTOR children are skipped (they are dropped by
// the node filter upstream) — all reported in `assumptions`.

export type StyleMode = "tailwind" | "css" | "inline";

export interface CodegenFile {
  path: string;
  content: string;
}

export interface CodegenResult {
  componentName: string;
  styling: StyleMode;
  files: CodegenFile[];
  assumptions: string[];
  stats: { nodes: number; textNodes: number; skipped: number };
}

interface Ctx {
  mode: StyleMode;
  css: string[];
  assumptions: string[];
  stats: { nodes: number; textNodes: number; skipped: number };
  classCount: number;
}

const slug = (s: string) =>
  (s || "node").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "node";

const pascal = (s: string) =>
  (s || "Component").replace(/[^a-zA-Z0-9]+/g, " ").split(" ").filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join("").slice(0, 60) || "Component";

const esc = (s: string) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

// A fill already comes as hex (node filter) — tolerate {r,g,b} objects too.
function solidHex(fills: any[]): { hex: string; opacity: number } | null {
  const f = (fills || []).find((x) => x && x.type === "SOLID");
  if (!f) return null;
  let hex: string | null = null;
  if (typeof f.color === "string") hex = f.color;
  else if (f.color && typeof f.color === "object") {
    const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
    hex = `#${h(f.color.r)}${h(f.color.g)}${h(f.color.b)}`;
  }
  if (!hex) return null;
  const opacity = f.opacity == null ? 1 : f.opacity;
  return { hex, opacity };
}

function boxOf(n: any) {
  const b = n.absoluteBoundingBox || n.bbox;
  if (b && typeof b.width === "number") return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  if (typeof n.width === "number") return { x: 0, y: 0, w: Math.round(n.width), h: Math.round(n.height) };
  return null;
}

function radiusOf(n: any): number | null {
  if (typeof n.cornerRadius === "number") return n.cornerRadius;
  return null;
}

// Emit atomic visual props per mode. Returns { cls, style, css } fragments.
function paint(n: any, ctx: Ctx, clsBase: string): { cls: string; style: string; css: string } {
  const out = { cls: "", style: "", css: "" };
  const bg = solidHex(n.fills);
  const r = radiusOf(n);
  if (ctx.mode === "tailwind") {
    const parts: string[] = [];
    if (bg) {
      parts.push(bg.opacity < 1 ? `bg-[${bg.hex}]/[${Math.round(bg.opacity * 100)}]` : `bg-[${bg.hex}]`);
    }
    if (r != null) parts.push(r >= 999 ? "rounded-full" : `rounded-[${r}px]`);
    // Tailwind has no per-corner mixed radius shorthand — flag it.
    if (n.rectangleCornerRadii && ctx.assumptions.indexOf("mixed-corners") === -1) {
      ctx.assumptions.push("mixed-corners: per-corner radii approximated as a single rounded value");
    }
    if (parts.length) out.cls = ` className="${parts.join(" ")}"`;
    return out;
  }
  // css + inline share declarations; css stores them under a class.
  const decls: string[] = [];
  if (bg) decls.push(`background-color: ${bg.hex};${bg.opacity < 1 ? ` opacity: ${+bg.opacity.toFixed(3)};` : ""}`);
  if (r != null) decls.push(`border-radius: ${r}px;`);
  if (!decls.length) return out;
  if (ctx.mode === "inline") {
    const obj = decls.map((d) => {
      const [k, v] = d.replace(/;$/, "").split(/:\s*/);
      const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return `${camel}: "${v}"`;
    });
    out.style = ` style={{ ${obj.join(", ")} }}`;
  } else {
    out.cls = ` className="${clsBase}"`;
    out.css = `.${clsBase} { ${decls.join(" ")} }`;
  }
  return out;
}

function textPaint(n: any, ctx: Ctx, clsBase: string): { cls: string; style: string; css: string } {
  const out = { cls: "", style: "", css: "" };
  const st = n.style || {};
  const fg = solidHex(n.fills);
  if (ctx.mode === "tailwind") {
    const parts: string[] = [];
    if (st.fontSize) parts.push(`text-[${Math.round(st.fontSize)}px]`);
    if (fg) parts.push(fg.opacity < 1 ? `text-[${fg.hex}]/[${Math.round(fg.opacity * 100)}]` : `text-[${fg.hex}]`);
    if (st.fontWeight && st.fontWeight >= 700) parts.push("font-bold");
    else if (st.fontWeight && st.fontWeight >= 600) parts.push("font-semibold");
    else if (st.fontWeight && st.fontWeight >= 500) parts.push("font-medium");
    if (st.textAlignHorizontal === "CENTER") parts.push("text-center");
    else if (st.textAlignHorizontal === "RIGHT") parts.push("text-right");
    if (parts.length) out.cls = ` className="${parts.join(" ")}"`;
    if (st.fontFamily) out.style = ` style={{ fontFamily: "${st.fontFamily}" }}`;
    return out;
  }
  const decls: string[] = [];
  if (st.fontSize) decls.push(`font-size: ${Math.round(st.fontSize)}px;`);
  if (fg) decls.push(`color: ${fg.hex};${fg.opacity < 1 ? ` opacity: ${+fg.opacity.toFixed(3)};` : ""}`);
  if (st.fontWeight) decls.push(`font-weight: ${st.fontWeight};`);
  if (st.fontFamily) decls.push(`font-family: "${st.fontFamily}", sans-serif;`);
  if (st.textAlignHorizontal === "CENTER") decls.push("text-align: center;");
  else if (st.textAlignHorizontal === "RIGHT") decls.push("text-align: right;");
  if (!decls.length) return out;
  if (ctx.mode === "inline") {
    const obj = decls.map((d) => {
      const [k, v] = d.replace(/;$/, "").split(/:\s*/);
      return `${k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}: "${v}"`;
    });
    out.style = ` style={{ ${obj.join(", ")} }}`;
  } else {
    out.cls = ` className="${clsBase}"`;
    out.css = `.${clsBase} { ${decls.join(" ")} }`;
  }
  return out;
}

function render(n: any, ctx: Ctx, origin: { x: number; y: number }, depth: number): string {
  if (!n || typeof n !== "object") return "";
  const pad = "  ".repeat(depth + 2);
  const kids = (n.children || []).map((c: any) => render(c, ctx, origin, depth + 1)).filter(Boolean);
  const inner = kids.length ? `\n${kids.join("\n")}\n${pad}` : "";

  // Instances become component references with a TODO for props.
  if (n.type === "INSTANCE") {
    ctx.stats.nodes++;
    const comp = pascal(n.name).replace(/Instance$/, "") || "Widget";
    ctx.assumptions.push(`instance "${n.name}" emitted as <${comp} /> — wire props manually`);
    return `${pad}<${comp} />`;
  }

  const box = boxOf(n);
  const rel = box ? { x: box.x - origin.x, y: box.y - origin.y, w: box.w, h: box.h } : null;
  const clsBase = `${slug(n.name)}-${n.id.replace(/[^0-9a-zA-Z]/g, "") || ctx.classCount++}`;

  if (n.type === "TEXT") {
    ctx.stats.nodes++;
    ctx.stats.textNodes++;
    const t = textPaint(n, ctx, clsBase);
    if (t.css) ctx.css.push(t.css);
    // Build deterministically per mode (kept explicit for readability).
    if (ctx.mode === "tailwind") {
      const parts: string[] = [];
      if (rel) parts.push("absolute", `left-[${rel.x}px]`, `top-[${rel.y}px]`, `w-[${rel.w}px]`);
      if (t.cls) parts.push(t.cls.slice(12, -1));
      return `${pad}<p${parts.length ? ` className="${parts.join(" ")}"` : ""}${t.style}>${esc(n.characters)}</p>`;
    }
    if (ctx.mode === "css") {
      const cls = ` className="${clsBase}${rel ? " positioned" : ""}"`;
      if (rel) ctx.css.push(`.${clsBase}.positioned { position: absolute; left: ${rel.x}px; top: ${rel.y}px; width: ${rel.w}px; }`);
      return `${pad}<p${cls}>${esc(n.characters)}</p>`;
    }
    const st = rel ? ` style={{ position: "absolute", left: ${rel.x}, top: ${rel.y}, width: ${rel.w}${t.style ? ", " + t.style.slice(10, -2) : ""} }}` : t.style;
    return `${pad}<p${st}>${esc(n.characters)}</p>`;
  }

  if (["FRAME", "COMPONENT", "COMPONENT_SET", "GROUP", "SECTION", "RECTANGLE", "ELLIPSE"].indexOf(n.type) === -1) {
    ctx.stats.skipped++;
    if (ctx.assumptions.indexOf(`skip-${n.type}`) === -1) ctx.assumptions.push(`skip-${n.type}: ${n.type} nodes have no direct JSX equivalent and were omitted`);
    return kids.length ? `${pad}<>${inner}</>` : "";
  }

  ctx.stats.nodes++;
  const p = paint(n, ctx, clsBase);
  if (p.css) ctx.css.push(p.css);
  const tag = "div";
  const isEllipse = n.type === "ELLIPSE";
  if (ctx.mode === "tailwind") {
    const parts: string[] = ["relative"];
    if (rel && depth > 0) {
      // Root is the positioning context; children are absolute within it.
      parts.length = 0;
      parts.push("absolute", `left-[${rel.x}px]`, `top-[${rel.y}px]`, `w-[${rel.w}px]`, `h-[${rel.h}px]`);
    } else if (rel) {
      parts.push(`w-[${rel.w}px]`, `h-[${rel.h}px]`);
    }
    if (p.cls) parts.push(p.cls.slice(12, -1));
    if (isEllipse && !/rounded/.test(parts.join(" "))) parts.push("rounded-full");
    return `${pad}<${tag} className="${parts.join(" ")}">${inner}</${tag}>`;
  }
  if (ctx.mode === "css") {
    const cls = ` className="${clsBase}${rel && depth > 0 ? " positioned" : ""}"`;
    const rules = [`position: ${depth === 0 ? "relative" : "absolute"};`];
    if (rel && depth > 0) rules.push(`left: ${rel.x}px;`, `top: ${rel.y}px;`, `width: ${rel.w}px;`, `height: ${rel.h}px;`);
    else if (rel) rules.push(`width: ${rel.w}px;`, `height: ${rel.h}px;`);
    if (isEllipse) rules.push("border-radius: 9999px;");
    ctx.css.push(`.${clsBase}${rel && depth > 0 ? ".positioned" : ""} { ${rules.join(" ")} }`);
    return `${pad}<${tag}${cls}>${inner}</${tag}>`;
  }
  const st: string[] = [`position: "${depth === 0 ? "relative" : "absolute"}"`];
  if (rel) {
    if (depth > 0) st.push(`left: ${rel.x}`, `top: ${rel.y}`);
    st.push(`width: ${rel.w}`, `height: ${rel.h}`);
  }
  if (isEllipse) st.push(`borderRadius: 9999`);
  const inlineExtra = p.style ? ", " + p.style.slice(10, -2) : "";
  return `${pad}<${tag} style={{ ${st.join(", ")}${inlineExtra} }}>${inner}</${tag}>`;
}

export function exportNodeToCode(node: any, opts: { styling?: StyleMode; componentName?: string } = {}): CodegenResult {
  const mode = opts.styling || "tailwind";
  const ctx: Ctx = { mode, css: [], assumptions: [], stats: { nodes: 0, textNodes: 0, skipped: 0 }, classCount: 0 };
  const origin = (() => {
    const b = boxOf(node || {});
    return { x: b ? b.x : 0, y: b ? b.y : 0 };
  })();
  const name = pascal((opts.componentName || (node && node.name)) ?? "Component");
  const body = render(node, ctx, origin, 0);
  const files: CodegenFile[] = [];
  const header = `// Generated locally by AIConnect export_code (${mode}). Static structure + styling.\n// Assumptions are listed in ASSUMPTIONS below — review before shipping.\n`;
  if (mode === "css") {
    files.push({
      path: `${name}.tsx`,
      content: `${header}export function ${name}() {\n  return (\n${body}\n  );\n}\n`,
    });
    files.push({
      path: `${name}.css`,
      content: `/* Generated alongside ${name}.tsx — import it in your component. */\n${ctx.css.join("\n")}\n`,
    });
  } else {
    files.push({
      path: `${name}.tsx`,
      content: `${header}export function ${name}() {\n  return (\n${body}\n  );\n}\n`,
    });
  }
  const assumptions = ctx.assumptions.length
    ? ctx.assumptions
    : ["none — direct 1:1 mapping held for every node"];
  return { componentName: name, styling: mode, files, assumptions, stats: ctx.stats };
}
