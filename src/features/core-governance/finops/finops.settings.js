'use strict';

const { toScaled } = require('./money');
const { ENVIRONMENTS } = require('./finops.constants');
const { DETECTOR_SETTING_DEFAULTS, DETECTOR_SETTINGS_SCHEMA } = require('./detectors/detectors.settings');

/**
 * Parâmetros do FinOps (M9-D860; aba Governança em /painel/configuracoes; catálogo em Maturacao/demandas/parametros.csv).
 *  - governanca.finops.moeda: moeda do ledger (BRL; é a única do livro).
 *  - governanca.finops.ambiente: ambiente (PROD, HOMOLOG, DEV) a que esta instalação atribui os custos que coleta.
 *  - governanca.finops.precos: JSON `{serviço: preço em centavos por unidade}`. Chaves: whatsapp, email, sms (por mensagem), storage_gb_mes, logs_gb_mes, egress_gb (por GB).
 *  - governanca.finops.gb_base: bytes de 1 GB (1024 = GiB, o padrão da nuvem; 1000 = GB decimal).
 *  - governanca.finops.storage_hora: hora (Brasília) em que o job diário mede o armazenamento.
 *  - governanca.finops.janela_dias: dias de histórico que a consulta de saúde (GET /finops/health) mostra.
 */
const KEYS = Object.freeze({
  currency: 'governanca.finops.moeda',
  environment: 'governanca.finops.ambiente',
  prices: 'governanca.finops.precos',
  gbBase: 'governanca.finops.gb_base',
  storageHour: 'governanca.finops.storage_hora',
  windowDays: 'governanca.finops.janela_dias',
});

const DEFAULT_PRICES = '{"whatsapp":5,"email":0,"sms":0,"storage_gb_mes":10,"logs_gb_mes":10,"egress_gb":50}';

const FINOPS_SETTING_DEFAULTS = Object.freeze({
  [KEYS.currency]: 'BRL', [KEYS.environment]: 'PROD', [KEYS.prices]: DEFAULT_PRICES, [KEYS.gbBase]: 1024, [KEYS.storageHour]: 2, [KEYS.windowDays]: 30,
  ...DETECTOR_SETTING_DEFAULTS, // M9-D862: limiares e horários dos detectores de desperdício (detectors/detectors.settings.js)
});

/** Texto JSON -> { chave: BigInt na escala 1e6 }; null se não for objeto com preços decimais não negativos. */
function parsePrices(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [name, price] of Object.entries(obj)) {
    const scaled = toScaled(price);
    if (scaled === null || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) return null;
    out[name] = scaled;
  }
  return out;
}

function validatePrices(key, value) {
  const { govError } = require('../governance.errors');
  if (!parsePrices(value)) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser um JSON com o preço em centavos de cada serviço, por exemplo {"whatsapp": 5, "egress_gb": 50}.`, { key });
}

function validateGbBase(key, value) {
  const { govError } = require('../governance.errors');
  if (![1000, 1024].includes(Number(value))) throw govError(400, 'VALIDATION_ERROR', `O valor de "${key}" deve ser 1000 ou 1024.`, { key });
}

const FINOPS_SETTINGS_SCHEMA = {
  [KEYS.currency]: { type: 'string', enum: ['BRL'] },
  [KEYS.environment]: { type: 'string', enum: [...ENVIRONMENTS] },
  [KEYS.prices]: { type: 'string', validate: validatePrices },
  [KEYS.gbBase]: { type: 'integer', min: 1000, max: 1024, validate: validateGbBase },
  [KEYS.storageHour]: { type: 'integer', min: 0, max: 23 },
  [KEYS.windowDays]: { type: 'integer', min: 1, max: 365 },
  ...DETECTOR_SETTINGS_SCHEMA,
};

module.exports = { KEYS, FINOPS_SETTING_DEFAULTS, FINOPS_SETTINGS_SCHEMA, DEFAULT_PRICES, parsePrices };
