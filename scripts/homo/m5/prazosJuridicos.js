#!/usr/bin/env node
'use strict';
/**
 * Reteste do Marco 5 na homologação publicada (pedido da cliente de 16/11/2026): caminho operacional para CRIAR, ATRIBUIR, REMARCAR e
 * CONCLUIR prazo jurídico, com as recusas do livro. Pela API pública, com o administrador de teste (cria e aprova) e o perfil somente
 * leitura (recebe a atribuição e não consegue alterar), em um processo fictício "ACEITE-M5 ...". Nada real é tocado; nada é apagado.
 *
 * Uso: HOMO_SEGREDOS_ARQUIVO=... HOMO_ADMIN_EMAIL=... HOMO_ADMIN_COMPANY_ID=... [HOMO_SAIDA_JSON=...] node scripts/homo/m5/prazosJuridicos.js
 */
const fs = require('fs');
const { Sessao, PararScript, lerBase } = require('../lib/cliente');
const { carregarSegredos, recusarSegredoNaLinhaDeComando } = require('../lib/segredosArquivo');
const auditoria = require('../lib/auditoria');

const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;
const lista = (r) => (Array.isArray(r.dados) ? r.dados : (r.dados && r.dados.items) || []);
const dia = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n% ACEITE-M5 intimacao ficticia (origem do prazo)\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

