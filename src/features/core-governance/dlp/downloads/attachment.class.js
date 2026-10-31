'use strict';

const scale = require('../../../../shared/data-classification/scale');
const { govError } = require('../../governance.errors');
const { readDownloadParams } = require('./download.params');

const MANAGE_PERMISSION = 'governance:classification:manage';

/**
 * Classe de um anexo novo (M9-D920 §3.2): a MAIOR classe entre as colunas da tabela do registro de classificação a que a categoria do upload se liga (parâmetro
 * `governanca.dlp.anexos.categoria_entidade`); anexo avulso (categoria sem tabela) recebe a classe padrão `governanca.dlp.classificacao_padrao` (HIGH). require tardio: o
 * módulo de arquivos é carregado antes do registro de classificação.
 */
async function resolveUploadClass({ tenant, category, transaction }) {
  const classification = require('../../data-quality/classification.service'); // eslint-disable-line global-require
  const params = await readDownloadParams(tenant, transaction);
  const table = params.entityMap[category];
  if (!table) return classification.defaultClass(tenant, transaction);
  // o registro da empresa é semeado sob demanda: sem isto a classe dependeria de alguém ter aberto a tela de classificação antes do upload
  await classification.ensureRegistry(tenant, transaction);
  return classification.classOfResource(tenant, { type: table }, transaction);
}

const invalid = () => govError(400, 'GOV_FILE_CLASSIFICATION_INVALID', 'Classificação inválida. Use LOW, MEDIUM, HIGH ou RESTRICTED.');
const forbidden = () => govError(403, 'GOV_FILE_CLASSIFICATION_FORBIDDEN', 'Você não tem permissão para definir a classificação do arquivo.');

/** Valor explícito de classificação (escala nova; a antiga PUBLIC/INTERNAL/CONFIDENTIAL é aceita e convertida): só quem tem `governance:classification:manage` define; outro valor é 400. */
function checkExplicitClass(value, permissions) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !scale.isKnown(value)) throw invalid();
  if (!(permissions || []).includes(MANAGE_PERMISSION)) throw forbidden();
  return scale.normalize(value);
}

module.exports = { resolveUploadClass, checkExplicitClass, MANAGE_PERMISSION };
