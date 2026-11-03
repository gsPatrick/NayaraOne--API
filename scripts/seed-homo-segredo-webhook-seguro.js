'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const { sequelize, TenantSetting } = require('../src/models');
const { upsertSetting, getDecryptedSetting } = require('../src/features/settings/settings.service');

/**
 * Grava, para a empresa de homologação, o segredo de TESTE do webhook da seguradora sandbox
 * (`procurement.insurance_webhook_secret`, guardado cifrado) e o salva num arquivo com permissão 0600,
 * FORA do repositório, para o script `simularRetornoSinistro.js`. Nunca imprime o segredo no console.
 * Não mexe em nada além dessa configuração. Recusa produção. Se já existir um segredo, não troca,
 * a não ser que se passe `--girar` (aí o antigo deixa de valer).
 *
 * Uso: node scripts/seed-homo-segredo-webhook-seguro.js --out <arquivo> [--girar] [--group <uuid> --company <uuid> --user <uuid>]
 * (sem --group/--company/--user valem a Empresa Dev e o admin da homologação; os três existem só para teste local)
 */
const GROUP_ID_PADRAO = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const COMPANY_ID_PADRAO = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID_PADRAO = '33477648-c752-4bed-83cb-a04114224f4d';
const CHAVE = 'procurement.insurance_webhook_secret';

function arg(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') throw new Error('Seed de homologação proibido em produção.');
  const out = arg('out');
  if (!out || out.startsWith('--')) throw new Error('Informe --out <arquivo> para gravar o segredo fora do repositório.');
  const groupId = arg('group') || GROUP_ID_PADRAO;
  const companyId = arg('company') || COMPANY_ID_PADRAO;
  const ADMIN_USER_ID = arg('user') || ADMIN_USER_ID_PADRAO;
  const girar = process.argv.includes('--girar');
  const tenant = { groupId, companyId };

  const t = await sequelize.transaction();
  try {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
      replacements: { g: groupId, c: companyId, u: ADMIN_USER_ID },
      transaction: t,
    });
    const existente = await TenantSetting.findOne({ where: { companyId, key: CHAVE }, transaction: t });
    if (existente && !girar) {
      await t.rollback();
      console.log('Já existe um segredo de teste do webhook para esta empresa; nada foi alterado. Use --girar para gerar um novo (o antigo deixa de valer).');
      return;
    }
    const segredo = crypto.randomBytes(24).toString('hex');
    await upsertSetting(CHAVE, segredo, tenant, ADMIN_USER_ID, t);
    // Confere que o valor gravado decifra para o mesmo segredo antes de entregar.
    const lido = await getDecryptedSetting(CHAVE, tenant, t, null);
    if (lido !== segredo) throw new Error('O segredo gravado não confere com o gerado; nada foi salvo.');
    await t.commit();
    fs.writeFileSync(out, `Segredo de teste do webhook da seguradora sandbox. Entregar pelo meio seguro; não colar em chat aberto.\n\nINSURANCE_WEBHOOK_SECRET=${segredo}\n`, { mode: 0o600 });
    console.log(`Segredo ${existente ? 'girado' : 'gravado'} para a empresa ${companyId}. Salvo em ${out} (0600).`);
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  } finally {
    await sequelize.close();
  }
}

main().catch((e) => { console.error('Falha:', e.message); process.exit(1); });