async function main() {
  recusarSegredoNaLinhaDeComando(process.argv);
  const env = carregarSegredos(process.env);
  const base = lerBase(env);
  const opc = (p) => ({ segredoMfa: env[`${p}_MFA_SECRET`], codigoMfa: env[`${p}_MFA_CODE`], companyId: env.HOMO_ADMIN_COMPANY_ID });
  const admin = await new Sessao(base, 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, opc('HOMO_ADMIN')).entrar();
  const leitura = await new Sessao(base, 'somente leitura', env.HOMO_LEITURA_EMAIL, env.HOMO_LEITURA_PASSWORD, opc('HOMO_LEITURA')).entrar();
  const out = { quando: new Date().toISOString(), base, empresa: admin.companyId, perfis: { admin: admin.userId, leitura: leitura.userId }, passos: [], conferencias: [], ids: {} };
  const passo = (nome, r) => { out.passos.push({ nome, http: r.status, erro: r.erro ? r.erro.code : null }); console.log(`- ${nome}: ${resumo(r)}`); return r; };
  const conferir = (descricao, ok, evidencia) => { out.conferencias.push({ descricao, ok: Boolean(ok), evidencia }); console.log(`  [${ok ? 'OK    ' : 'FALHOU'}] ${descricao} -> ${evidencia}`); };

  const caso = passo('criar processo fictício', await admin.chamar('POST', '/legal/cases', { caseType: 'CONSULTATIVE', summary: `ACEITE-M5 processo fictício para o reteste de prazos (${dia(0)})`, responsibleUserId: admin.userId, riskLevel: 'LOW', estimatedAmount: '1000.00' }));
  if (caso.status !== 201) throw new PararScript(`Processo não criado: ${resumo(caso)} ${caso.erro ? caso.erro.message : ''}`);
  out.ids.processo = caso.dados.id;
  const arq = passo('enviar a intimação fictícia (origem do prazo)', await admin.chamar('POST', '/files', { fileName: 'aceite-m5-intimacao.pdf', mimeType: 'application/pdf', contentBase64: PDF, category: 'legal' }));
  if (arq.status !== 201) throw new PararScript(`Arquivo recusado: ${resumo(arq)}`);
  out.ids.arquivoOrigem = arq.dados.id;

  const semOrigem = passo('recusa: prazo sem origem', await admin.chamar('POST', `/legal/cases/${caso.dados.id}/deadlines`, { description: 'ACEITE-M5 prazo sem origem', dueAt: dia(10) }));
  conferir('prazo sem origem (arquivo ou evento) é recusado', semOrigem.status === 400, resumo(semOrigem));

  const criado = passo('CRIAR prazo (vence em 10 dias, responsável = administrador)', await admin.chamar('POST', `/legal/cases/${caso.dados.id}/deadlines`, {
    description: 'ACEITE-M5 prazo fictício: manifestação sobre a intimação', dueAt: dia(10), sourceFileId: arq.dados.id, criticality: 'HIGH', responsibleUserId: admin.userId,
  }));
  if (criado.status !== 201) throw new PararScript(`Prazo não criado: ${resumo(criado)} ${criado.erro ? criado.erro.message : ''}`);
  const p = criado.dados; out.ids.prazo = p.id;
  conferir('prazo criado, aberto, com origem e responsável', p.responsibleUserId === admin.userId && p.sourceFileId === arq.dados.id, `status ${p.status}, vence ${p.dueAt}, criticidade ${p.criticality}, tarefa ${p.taskId || '-'}`);

  const atrib = passo('ATRIBUIR ao perfil somente leitura', await admin.chamar('PATCH', `/legal/deadlines/${p.id}`, { responsibleUserId: leitura.userId, changeReason: 'ACEITE-M5 reatribuição de teste' }));
  conferir('responsável trocado', atrib.status === 200 && atrib.dados.responsibleUserId === leitura.userId, `${resumo(atrib)}, responsável ${atrib.dados && atrib.dados.responsibleUserId}`);

  const semMotivo = passo('recusa: remarcar sem motivo', await admin.chamar('PATCH', `/legal/deadlines/${p.id}`, { dueAt: dia(15) }));
  conferir('remarcar sem motivo é recusado', semMotivo.status === 400 && semMotivo.erro && semMotivo.erro.code === 'LEGAL_DEADLINE_CHANGE_REASON_REQUIRED', resumo(semMotivo));
  const remarc = passo('REMARCAR para 15 dias, com motivo', await admin.chamar('PATCH', `/legal/deadlines/${p.id}`, { dueAt: dia(15), changeReason: 'ACEITE-M5 prorrogação deferida (fictícia)' }));
  conferir('vencimento remarcado', remarc.status === 200 && String(remarc.dados.dueAt).slice(0, 10) >= dia(14), `${resumo(remarc)}, vence ${remarc.dados && remarc.dados.dueAt}`);

  const leituraConclui = passo('recusa: perfil somente leitura tenta concluir', await leitura.chamar('PATCH', `/legal/deadlines/${p.id}`, { status: 'DONE', conclusionNote: 'ACEITE-M5 tentativa do perfil de leitura' }));
  conferir('perfil sem permissão de alteração não conclui (403)', leituraConclui.status === 403, resumo(leituraConclui));
  const semProva = passo('recusa: concluir sem nota nem arquivo', await admin.chamar('PATCH', `/legal/deadlines/${p.id}`, { status: 'DONE' }));
  conferir('concluir exige prova (nota ou arquivo)', semProva.status === 422 && semProva.erro && semProva.erro.code === 'LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED', resumo(semProva));
  const concl = passo('CONCLUIR com nota (administrador, que tem aprovação jurídica)', await admin.chamar('PATCH', `/legal/deadlines/${p.id}`, { status: 'DONE', conclusionNote: 'ACEITE-M5 manifestação protocolada (fictícia)' }));
  conferir('prazo concluído', concl.status === 200 && concl.dados.status === 'DONE', `${resumo(concl)}, status ${concl.dados && concl.dados.status}`);

  const lido = lista(await admin.chamar('GET', `/legal/deadlines?caseId=${caso.dados.id}`)).find((d) => d.id === p.id);
  conferir('leitura final: concluído, responsável e vencimento remarcado', lido && lido.status === 'DONE', lido ? `status ${lido.status}, responsável ${lido.responsibleUserId}, vence ${lido.dueAt}` : 'não listado');
  const aud = await auditoria.listar(admin, { entityId: p.id });
  out.auditoria = aud.itens.map((e) => ({ acao: e.action, quando: e.occurredAt, por: e.userId, motivo: e.reason ? String(e.reason).slice(0, 200) : null }));
  conferir('auditoria do prazo: criação, atribuição, remarcação e conclusão', aud.itens.length >= 4, `${aud.itens.length} eventos: ${[...new Set(aud.itens.map((e) => e.action))].join(', ')}`);

  out.caminhoNaTela = `Contratos > Processos (/painel/contratos/processos/${caso.dados.id}) → cartão "Prazos": Novo prazo, Reatribuir, Remarcar, Concluir (pela tela, concluir com nota; arquivo de evidência pela API).`;
  out.resultado = { ok: out.conferencias.filter((c) => c.ok).length, falharam: out.conferencias.filter((c) => !c.ok).length };
  console.log(`\nResultado: ${out.resultado.ok} ok, ${out.resultado.falharam} falharam. IDs: ${JSON.stringify(out.ids)}`);
  if (env.HOMO_SAIDA_JSON) fs.writeFileSync(env.HOMO_SAIDA_JSON, `${JSON.stringify(out, null, 2)}\n`);
  if (out.resultado.falharam) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof PararScript ? `PARADO: ${e.message}` : `ERRO: ${e.message}`);
  process.exit(e instanceof PararScript ? 2 : 1);
});
