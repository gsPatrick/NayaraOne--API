# src/features/ai — a NAY

Pastas do livro: `providers/`, `agents/`, `tools/`, `retrieval/`, `memory/`, `evaluations/`, `budgets/`, mais `orchestrator/` e `readmodels/`. Serviços exportados por `index.js`: AiOrchestrator, ToolRegistry, RetrievalService, MemoryService, ModelRouter, AiEvaluationService.

- Rotas: `/v1/ai/*` (ordem: auth, tenant, requirePermission, aiGate, handler).
- Permissões: `ai:use`, `ai:read`, `ai:audit`, `ai:approve`, `ai:admin`, `ai:budget`, `ai:evaluate`, `ai:restricted`.
- Chave geral: `ia.habilitada` (padrão Desligado; alterar exige `ai:admin` e grava auditoria antes/depois). Por agente: `ai.agents.enabled`.
- Regra de arquitetura: `npm run ai:arch-guard` (M9-D001).
