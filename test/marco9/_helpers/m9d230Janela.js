'use strict';

// Janela de atendimento do WhatsApp nos testes (M9-D230): a conversa interna da pessoa guarda quando o cliente escreveu por último. Este apoio abre (ou fecha) a janela sem criar mensagem.
const env = require('./m9d212Env');

/** Define quando o cliente escreveu por último (`horasAtras`; null = nunca escreveu). Cria a conversa interna da pessoa se ainda não existir. */
async function abrirJanela(tenant, personId, horasAtras = 1) {
  const quando = horasAtras === null ? null : new Date(Date.now() - horasAtras * 3600000).toISOString();
  await env.sql(tenant, `INSERT INTO crm.conversations (id, group_id, company_id, person_id, channel, last_inbound_at)
    VALUES (gen_random_uuid(), :g, :c, :p, 'WHATSAPP', :q)
    ON CONFLICT (company_id, person_id, channel) DO UPDATE SET last_inbound_at = EXCLUDED.last_inbound_at`, { g: tenant.groupId, c: tenant.companyId, p: personId, q: quando });
}

const conversaDe = async (tenant, personId) => (await env.sql(tenant, "SELECT * FROM crm.conversations WHERE company_id = :c AND person_id = :p AND channel = 'WHATSAPP'", { c: tenant.companyId, p: personId }))[0];

module.exports = { abrirJanela, conversaDe };
