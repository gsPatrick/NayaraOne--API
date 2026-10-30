'use strict';

const { isUuid } = require('../../finops/budgets/budget.input');
const E = require('../flags.errors');
const repo = require('../flags.repository');
const { ACTIONS } = require('./killSwitch.constants');

/** Resolve a referência (id ou chave) para um único kill switch da empresa; `null` se não existir, não for kill switch ou a chave estiver em mais de um escopo. */
async function locateSwitch(tenant, ref, transaction) {
  if (typeof ref !== 'string' || !ref) return null;
  const rows = isUuid(ref) ? [await repo.findById(tenant, 'FLAG', ref, transaction)].filter(Boolean) : (await repo.findByKey(tenant, ref, transaction)).filter((r) => r.kind === 'FLAG');
  return rows.length === 1 && rows[0].is_kill_switch ? rows[0] : null;
}

/** O que o PATCH pede para o valor do switch: `true` aciona, `false` restaura, qualquer outra coisa não é transição. */
const wantedValue = (body) => (body && typeof body.value === 'boolean' ? body.value : null);

/**
 * Provedor de impacto das linhas 14 do inventário (M9-D852): acionar (nível 2, sem MFA) e restaurar (nível 3, com MFA e a chave digitada). Na ação (`!preview`) só pede confirmação
 * quando o PATCH é de fato a transição (acionar um switch desligado ou restaurar um acionado): qualquer outra alteração de flag segue sem guarda. O impacto é o que fica pausado.
 */
const provider = (action) => async ({ id, body, tenant, transaction, preview }) => {
  const flag = await locateSwitch(tenant, id, transaction);
  if (!flag) {
    if (preview) throw E.notFound();
    return { skip: true };
  }
  const triggered = flag.value === true;
  const wanted = wantedValue(body);
  if (!preview && !(action === ACTIONS.activate ? wanted === true && !triggered : wanted === false && triggered)) return { skip: true };
  const blockers = action === ACTIONS.restore && !triggered ? ['Este kill switch não está acionado.'] : [];
  return {
    code: flag.key,
    label: flag.description || flag.key,
    impact: {
      counts: { switches: 1, alreadyTriggered: triggered ? 1 : 0, unverified: flag.verification_state === 'UNVERIFIED' ? 1 : 0 },
      totalAmountCents: 0,
      blockers,
      items: [{ type: 'KILL_SWITCH', key: flag.key, label: flag.description || flag.key, scope: flag.scope, effect: action === ACTIONS.activate ? 'a função ligada a este switch para de funcionar' : 'a função ligada a este switch volta a funcionar' }],
    },
  };
};

/** O que o cliente enviou para identificar o switch: `id` ou `key` (a mesma identificação da simulação vale na ação, porque o impactToken é preso a ela). */
const resourceIdOf = (req) => {
  const b = (req && req.body) || {};
  if (typeof b.id === 'string' && b.id) return b.id;
  return typeof b.key === 'string' && b.key ? b.key : null;
};

module.exports = { activateProvider: provider(ACTIONS.activate), restoreProvider: provider(ACTIONS.restore), resourceIdOf, locateSwitch };
