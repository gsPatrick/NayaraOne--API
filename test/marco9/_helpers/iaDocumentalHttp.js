'use strict';

// Ambiente HTTP da NAY Documental (M9-D040): o mesmo ambiente da NAY Correspondente (app real no cluster descartável, perfis do seed de dois
// tenants), com o agente ATIVO da definição de código e arquivos commitados. Nunca chama MFA nem forja token.

const { withTenantTransaction } = require('../../testHelpers');
const { DEFINITION } = require('../../../src/features/ai/agents/nay_documental');
const Http = require('./iaCorrespondenteHttp');
const D = require('./iaDocumental');

const agenteAtivo = (env, tenant) => Http.agenteAtivo(env, tenant, DEFINITION);

/** Arquivo OCR de teste commitado na empresa, enviado por `tenant.userId` (o gestor). */
const arquivoCommitado = (tenant, opcoes) => withTenantTransaction(tenant, (tx) => D.arquivoOcr(tenant, tx, opcoes));

module.exports = { subir: Http.subir, agenteAtivo, arquivoCommitado, encerrar: Http.encerrar, admin: Http.admin };
