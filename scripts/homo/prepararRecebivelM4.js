#!/usr/bin/env node
'use strict';
/**
 * Prepara na homologação o recebível fictício de R$ 0,30 que a Nayara baixa em duas vezes (R$ 0,10 e R$ 0,20), confirmando cada baixa
 * pelo autenticador (Marco 4, pedido de 16/11/2026). Só CRIA o lançamento, pela API pública, com o administrador de teste; as baixas
 * ficam para a Nayara. Idempotente pela chave do dia: rodar de novo devolve o mesmo lançamento.
 *
 * Uso: HOMO_SEGREDOS_ARQUIVO=<arquivo fora do repositório> HOMO_ADMIN_EMAIL=... [HOMO_ADMIN_COMPANY_ID=...] [HOMO_API_BASE=...]
 *      [HOMO_SAIDA_JSON=arquivo] node scripts/homo/prepararRecebivelM4.js
 * Nenhuma senha, token ou segredo é impresso nem gravado.
 */
const fs = require('fs');
const { Sessao, PararScript, lerBase } = require('./lib/cliente');
const { carregarSegredos, recusarSegredoNaLinhaDeComando } = require('./lib/segredosArquivo');

const hoje = () => new Date().toISOString().slice(0, 10);
const CAMINHO = 'Financeiro > Lançamentos (/painel/financeiro/lancamentos) → abrir "ACEITE-M4 recebível fictício de R$ 0,30" → preencher "Motivo da baixa manual" e '
  + '"Valor da baixa parcial" = 0,10 → "Liquidar parcial" → confirmar → código do autenticador → "Já baixado" 0,10 e saldo 0,20; repetir com 0,20 → saldo 0,00 e '
  + 'status Liquidado; o histórico do lançamento e a auditoria mostram as duas baixas, sem duplicidade.';

async function main() {
  recusarSegredoNaLinhaDeComando(process.argv);
  const env = carregarSegredos(process.env);
  const base = lerBase(env);
  if (!env.HOMO_ADMIN_EMAIL || !env.HOMO_ADMIN_PASSWORD) throw new PararScript('Informe HOMO_ADMIN_EMAIL e a senha no arquivo de segredos.');
  const admin = await new Sessao(base, 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, {
    segredoMfa: env.HOMO_ADMIN_MFA_SECRET, codigoMfa: env.HOMO_ADMIN_MFA_CODE, companyId: env.HOMO_ADMIN_COMPANY_ID,
  }).entrar();

  const centros = await admin.chamar('GET', '/finance/result-centers');
  const lista = Array.isArray(centros.dados) ? centros.dados : (centros.dados && centros.dados.items) || [];
  const centro = lista.find((c) => c.status === undefined || c.status === 'ACTIVE' || c.isActive !== false);
  if (!centro) throw new PararScript(`Nenhum centro de resultado na empresa (HTTP ${centros.status}): o recebível exige um (Caderno M4 §3).`);

  const vencimento = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const pedido = {
    entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '0.30', dueAt: vencimento, resultCenterId: centro.id,
    description: `ACEITE-M4 recebível fictício de R$ 0,30 (${hoje()}): baixas de R$ 0,10 e R$ 0,20 pela Nayara, com o autenticador`,
    idempotencyKey: `aceite-m4-recebivel-030-${hoje()}`,
  };
  const criado = await admin.chamar('POST', '/finance/entries', pedido);
  if (![200, 201].includes(criado.status)) throw new PararScript(`Criação recusada: HTTP ${criado.status} ${criado.erro ? `${criado.erro.code} ${criado.erro.message}` : ''}`);
  const l = criado.dados;
  const lido = await admin.chamar('GET', `/finance/entries/${l.id}`);
  const r = {
    quando: new Date().toISOString(), base, empresa: admin.companyId,
    lancamento: { id: l.id, descricao: l.description, valor: l.amount, natureza: l.nature, status: (lido.dados || l).status, vencimento: l.dueAt, centroDeResultado: centro.name || centro.id },
    criacao: { http: criado.status, chaveDeIdempotencia: pedido.idempotencyKey },
    caminhoNaTela: CAMINHO,
  };
  if (env.HOMO_SAIDA_JSON) fs.writeFileSync(env.HOMO_SAIDA_JSON, `${JSON.stringify(r, null, 2)}\n`);
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e instanceof PararScript ? `PARADO: ${e.message}` : `ERRO: ${e.message}`);
  process.exit(e instanceof PararScript ? 2 : 1);
});
