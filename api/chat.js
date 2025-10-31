/**
 * Vercel Serverless Function: Chat API
 * Proxies requests to Gemini API for chat conversations
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Redis for rate limiting (only if credentials are provided)
let redis = null;
let perUserRatelimit = null;
let globalDailyRatelimit = null;
let globalRpmRatelimit = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  // Per-user rate limit: 50 requests per day (generous, prevents single user abuse)
  perUserRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(50, '24 h'),
    prefix: 'ratelimit:user',
  });

  // Global daily limit: 900 requests per day (90% of Gemini's 1000 free tier limit)
  globalDailyRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(900, '24 h'),
    prefix: 'ratelimit:global:daily',
  });

  // Global RPM limit: 12 requests per minute (80% of Gemini's 15 RPM free tier limit)
  globalRpmRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(12, '1 m'),
    prefix: 'ratelimit:global:rpm',
  });
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
};

/**
 * Check rate limits using Upstash Redis
 */
async function checkRateLimit(ip) {
  // If Redis is not configured, allow all requests (fallback)
  if (!redis || !perUserRatelimit || !globalDailyRatelimit || !globalRpmRatelimit) {
    console.warn('Rate limiting not configured - Redis credentials missing');
    return { allowed: true };
  }

  try {
    // Check global daily limit (use fixed key for all users)
    const globalDailyResult = await globalDailyRatelimit.limit('global');
    if (!globalDailyResult.success) {
      return {
        allowed: false,
        reason: 'daily_limit',
        message: 'Daily request limit reached. Please try again tomorrow.',
        resetTime: globalDailyResult.reset
      };
    }

    // Check global RPM limit
    const globalRpmResult = await globalRpmRatelimit.limit('global');
    if (!globalRpmResult.success) {
      return {
        allowed: false,
        reason: 'rpm_limit',
        message: 'Too many requests per minute. Please wait a moment.',
        resetTime: globalRpmResult.reset
      };
    }

    // Check per-user limit (by IP)
    const userResult = await perUserRatelimit.limit(ip);
    if (!userResult.success) {
      return {
        allowed: false,
        reason: 'user_limit',
        message: 'You have reached your daily limit of 50 questions. Please try again tomorrow.',
        resetTime: userResult.reset
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error('Rate limit check error:', error);
    // On error, allow the request (fail open)
    return { allowed: true };
  }
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).json({});
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get client IP for rate limiting
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // Check rate limit
    const rateLimitResult = checkRateLimit(clientIp);
    if (!rateLimitResult.allowed) {
      console.log(`Rate limit hit: ${rateLimitResult.reason} for IP ${clientIp}`);
      return res.status(429).json({
        error: rateLimitResult.message,
        reason: rateLimitResult.reason
      });
    }

    // Optional: Verify app secret (simple security layer)
    // TEMPORARILY DISABLED FOR TESTING
    // const appSecret = req.headers['x-app-secret'];
    // if (process.env.APP_SECRET && appSecret !== process.env.APP_SECRET) {
    //   return res.status(403).json({ error: 'Unauthorized' });
    // }

    const { message, conversationHistory = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Initialize model with Telugu system instruction
    const model = genAI.getGenerativeModel({
      model: "models/gemini-2.5-flash-lite",
      systemInstruction: `You are a helpful Bible study assistant for Telugu-speaking users.

CRITICAL RULES:
1. ALWAYS respond in Telugu (తెలుగు)
2. Be warm, patient, and encouraging
3. Provide clear, accurate answers about Bible content
4. When the user provides their current Bible location, use that context to give relevant answers
5. Keep responses concise but thorough
6. Use simple, everyday Telugu that elderly users can understand

LANGUAGE EXAMPLES:
- "నేను మీకు సహాయం చేస్తాను" (I will help you)
- "బైబిల్ ప్రకారం..." (According to the Bible...)
- "ఈ అధ్యాయం గురించి..." (About this chapter...)

Remember: Always respond in Telugu, even if the user writes in English.`,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
      }
    });

    // Build chat history
    const chat = model.startChat({
      history: conversationHistory.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.content }],
      })),
    });

    // Send message and get response with retry logic for overload errors
    let result;
    let retries = 0;
    const MAX_RETRIES = 2;

    while (retries <= MAX_RETRIES) {
      try {
        result = await chat.sendMessage(message);
        break; // Success, exit retry loop
      } catch (err) {
        if (err.status === 503 && retries < MAX_RETRIES) {
          console.log(`Gemini API overloaded, retry ${retries + 1}/${MAX_RETRIES}`);
          retries++;
          // Exponential backoff: 1s, 2s
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        } else {
          throw err; // Re-throw if not 503 or out of retries
        }
      }
    }

    const response = await result.response;
    const text = response.text();

    // Return response
    res.status(200).json({
      response: text,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Chat API error:', error);

    // Handle specific error types
    if (error.status === 503 || error.message?.includes('overloaded')) {
      return res.status(503).json({ error: 'AI service is temporarily overloaded. Please try again in a moment.' });
    }

    if (error.message?.includes('quota')) {
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
    }

    res.status(500).json({
      error: 'Failed to process chat request',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// Set CORS headers for all responses
export const config = {
  api: {
    bodyParser: true,
  },
};
