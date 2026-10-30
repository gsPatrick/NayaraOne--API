'use strict';

/**
 * Escala única de classificação de dados do projeto (M9-D910 §3.2.5): LOW < MEDIUM < HIGH < RESTRICTED (a do livro e da política de DLP, M9-D820). Código antigo
 * grava PUBLIC, INTERNAL, CONFIDENTIAL e RESTRICTED; o mapeamento é obrigatório e reversível. Valor desconhecido vira HIGH (o mais protetor entre os que ainda deixam
 * o dado ser lido por quem tem a permissão) e quem converte registra o caso na lista de revisão. Transversal: usado pelos modelos que gravam `classification`.
 */
const SCALE = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED']);
const LEGACY_TO_SCALE = Object.freeze({ PUBLIC: 'LOW', INTERNAL: 'MEDIUM', CONFIDENTIAL: 'HIGH', RESTRICTED: 'RESTRICTED' });
const SCALE_TO_LEGACY = Object.freeze({ LOW: 'PUBLIC', MEDIUM: 'INTERNAL', HIGH: 'CONFIDENTIAL', RESTRICTED: 'RESTRICTED' });
const UNKNOWN_FALLBACK = 'HIGH';

const clean = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** Valor da escala nova; aceita a antiga e a nova; null continua null; desconhecido vira HIGH. */
function normalize(value) {
  if (value === null || value === undefined) return value;
  const key = clean(value);
  if (SCALE.includes(key)) return key;
  return LEGACY_TO_SCALE[key] || UNKNOWN_FALLBACK;
}

/** O valor antigo correspondente (reverso do mapeamento); valor fora da escala volta como veio. */
function toLegacy(value) {
  if (value === null || value === undefined) return value;
  return SCALE_TO_LEGACY[clean(value)] || value;
}

const isKnown = (value) => SCALE.includes(clean(value)) || Object.prototype.hasOwnProperty.call(LEGACY_TO_SCALE, clean(value));
const rank = (value) => SCALE.indexOf(normalize(value));
const highest = (values) => values.filter(Boolean).map(normalize).sort((a, b) => rank(b) - rank(a))[0] || null;

/** Opções de atributo Sequelize para uma coluna `classification`: grava sempre na escala nova e valida contra ela; `legacyView` faz o código antigo ainda ler PUBLIC/INTERNAL/... */
function attributeOptions({ legacyView = false } = {}) {
  return {
    set(value) { this.setDataValue('classification', normalize(value)); },
    ...(legacyView ? { get() { return toLegacy(this.getDataValue('classification')); } } : {}),
    validate: { isIn: { args: [SCALE], msg: 'A classificação deve ser LOW, MEDIUM, HIGH ou RESTRICTED.' } },
  };
}

module.exports = { SCALE, LEGACY_TO_SCALE, SCALE_TO_LEGACY, UNKNOWN_FALLBACK, normalize, toLegacy, isKnown, rank, highest, attributeOptions };
