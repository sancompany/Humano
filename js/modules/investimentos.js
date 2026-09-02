/**
 * SAN & CO. — sub-tela Patrimônio (dentro do módulo Finanças)
 *
 * NÃO É UMA ABA. Não tem rota própria nem item na barra inferior: quem o
 * monta é o financeiro.js, na rota #/financas/patrimonio. Por isso este
 * arquivo não desenha cabeçalho, seletor PF/PJ nem título — tudo isso é do
 * financeiro.js, e vale para as duas sub-telas.
 *
 * O contrato aqui é reduzido de propósito:
 *   render()        -> devolve só o conteúdo, sem casca
 *   mount(regiao)   -> assina o estado e desenha
 *   unmount()       -> cancela tudo
 *
 * Estrutura do conteúdo
 *   1. Header de patrimônio: total investido, liquidez imediata e variação do mês.
 *   2. Alocação por categoria, em barras percentuais.
 *   3. Tabela de ativos com aplicado, atual e rentabilidade em reais e em %.
 *
 * Segue as mesmas regras do módulo financeiro: números grandes em branco com
 * faixa colorida embaixo, valores pequenos com a cor no próprio texto, e
 * R$ ---.---,-- onde o dado ainda não existe. Os dados vêm de
 * js/dados.js, que já normaliza PF, PJ, mock e .OFX na mesma forma.
 */

import { estado, observar, abrirDetalhe } from '../state.js';
import { carregarInvestimentos, moldeInvestimentos } from '../dados.js';
import { corDoBanco } from '../bancos.js';

/* ==================================================================
   1. FORMATAÇÃO
   ================================================================== */
const FORMATO_BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2
});

const VALOR_VAZIO = 'R$ ---.---,--';
const PCT_VAZIO = '---,--%';

function brl(valor, { sinal = false } = {}) {
  if (!Number.isFinite(valor)) return VALOR_VAZIO;
  const texto = FORMATO_BRL.format(Math.abs(valor));
  if (!sinal) return texto;
  return `${valor >= 0 ? '+' : '−'}\u00A0${texto}`;
}

function brlHtml(valor, opcoes) {
  const texto = brl(valor, opcoes);
  return texto === VALOR_VAZIO
    ? `<span class="valor-vazio" aria-label="valor não carregado">${texto}</span>`
    : texto;
}

function pct(valor, { sinal = true } = {}) {
  if (!Number.isFinite(valor)) return `<span class="valor-vazio">${PCT_VAZIO}</span>`;
  const numero = Math.abs(valor).toFixed(2).replace('.', ',');
  return sinal ? `${valor >= 0 ? '+' : '−'}${numero}%` : `${numero}%`;
}

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ==================================================================
   2. FRAGMENTOS
   ================================================================== */

/** Cor da faixa de cada categoria — a mesma da paleta semântica do app. */
const COR_CATEGORIA = {
  'Renda Fixa':         'var(--info)',
  'Renda Variável':     'var(--indigo)',
  'Fundos/Previdência': 'var(--success)',
  'Cripto/Outros':      'var(--violeta)'
};

