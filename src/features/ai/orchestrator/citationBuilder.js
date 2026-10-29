'use strict';

// Monta as fontes citadas (com versão, vigência e classificação), o carimbo do dado em America/Sao_Paulo e o bloco de divergência.

const C = require('./grounding/grounding.constants');

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** "27/10/2026 14:05" no fuso de São Paulo (o carimbo do dado, não o da resposta). */
function formatSnapshot(date) {
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: C.FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Fonte de saída: o que a pessoa vê (nunca o objeto interno inteiro). `ref` é o número do marcador [n]. */
function citationOf(source, ref) {
  return {
    ref,
    type: source.sourceType || null,
    title: source.title || null,
    version: source.version || null,
    validity: { from: iso(source.effectiveFrom), until: iso(source.effectiveUntil) },
    classification: source.classification || null,
    clause: source.clause || null,
    excerpt: source.excerpt || null,
    retrievedAt: iso(source.retrievedAt),
  };
}

/** Carimbo do dado: o informado pelo read model; senão a leitura mais recente entre as fontes citadas. */
function resolveSnapshot(snapshotAt, cited) {
  if (snapshotAt) return new Date(snapshotAt);
  const times = cited.map((s) => (s.retrievedAt ? new Date(s.retrievedAt).getTime() : null)).filter((t) => t !== null);
  return times.length ? new Date(Math.max(...times)) : null;
}

/** Bloco de divergência (D024 entrega a detecção; aqui só a apresentação): cada versão com vigência e valor. */
function buildConflictBlock(conflicts) {
  const linhas = [C.MENSAGEM_DIVERGENCIA];
  for (const c of conflicts) {
    linhas.push(`- ${c.label || 'Ponto divergente'}:`);
    for (const v of c.versions || []) {
      const vig = v.effectiveFrom ? ` (vigente desde ${formatSnapshot(v.effectiveFrom).slice(0, 10)})` : '';
      linhas.push(`  * ${v.title ? `${v.title}, ` : ''}versão ${v.version || '?'}${vig}: ${v.value}${v.ref ? ` [${v.ref}]` : ''}`);
    }
  }
  return linhas.join('\n');
}

module.exports = { citationOf, formatSnapshot, resolveSnapshot, buildConflictBlock };
