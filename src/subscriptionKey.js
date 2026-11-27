'use strict';

const ORIGIN = 'https://saladofuturo.educacao.sp.gov.br';
const TTL_MS = 6 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CONFIG_PATHS = ['/assets/config.json', '/config.json', '/assets/env.json',
  '/assets/app-config.json', '/assets/config/config.json'];
const MAX_SCRIPTS = 20;
const MAX_SCRIPT_BYTES = 3_000_000;
const MAX_HTML_BYTES = 1_500_000;

const PATTERNS = [
  [3, /Ocp-Apim-Subscription-Key["'`]?\s*[:=]\s*["'`]([A-Za-z0-9]{16,64})["'`]/gi],
  [3, /["'`]Ocp-Apim-Subscription-Key["'`]\s*,\s*["'`]([A-Za-z0-9]{16,64})["'`]/gi],
  [2, /(?:apim|api)[_-]?subscription[_-]?key["'`]?\s*[:=]\s*["'`]([A-Za-z0-9]{16,64})["'`]/gi],
  [2, /subscription[_-]?key["'`]?\s*[:=]\s*["'`]([A-Za-z0-9]{16,64})["'`]/gi],
];

let cache = { key: null, at: 0 };
let inflight = null;

async function readText(url, limit) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return '';
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => {}); break; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function harvest(text, into) {
  for (const [peso, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const key = m[1].trim();
      into.set(key, (into.get(key) || 0) + peso);
    }
  }
}

function rank(candidates) {
  const lista = [...candidates.entries()].map(([key, score]) => ({
    key,
    score: score + (/^[a-f0-9]{32}$/i.test(key) ? 4 : 0),
  }));
  lista.sort((a, b) => b.score - a.score || b.key.length - a.key.length);
  return lista[0]?.key ?? null;
}

async function resolve() {
  const candidates = new Map();

  for (const path of CONFIG_PATHS) {
    const bruto = await readText(ORIGIN + path, MAX_HTML_BYTES).catch(() => '');
    if (bruto) harvest(bruto, candidates);
  }

  const html = await readText(ORIGIN + '/', MAX_HTML_BYTES).catch(() => '');
  if (html) {
    harvest(html, candidates);
    const urls = new Set();
    const tag = /<(?:script|link)[^>]+(?:src|href)=["']([^"']+\.js[^"']*)["']/gi;
    let m;
    while ((m = tag.exec(html)) !== null && urls.size < MAX_SCRIPTS) {
      try {
        const abs = new URL(m[1], ORIGIN + '/');
        if (abs.origin === ORIGIN) urls.add(abs.href);
      } catch { /* ignora */ }
    }
    for (const url of urls) {
      const bundle = await readText(url, MAX_SCRIPT_BYTES).catch(() => '');
      if (bundle) harvest(bundle, candidates);
    }
  }

  const achada = rank(candidates);
  if (achada) return achada;

  const env = (process.env.SED_SUBSCRIPTION_KEY || '').trim();
  if (env) return env;

  throw new Error('Não foi possível obter a subscription key.');
}

function get(force = false) {
  if (!force && cache.key && Date.now() - cache.at < TTL_MS) {
    return Promise.resolve({ key: cache.key, cached: true });
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const key = await resolve();
      cache = { key, at: Date.now() };
      return { key, cached: false };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function invalidate() {
  cache = { key: null, at: 0 };
}

module.exports = { get, invalidate };