function htmlPatrimonio(dados) {
  const variacaoBoa = Number.isFinite(dados.variacaoMes) && dados.variacaoMes >= 0;

  return `
    <div class="fin-cards fin-cards--tres">
      <article class="card-exec" data-clickable="true" role="button" tabindex="0"
               data-detalhe="patrimonio" data-id="investido"
               aria-label="Total investido: ${brl(dados.totalInvestido)}. Abrir detalhamento.">
        <header class="card-exec__topo">
          <span class="card-exec__label">Total investido</span>
        </header>
        <p class="card-exec__valor">${brlHtml(dados.totalInvestido)}</p>
        <span class="card-exec__faixa card-exec__faixa--neutro" aria-hidden="true"></span>
        <p class="card-exec__sub">${dados.ativos.length} ativo${dados.ativos.length === 1 ? '' : 's'} em carteira</p>
      </article>

      <article class="card-exec" data-clickable="true" role="button" tabindex="0"
               data-detalhe="patrimonio" data-id="liquidez"
               aria-label="Liquidez imediata: ${brl(dados.liquidezImediata)}. Abrir detalhamento.">
        <header class="card-exec__topo">
          <span class="card-exec__label">Liquidez imediata</span>
        </header>
        <p class="card-exec__valor">${brlHtml(dados.liquidezImediata)}</p>
        <span class="card-exec__faixa card-exec__faixa--positivo" aria-hidden="true"></span>
        <p class="card-exec__sub">Saldo em conta, disponível hoje</p>
      </article>

      <article class="card-exec" data-clickable="true" role="button" tabindex="0"
               data-detalhe="patrimonio" data-id="rendimento"
               aria-label="Variação do mês: ${Number.isFinite(dados.variacaoMes) ? dados.variacaoMes.toFixed(2) + '%' : 'não carregada'}.">
        <header class="card-exec__topo">
          <span class="card-exec__label">Variação do mês</span>
        </header>
        <p class="card-exec__valor">${pct(dados.variacaoMes)}</p>
        <span class="card-exec__faixa card-exec__faixa--${
          !Number.isFinite(dados.variacaoMes) ? 'neutro' : variacaoBoa ? 'positivo' : 'negativo'
        }" aria-hidden="true"></span>
        <p class="card-exec__sub">Rendimento da carteira no período</p>
      </article>
    </div>
  `;
}

function htmlAlocacao(dados) {
  const comValor = dados.alocacao.filter((a) => a.quantidade > 0);

  if (!comValor.length) {
    return '<p class="extrato__vazio">Alocação indisponível até a primeira sincronização.</p>';
  }

  const barras = comValor.map((faixa) => `
    <li class="alocacao__item">
      <div class="alocacao__topo">
        <span class="alocacao__nome" style="color: ${COR_CATEGORIA[faixa.categoria]}">
          ${faixa.categoria}
        </span>
        <span class="alocacao__pct">${pct(faixa.percentual, { sinal: false })}</span>
      </div>
      <div class="alocacao__trilho">
        <span class="alocacao__barra"
              style="width: ${Number.isFinite(faixa.percentual) ? faixa.percentual.toFixed(1) : 0}%;
                     background: ${COR_CATEGORIA[faixa.categoria]}"></span>
      </div>
      <span class="alocacao__valor">${brlHtml(faixa.valor)}</span>
    </li>
  `).join('');

  return `<ul class="alocacao">${barras}</ul>`;
}

function htmlAtivos(dados) {
  if (!dados.ativos.length) {
    return '<p class="extrato__vazio">Nenhum ativo carregado neste perfil.</p>';
  }

  const linhas = dados.ativos.map((ativo) => {
    const lucro = Number.isFinite(ativo.rentabilidade_reais) && ativo.rentabilidade_reais >= 0;
    const classe = !Number.isFinite(ativo.rentabilidade_reais)
      ? '' : lucro ? 'ativo__rent--positiva' : 'ativo__rent--negativa';

    return `
      <li class="ativo" data-clickable="true" role="button" tabindex="0"
          data-detalhe="ativo" data-id="${ativo.id}"
          aria-label="${escapar(ativo.nome)}, valor atual ${brl(ativo.valor_atual)}.">
        <span class="ativo__marca" aria-hidden="true"
              style="background: ${corDoBanco(ativo.instituicao)}"></span>

        <span class="ativo__corpo">
          <span class="ativo__nome">${escapar(ativo.nome)}</span>
          <span class="ativo__meta">
            <span style="color: ${corDoBanco(ativo.instituicao)}">${escapar(ativo.instituicao)}</span>
            <span class="ativo__categoria">${escapar(ativo.categoria)}</span>
          </span>
        </span>

        <span class="ativo__numeros">
          <span class="ativo__atual">${brlHtml(ativo.valor_atual)}</span>
          <span class="ativo__aplicado">aplicado ${brl(ativo.valor_aplicado)}</span>
          <span class="ativo__rent ${classe}">
            ${brlHtml(ativo.rentabilidade_reais, { sinal: true })}
            · ${pct(ativo.rentabilidade_pct)}
          </span>
        </span>
      </li>
    `;
  }).join('');

  return `<ul class="ativos">${linhas}</ul>`;
}

