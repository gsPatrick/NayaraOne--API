'use strict';

const { priceToScaled } = require('./providers.cost');

/** Catálogo de modelos de um adapter (M9-D010): o que cada modelo faz, quanto custa e que garantias dá. `cheaperAlternative` (opcional, M9-D863): código de outro modelo do mesmo provedor, mais barato, para a degradação por custo. */
const CLASSES = Object.freeze(['SMALL', 'ADVANCED', 'EMBEDDING']);
const RETENTIONS = Object.freeze(['NONE', '30D', 'PROVIDER_DEFAULT']);
const OPERATION_FLAG = Object.freeze({ generate: 'generate', embed: 'embed', transcribe: 'transcribe', analyzeImage: 'vision' });
const BOOLEANS = ['generate', 'embed', 'transcribe', 'vision', 'structuredOutput', 'toolUse'];
const POSITIVE_INTS = ['maxInputTokens', 'maxOutputTokens', 'p95LatencyMs'];

/** Problemas de uma linha do catálogo (lista vazia = válida). */
function modelProblems(m) {
  const p = [];
  if (!m || typeof m !== 'object') return ['modelo inválido'];
  if (typeof m.model !== 'string' || !m.model.trim()) p.push('model');
  if (!CLASSES.includes(m.classe)) p.push('classe');
  BOOLEANS.forEach((k) => { if (typeof m[k] !== 'boolean') p.push(k); });
  POSITIVE_INTS.forEach((k) => { if (!Number.isInteger(m[k]) || m[k] < 0) p.push(k); });
  if (!RETENTIONS.includes(m.dataRetention)) p.push('dataRetention');
  if (typeof m.region !== 'string' || !m.region.trim()) p.push('region');
  if (priceToScaled(m.pricePerMTokIn) === null) p.push('pricePerMTokIn');
  if (priceToScaled(m.pricePerMTokOut) === null) p.push('pricePerMTokOut');
  if (![1, 2, 3].includes(m.safetyTier)) p.push('safetyTier');
  if (m.cheaperAlternative !== undefined && m.cheaperAlternative !== null && (typeof m.cheaperAlternative !== 'string' || !m.cheaperAlternative.trim() || m.cheaperAlternative === m.model)) p.push('cheaperAlternative'); // M9-D863: modelo mais barato (do mesmo provedor) que o roteador usa no passo SWITCH_AI_MODEL_CHEAPER
  return p;
}

/** O modelo faz a capacidade pedida (generate, embed, transcribe, analyzeImage)? */
const modelSupports = (m, capability) => Boolean(OPERATION_FLAG[capability] && m[OPERATION_FLAG[capability]] === true);

module.exports = { CLASSES, RETENTIONS, OPERATION_FLAG, modelProblems, modelSupports };
