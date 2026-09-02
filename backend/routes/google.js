/**
 * SAN & CO. — backend/routes/google.js
 * Rotas de VERIFICAÇÃO — pra confirmar, pelo navegador ou por curl, que a
 * autorização do Google está funcionando, antes de qualquer agente do
 * Panteão começar a usar isso. Nenhuma delas é chamada pelo front-end
 * ainda; é só uma bancada de teste.
 *
 *   GET  /api/google/status           — a autorização existe?
 *   GET  /api/google/drive/recentes   — últimos arquivos do Drive
 *   GET  /api/google/gmail/recentes   — últimas mensagens da caixa de entrada
 *   POST /api/google/gmail/enviar     — envia um e-mail de teste
 *   GET  /api/google/agenda/proximos  — próximos compromissos
 *   POST /api/google/agenda/criar     — cria um compromisso de teste
 */

import { Router } from 'express';
import { listarArquivosRecentes } from '../services/driveService.js';
import { garantirEstruturaCompleta } from '../services/driveVault.js';
import { listarMensagensRecentes, enviarEmail } from '../services/gmailService.js';
import { listarProximosEventos, criarEvento } from '../services/calendarService.js';

const rotas = Router();

rotas.get('/status', (_req, resposta) => {
  resposta.json({ autorizado: Boolean(process.env.GOOGLE_REFRESH_TOKEN) });
});

rotas.get('/drive/recentes', async (_req, resposta) => {
  try {
    resposta.json(await listarArquivosRecentes());
  } catch (erro) {
    console.error('[google/drive]', erro.message);
    resposta.status(502).json({ erro: erro.message });
  }
});

/**
 * Cria (ou só confirma, se já existir) a estrutura inteira do Data Vault.
 * Rodar isto de novo depois da primeira vez não duplica nada — é
 * exatamente por isso que dá pra chamar via GET, sem risco.
 */
rotas.get('/drive/garantir-estrutura', async (_req, resposta) => {
  try {
    const mapa = await garantirEstruturaCompleta();
    resposta.json({ pastasGarantidas: Object.keys(mapa).length, mapa });
  } catch (erro) {
    console.error('[google/drive/garantir-estrutura]', erro.message);
    resposta.status(502).json({ erro: erro.message });
  }
});

rotas.get('/gmail/recentes', async (_req, resposta) => {
  try {
    resposta.json(await listarMensagensRecentes());
  } catch (erro) {
    console.error('[google/gmail]', erro.message);
    resposta.status(502).json({ erro: erro.message });
  }
});

rotas.post('/gmail/enviar', async (requisicao, resposta) => {
  const { para, assunto, corpo } = requisicao.body ?? {};
  if (!para || !assunto || !corpo) {
    return resposta.status(400).json({ erro: 'Campos obrigatórios: para, assunto, corpo.' });
  }
  try {
    resposta.json(await enviarEmail({ para, assunto, corpo }));
  } catch (erro) {
    console.error('[google/gmail/enviar]', erro.message);
    resposta.status(502).json({ erro: erro.message });
  }
});

rotas.get('/agenda/proximos', async (_req, resposta) => {
  try {
    resposta.json(await listarProximosEventos());
  } catch (erro) {
    console.error('[google/agenda]', erro.message);
    resposta.status(502).json({ erro: erro.message });
  }
});

rotas.post('/agenda/criar', async (requisicao, resposta) => {
  const { titulo, inicio, fim, local, descricao } = requisicao.body ?? {};
  if (!titulo || !inicio || !fim) {
    return resposta.status(400).json({ erro: 'Campos obrigatórios: titulo, inicio, fim.' });
  }
  try {
    resposta.json(await criarEvento({ titulo, inicio, fim, local, descricao }));
  } catch (erro) {
    console.error('[google/agenda/criar]', erro.message);
    resposta.status(502).json({ erro: erro.message });
  }
});

export default rotas;
