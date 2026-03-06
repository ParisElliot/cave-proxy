/**
 * Proxy Vercel → Groq API
 * Route unique : POST /api/ai
 * La clé Groq reste côté serveur dans GROQ_API_KEY
 *
 * Corps attendu : { type: "enrich" | "label" | "price", ...payload }
 */

const GROQ_KEY  = process.env.GROQ_API_KEY;
const GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions";
const MODEL_TEXT = "llama-3.3-70b-versatile";          // texte + recherche
const MODEL_VIS  = "meta-llama/llama-4-scout-17b-16e-instruct"; // vision

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

async function groqText(prompt) {
  const res = await fetch(GROQ_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_TEXT,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) {
    console.error("Groq text error:", JSON.stringify(data.error));
    throw new Error(data.error.message);
  }
  return data.choices?.[0]?.message?.content || "";
}

async function groqVision(base64, mimeType, prompt) {
  const res = await fetch(GROQ_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_VIS,
      temperature: 0.1,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  const data = await res.json();
  if (data.error) {
    console.error("Groq vision error:", JSON.stringify(data.error));
    throw new Error(data.error.message);
  }
  const text = data.choices?.[0]?.message?.content || "";
  console.log("Groq vision response:", text.slice(0, 200));
  return text;
}

function parseJson(txt) {
  try {
    const clean = txt.replace(/```json|```/g, "").trim();
    const m = clean.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : clean);
  } catch {
    return {};
  }
}

// ── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, corsHeaders());
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (!GROQ_KEY) {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: "GROQ_API_KEY non configurée sur le serveur" }));
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.writeHead(400, corsHeaders());
    res.end(JSON.stringify({ error: "Corps JSON invalide" }));
    return;
  }

  try {
    let result = {};

    // ── 1. Enrichissement par nom ─────────────────────────────────────────
    if (body.type === "enrich") {
      const { name, year } = body;
      const currentYear = new Date().getFullYear();
      const prompt = `Tu es un expert en vins. Donne les informations précises sur ce vin :
Vin : "${name}"${year ? " millésime " + year : ""}

IMPORTANT : 
- "grape" doit TOUJOURS être renseigné avec les cépages réels (ex: "Merlot 70%, Cabernet Franc 30%")
- "kF" = année à partir de laquelle boire = ${currentYear} si le vin est déjà prêt, sinon l'année réelle
- "kT" = année limite de consommation
- "pF" et "pT" = fenêtre d'apogée

Réponds JSON UNIQUEMENT, sans markdown, sans commentaire :
{"domain":"producteur","region":"région","app":"appellation","country":"France","grape":"cépages et pourcentages","kF":${currentYear},"kT":2038,"pF":2026,"pT":2032,"decant":60,"temp":16,"food":"accords mets-vins","notes":"description courte du vin","currentPrice":75,"priceSource":"estimation","priceTrend":"hausse|stable|baisse"}`;
      const txt = await groqText(prompt);
      result = parseJson(txt);

    // ── 2. Analyse d'étiquette (vision) ──────────────────────────────────
    } else if (body.type === "label") {
      const { base64, mimeType } = body;
      const currentYear = new Date().getFullYear();
      const prompt = `Tu es un expert en vins. Analyse cette étiquette et extrais toutes les informations visibles.

IMPORTANT :
- "grape" doit TOUJOURS être renseigné avec les cépages réels du vin identifié
- "kF" = ${currentYear} si le vin est déjà prêt à boire, sinon l'année réelle
- "kT" = année limite de consommation estimée

Réponds JSON UNIQUEMENT, sans markdown :
{"name":"nom/cuvée","domain":"domaine","year":2018,"type":"red|white|rose|champagne|orange|sweet|fortified|other","region":"région","app":"appellation","country":"pays","format":750,"grape":"cépages et pourcentages réels","kF":${currentYear},"kT":2035,"pF":2026,"pT":2030,"decant":90,"temp":17,"food":"accords","notes":"description","currentPrice":85,"priceSource":"estimation","priceTrend":"hausse|stable|baisse"}`;
      const txt = await groqVision(base64, mimeType, prompt);
      result = parseJson(txt);

    // ── 3. Recherche de prix ──────────────────────────────────────────────
    } else if (body.type === "price") {
      const { name, year, domain, app, region } = body;
      const prompt = `Tu es un expert en vins. Estime le prix actuel marché 2025-2026 de ce vin :
"${name}"${year ? " " + year : ""}${domain ? " · " + domain : ""}${app ? " · " + app : (region ? " · " + region : "")}

Base-toi sur ta connaissance des prix Wine-Searcher, iDealwine, Millésima.
Réponds JSON UNIQUEMENT, sans markdown :
{"currentPrice":85,"priceRange":"70-100€","priceSource":"estimation experte","trend":"hausse|stable|baisse","priceNote":"contexte court"}`;
      const txt = await groqText(prompt);
      result = parseJson(txt);

    } else {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: "type inconnu : enrich | label | price" }));
      return;
    }

    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify(result));

  } catch (err) {
    console.error("Proxy error:", err);
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: err.message || "Erreur serveur" }));
  }
}
