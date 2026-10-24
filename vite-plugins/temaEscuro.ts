// =========================================================================
// TEMA ESCURO GERADO NO BUILD
// -------------------------------------------------------------------------
// A interface usa cores fixas (Tailwind com valores arbitrários e blocos
// <style> nos componentes). Em vez de duplicar cada classe à mão, este plugin
// lê todo o CSS final e, para cada regra com cor, cria uma cópia prefixada por
// `.dark` com a cor convertida no espaço OKLCH:
//   - fundos claros viram superfícies escuras (preservando o matiz)
//   - textos escuros viram claros
//   - bordas claras viram cinzas médios
//   - cores vivas (botões, status, seleção) são mantidas
// A cópia fica logo após a original, na mesma camada/@media, com +1 de
// especificidade, preservando hover/foco/seleção e a ordem da cascata.
// =========================================================================
import fs from 'fs';
import path from 'path';
import postcss, { type Root, type Rule, type AtRule } from 'postcss';
import type { Plugin } from 'vite';

type Papel = 'fundo' | 'texto' | 'borda' | 'sombra';
type Rgba = { r: number; g: number; b: number; a: number };
type Oklch = { L: number; C: number; h: number; a: number };

// ------------------------------------------------------------------
// Conversões de cor (sRGB <-> OKLab/OKLCH)
// ------------------------------------------------------------------
const paraLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const paraSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbParaOklch({ r, g, b, a }: Rgba): Oklch {
  const [lr, lg, lb] = [paraLinear(r), paraLinear(g), paraLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI, a };
}

function oklchParaRgbBruto({ L, C, h, a }: Oklch): Rgba {
  const A = C * Math.cos((h * Math.PI) / 180);
  const B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: paraSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: paraSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: paraSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a
  };
}

const dentroDoGamut = (c: Rgba) => [c.r, c.g, c.b].every((v) => v >= -0.0005 && v <= 1.0005);

// Reduz o croma até a cor caber no sRGB (mantém luminosidade e matiz)
function oklchParaRgb(cor: Oklch): Rgba {
  let rgb = oklchParaRgbBruto(cor);
  if (!dentroDoGamut(rgb)) {
    let lo = 0, hi = cor.C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (dentroDoGamut(oklchParaRgbBruto({ ...cor, C: mid }))) lo = mid; else hi = mid;
    }
    rgb = oklchParaRgbBruto({ ...cor, C: lo });
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { r: clamp(rgb.r), g: clamp(rgb.g), b: clamp(rgb.b), a: rgb.a };
}

