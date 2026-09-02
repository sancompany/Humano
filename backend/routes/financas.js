/**
 * SAN & CO. — backend/routes/financas.js
 * Ponte entre o front (js/dados.js) e financasRepo.js.
 *
 * O formato de saída de GET /resumo e GET /investimentos precisa bater
 * exatamente com o que normalizarFinanceiro() e normalizarInvestimentos()
 * esperam em js/dados.js — qualquer mudança de forma aqui exige revisar
 * os dois lados juntos, não só este arquivo.
 */

import { Router } from 'express';
import {
  obterResumoFinanceiro,
  listarInvestimentos,
  gravarImportacaoOfx
} from '../services/financasRepo.js';

const router = Router();

function perfilValido(perfil) {
  return perfil === 'PF' || perfil === 'PJ';
}

/** GET /api/financas/resumo?perfil=PF */
router.get('/resumo', async (req, res) => {
  const { perfil } = req.query;
  if (!perfilValido(perfil)) {
    return res.status(400).json({ erro: 'parâmetro perfil precisa ser PF ou PJ' });
  }

  try {
    const resumo = await obterResumoFinanceiro({ perfil });
    res.json(resumo);
  } catch (erro) {
    console.error('[financas] GET /resumo', erro);
    res.status(500).json({ erro: erro.message });
  }
});

/** GET /api/financas/investimentos?perfil=PF */
router.get('/investimentos', async (req, res) => {
  const { perfil } = req.query;
  if (!perfilValido(perfil)) {
    return res.status(400).json({ erro: 'parâmetro perfil precisa ser PF ou PJ' });
  }

  try {
    const ativos = await listarInvestimentos({ perfil });
    // normalizarInvestimentos() no front deriva totalInvestido/alocação a
    // partir de `ativos` sozinho — não precisa vir pronto daqui
    res.json({ origem: 'supabase', ativos });
  } catch (erro) {
    console.error('[financas] GET /investimentos', erro);
    res.status(500).json({ erro: erro.message });
  }
});

/**
 * POST /api/financas/importar-ofx
 * Body: { perfil: 'PF'|'PJ', conta: object|null, movimentos: object[] }
 * Chamado pelo front logo depois de ler um .OFX (ver
 * persistirImportacaoOfx() em js/dados.js) — grava o que já foi
 * deduplicado em memória no front; upsert por id garante que reimportar
 * o mesmo extrato não duplica nada aqui também.
 */
router.post('/importar-ofx', async (req, res) => {
  const { perfil, conta, movimentos } = req.body ?? {};

  if (!perfilValido(perfil)) {
    return res.status(400).json({ erro: 'perfil precisa ser PF ou PJ' });
  }
  if (!Array.isArray(movimentos)) {
    return res.status(400).json({ erro: 'movimentos precisa ser um array' });
  }

  try {
    const resultado = await gravarImportacaoOfx({ perfil, conta: conta ?? null, movimentos });
    res.json({ ok: true, ...resultado });
  } catch (erro) {
    console.error('[financas] POST /importar-ofx', erro);
    res.status(500).json({ erro: erro.message });
  }
});

export default router;
