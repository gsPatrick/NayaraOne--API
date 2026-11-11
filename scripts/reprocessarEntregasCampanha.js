#!/usr/bin/env node
'use strict';
/**
 * Roteiro do administrador (verificação K=7 do e-mail de campanha): mostra o resumo das entregas de UMA campanha e, só com REPROCESSAR=sim, devolve à fila as
 * entregas que ficaram FAILED por falha transitória (cofre fora, 429, 5xx, resultado incerto). Usa a API pública (POST /marketing/campaigns/:id/deliveries/reprocess),
 * nunca SQL: a permissão (marketing:campaign:manage), o motivo e a auditoria são os da API. Nada é enviado por este script; o envio sai no ciclo seguinte do job de
 * campanhas, com o canSend na hora e a mesma chave de idempotência.
 *
 * Variáveis de ambiente:
 *   HOMO_API_BASE                 ex.: https://<api-da-homologacao>/api/v1 (recusa endereço que pareça produção)
 *   HOMO_ADMIN_EMAIL / HOMO_ADMIN_PASSWORD      administrador da empresa da campanha
 *   HOMO_ADMIN_MFA_CODE / HOMO_ADMIN_MFA_SECRET opcional, só se a API pedir MFA recente (nunca contornado)
 *   CAMPANHA_ID                   id da campanha (ex.: cfc5c8e1-784c-4b1f-abc9-60411dbf67f3)
 *   MOTIVO                        motivo do reprocessamento (mínimo 10 caracteres; vai para a auditoria)
 *   REPROCESSAR=sim               sem isto o script só mostra o resumo (modo consulta)
 *   ESPERAR_S                     opcional: depois de reprocessar, espera N segundos e mostra o resumo de novo (padrão 0)
 * Saída: 0 = ok; 1 = a API recusou; 2 = parada de segurança ou configuração. Nunca imprime senha, token ou código MFA.
 */
const { Sessao, PararScript, lerBase, dormir } = require('./homo/lib/cliente');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function imprimirResumo(rotulo, campanha) {
  const d = campanha.deliveries || {};
  console.log(`\n${rotulo}: campanha ${campanha.code} (${campanha.status})`);
  console.log(`  por status: ${JSON.stringify(d.byStatus || {})}`);
  console.log(`  motivos:    ${JSON.stringify(d.reasonsByStatus || {})}`);
  console.log(`  abertas: ${d.open ?? 0}; próxima tentativa: ${d.nextAttemptAt || 'nenhuma'}; reprocessáveis: ${d.reprocessable ?? 0}`);
}

async function lerCampanha(sessao, id) {
  const r = await sessao.chamar('GET', `/marketing/campaigns/${id}`);
  if (r.status !== 200) throw Object.assign(new Error(`GET da campanha: HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`), { saida: 1 });
  return r.dados;
}

async function principal() {
  const env = process.env;
  const base = lerBase(env);
  const id = String(env.CAMPANHA_ID || '').trim();
  if (!UUID.test(id)) throw new PararScript('Informe CAMPANHA_ID (o id completo da campanha).');
  if (!env.HOMO_ADMIN_EMAIL || !env.HOMO_ADMIN_PASSWORD) throw new PararScript('Informe HOMO_ADMIN_EMAIL e HOMO_ADMIN_PASSWORD.');
  const sessao = await new Sessao(base, 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, { codigoMfa: env.HOMO_ADMIN_MFA_CODE, segredoMfa: env.HOMO_ADMIN_MFA_SECRET }).entrar();
  imprimirResumo('Antes', await lerCampanha(sessao, id));
  if (env.REPROCESSAR !== 'sim') { console.log('\nModo consulta: nada foi alterado. Para reprocessar, rode de novo com REPROCESSAR=sim e MOTIVO="...".'); return 0; }
  const motivo = String(env.MOTIVO || '').trim();
  if (motivo.length < 10) throw new PararScript('Informe MOTIVO com pelo menos 10 caracteres (vai para a auditoria).');
  const r = await sessao.chamar('POST', `/marketing/campaigns/${id}/deliveries/reprocess`, { reason: motivo });
  if (r.status !== 200) { console.log(`\nA API recusou: HTTP ${r.status} ${r.erro ? `${r.erro.code}: ${r.erro.message}` : ''}`); return 1; }
  console.log(`\nReprocessadas: ${r.dados.reprocessed} (RETRY ${r.dados.asRetry}, UNKNOWN ${r.dados.asUnknown}); steps reabertos: ${r.dados.stepsReopened}; voltam a partir de ${r.dados.nextAttemptAt || 'nenhuma'}.`);
  const espera = Number(env.ESPERAR_S || 0);
  if (espera > 0) { await dormir(espera * 1000); imprimirResumo(`Depois de ${espera} s`, await lerCampanha(sessao, id)); }
  return 0;
}

principal().then((code) => process.exit(code)).catch((err) => {
  if (err instanceof PararScript) { console.error(`PARADA: ${err.message}`); process.exit(2); }
  console.error(`ERRO: ${err.message}`);
  process.exit(err.saida || 1);
});
