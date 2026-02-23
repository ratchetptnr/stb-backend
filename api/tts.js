/**
 * Vercel Serverless Function: TTS API
 * Proxies text-to-speech requests to Gemini 2.5 Flash TTS.
 * Returns raw base64 PCM audio (24 kHz, 16-bit mono) to the Android app.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Initialize Redis for rate limiting (only if credentials are provided)
let redis = null;
let perUserRatelimit = null;
let globalRpmRatelimit = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  // Per-user: 500 TTS requests per day (~16 full chapters)
  perUserRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(500, '24 h'),
    prefix: 'ratelimit:tts:user',
  });

  // Global RPM: 10 per minute (conservative, avoids Gemini quota bursts)
  globalRpmRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '1 m'),
    prefix: 'ratelimit:tts:global:rpm',
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
};

async function checkRateLimit(ip) {
  if (!redis || !perUserRatelimit || !globalRpmRatelimit) {
    return { allowed: true };
  }

  try {
    const rpmResult = await globalRpmRatelimit.limit('global');
    if (!rpmResult.success) {
      return { allowed: false, message: 'Too many requests. Please wait a moment.' };
    }

    const userResult = await perUserRatelimit.limit(ip);
    if (!userResult.success) {
      return { allowed: false, message: 'Daily TTS limit reached. Please try again tomorrow.' };
    }

    return { allowed: true };
  } catch (error) {
    console.error('TTS rate limit check error:', error);
    return { allowed: true }; // fail open
  }
}

export default async function handler(req, res) {
  // Set CORS headers on every response
  Object.entries(corsHeaders).forEach(([key, value]) => res.setHeader(key, value));

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // App secret check disabled (consistent with /api/chat)
  // const appSecret = req.headers['x-app-secret'];
  // if (process.env.APP_SECRET && appSecret !== process.env.APP_SECRET) {
  //   return res.status(403).json({ error: 'Unauthorized' });
  // }

  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const rateLimitResult = await checkRateLimit(clientIp);
  if (!rateLimitResult.allowed) {
    return res.status(429).json({ error: rateLimitResult.message });
  }

  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: text.trim() }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      console.error('Gemini TTS error:', geminiRes.status, errBody);
      return res.status(502).json({ error: `Gemini TTS error: ${geminiRes.status}` });
    }

    const data = await geminiRes.json();
    const part = data?.candidates?.[0]?.content?.parts?.[0];

    if (!part?.inlineData?.data) {
      console.error('No audio data in Gemini TTS response:', JSON.stringify(data));
      return res.status(502).json({ error: 'No audio data returned from Gemini TTS' });
    }

    return res.status(200).json({
      audioData: part.inlineData.data,   // base64 PCM, 24kHz 16-bit mono
      mimeType: part.inlineData.mimeType, // "audio/pcm;rate=24000"
    });

  } catch (error) {
    console.error('TTS handler error:', error);
    return res.status(500).json({ error: 'Failed to synthesize speech' });
  }
}