function formatar({ r, g, b, a }: Rgba): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  if (a >= 0.999) return `#${h(r)}${h(g)}${h(b)}`;
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${+a.toFixed(3)})`;
}

function lerCor(txt: string): Rgba | null {
  const s = txt.trim().toLowerCase();
  if (s === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let x = m[1];
    if (x.length === 3 || x.length === 4) x = x.split('').map((c) => c + c).join('');
    if (x.length !== 6 && x.length !== 8) return null;
    const v = (i: number) => parseInt(x.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), a: x.length === 8 ? v(6) : 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    if (p.length < 3) return null;
    const canal = (v: string) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 255);
    const alfa = p[3] == null ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    return { r: canal(p[0]), g: canal(p[1]), b: canal(p[2]), a: alfa };
  }
  m = s.match(/^oklch\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s/]+/).filter(Boolean);
    const L = p[0].endsWith('%') ? parseFloat(p[0]) / 100 : parseFloat(p[0]);
    const alfa = p[3] == null ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    return oklchParaRgb({ L, C: parseFloat(p[1]) || 0, h: parseFloat(p[2]) || 0, a: alfa });
  }
  return null;
}

// ------------------------------------------------------------------
// Regras de conversão para o tema escuro
// ------------------------------------------------------------------
const viva = (c: Oklch) => c.C >= 0.09 && c.L < 0.8;

function converter(rgb: Rgba, papel: Papel): Rgba {
  if (rgb.a === 0) return rgb;
  const c = rgbParaOklch(rgb);
  let { L, C } = c;

  if (papel === 'fundo' || (papel === 'sombra' && c.L > 0.6)) {
    if (c.L < 0.55 || viva(c)) return rgb; // já é escuro ou é cor de destaque
    L = 0.2 + (1 - c.L) * 0.55;
    C = Math.min(c.C, 0.07);
  } else if (papel === 'texto') {
    if (c.L > 0.65) return rgb;
    L = 0.93 - c.L * 0.4;
  } else if (papel === 'borda') {
    if (viva(c)) return rgb;
    if (c.L >= 0.5) {
      L = 0.28 + (1 - c.L) * 0.5;
      C = Math.min(c.C, 0.05);
    } else {
      L = 0.5 + (0.5 - c.L) * 0.2;
    }
  } else {
    return rgb;
  }
  return oklchParaRgb({ L, C, h: c.h, a: c.a });
}

const PAPEL_POR_PROPRIEDADE: Record<string, Papel> = {
  background: 'fundo', 'background-color': 'fundo', 'background-image': 'fundo',
  '--tw-gradient-from': 'fundo', '--tw-gradient-via': 'fundo', '--tw-gradient-to': 'fundo',
  color: 'texto', '-webkit-text-fill-color': 'texto', 'caret-color': 'texto', 'text-decoration-color': 'texto', fill: 'texto', stroke: 'texto',
  border: 'borda', 'border-color': 'borda', 'border-top': 'borda', 'border-right': 'borda', 'border-bottom': 'borda', 'border-left': 'borda',
  'border-top-color': 'borda', 'border-right-color': 'borda', 'border-bottom-color': 'borda', 'border-left-color': 'borda',
  'border-inline': 'borda', 'border-inline-color': 'borda', 'border-block': 'borda', 'border-block-color': 'borda',
  'border-inline-start-color': 'borda', 'border-inline-end-color': 'borda', 'border-block-start-color': 'borda', 'border-block-end-color': 'borda',
  outline: 'borda', 'outline-color': 'borda', 'column-rule-color': 'borda', '--tw-ring-color': 'borda', '--tw-inset-ring-color': 'borda',
  'box-shadow': 'sombra', 'text-shadow': 'sombra', '--tw-shadow-color': 'sombra', '--tw-inset-shadow-color': 'sombra'
};

const RE_COR = /color-mix\(in (?:oklab|srgb),\s*([^,]+?)\s+(\d+(?:\.\d+)?)%,\s*transparent\)|var\((--color-[a-z0-9-]+)\)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|oklch\([^)]*\)|\b(?:white|black)\b/g;

function converterValor(valor: string, papel: Papel, tema: Map<string, string>): string {
  return valor.replace(RE_COR, (trecho, misturaCor, misturaPct, varNome) => {
    if (misturaCor) {
      const interno = misturaCor.trim();
      const base = lerCor(interno.startsWith('var(') ? tema.get(interno.slice(4, -1)) || '' : interno);
      if (!base) return trecho;
      const misturada = { ...base, a: base.a * (parseFloat(misturaPct) / 100) };
      const convertida = converter(misturada, papel);
      return convertida === misturada ? trecho : formatar(convertida);
    }
    const cor = lerCor(varNome ? tema.get(varNome) || '' : trecho);
    if (!cor) return trecho;
    const convertida = converter(cor, papel);
    return convertida === cor ? trecho : formatar(convertida); // sem mudança: mantém o valor original
  });
}

function prefixar(seletor: string): string {
  const s = seletor.trim();
  if (/^(html|:root)\b/.test(s)) return s.replace(/^(html|:root)/, '$1.dark');
  return `.dark ${s}`;
}

const dentroDeKeyframes = (rule: Rule) => {
  for (let p = rule.parent as AtRule | Root | undefined; p && p.type !== 'root'; p = p.parent as AtRule | Root | undefined) {
    if (p.type === 'atrule' && /keyframes$/i.test((p as AtRule).name)) return true;
  }
  return false;
};

// Cria, para cada regra com propriedades de cor, a cópia `.dark` logo após a original.
// Valores sem cor convertível (transparent, inherit...) são copiados como estão para
// manter a precedência entre regras.
function gerarRegrasEscuras(root: Root, tema: Map<string, string>, somenteCopias = false): Root {
  const saida = postcss.root();
  root.walkRules((rule) => {
    if (dentroDeKeyframes(rule) || rule.selector.includes('.dark')) return;
    const decls: { prop: string; value: string; important: boolean }[] = [];
    let mudou = false;
    rule.each((node) => {
      if (node.type !== 'decl') return;
      const papel = PAPEL_POR_PROPRIEDADE[node.prop.toLowerCase()];
      if (!papel) return;
      const novo = converterValor(node.value, papel, tema);
      if (novo !== node.value) mudou = true;
      decls.push({ prop: node.prop, value: novo, important: node.important });
    });
    if (!mudou) return;

    const copia = rule.clone({ selectors: rule.selectors.map(prefixar) });
    copia.removeAll();
    for (const d of decls) copia.append({ prop: d.prop, value: d.value, important: d.important });

    if (somenteCopias) {
      // Reconstrói os @media/@supports que envolvem a regra
      let alvo: Rule | AtRule = copia;
      for (let p = rule.parent; p && p.type === 'atrule'; p = p.parent) {
        const envolto = (p as AtRule).clone({ nodes: [] });
        envolto.append(alvo);
        alvo = envolto;
      }
      saida.append(alvo);
    } else {
      rule.after(copia);
    }
  });
  return saida;
}

function lerTema(root: Root): Map<string, string> {
  const tema = new Map<string, string>();
  root.walkDecls(/^--color-/, (d) => { if (!tema.has(d.prop)) tema.set(d.prop, d.value); });
  return tema;
}

// CSS dos blocos <style>{`...`}</style> dos componentes React
function cssDosComponentes(dirSrc: string): string {
  const partes: string[] = [];
  const atributos = new Set<string>();
  const varrer = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (/\.(tsx|jsx)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/<style>\{`([\s\S]*?)`\}<\/style>/g)) partes.push(m[1]);
        for (const m of src.matchAll(/\b(fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)) atributos.add(`${m[1]}|${m[2]}`);
      }
    }
  };
  varrer(dirSrc);
  // Cores de SVG definidas por atributo (gráficos)
  for (const a of atributos) {
    const [prop, cor] = a.split('|');
    partes.push(`[${prop}="${cor}"]{${prop}:${cor}}`);
  }
  return partes.join('\n');
}

export default function temaEscuro(): Plugin {
  return {
    name: 'captador-tema-escuro',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const extra = postcss.parse(cssDosComponentes(path.resolve(__dirname, '../src')));
      for (const arquivo of Object.values(bundle)) {
        if (arquivo.type !== 'asset' || !arquivo.fileName.endsWith('.css')) continue;
        const root = postcss.parse(String(arquivo.source));
        const tema = lerTema(root);
        gerarRegrasEscuras(root, tema);
        root.append(gerarRegrasEscuras(extra, tema, true).nodes);
        arquivo.source = root.toString();
      }
    }
  };
}
