'use strict';

const { createAutomation, publishAutomation } = require('../definition.service');
const { findFlowByCode } = require('../definition.repository');
const { posChavesDefinition, POS_CHAVES_CODE } = require('./posChaves');
const { locacaoDefinition, LOCACAO_CODE } = require('./locacao');

/** Automações prontas do Marketing (M9-D422 a M9-D424): código do fluxo -> montagem da definição. Entram nas mesmas rotas de criação e publicação do livro. */
const SEEDS = { [POS_CHAVES_CODE]: posChavesDefinition, [LOCACAO_CODE]: locacaoDefinition };
const registerSeed = (code, build) => { SEEDS[code] = build; };

/**
 * Cria e publica a automação pronta `code` para a empresa, pelo serviço de definição (rascunho completo, auditoria antes/depois, publicação com motivo). Idempotente pelo código do
 * fluxo: se já existe, devolve o existente sem criar versão. `templates` (opcional): { posição da mensagem: id do template publicado }, necessário no WhatsApp fora da janela.
 */
async function installSeed({ code, tenant, actor, ownerUserId, templates }, transaction) {
  const build = SEEDS[code];
  if (!build) throw new Error(`Automação pronta desconhecida: ${code}.`);
  const existing = await findFlowByCode(code, transaction);
  if (existing) return { installed: false, flowId: existing.id };
  const definition = await build({ ownerUserId: ownerUserId || actor, templates, tenant, transaction });
  const created = await createAutomation({ tenant, actor, input: definition }, transaction);
  await publishAutomation({ tenant, actor, flowId: created.flow.id, input: { versionNo: 1, reason: `Automação pronta ${code} publicada.` } }, transaction);
  return { installed: true, flowId: created.flow.id };
}

module.exports = { installSeed, registerSeed, SEEDS };
