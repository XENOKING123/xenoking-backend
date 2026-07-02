'use strict';

// AI description generator. Uses OpenAI or Google Gemini, whichever key the
// owner set (OPENAI_API_KEY or GEMINI_API_KEY). If neither is set, callers get
// a 501 and the extension falls back to its built-in clean template.

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const enabled = () => !!(OPENAI_KEY || GEMINI_KEY);

function buildPrompt(vehicle, instructions) {
  const v = vehicle || {};
  const facts = [
    ['Year', v.Year], ['Make', v.Make], ['Model', v.Model], ['Trim', v.Trim],
    ['Price', v.Price], ['Mileage', v['Mileage Value'] || v.MileageValue],
    ['Exterior', v['Exterior Color'] || v.ExteriorColor], ['Interior', v['Interior Color'] || v.InteriorColor],
    ['Drivetrain', v.Drivetrain], ['Transmission', v.Transmission], ['Engine', v.engine],
    ['Fuel', v.fuel_type], ['VIN', v.VIN], ['Stock #', v.stock_number],
  ].filter(([, val]) => val != null && String(val).trim() !== '')
    .map(([k, val]) => `${k}: ${val}`).join('\n');

  const style = (instructions && instructions.trim())
    ? `The seller's style instructions (follow these closely):\n"${instructions.trim()}"`
    : 'Keep it clean, friendly, and easy to read.';

  return `You write short Facebook Marketplace car listings that sound human, not robotic.

${style}

Rules:
- Sound natural and inviting, never corporate or spammy.
- Use a few tasteful emojis (not every line).
- ALWAYS include the price, mileage, and drivetrain if provided.
- Mention 2-3 appealing things about the car in plain language.
- Keep it to about 4-6 short lines. End with a simple call to action.
- Do not invent facts that aren't in the data. No markdown headings.

VEHICLE DATA:
${facts}

Write the listing description now.`;
}

async function viaOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 320,
    }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message || 'OpenAI error');
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
}

async function viaGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 320 } }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message || 'Gemini error');
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return (parts && parts.map((p) => p.text).join('') || '').trim();
}

async function describe(vehicle, instructions) {
  if (!enabled()) { const e = new Error('AI not configured'); e.code = 'ai_disabled'; throw e; }
  const prompt = buildPrompt(vehicle, instructions);
  const text = OPENAI_KEY ? await viaOpenAI(prompt) : await viaGemini(prompt);
  if (!text) throw new Error('empty AI response');
  return text;
}

module.exports = { describe, enabled };
