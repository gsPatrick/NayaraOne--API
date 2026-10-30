'use strict';

// M9-D021 — frases-gatilho do InjectionDetector: lista padrão versionada (injectionPhrases.json) mais as frases que o administrador acrescenta
// (`ia.injecao.frases_extra`) menos os grupos que ele desliga (`ia.injecao.frases_desativadas`). Cada frase é casada por inclusão no texto
// COLADO (textNormalizer.squash), então letras espaçadas, pontuação no meio, leet, espanhol, francês e paráfrases curtas não escapam.

const { normalizeText, squash } = require('./textNormalizer');
const lista = require('./injectionPhrases.json');

const PHRASE_LIST_VERSION = lista.version;
/** Frase colada com menos letras que isto casaria por acaso no meio de um texto comum: é ignorada. */
const MIN_SQUASHED_LENGTH = 8;
const EXTRA_GROUP_ID = 'FRASE_EXTRA_ADMIN';
const EXTRA_MAX_LINES = 200;
const DEFAULT_EXTRA_WEIGHT = 100;

const compile = (phrases) => phrases.map((f) => squash(normalizeText(f))).filter((f) => f.length >= MIN_SQUASHED_LENGTH);

const GRUPOS_PADRAO = Object.freeze(lista.groups.map((g) => Object.freeze({ id: g.id, weight: g.weight, phrases: Object.freeze(compile(g.phrases)) })));
const IDS_PADRAO = Object.freeze(GRUPOS_PADRAO.map((g) => g.id));

/** Itens do parâmetro de frases extras, separados por linha ou ponto e vírgula: "frase" (bloqueia) ou "peso|frase" (peso de 1 a 100); vazio ou iniciado por # é ignorado. */
function parseExtraPhrases(raw) {
  const linhas = String(raw || '').split(/[\r\n;]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, EXTRA_MAX_LINES);
  const porPeso = new Map();
  for (const linha of linhas) {
    const m = /^(\d{1,3})\s*\|\s*(.+)$/.exec(linha);
    const peso = m ? Math.min(100, Math.max(1, Number(m[1]))) : DEFAULT_EXTRA_WEIGHT;
    const colada = compile([m ? m[2] : linha])[0];
    if (colada) porPeso.set(peso, [...(porPeso.get(peso) || []), colada]);
  }
  return [...porPeso.entries()].map(([weight, phrases]) => ({ id: `${EXTRA_GROUP_ID}_${weight}`, weight, phrases }));
}

/** Ids de grupos padrão desligados pelo administrador (lista separada por vírgula; id desconhecido é ignorado). */
function parseDisabledGroups(raw) {
  const pedidos = String(raw || '').split(/[,\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return pedidos.filter((id) => IDS_PADRAO.includes(id));
}

/** Grupos valendo para a empresa: padrão (menos os desligados) e extras. */
function activeGroups({ extraPhrases = [], disabledGroups = [] } = {}) {
  return [...GRUPOS_PADRAO.filter((g) => !disabledGroups.includes(g.id)), ...extraPhrases];
}

/** Grupos que casam alguma das variantes coladas do texto: [{ id, weight }]. */
function matchPhrases(squashedVariants, limits) {
  return activeGroups(limits || {}).filter((g) => g.phrases.some((f) => squashedVariants.some((v) => v.includes(f)))).map((g) => ({ id: g.id, weight: g.weight }));
}

module.exports = { matchPhrases, parseExtraPhrases, parseDisabledGroups, PHRASE_LIST_VERSION, IDS_PADRAO };
