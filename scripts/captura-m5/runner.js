'use strict';
/**
 * Runner da captura ao vivo do fechamento do Marco 5 (matriz requisito x evidência).
 *
 * Estende o runner da conferência dos Marcos 4/5 (scripts/captura-marco45/runner.js): cada passo
 * HTTP, de serviço ou SQL leva `req` = lista de ids de requisito do caderno (M5-Axxxx-yyyyyy, os
 * mesmos ids de Maturacao/demandas/_rastreabilidade/atomos-marco-5.csv) e um `id` de passo único
 * (prefixo do módulo). Regras herdadas: requisição real ao app Express (JWT real + tenant + RLS),
 * login normal dos usuários fictícios do seed de dois tenants, nunca endpoint de MFA, nunca token
 * forjado; tokens e senhas redigidos.
 *
 * `sqlTenant` roda SELECT como a role de runtime (sem BYPASSRLS) DENTRO do contexto de tenant de
 * um perfil (SET LOCAL app.*), em transação READ ONLY desfeita no fim: o RLS vale de verdade.
 */
const { Runner, redigir } = require('../captura-marco45/runner');

const ID_REQ = /^M5-A\d{4}-[0-9a-f]{6}$/;

function exigirReq(req, id) {
  if (!Array.isArray(req) || req.length === 0) throw new Error(`passo ${id}: informe req (ids de requisito do caderno)`);
  for (const r of req) if (!ID_REQ.test(r)) throw new Error(`passo ${id}: id de requisito inválido "${r}"`);
}

class RunnerM5 extends Runner {
  constructor(opts) {
    super(opts);
    this.ids = new Set();
  }

  marcar(lista, id, req, modulo) {
    if (this.ids.has(id)) throw new Error(`id de passo repetido: ${id}`);
    this.ids.add(id);
    const ultimo = lista[lista.length - 1];
    ultimo.req = req;
    ultimo.modulo = modulo || this.moduloAtual || 'não informado';
  }

  async http(o) {
    exigirReq(o.req, o.id);
    const r = await super.http({ ...o, titulo: o.titulo });
    this.marcar(this.passos, o.id, o.req);
    return r;
  }

  async servico(o) {
    exigirReq(o.req, o.id);
    const r = await super.servico(o);
    this.marcar(this.passos, o.id, o.req);
    return r;
  }

  /** SELECT somente leitura no contexto de tenant do perfil `quem` (RLS real). */
  async sqlTenant({ id, req, quem, descricao, sql, replacements, avaliar }) {
    exigirReq(req, id);
    const { sequelize } = require('../../src/models');
    const t = this.tenant(quem);
    let resultado;
    let erro = null;
    const tx = await sequelize.transaction();
    try {
      await sequelize.query('SET TRANSACTION READ ONLY', { transaction: tx });
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: t.groupId }, transaction: tx });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: t.companyId }, transaction: tx });
      await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: t.userId }, transaction: tx });
      [resultado] = await sequelize.query(sql, { replacements: typeof replacements === 'function' ? replacements(this.ctx) : replacements, transaction: tx });
    } catch (err) {
      erro = err.message;
    } finally {
      await tx.rollback().catch(() => {});
    }
    const limpo = erro ? { erro } : JSON.parse(JSON.stringify(redigir(resultado), (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    const invarianteOk = erro ? false : (avaliar ? !!avaliar(resultado, this.ctx) : true);
    this.consultas.push({ id, req, modulo: this.moduloAtual, perfil: quem, descricao, sql: sql.replace(/\s+/g, ' ').trim(), resultado: limpo, invarianteOk, quando: new Date().toISOString() });
    if (this.ids.has(id)) throw new Error(`id de passo repetido: ${id}`);
    this.ids.add(id);
    if (!invarianteOk) console.error(`[captura-m5] INVARIANTE FALHOU ${id}${erro ? `: ${erro}` : ''}`);
    return { resultado, erro, invarianteOk };
  }

  /**
   * Roda `fn(transaction)` no contexto de tenant do perfil `quem` (SET LOCAL app.*), com COMMIT
   * ao fim: para passos de serviço (`R.servico`) em regras cuja rota exige MFA humano.
   */
  async comTenant(quem, fn) {
    const { sequelize } = require('../../src/models');
    const t = this.tenant(quem);
    return sequelize.transaction(async (tx) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: t.groupId }, transaction: tx });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: t.companyId }, transaction: tx });
      await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: t.userId }, transaction: tx });
      return fn(tx, t);
    });
  }

  /** SELECT de catálogo (sem dado de tenant), também somente leitura. */
  async sqlCatalogo({ id, req, descricao, sql, avaliar }) {
    exigirReq(req, id);
    const before = this.consultas.length;
    await super.sql({ id, descricao, sql, avaliar });
    const c = this.consultas[before];
    c.req = req;
    c.modulo = this.moduloAtual;
    c.perfil = 'catálogo (role de runtime, sem tenant)';
    if (this.ids.has(id)) throw new Error(`id de passo repetido: ${id}`);
    this.ids.add(id);
  }
}

module.exports = { RunnerM5, redigir, ID_REQ };
