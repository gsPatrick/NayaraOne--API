'use strict';

/**
 * ToolRegistry (M9-D016) — registro, no servidor, das tools que a NAY pode pedir. Cada definição declara permissão, risco,
 * schemas e aprovação humana; o registro recusa (erro de boot) a definição incompleta ou insegura. O modelo só sugere nome e
 * argumentos: permissão, risco e aprovação saem sempre da definição registrada. A saída de toda tool é validada e podada
 * pelo outputSchema, e escrita nunca executa direto por padrão (vira proposta, M9-D019).
 */
const { validateDefinition, invalid } = require('./toolDefinition');
const { pruneOutput } = require('./outputSchema');
const { promptView } = require('./toolPromptView');

class ToolRegistry {
  /** `permissionCodes`: catálogo de core.permissions (lista ou Set). Sem ele o catálogo é vazio e nenhuma tool é aceita: falha fechada. */
  /** @param {{ permissionCodes?: Iterable<string> | null }} [opcoes] */
  constructor({ permissionCodes } = {}) {
    if (permissionCodes !== undefined && (permissionCodes === null || typeof permissionCodes[Symbol.iterator] !== 'function')) {
      throw invalid(null, 'permissionCodes', 'catalogo_de_permissoes_invalido');
    }
    this.nome = 'ToolRegistry';
    this.permissionCodes = new Set(permissionCodes || []);
    this.byName = new Map(); // nome -> Map(versão -> definição congelada)
  }

  /** @param {ToolDefinition} def */
  register(def) {
    const valida = validateDefinition(def, this.permissionCodes);
    const versoes = this.byName.get(valida.name) || new Map();
    if (versoes.has(valida.version)) throw invalid(valida.name, 'version', 'versao_ja_registrada', `Ferramenta ${valida.name} v${valida.version} já registrada.`);
    versoes.set(valida.version, valida);
    this.byName.set(valida.name, versoes);
    return valida;
  }

  registerAll(defs) {
    return defs.map((d) => this.register(d));
  }

  /** Versão pedida ou, sem ela, a mais nova. Devolve undefined se não existe. */
  get(name, version) {
    const versoes = this.byName.get(name);
    if (!versoes) return undefined;
    if (version !== undefined) return versoes.get(version);
    return versoes.get(Math.max(...versoes.keys()));
  }

  has(name) {
    return this.byName.has(name);
  }

  /** A versão mais nova de cada tool, em ordem alfabética. */
  list() {
    return [...this.byName.keys()].sort().map((n) => this.get(n));
  }

  /** Visão enxuta para o prompt, só das tools da allowlist do agente (nome, descrição e schema reduzido). */
  promptViewFor(allowedNames) {
    return (allowedNames || []).map((n) => this.get(n)).filter(Boolean).map(promptView);
  }

  /**
   * Mapa nome -> tool pronto para o executor (M9-D002/D018): execute com saída podada pelo outputSchema e, por padrão, toda
   * escrita marcada para aprovação (vira proposta). `allowDirectWrite(def)` é a decisão de M9-D019 para escrita de baixo risco.
   */
  /** @param {{ allowDirectWrite?: (def: ToolDefinition) => boolean }} [opcoes] */
  executorMap({ allowDirectWrite } = {}) {
    const mapa = Object.create(null);
    for (const def of this.list()) {
      const direta = def.category === 'WRITE' && !def.requiresHumanApproval && typeof allowDirectWrite === 'function' && allowDirectWrite(def) === true;
      mapa[def.name] = {
        ...def,
        requiresHumanApproval: def.requiresHumanApproval || (def.category === 'WRITE' && !direta),
        execute: async (ctx, input) => pruneOutput(def, await def.execute(ctx, input)),
      };
    }
    return mapa;
  }
}

module.exports = { ToolRegistry };
