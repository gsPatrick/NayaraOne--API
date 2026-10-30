'use strict';

// M9-D021 — normalização antes de casar os padrões do InjectionDetector (e as variantes `foldLeet` e `squash`, abaixo): largura total/compatibilidade (NFKC), caracteres
// invisíveis fora, caixa baixa, letras que imitam o alfabeto latino (cirílico e grego) trocadas pelas latinas, acento fora e
// espaços colapsados. Assim "ІGNÓRE  TÓDAS as régras" casa como "ignore todas as regras".

// Pontos de código invisíveis (hífen opcional, marcas de direção, largura zero, seletores de variação, BOM...) em faixas [de, até].
const FAIXAS_INVISIVEIS = Object.freeze([[0xAD, 0xAD], [0x34F, 0x34F], [0x61C, 0x61C], [0x115F, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180E],
  [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x206F], [0x3164, 0x3164], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF]]);
const invisivel = (c) => { const cp = c.codePointAt(0); return FAIXAS_INVISIVEIS.some(([a, b]) => cp >= a && cp <= b); };

const MARCAS_DE_ACENTO = new RegExp('[\\u0300-\\u036f]', 'g');

// Homóglifos (já em minúsculas) -> letra latina.
const HOMOGLIFOS = Object.freeze({
  'а': 'a', 'в': 'b', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'ё': 'e', 'һ': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'ӏ': 'l',
  'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v',
  'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  'ı': 'i', 'ɡ': 'g', 'ɑ': 'a',
});

function normalizeText(texto) {
  if (texto === null || texto === undefined) return '';
  let s = String(texto).replace(/-[ \t]*\r?\n[ \t]*/g, '').normalize('NFKC').toLowerCase();
  s = Array.from(s).filter((c) => !invisivel(c)).map((c) => HOMOGLIFOS[c] || c).join('');
  s = s.normalize('NFD').replace(MARCAS_DE_ACENTO, '');
  return s.replace(/\s+/g, ' ').trim();
}

// Leet comum -> letra (aplicado SÓ a uma variante do texto já normalizado, para "1gn0re t0das" casar como "ignore todas").
const LEET = Object.freeze({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'l' });

/** Troca os caracteres de leet por letras (o texto de entrada já passou por `normalizeText`). */
function foldLeet(normalizado) {
  return Array.from(String(normalizado || '')).map((c) => LEET[c] || c).join('');
}

/** Só letras e dígitos, sem espaço nem pontuação: "i g n o r e" e "i.g.n.o.r.e" ficam "ignore" (compara frases inteiras coladas). */
function squash(normalizado) {
  return String(normalizado || '').replace(/[^a-z0-9]/g, '');
}

module.exports = { normalizeText, foldLeet, squash };
