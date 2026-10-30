'use strict';

const AppError = require('../../utils/AppError');
const { blockedMessage } = require('./impact.shape');

/** Erros da confirmação (M9-D852 §4). Todos com prefixo GOV_ e cadastrados em errorCatalog.data.json. */
const required = (level, missing) =>
  new AppError(
    level >= 3 ? 'Confirme a ação digitando o código do registro.' : 'Confirme que você entendeu o impacto da ação.',
    422,
    'GOV_CONFIRMATION_REQUIRED',
    { level, missing }
  );

const blocked = (impact) => new AppError(blockedMessage(impact), 409, 'GOV_ACTION_BLOCKED', { blockers: impact.blockers });

const impactChanged = (reason) => new AppError('O impacto mudou. Revise e confirme novamente.', 409, 'GOV_ACTION_IMPACT_CHANGED', { reason });

module.exports = { required, blocked, impactChanged };