/* ==================================================================
   3. MÓDULO
   ================================================================== */
let raiz = null;
let cancelarObservadores = [];
let aoClicar = null;
let aoTeclar = null;
let fichaAtual = 0;

async function sincronizar({ animar = true } = {}) {
  if (!raiz) return;

  const perfil = estado.perfil;
  const ficha = ++fichaAtual;
  const dados = await carregarInvestimentos(perfil);

  if (ficha !== fichaAtual || !raiz) return;   // troca de perfil no meio da busca

  raiz.querySelector('[data-regiao="patrimonio"]').innerHTML = htmlPatrimonio(dados);
  raiz.querySelector('[data-regiao="alocacao"]').innerHTML = htmlAlocacao(dados);
  raiz.querySelector('[data-regiao="ativos"]').innerHTML = htmlAtivos(dados);

  if (animar) {
    raiz.querySelectorAll('.card-exec__valor').forEach((valor) => {
      valor.classList.remove('valor--pulso');
      void valor.offsetWidth;
      valor.classList.add('valor--pulso');
    });
  }
}

function despacharDetalhe(alvo) {
  const { detalhe, id } = alvo.dataset;
  if (!detalhe) return;
  abrirDetalhe(detalhe, { id, perfil: estado.perfil });

  // sem o id na URL, a tela de detalhe não tem como saber QUAL ativo
  // mostrar — mesmo bug que já corrigimos em financeiro.js, mas que nunca
  // tinha sido replicado aqui
  const caminho = id ? `${detalhe}/${encodeURIComponent(id)}` : detalhe;
  window.location.hash = `#/financas/detalhe/${caminho}`;
}

const investimentos = {
  id: 'patrimonio',
  titulo: 'Patrimônio',

  /** Conteúdo da sub-tela, sem cabeçalho: o financeiro.js já desenhou o dele. */
  render() {
    const bloco = document.createElement('div');
    bloco.dataset.subtela = this.id;

    bloco.innerHTML = `
      <div data-regiao="patrimonio"></div>

      <section class="section">
        <p class="section__label">Alocação de ativos</p>
        <div data-regiao="alocacao"></div>
      </section>

      <section class="section">
        <p class="section__label">Ativos em carteira</p>
        <div data-regiao="ativos"></div>
      </section>
    `;

    return bloco;
  },

  mount(view) {
    raiz = view;

    aoClicar = (evento) => {
      const clicavel = evento.target.closest('[data-clickable="true"]');
      if (clicavel) despacharDetalhe(clicavel);
    };

    aoTeclar = (evento) => {
      if (evento.key !== 'Enter' && evento.key !== ' ') return;
      const clicavel = evento.target.closest('[data-clickable="true"]');
      if (!clicavel) return;
      evento.preventDefault();
      despacharDetalhe(clicavel);
    };

    view.addEventListener('click', aoClicar);
    view.addEventListener('keydown', aoTeclar);

    cancelarObservadores = [observar('perfil', () => sincronizar())];

    sincronizar({ animar: false });
  },

  unmount() {
    cancelarObservadores.forEach((cancelar) => cancelar());
    cancelarObservadores = [];
    if (raiz) {
      raiz.removeEventListener('click', aoClicar);
      raiz.removeEventListener('keydown', aoTeclar);
    }
    aoClicar = null;
    aoTeclar = null;
    raiz = null;
    fichaAtual += 1;   // invalida qualquer busca ainda no ar
  }
};

export default investimentos;
