'use strict';

// Fábricas da retenção da NAY (M9-D028): runs finalizados e "velhos", com fontes de classificações diferentes e conteúdo a expurgar.

const { uid, q, run } = require('../../helpers/aiRuns');

const DIA_MS = 24 * 3600 * 1000;

/**
 * Cria um run (RUNNING, com fontes) com created_at `diasAtras` dias no passado e o leva a COMPLETED.
 * `fontes` = lista de classificações (uma fonte por item). Devolve { id, fontes: [ids] }.
 */
async function runVelho(tenant, tx, { diasAtras, fontes = [], providerCode = null, custo = '1.234567', tokensIn = 100, tokensOut = 50, requestHash = 'c'.repeat(64) } = {}) {
  const id = uid();
  const criado = new Date(Date.now() - diasAtras * DIA_MS).toISOString();
  await run(
    `INSERT INTO ai.ai_runs (id, group_id, company_id, agent_name, input_summary, tool_calls_json, status, provider_code, request_hash, created_at, updated_at, started_at)
     VALUES (:id, :g, :c, 'NAY_TESTE', 'entrada sanitizada', :tools::jsonb, 'RUNNING', :prov, :hash, :criado, :criado, :criado)`,
    { id, g: tenant.groupId, c: tenant.companyId, prov: providerCode, hash: requestHash, criado, tools: JSON.stringify([{ tool: 'crm.buscar', status: 'OK', argsSanitized: { id: 1 }, resultSummary: 'achou 3' }]) }, tx
  );
  const idsFontes = [];
  for (const classificacao of fontes) {
    const fid = uid();
    await run(
      `INSERT INTO ai.ai_sources (id, group_id, company_id, ai_run_id, source_type, source_ref, excerpt, classification, content_hash)
       VALUES (:fid, :g, :c, :id, 'DOCUMENT_CHUNK', :ref, 'trecho redigido', :cl, :h)`,
      { fid, g: tenant.groupId, c: tenant.companyId, id, ref: `doc:${fid.slice(0, 8)}`, cl: classificacao, h: 'd'.repeat(64) }, tx
    );
    idsFontes.push(fid);
  }
  await run(
    `UPDATE ai.ai_runs SET status = 'COMPLETED', output_summary = 'saida sanitizada', cost_amount = :custo, tokens_in = :ti, tokens_out = :to WHERE id = :id`,
    { id, custo, ti: tokensIn, to: tokensOut }, tx
  );
  return { id, fontes: idsFontes };
}

const lerRunCompleto = async (id, tx) => (await q('SELECT * FROM ai.ai_runs WHERE id = :id', { id }, tx))[0];
const lerFonte = async (id, tx) => (await q('SELECT * FROM ai.ai_sources WHERE id = :id', { id }, tx))[0];

/** Registra no catálogo um provider de IA e uma connection com a retenção contratada (data_retention). */
async function providerComRetencao(tenant, tx, dataRetention) {
  const code = `ia-d028-${uid().slice(0, 8)}`;
  await run("SELECT set_config('app.integration_platform_admin', 'on', true)", {}, tx);
  await run(
    `INSERT INTO integration.providers (code, display_name, domain, capabilities, supported_versions, criticality, sandbox_available)
     VALUES (:code, 'Provider de teste', 'AI', '["generate"]'::jsonb, '["v1"]'::jsonb, 'LOW', true)`, { code }, tx
  );
  await run(
    `INSERT INTO integration.connections (group_id, company_id, provider_code, environment, label, status, config_json)
     VALUES (:g, :c, :code, 'SANDBOX', 'teste', 'ACTIVE', :cfg::jsonb)`,
    { g: tenant.groupId, c: tenant.companyId, code, cfg: JSON.stringify({ data_retention: dataRetention }) }, tx
  );
  return code;
}

module.exports = { runVelho, lerRunCompleto, lerFonte, providerComRetencao, DIA_MS };
