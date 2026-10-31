'use strict';

const { govError, govNotFound } = require('../../core-governance/governance.errors');

/** Erros do ensaio DRY3 e da validação de volume e fuso (M9-D908 §4). */
module.exports = {
  sharedDatabase: () => govError(409, 'GOV_MIG_DRY_SHARED_DB', 'O ensaio só roda em banco descartável; este é um banco compartilhado.'),
  running: (details) => govError(409, 'GOV_MIG_DRY_RUNNING', 'Já existe um ensaio DRY3 em andamento nesta empresa.', details),
  notFound: () => govNotFound('Relatório do ensaio não encontrado.'),
  volumeMismatch: (details) => govError(409, 'GOV_MIG_VOLUME_MISMATCH', 'O volume migrado não confere com a origem.', details),
};
