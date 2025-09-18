import AnchorBrowser from "anchorbrowser";
import { chromium } from "playwright";
import { fetch } from "undici";
import { setTimeout as delay } from "node:timers/promises";
import { GoogleGenerativeAI } from "@google/generative-ai"; // <-- Gemini

try {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: ".env.local" });
} catch { /* ok if using --env-file */ }

// ---------- Config flags ----------
const KEEP_SESSION_ON_SUCCESS = process.env.KEEP_SESSION_ON_SUCCESS === "true";
const CLOSE_ON_ERROR = process.env.CLOSE_ON_ERROR !== "false";
const USE_GEMINI_TEXT_GEN = process.env.USE_GEMINI_TEXT_GEN === "true";

const GEMINI_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-1.5-flash"; // or gemini-1.5-pro

const TRUSTED_DOMAINS = [
  ".gov", ".edu", "nature.com", "nejm.org", "who.int", "nasa.gov",
  "nih.gov", "worldbank.org", "un.org", "ft.com", "economist.com",
  "reuters.com", "apnews.com", "npr.org", "bmj.com", "aaai.org",
];
const MIN_YEAR = 2012;

// ---------- Search + ranking ----------
async function serperSearch(query, k = 12, gl = "us") {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("Missing SERPER_API_KEY.");
  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: k, gl })
  });
  if (!r.ok) throw new Error(`Serper error ${r.status}`);
  const data = await r.json();
  return (data.organic || []).slice(0, k).map(o => ({
    title: o.title, url: o.link, snippet: o.snippet, date: o.date || o.dateUtc
  }));
}

function rankAndPickFive(results) {
  const score = (it) => {
    const url = (it.url || "").toLowerCase();
    const title = (it.title || "").toLowerCase();
    const trust = TRUSTED_DOMAINS.some(d => url.includes(d)) ? 2 : 0;
    let recency = 0;
    if (it.date) {
      const y = new Date(it.date).getFullYear();
      if (!Number.isNaN(y) && y >= MIN_YEAR) recency = 0.2 * (y - MIN_YEAR);
    }
    const clickbaitPenalty = /(top |things you|ultimate guide|what is)/.test(title) ? -0.5 : 0;
    return trust + recency + clickbaitPenalty;
  };
  return results
    .filter(r => r.title && r.url)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 5);
}

// ---------- Paper drafting (template + Gemini) ----------
function makeTemplatePaper(topic, sources) {
  const refs = sources.map((s, i) => {
    let d = "";
    if (s.date) {
      const dt = new Date(s.date);
      if (!Number.isNaN(dt.getTime())) d = ` (${dt.toISOString().slice(0,10)})`;
    }
    return `[${i + 1}] ${s.title || "Untitled"}${d} — ${s.url || ""}`;
  }).join("\n");

  return `${topic}: A Brief Research Summary

Thesis — This paper summarizes current understanding of "${topic}" by synthesizing findings from reputable sources, noting areas of agreement and uncertainty.

Background
Recent literature and institutional reporting provide context for ${topic}. Key sources include policy or research institutions and well-established publishers [1]–[5]. Where sources diverge, differences often reflect scope, methodology, or publication timing.

Evidence & Discussion
Across the surveyed materials, themes recur. Foundational descriptions appear consistent across primary outlets [1][2]. Empirical, data-backed analyses add quantitative perspective and trend lines [3][4]. Respected news or trade outlets bridge research to implementation details and real-world constraints [5]. Together, these suggest that while consensus exists on core mechanisms and risks/benefits, open questions remain around scale effects, measurement standards, and edge cases.

Implications
The sources indicate practical implications for decision-makers: clarify goals/metrics early; choose methods aligned to scale and context; and track secondary impacts over time. For practitioners, favor transparent methodologies and cross-validate results with at least one independent dataset or review when feasible.

Conclusion
The preponderance of evidence supports a balanced, evidence-first posture on ${topic}. Future work should prioritize standardized evaluation frameworks and transparent reporting to minimize conflicting claims and accelerate learning.

References
${refs}
`;
}

