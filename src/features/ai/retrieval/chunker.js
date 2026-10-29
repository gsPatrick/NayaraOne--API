'use strict';

/**
 * Chunker (M9-D023): divide o texto em blocos de ~`chunkTokens` com sobreposição `chunkOverlap`, respeitando títulos. Token = palavra
 * separada por espaço (aproximação estável, sem depender do fornecedor). Um título abre uma seção; o bloco nunca atravessa uma seção e
 * cada pedaço de uma seção longa repete o título. Seção só com título não vira chunk. Os metadados do livro são copiados da fonte por
 * quem grava (chunks.write); aqui só se parte o texto.
 */
const TITLE_MAX_CHARS = 80;
const TITLE_MAX_TOKENS = 30;
const SECTION_WORD = /^(?:cl[áa]usula|cap[íi]tulo|se[çc][ãa]o|artigo|art\.|t[íi]tulo|anexo)\s+[\dIVXLC]+/i;

const tokensOf = (text) => text.match(/\S+\s*/g) || [];

/** Linha de título: markdown `#`, linha curta em MAIÚSCULAS ou "Cláusula/Capítulo/Seção/Artigo N". */
function isTitle(line) {
  const t = line.trim();
  if (!t || t.length > TITLE_MAX_CHARS) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (SECTION_WORD.test(t)) return true;
  return /\p{Lu}{3}/u.test(t) && t === t.toUpperCase() && !/[.:;,]$/.test(t) && /\p{L}/u.test(t);
}

function splitSections(text) {
  const sections = [];
  let atual = { title: '', lines: [] };
  for (const line of String(text || '').split('\n')) {
    if (isTitle(line)) {
      sections.push(atual);
      atual = { title: line.replace(/^#{1,6}\s+/, '').trim(), lines: [] };
    } else atual.lines.push(line);
  }
  sections.push(atual);
  return sections.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() })).filter((s) => s.body);
}

function windows(tokens, size, overlap) {
  const passo = Math.max(1, size - overlap);
  const out = [];
  for (let start = 0; start < tokens.length; start += passo) {
    const end = Math.min(tokens.length, start + size);
    out.push(tokens.slice(start, end));
    if (end === tokens.length) break;
  }
  return out;
}

/** chunkText(texto, { chunkTokens, chunkOverlap }) => [{ index, text, tokens }] */
function chunkText(text, { chunkTokens, chunkOverlap }) {
  const chunks = [];
  for (const section of splitSections(text)) {
    const titleTokens = tokensOf(section.title).slice(0, TITLE_MAX_TOKENS);
    const title = titleTokens.join('').trim();
    const bodySize = Math.max(1, chunkTokens - titleTokens.length);
    for (const janela of windows(tokensOf(section.body), bodySize, Math.min(chunkOverlap, bodySize - 1))) {
      const corpo = janela.join('').trim();
      if (!corpo) continue;
      chunks.push({ index: chunks.length, text: title ? `${title}\n${corpo}` : corpo, tokens: titleTokens.length + janela.length });
    }
  }
  return chunks;
}

module.exports = { chunkText, isTitle, tokensOf };
