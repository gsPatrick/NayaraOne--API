'use strict';

/**
 * Parâmetro do ledger (Caderno M4 §7: `bank_account_id uuid NOT NULL` no movimento realizado). Nos fluxos do livro a conta vem
 * sempre: o pagamento confirmado pelo banco leva a conta da intenção (Guia §7, garantido por CHECK no banco) e o estorno leva a
 * conta do movimento original (Guia §8). A baixa manual (recebimento informado por quem recebeu, baixa com comprovante) não está no
 * fluxo do livro e o lançamento pode não ter conta: o administrador decide se ela passa a ser obrigatória (DI-M4LR-1). Padrão =
 * comportamento anterior (não obrigatória), aba "Financeiro" de Configurações.
 */
const KEYS = Object.freeze({ bankAccountRequired: 'finance.ledger.conta_bancaria_obrigatoria_na_baixa' });

const LEDGER_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.bankAccountRequired]: { type: 'boolean', label: 'Exigir a conta bancária em toda baixa (ledger)' },
});

const LEDGER_SETTINGS_DEFAULTS = Object.freeze({ [KEYS.bankAccountRequired]: false });

async function readBankAccountRequired(tenant, transaction) {
  const { getSetting } = require('../../../../features/settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  if (!tenant || !tenant.companyId) return LEDGER_SETTINGS_DEFAULTS[KEYS.bankAccountRequired];
  const value = await getSetting(KEYS.bankAccountRequired, tenant, transaction, LEDGER_SETTINGS_DEFAULTS[KEYS.bankAccountRequired]);
  return value === true || value === 'true';
}

module.exports = { KEYS, LEDGER_SETTINGS_SCHEMA, LEDGER_SETTINGS_DEFAULTS, readBankAccountRequired };
