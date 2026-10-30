'use strict';

// M9-D021 — InjectionDetector: regras determinísticas sobre o texto normalizado. Duas listas versionadas: os padrões (regex) de
// security/injectionPatterns.json e as frases-gatilho de security/injectionPhrases.json, que o administrador amplia ou desliga.
// A entrada é conferida em variantes: normal, com leet desfeito, colada (letras espaçadas) e o que estiver escondido em base64.
// score = min(1,00; maior peso + 0,10 x (padrões distintos - 1)), em centésimos inteiros (soma exata, sem ponto flutuante).
// score >= limiar de bloqueio => QUARANTINE (trecho removido); entre alerta e bloqueio => SUSPICIOUS (mantido e rotulado).

const crypto = require('node:crypto');
const { getSetting } = require('../../../features/settings/settings.service');
const { maskSecrets } = require('../guards/secretPatterns');
const { normalizeText, foldLeet, squash } = require('../security/textNormalizer');
const { decodedSegments } = require('../security/encodedText');
const { matchPhrases, parseExtraPhrases, parseDisabledGroups, PHRASE_LIST_VERSION } = require('../security/injectionPhrases');
const { INJECTION_SETTING_DEFAULTS } = require('../security/injection.settings');
const lista = require('../security/injectionPatterns.json');

const PATTERN_LIST_VERSION = lista.version;
const EXCERPT_MAX = 120;
const BONUS_POR_PADRAO_ADICIONAL = 10;
const PADROES = Object.freeze(lista.patterns.map((p) => Object.freeze({ id: p.id, weight: p.weight, soloOnly: p.soloOnly === true, re: new RegExp(p.regex) })));

const KEY_BLOCK = 'ia.injecao.limiar_bloqueio';
const KEY_ALERT = 'ia.injecao.limiar_alerta';
const KEY_DERIVED = 'ia.injecao.derivado_min_caracteres';
const KEY_EXTRA = 'ia.injecao.frases_extra';
const KEY_DISABLED = 'ia.injecao.frases_desativadas';

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** Variantes do texto para casar: normal, leet desfeito e o que estiver dentro de base64 (cada uma também com leet desfeito). */
function variantsOf(original) {
  const textos = [original, ...decodedSegments(original)].map(normalizeText);
  return [...new Set(textos.flatMap((t) => [t, foldLeet(t)]))];
}

/** Padrões (regex) e frases que casam alguma variante; o padrão isolado só conta se for o único que casou. */
function padroesQueCasam(variantes, limits) {
  const achados = PADROES.filter((p) => variantes.some((v) => p.re.test(v)));
  const fortes = achados.filter((p) => !p.soloOnly);
  const regex = (fortes.length ? fortes : achados).map((p) => ({ id: p.id, weight: p.weight }));
  // A frase é rede de segurança do que a regex não pegou: se um padrão de peso igual ou maior já casou, a frase não conta de novo.
  const maiorRegex = regex.reduce((m, p) => Math.max(m, p.weight), 0);
  return [...regex, ...matchPhrases(variantes.map(squash), limits).filter((f) => f.weight > maiorRegex)];
}

/** { alertCents, blockCents, extraPhrases?, disabledGroups? } (centésimos inteiros). Sem padrão casado a ação é sempre ALLOW. */
function detectInjection(texto, limits) {
  const original = texto === null || texto === undefined ? '' : String(texto);
  const casados = padroesQueCasam(variantsOf(original), limits);
  const maior = casados.reduce((m, p) => Math.max(m, p.weight), 0);
  const scoreCents = casados.length ? Math.min(100, maior + BONUS_POR_PADRAO_ADICIONAL * (casados.length - 1)) : 0;
  let action = 'ALLOW';
  if (casados.length && scoreCents >= limits.blockCents) action = 'QUARANTINE';
  else if (casados.length && scoreCents >= limits.alertCents) action = 'SUSPICIOUS';
  return {
    scoreCents, score: scoreCents / 100, patternIds: casados.map((p) => p.id), action,
    contentHash: hash(original), excerpt: maskSecrets(original).slice(0, EXCERPT_MAX),
  };
}

const centesimos = (valor, padrao) => {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 100) : Math.round(padrao * 100);
};

/** Limiares, mínimo de caracteres e lista de frases (extras e desligadas) da empresa. Chamar com a transação do tenant (RLS); alerta nunca passa do bloqueio. */
async function loadInjectionLimits(tenant, transaction) {
  const D = INJECTION_SETTING_DEFAULTS;
  const blockCents = centesimos(await getSetting(KEY_BLOCK, tenant, transaction, D[KEY_BLOCK]), D[KEY_BLOCK]);
  const alertCents = Math.min(centesimos(await getSetting(KEY_ALERT, tenant, transaction, D[KEY_ALERT]), D[KEY_ALERT]), blockCents);
  const min = Number(await getSetting(KEY_DERIVED, tenant, transaction, D[KEY_DERIVED]));
  const extraPhrases = parseExtraPhrases(await getSetting(KEY_EXTRA, tenant, transaction, D[KEY_EXTRA]));
  const disabledGroups = parseDisabledGroups(await getSetting(KEY_DISABLED, tenant, transaction, D[KEY_DISABLED]));
  return { alertCents, blockCents, derivedMinChars: Number.isInteger(min) && min >= 1 ? min : D[KEY_DERIVED], extraPhrases, disabledGroups };
}

module.exports = { detectInjection, loadInjectionLimits, PATTERN_LIST_VERSION, PHRASE_LIST_VERSION, EXCERPT_MAX };
