'use strict';

const fs = require('fs');
const path = require('path');
const AppError = require('../../../utils/AppError');

/**
 * Runbook obrigatório por fornecedor (M9-D223 regra 3.2, INT-011): `docs/runbooks/integrations/<provider>.md` no repositório da
 * API, com as 7 seções fixas, cada uma preenchida. O teste `runbooks_existem_para_todos_os_providers` reprova o CI se um
 * fornecedor ativo do catálogo não tiver runbook completo (INTEGRATION_RUNBOOK_MISSING).
 */
const RUNBOOK_SECTIONS = Object.freeze([
  'O que é e criticidade',
  'Sintomas e alertas',
  'Diagnóstico passo a passo',
  'Contingência',
  'Como rotacionar credencial',
  'Quem acionar',
  'Como validar a recuperação',
]);
const RUNBOOK_DIR = 'docs/runbooks/integrations';
const API_ROOT = path.join(__dirname, '..', '..', '..', '..');
/** Seção com menos palavras que isto, ou só um marcador (TODO, TBD, ...), conta como vazia. */
const MIN_WORDS = 5;
const PLACEHOLDER = /^(todo|tbd|a definir|a preencher|n\/a|\.\.\.|-)*$/i;

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Caminho do runbook (relativo à raiz da API), como o endpoint de saúde devolve. */
const runbookPathFor = (providerCode) => `${RUNBOOK_DIR}/${providerCode}.md`;

/** Quebra o texto em seções `## n. Título` (a numeração é opcional). */
function splitSections(text) {
  const partes = [];
  String(text).split('\n').forEach((linha) => {
    const m = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(linha);
    if (m) partes.push({ title: m[1], body: [] });
    else if (partes.length) partes[partes.length - 1].body.push(linha);
  });
  return partes.map((p) => ({ title: p.title, body: p.body.join('\n').trim() }));
}

/** Lista de problemas do runbook (vazia = completo): seção ausente ou sem conteúdo de verdade. */
function validateRunbook(text) {
  const secoes = splitSections(text);
  return RUNBOOK_SECTIONS.flatMap((nome) => {
    const achada = secoes.find((s) => norm(s.title).startsWith(norm(nome)));
    if (!achada) return [`seção ausente: ${nome}`];
    const palavras = achada.body.split(/\s+/).filter(Boolean);
    if (palavras.length < MIN_WORDS || PLACEHOLDER.test(achada.body.replace(/\s+/g, ''))) return [`seção sem conteúdo: ${nome}`];
    return [];
  });
}

/** Garante o runbook completo do fornecedor ou lança INTEGRATION_RUNBOOK_MISSING. Devolve o caminho. */
function assertRunbook(providerCode, { root = API_ROOT } = {}) {
  const relativo = runbookPathFor(providerCode);
  let problemas = [`arquivo ausente: ${relativo}`];
  try {
    problemas = validateRunbook(fs.readFileSync(path.join(root, relativo), 'utf8'));
  } catch (err) { /* arquivo ausente: o problema já está na lista */ }
  if (problemas.length) throw AppError.internal('Fornecedor ativo sem runbook completo.', 'INTEGRATION_RUNBOOK_MISSING', { providerCode, problemas });
  return relativo;
}

module.exports = { RUNBOOK_SECTIONS, runbookPathFor, validateRunbook, assertRunbook, splitSections };
