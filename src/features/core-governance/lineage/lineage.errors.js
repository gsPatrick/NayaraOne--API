'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros do registro de lineage (M9-D810 §4). Códigos novos levam GOV_; mensagens em português, as do livro/da demanda. */
const layerInvalid = () => govError(422, 'GOV_LINEAGE_LAYER_INVALID', 'Esta ligação não respeita a ordem das camadas.');
const ownerRequired = () => govError(422, 'GOV_LINEAGE_OWNER_REQUIRED', 'Informe o domínio responsável pelo nó.');
const descriptionRequired = () => govError(422, 'GOV_LINEAGE_DESCRIPTION_REQUIRED', 'Descreva o nó de lineage.');
const areaRequired = () => govError(422, 'GOV_LINEAGE_AREA_REQUIRED', 'Informe a área do nó de lineage.');
const criticalityLocked = () => govError(409, 'GOV_LINEAGE_CRITICALITY_LOCKED', 'Esta área exige lineage crítico.');
const nodeNotFound = () => govNotFound('Nó de lineage não encontrado.');
const nodeExists = () => govError(409, 'GOV_LINEAGE_NODE_EXISTS', 'Já existe um nó de lineage com este tipo e código.');
const edgeExists = () => govError(409, 'GOV_LINEAGE_EDGE_EXISTS', 'Esta ligação de lineage já existe.');
const nodeTypeInvalid = () => govError(400, 'GOV_LINEAGE_NODE_TYPE_INVALID', 'Tipo de nó de lineage inválido.');
const areaInvalid = () => govError(400, 'GOV_LINEAGE_AREA_INVALID', 'Área de lineage inválida.');
const criticalityInvalid = () => govError(400, 'GOV_LINEAGE_CRITICALITY_INVALID', 'Criticidade de lineage inválida.');
const codeInvalid = () => govError(400, 'GOV_LINEAGE_CODE_INVALID', 'Informe o código do nó (letras, números, ponto, dois-pontos, barra, hífen e sublinhado; até 200 caracteres).');
const domainInvalid = () => govError(400, 'GOV_DOMAIN_INVALID', 'Domínio de dados inválido.');
const seedConflict = (details) => govError(500, 'GOV_LINEAGE_SEED_CONFLICT', 'Duas sementes de lineage definem o mesmo nó de formas diferentes.', details);
const seedInvalid = (details) => govError(500, 'GOV_LINEAGE_SEED_INVALID', 'Semente de lineage inválida.', details);

module.exports = {
  layerInvalid, ownerRequired, descriptionRequired, areaRequired, criticalityLocked, nodeNotFound, nodeExists, edgeExists, nodeTypeInvalid, areaInvalid,
  criticalityInvalid, codeInvalid, domainInvalid, seedConflict, seedInvalid,
};
