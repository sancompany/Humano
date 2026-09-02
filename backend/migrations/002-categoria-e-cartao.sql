-- ============================================================================
-- SAN & CO. — Migração 002: categoria de gasto + tipo/limite de cartão
--
-- Por que existe: financasRepo.js foi escrito para um desenho
-- (conexoes -> contas -> movimentos) que nunca virou schema real. O
-- schema-supabase.sql real já é mais simples (perfil direto em `contas` e
-- `movimentos`, sem tabela `conexoes`) — essa é a versão que vence, por já
-- estar criada e testada no Supabase. Esta migração só ADICIONA 3 colunas
-- que faltavam para o que já foi construído no front:
--   - movimentos.categoria: a categorização de gastos (Pluggy, traduzida)
--     já está pronta no front, mas não tinha onde persistir
--   - contas.tipo / limite_total / fatura_aberta: a tela de Faturas já
--     existe no front, mas as colunas para ela nunca foram criadas
--
-- A tabela `conexoes` (consentimento por integração Pluggy) fica de fora
-- de propósito — só faz sentido quando a Pluggy conectar de verdade,
-- sessão separada e já combinada. financasRepo.js foi reescrito para não
-- depender dela por enquanto.
--
-- COMO RODAR: cole no SQL Editor do Supabase e execute — é aditivo, não
-- apaga nem modifica dado nenhum que já exista.
-- ============================================================================

ALTER TABLE movimentos ADD COLUMN IF NOT EXISTS categoria TEXT;

ALTER TABLE contas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'corrente'
  CHECK (tipo IN ('corrente', 'credito'));
ALTER TABLE contas ADD COLUMN IF NOT EXISTS limite_total NUMERIC;
ALTER TABLE contas ADD COLUMN IF NOT EXISTS fatura_aberta NUMERIC;
