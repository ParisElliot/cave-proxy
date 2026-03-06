/**
 * Proxy Vercel → Gemini API
 * Route unique : POST /api/ai
 * La clé Gemini reste côté serveur dans la variable d'environnement GEMINI_API_KEY
 *
 * Corps attendu (JSON) :
 *   { type: "enrich" | "label" | "price", ...payload }
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL_TEXT  = "gemini-2.0-flash-lite";   // texte + grounding — free tier
const MODEL_VIS   = "gemini-2.0-flash-lite";   // vision — free tier

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

async function geminiText(prompt, useGrounding = true) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };
  if (useGrounding) {
    body.tools = [{ google_search: {} }];
  }
  const url = `${GEMINI_BASE}/${MODEL_TEXT}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
}

async function geminiVision(base64, mimeType, prompt) {
  const body = {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
  };
  const url = `${GEMINI_BASE}/${MODEL_VIS}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    console.error("Gemini Vision error:", JSON.stringify(data.error));
    throw new Error(data.error.message);
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  console.log("Gemini Vision response:", text.slice(0, 200));
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
  // CORS preflight
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

  if (!GEMINI_KEY) {
    res.writeHead(500, corsHeaders());
    res.end(JSON.stringify({ error: "GEMINI_API_KEY non configurée sur le serveur" }));
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

    // ── 1. Enrichissement par nom (web search) ────────────────────────────
    if (body.type === "enrich") {
      const { name, year } = body;
      const prompt = `Vin : "${name}"${year ? " millésime " + year : ""}
Recherche ses informations précises sur Wine-Searcher, iDealwine, Millésima ou le site du domaine.
Réponds JSON UNIQUEMENT, sans markdown, sans commentaire :
{"domain":"producteur","region":"région","app":"appellation","country":"France","grape":"cépages %","kF":2020,"kT":2038,"pF":2026,"pT":2032,"decant":60,"temp":16,"food":"accords mets-vins","notes":"description courte du vin","currentPrice":75,"priceSource":"Wine-Searcher","priceTrend":"hausse|stable|baisse"}`;
      const txt = await geminiText(prompt, true);
      result = parseJson(txt);

    // ── 2. Analyse d'étiquette (vision) ──────────────────────────────────
    } else if (body.type === "label") {
      const { base64, mimeType } = body;
      const prompt = `Analyse cette étiquette de vin. Réponds JSON UNIQUEMENT, sans markdown :
{"name":"nom/cuvée","domain":"domaine","year":2018,"type":"red|white|rose|champagne|orange|sweet|fortified|other","region":"région","app":"appellation","country":"pays","format":750,"grape":"cépages %","kF":2022,"kT":2035,"pF":2026,"pT":2030,"decant":90,"temp":17,"food":"accords","notes":"description","currentPrice":85,"priceSource":"source","priceTrend":"hausse|stable|baisse"}`;
      const txt = await geminiVision(base64, mimeType, prompt);
      result = parseJson(txt);

    // ── 3. Recherche de prix (web search) ────────────────────────────────
    } else if (body.type === "price") {
      const { name, year, domain, app, region } = body;
      const prompt = `Prix actuel marché 2025-2026 du vin : "${name}"${year ? " " + year : ""}${domain ? " · " + domain : ""}${app ? " · " + app : (region ? " · " + region : "")}
Cherche sur Wine-Searcher, iDealwine, Millésima, cavistes en ligne.
Réponds JSON UNIQUEMENT, sans markdown :
{"currentPrice":85,"priceRange":"70-100€","priceSource":"Wine-Searcher","trend":"hausse|stable|baisse","priceNote":"contexte court"}`;
      const txt = await geminiText(prompt, true);
      result = parseJson(txt);

    } else {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: "type inconnu : utilisez enrich | label | price" }));
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
