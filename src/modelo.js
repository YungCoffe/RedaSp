'use strict';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT = 20_000;
const MAX_CANDIDATOS = 8;
const IGNORAR = /embedding|aqa|imagen|veo|tts|live|learnlm/i;
const RESERVA = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

let cache = { nome: null, at: 0 };
let inflight = null;

class ModeloError extends Error {}

function chave() {
  const valor = (process.env.GEMINI_API_KEY || '').trim();
  if (!valor) throw new ModeloError('GEMINI_API_KEY não configurada.');
  return valor;
}

function pontuar(nome) {
  let pontos = 0;
  if (/flash/i.test(nome)) pontos += 40;
  if (/pro/i.test(nome)) pontos += 20;
  if (/latest/i.test(nome)) pontos += 15;
  if (/lite/i.test(nome)) pontos -= 5;
  if (/preview|exp\b|experimental/i.test(nome)) pontos -= 10;
  const versao = /(\d+)\.(\d+)/.exec(nome);
  if (versao) pontos += Number(versao[1]) * 6 + Number(versao[2]);
  return pontos;
}

async function listar() {
  const url = `${BASE}?key=${encodeURIComponent(chave())}&pageSize=1000`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new ModeloError(`Catálogo indisponível (HTTP ${res.status}).`);

  let dados;
  try { dados = await res.json(); } catch { throw new ModeloError('Catálogo não reconhecido.'); }
  if (!dados || !Array.isArray(dados.models)) throw new ModeloError('Catálogo não reconhecido.');

  return dados.models
    .map((m) => ({ nome: String(m.name || '').replace(/^models\//, ''), metodos: m.supportedGenerationMethods }))
    .filter((m) => m.nome && !IGNORAR.test(m.nome))
    .filter((m) => Array.isArray(m.metodos) && m.metodos.includes('generateContent'))
    .map((m) => m.nome)
    .sort((a, b) => pontuar(b) - pontuar(a));
}

async function testar(nome) {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(nome)}:generateContent?key=${encodeURIComponent(chave())}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
        generationConfig: { maxOutputTokens: 256, temperature: 0 },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return false;
    const dados = await res.json().catch(() => null);
    return Array.isArray(dados?.candidates) && dados.candidates.length > 0;
  } catch {
    return false;
  }
}

async function resolver() {
  chave();
  const preferido = (process.env.GEMINI_MODEL || '').trim();

  let lista = [];
  try { lista = await listar(); } catch { lista = []; }

  const ordem = [...new Set([preferido, ...lista].filter(Boolean))].slice(0, MAX_CANDIDATOS + 1);
  for (const nome of ordem) {
    if (await testar(nome)) return nome;
  }
  return preferido || ordem[0] || RESERVA[0];
}

function get(force = false) {
  if (!force && cache.nome && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.nome);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const nome = await resolver();
      cache = { nome, at: Date.now() };
      return nome;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function invalidar() {
  cache = { nome: null, at: 0 };
}

module.exports = { get, invalidar, ModeloError };
