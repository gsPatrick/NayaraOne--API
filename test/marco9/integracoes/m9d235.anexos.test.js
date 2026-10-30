'use strict';

// Marco 9, M9-D235 — e-mail recebido: anexos em quarentena e antivírus, infectado descartado com evento, nenhuma tela ou regra usa o e-mail como fonte única. Banco descartável.
process.env.PORT = process.env.M9D235_ANEXOS_PORT || '24235';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d235Env');
const quarantine = require('../../../src/features/files/quarantine');
const inbound = require('../../../src/features/integrations/email/inbound');

let tenant;
let desligarCofre;
let canal;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  canal = await env.conectar(tenant);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

test('inbound_anexo_vai_para_quarentena_e_antivirus', async () => {
  await env.config(tenant, 'integration.email.inbound_verify_immediately', false);
  try {
    await quarentenaEAntivirus();
  } finally {
    await env.config(tenant, 'integration.email.inbound_verify_immediately', true);
  }
});

async function quarentenaEAntivirus() {
  const { externalId } = await env.receber(canal, tenant, { attachments: [env.pdfLimpo()] });
  const m = await env.mensagemIn(tenant, externalId);
  assert.ok(m, 'a mensagem foi registrada');
  let [a] = await env.anexosIn(tenant, m.id);
  // Antes da verificação: o anexo está em files.quarantine com status QUARANTINED e nada foi promovido.
  assert.equal(a.quarantine_status, 'QUARANTINED');
  assert.equal(a.status, 'QUARANTINED');
  assert.equal(a.file_id, null);
  await assert.rejects(env.comTenant(tenant, (t) => quarantine.assertReleased(env.ctxDe(tenant), a.quarantine_id, t)), (e) => e.code === 'INTEGRATION_FILE_QUARANTINED');
  // A rodada da quarentena (antivírus + tipo real) libera e a do inbound promove: só depois de assertReleased o anexo passa a apontar para o arquivo.
  await env.comTenant(tenant, (t) => quarantine.verifyQuarantine(env.ctxDe(tenant), a.quarantine_id, t));
  await env.comTenant(tenant, (t) => inbound.settlePendingAttachments(env.ctxDe(tenant), t));
  [a] = await env.anexosIn(tenant, m.id);
  assert.equal(a.status, 'CLEAN');
  assert.ok(a.file_id);
  const [arq] = await env.sql(tenant, 'SELECT classification FROM people.files WHERE id = :id', { id: a.file_id });
  assert.equal(arq.classification, 'CONFIDENTIAL');
}

test('inbound_infectado_descartado_com_evento', async () => {
  const { externalId } = await env.receber(canal, tenant, { attachments: [env.pdfLimpo(), env.pdfLimpo(), env.pdfInfectado()] });
  const m = await env.mensagemIn(tenant, externalId);
  const anexos = await env.anexosIn(tenant, m.id);
  assert.deepEqual(anexos.map((x) => x.status), ['CLEAN', 'CLEAN', 'BLOCKED'], '2 promovidos e 1 bloqueado');
  assert.equal(anexos.filter((x) => x.file_id).length, 2);
  const ruim = anexos[2];
  assert.equal(ruim.file_id, null);
  assert.equal(ruim.block_code, 'INTEGRATION_EMAIL_ATTACHMENT_BLOCKED');
  const [q] = await env.sql(tenant, 'SELECT status, storage_key FROM files.quarantine WHERE id = :id', { id: ruim.quarantine_id });
  assert.equal(q.status, 'INFECTED');
  assert.equal(q.storage_key, null, 'o conteúdo infectado foi descartado');
  const ev = await env.sql(tenant, "SELECT 1 FROM integration.outbox_events WHERE company_id = :c AND event_type = 'file.infected' AND payload_json->>'quarantineId' = :q", { c: tenant.companyId, q: ruim.quarantine_id });
  assert.equal(ev.length, 1, 'evento de segurança publicado');
  // O que a pessoa vê: "anexo bloqueado", sem conteúdo.
  const visao = await env.comTenant(tenant, (t) => inbound.getInboundMessage(env.ctxDe(tenant), m.id, { canReadPii: true }, t));
  assert.equal(visao.attachments[2].message, 'Anexo bloqueado pela verificação de segurança.');
  assert.equal(JSON.stringify(visao).includes('EICAR'), false);
});

test('documentos_nao_dependem_da_caixa_de_email', async () => {
  // Nenhum código fora do módulo do inbound lê as tabelas do e-mail recebido (o checklist usa só arquivos do módulo files).
  const raiz = path.join(__dirname, '..', '..', '..', 'src');
  const donos = path.join('features', 'integrations', 'email', 'inbound');
  const usos = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.js') && !p.includes(donos) && !p.endsWith(path.join('models', 'index.js')) && !/models[\\/]EmailInbound/.test(p)) {
        if (/EmailInboundMessage|EmailInboundAttachment|email_inbound_(messages|attachments)/.test(fs.readFileSync(p, 'utf8'))) usos.push(path.relative(raiz, p));
      }
    }
  };
  varrer(raiz);
  assert.deepEqual(usos, [], 'só o módulo do inbound toca o e-mail recebido');
  // O checklist de documentos do Correspondente guarda arquivo do módulo files (file_id), nunca texto de e-mail.
  const cols = await env.sql(tenant, "SELECT column_name FROM information_schema.columns WHERE table_schema = 'correspondent' AND table_name = 'case_documents'");
  const nomes = cols.map((c) => c.column_name);
  assert.ok(nomes.includes('file_id'));
  assert.equal(nomes.some((n) => /email|body/.test(n)), false);
  // O anexo recebido só vira documento pelo arquivo promovido: a mensagem aponta para files, e a listagem não devolve o corpo de e-mail como evidência.
  const { externalId } = await env.receber(canal, tenant, { attachments: [env.pdfLimpo()] });
  const m = await env.mensagemIn(tenant, externalId);
  const [a] = await env.anexosIn(tenant, m.id);
  assert.ok(a.file_id, 'o documento existe em files, independente da caixa de e-mail');
});