async function makeGeminiPaper(topic, sources) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY; // support either var
  if (!key || !USE_GEMINI_TEXT_GEN) return makeTemplatePaper(topic, sources);

  const refs = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n");
  const prompt = `
Write ~500 words on "${topic}" in clear, neutral prose for a general audience.
Cite inline using [1]-[5] where appropriate.
End with a "References" section listing these five sources verbatim.

Sources:
${refs}`.trim();

  try {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const resp = await model.generateContent([{ text: prompt }]);
    const text = resp?.response?.text?.();
    return (typeof text === "function" ? text() : text) || makeTemplatePaper(topic, sources);
  } catch (e) {
    console.warn("Gemini drafting failed; using template. Error:", e?.message || e);
    return makeTemplatePaper(topic, sources);
  }
}

// ---------- HITL login ----------
async function ensureLoggedIn({ page, liveUrl, loginTimeoutMs = 10 * 60_000 }) {
  console.log(`\nOpen Live View and complete Google login:\n${liveUrl}\n`);
  await page.goto(
    "https://accounts.google.com/ServiceLogin?service=wise&continue=https://docs.google.com/document/u/0/",
    { waitUntil: "load", timeout: 60_000 }
  );

  const start = Date.now();
  while (Date.now() - start < loginTimeoutMs) {
    try {
      await page.waitForURL(/docs\.google\.com\/document/i, { timeout: 5_000 });
      break;
    } catch { /* still logging in */ }
  }
  if (!/docs\.google\.com\/document/i.test(page.url())) {
    throw new Error("Login timeout waiting for docs.google.com/document after HITL.");
  }
  console.log("✅ Google login detected. Continuing…");
}

// ---------- Write to Docs ----------
async function openDocsAndWrite({ page, title, paper }) {
  await page.goto("https://docs.new", { waitUntil: "domcontentloaded", timeout: 60_000 });

  try { await page.getByRole("button", { name: /blank/i }).first().click({ timeout: 5_000 }); } catch {}
  await delay(1200);
  await page.keyboard.press(process.platform === "win32" ? "Control+Home" : "Meta+Home");
  await page.keyboard.type(paper, { delay: 1 });

  try {
    const titleBox = page.getByRole("textbox", { name: /untitled document/i });
    await titleBox.click({ timeout: 5_000 });
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
  } catch {}
}

// ---------- Main ----------
async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  if (!topic) {
    console.error('Usage: node --env-file=.env.local anchor_operator_researcher.mjs "Your topic"');
    process.exit(1);
  }
  if (!process.env.ANCHOR_API_KEY) {
    throw new Error("Missing ANCHOR_API_KEY.");
  }

  let client, session, browser;
  try {
    // 1) Search + pick 5
    const filterQ = `${topic} site:.gov OR site:.edu OR site:nature.com OR site:who.int OR site:nih.gov OR site:reuters.com OR site:economist.com OR site:npr.org`;
    const raw = await serperSearch(filterQ, 12, "us");
    const picks = rankAndPickFive(raw);

    console.log("\n===== Curated Sources (5) =====");
    picks.forEach((s, i) => console.log(`[${i + 1}] ${s.title} — ${s.url}`));

    // 2) Draft with Gemini (or fallback template)
    const paper = await makeGeminiPaper(topic, picks);
    const niceTitle = `Auto Research: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

    // 3) Anchor session + Live View + connect to Playwright
    client = new AnchorBrowser({ apiKey: process.env.ANCHOR_API_KEY });

    // Example session options; adjust as needed (see Anchor docs)
    session = await client.sessions.create({
      browser: { headless: { active: false } }
    });

    const sessionId = session.data.id;
    const liveUrl = session.data.live_view_url;
    console.log(`\nLive View: ${liveUrl}`);
    console.log(`Session ID: ${sessionId}`);

    browser = await client.browser.connect(sessionId);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();

    // 4) HITL login
    await ensureLoggedIn({ page, liveUrl });

    // 5) Write paper
    await openDocsAndWrite({ page, title: niceTitle, paper });

    console.log("\n✅ Done. Paper typed in Google Docs.");

    if (!KEEP_SESSION_ON_SUCCESS) {
      await client.sessions.end(sessionId).catch(()=>{});
      console.log("🔚 Session ended (success).");
    } else {
      console.log("ℹ️ Session kept alive (KEEP_SESSION_ON_SUCCESS=true).");
    }
  } catch (err) {
    console.error("\n❌ Error:", err?.message || err);
    if (CLOSE_ON_ERROR && client && session?.data?.id) {
      try { await client.sessions.end(session.data.id, { reason: "error" }); } catch {}
      console.log("🔚 Session ended due to error.");
    }
    process.exit(1);
  }
}

main();
