'use strict';

// Divide a resposta em frases mantendo o marcador [n] na frase que ele fecha (um marcador solto depois do ponto volta para a anterior).

const MARKER = /\[(\d+)\]/g;

function splitSentences(text) {
  const parts = String(text || '').split(/(?<=[.!?])\s+(?=\S)|\n+/).map((p) => p.trim()).filter(Boolean);
  const merged = [];
  for (const part of parts) {
    if (merged.length && /^(\[\d+\][\s,.;]*)+$/.test(part)) merged[merged.length - 1] += ` ${part}`;
    else merged.push(part);
  }
  return merged;
}

const markersOf = (sentence) => [...String(sentence).matchAll(MARKER)].map((m) => Number(m[1]));

module.exports = { splitSentences, markersOf };
