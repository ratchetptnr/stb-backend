/**
 * Vercel Serverless Function: Chat API
 * Proxies requests to Gemini API for chat conversations
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
};

// Simple rate limiting (in-memory, resets on cold start)
const requestCounts = new Map();
const RATE_LIMIT = 100; // requests per IP per hour
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in ms

function checkRateLimit(ip) {
  const now = Date.now();
  const record = requestCounts.get(ip) || { count: 0, resetTime: now + RATE_WINDOW };

  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + RATE_WINDOW;
  }

  record.count++;
  requestCounts.set(ip, record);

  return record.count <= RATE_LIMIT;
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
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
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

    // Initialize model
    const model = genAI.getGenerativeModel({
      model: "models/gemini-2.5-flash-lite",
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
