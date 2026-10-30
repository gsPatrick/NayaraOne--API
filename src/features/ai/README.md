# src/features/ai — a NAY

Pastas do livro: `providers/`, `agents/`, `tools/`, `retrieval/`, `memory/`, `evaluations/`, `budgets/`, mais `orchestrator/` e `readmodels/`. Serviços exportados por `index.js`: AiOrchestrator, ToolRegistry, RetrievalService, MemoryService, ModelRouter, AiEvaluationService.

- Rotas: `/v1/ai/*` (ordem: auth, tenant, requirePermission, aiGate, handler).
- Permissões: `ai:use`, `ai:read`, `ai:audit`, `ai:approve`, `ai:admin`, `ai:budget`, `ai:evaluate`, `ai:restricted`.
- Chave geral: `ia.habilitada` (padrão Desligado; alterar exige `ai:admin` e grava auditoria antes/depois). Por agente: `ai.agents.enabled`.
- IA fora (M9-D228): `deterministic/` guarda o caminho determinístico equivalente de cada tool, agente e da busca do RAG (`GET /v1/ai/deterministic`, `POST /v1/ai/deterministic/:tool`); `runAiFunction` o aciona por `withAiFallback`. Função nova com IA precisa de entrada em `deterministic.catalog.js` (o teste de cobertura reprova sem ela).
- Regra de arquitetura: `npm run ai:arch-guard` (M9-D001).
