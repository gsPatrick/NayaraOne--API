#!/usr/bin/env node
'use strict';
/**
 * Demonstração do indicador "Integrações com erro" (tec.integration_errors) na homologação publicada, pedida pela cliente em 16/11/2026:
 * a janela usada, as chamadas de teste que entraram nela e a contagem de origem comparada ao painel, com janela vazia e com chamadas.
 *
 *   fase "enviar": cria um contato fictício com telefone fictício e envia N mensagens transacionais pela conexão de mensagens ativa
 *                  (POST /messages/send); o worker de envio grava as tentativas em integration.dispatch_attempts.
 *   fase "ler":    depois que a hora cheia fecha e o read model recalcula (até ~5 min), lê o indicador (GET /analytics/metrics/:code), a série de
 *                  janelas de 60 min de cada fornecedor (GET /admin/integrations/:provider/health?window=1h) e as linhas de origem do painel
 *                  (GET /analytics/metrics/:code/drilldown com o filtro assinado), e confere que o número do painel = erros / chamadas da janela.
 *
 * Uso: HOMO_SEGREDOS_ARQUIVO=... HOMO_ADMIN_EMAIL=... HOMO_ADMIN_COMPANY_ID=... [HOMO_SAIDA_JSON=...] node scripts/homo/m9/integracoesJanela.js enviar|ler [N]
 */
const fs = require('fs');
const { Sessao, PararScript, lerBase } = require('../lib/cliente');
const { carregarSegredos, recusarSegredoNaLinhaDeComando } = require('../lib/segredosArquivo');

const NOME = 'ACEITE-M9 Contato da Janela de Integrações';
const TELEFONE = '+5511900000916';
const CODE = 'tec.integration_errors';
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;
const lista = (r) => (Array.isArray(r.dados) ? r.dados : (r.dados && (r.dados.items || r.dados.rows)) || []);
const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const horaSP = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-');

async function enviar(admin, n, out) {
  let pessoa = lista(await admin.chamar('GET', '/people')).find((p) => p.legalName === NOME);
  if (!pessoa) {
    const r = await admin.chamar('POST', '/people', { personType: 'PF', legalName: NOME });
    if (r.status !== 201) throw new PararScript(`Contato não criado: ${resumo(r)}`);
    pessoa = r.dados;
  }
  out.ids.pessoa = pessoa.id;
  out.envios = [];
  for (let i = 1; i <= n; i += 1) {
    // Fora da janela de 24 h de conversa o WhatsApp só aceita modelo aprovado (texto livre: 422 OUTSIDE_SESSION_WINDOW, sem tentativa).
    // Modelo aprovado na conexão de mensagens da homologação: HOMO_MODELO_APROVADO (padrão "bi_teste", sem variáveis).
    const r = await admin.chamar('POST', '/messages/send', {
      kind: 'template', personId: pessoa.id, to: TELEFONE, purpose: 'TRANSACTIONAL', templateName: process.env.HOMO_MODELO_APROVADO || 'bi_teste',
    });
    out.envios.push({ i, http: r.status, erro: r.erro ? r.erro.code : null, mensagem: r.dados && r.dados.id, status: r.dados && (r.dados.deliveryStatus || r.dados.status) });
    console.log(`- envio ${i}: ${resumo(r)} ${r.dados ? `mensagem ${r.dados.id} ${r.dados.deliveryStatus || r.dados.status || ''}` : ''}`);
  }
  out.janelaEsperada = `${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit' })}:00 até a hora seguinte (horário de Brasília)`;
}

async function ler(admin, out) {
  const m = await admin.chamar('GET', `/analytics/metrics/${CODE}?asOf=${hojeSP()}`);
  const v = m.dados || {};
  const ref = (v.sourceRefs || [])[0] || null;
  out.indicador = { http: m.status, status: v.status, valor: v.value, frescor: v.freshness && v.freshness.state, sourceSnapshotAt: v.sourceSnapshotAt, refreshedAt: v.refreshedAt, janela: ref && ref.filter && ref.filter.equals };
  console.log(`indicador: ${resumo(m)} status ${v.status} valor ${v.value} frescor ${out.indicador.frescor} janela ${JSON.stringify(out.indicador.janela)}`);
  const fornecedores = lista(await admin.chamar('GET', '/admin/integrations'));
  out.series = {};
  for (const f of fornecedores) {
    const code = f.providerCode || f.code || f.provider_code;
    if (!code) continue;
    const h = await admin.chamar('GET', `/admin/integrations/${code}/health?window=1h`);
    const serie = (h.dados && (h.dados.series || h.dados.items)) || [];
    out.series[code] = serie.slice(-4).map((s) => ({ janela: horaSP(s.windowStart), chamadas: s.callsTotal, falhas: s.callsFailed }));
    console.log(`série ${code}: ${JSON.stringify(out.series[code])}`);
  }
  if (ref && ref.filterHash && ref.filterSignature) {
    const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature, pageSize: '50' });
    const d = await admin.chamar('GET', `/analytics/metrics/${CODE}/drilldown?${q}`);
    const linhas = (d.dados && d.dados.rows) || [];
    const chamadas = linhas.reduce((s, l) => s + Number(l.calls_total || 0), 0);
    const falhas = linhas.reduce((s, l) => s + Number(l.calls_failed || 0), 0);
    out.origem = { http: d.status, linhas: linhas.map((l) => ({ fornecedor: l.provider_code, janela: horaSP(l.window_start), chamadas: l.calls_total, falhas: l.calls_failed })), chamadas, falhas };
    const esperado = chamadas > 0 ? Math.round((falhas / chamadas) * 10000) / 100 : null;
    out.conciliacao = { chamadasNaOrigem: chamadas, falhasNaOrigem: falhas, percentualCalculado: esperado, valorDoPainel: v.value == null ? null : Number(v.value),
      bate: chamadas === 0 ? v.status === 'INCOMPLETE' : Number(v.value) === esperado };
    console.log(`origem: ${resumo(d)} ${linhas.length} linhas, ${chamadas} chamadas, ${falhas} falhas -> esperado ${esperado} | painel ${v.value} | bate ${out.conciliacao.bate}`);
  }
}

async function main() {
  recusarSegredoNaLinhaDeComando(process.argv);
  const fase = process.argv[2];
  const n = Number(process.argv[3] || 5);
  if (!['enviar', 'ler'].includes(fase)) throw new PararScript('Use: enviar [N] | ler');
  const env = carregarSegredos(process.env);
  const admin = await new Sessao(lerBase(env), 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, { companyId: env.HOMO_ADMIN_COMPANY_ID }).entrar();
  const out = { fase, quando: new Date().toISOString(), ids: {} };
  if (fase === 'enviar') await enviar(admin, n, out); else await ler(admin, out);
  if (env.HOMO_SAIDA_JSON) fs.writeFileSync(env.HOMO_SAIDA_JSON, `${JSON.stringify(out, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e instanceof PararScript ? `PARADO: ${e.message}` : `ERRO: ${e.message}`);
  process.exit(e instanceof PararScript ? 2 : 1);
});
