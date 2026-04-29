/**
 * Vercel Serverless Function: Chat API
 * Proxies requests to Gemini API for chat conversations
 */

import { GoogleGenAI } from '@google/genai';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';

// Initialize Gemini AI
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
let appCheckVerifier = null;

const ALLOWED_LANGUAGES = new Set(['english', 'telugu']);
const ALLOWED_HISTORY_ROLES = new Set(['user', 'model']);
const ALLOWED_TESTAMENTS = new Set(['old_testament', 'new_testament']);
const MAX_MESSAGE_LENGTH = 8000;
const MAX_HISTORY_MESSAGES = 30;
const MAX_HISTORY_CONTENT_LENGTH = 8000;
const MAX_CONTEXT_REFERENCE_LENGTH = 120;
const MAX_CONTEXT_BOOK_NAME_LENGTH = 80;
const MAX_CONTEXT_LABEL_LENGTH = 80;
const MAX_CONTEXT_VERSE_TEXT_LENGTH = 3000;
const MAX_CONTEXT_CHAPTER_TEXT_LENGTH = 5000;
const MAX_REFERENCED_PASSAGES = 3;
const MAX_REFERENCED_PASSAGE_REFERENCE_LENGTH = 120;
const MAX_REFERENCED_PASSAGE_TEXT_LENGTH = 1800;
const MAX_RESPONSE_ANSWER_LENGTH = 12000;
const MAX_RESPONSE_CITATIONS = 5;
const MAX_RESPONSE_FOLLOW_UPS = 3;
const MAX_FOLLOW_UP_LENGTH = 200;
const MAX_RECENT_CONTEXT_CHARS = 500;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

const CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description:
        'The main answer to the user. Keep it concise, grounded in the provided Bible context, and include inline verse citations where appropriate.',
    },
    citations: {
      type: 'array',
      description:
        'A list of explicit verse references used in the answer, such as "John 3:16" or "Romans 8:28".',
      items: {
        type: 'string',
      },
    },
    followUpQuestions: {
      type: 'array',
      description:
        'Two or three short follow-up questions that naturally continue the current conversation, stay in the same language as the answer, and are useful for a one-tap next question.',
      items: {
        type: 'string',
      },
    },
  },
  required: ['answer', 'citations', 'followUpQuestions'],
  propertyOrdering: ['answer', 'citations', 'followUpQuestions'],
};

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
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret, X-Firebase-AppCheck',
};

function parseFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
    );
  }

  return null;
}

function getAppCheckVerifier() {
  if (appCheckVerifier) {
    return appCheckVerifier;
  }

  const existingApp = getApps()[0];
  if (existingApp) {
    appCheckVerifier = getAppCheck(existingApp);
    return appCheckVerifier;
  }

  const serviceAccount = parseFirebaseServiceAccount();
  const app = initializeApp({
    credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  appCheckVerifier = getAppCheck(app);
  return appCheckVerifier;
}

async function verifyAppCheckToken(req) {
  const token = req.headers['x-firebase-appcheck'];

  if (!token || Array.isArray(token)) {
    return { ok: false, status: 403, error: 'Missing App Check token' };
  }

  try {
    const claims = await getAppCheckVerifier().verifyToken(token);
    return { ok: true, claims };
  } catch (error) {
    console.error('App Check verification failed:', error);

    if (
      error.code === 'app/invalid-credential' ||
      error.code === 'app/invalid-app-options' ||
      error.code === 'app/no-app'
    ) {
      return { ok: false, status: 500, error: 'App Check is not configured correctly' };
    }

    return { ok: false, status: 403, error: 'Invalid App Check token' };
  }
}

function validateTextField(value, fieldName, maxLength) {
  if (typeof value !== 'string') {
    return { ok: false, error: `${fieldName} must be a string` };
  }

  const text = value.trim();
  if (!text) {
    return { ok: false, error: `${fieldName} is required` };
  }

  if (text.length > maxLength) {
    return {
      ok: false,
      error: `${fieldName} must be ${maxLength} characters or fewer`,
    };
  }

  return { ok: true, value: text };
}

function validateOptionalStringField(value, fieldName, maxLength) {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== 'string') {
    return { ok: false, error: `${fieldName} must be a string` };
  }

  const text = value.trim();
  if (!text) {
    return { ok: false, error: `${fieldName} must not be empty` };
  }

  if (text.length > maxLength) {
    return {
      ok: false,
      error: `${fieldName} must be ${maxLength} characters or fewer`,
    };
  }

  return { ok: true, value: text };
}

function validateBibleContext(value) {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'bibleContext must be an object' };
  }

  const currentReferenceResult = validateTextField(
    value.currentReference,
    'bibleContext.currentReference',
    MAX_CONTEXT_REFERENCE_LENGTH
  );
  if (!currentReferenceResult.ok) {
    return currentReferenceResult;
  }

  const currentBookNameResult = validateTextField(
    value.currentBookName,
    'bibleContext.currentBookName',
    MAX_CONTEXT_BOOK_NAME_LENGTH
  );
  if (!currentBookNameResult.ok) {
    return currentBookNameResult;
  }

  if (!Number.isInteger(value.currentChapterNumber) || value.currentChapterNumber < 1) {
    return { ok: false, error: 'bibleContext.currentChapterNumber must be a positive integer' };
  }

  const translationLanguage = value.translationLanguage ?? 'telugu';
  if (typeof translationLanguage !== 'string' || !ALLOWED_LANGUAGES.has(translationLanguage)) {
    return {
      ok: false,
      error: 'bibleContext.translationLanguage must be either "english" or "telugu"',
    };
  }

  const translationLabelResult = validateTextField(
    value.translationLabel,
    'bibleContext.translationLabel',
    MAX_CONTEXT_LABEL_LENGTH
  );
  if (!translationLabelResult.ok) {
    return translationLabelResult;
  }

  if (
    value.currentBookNumber !== undefined &&
    value.currentBookNumber !== null &&
    (!Number.isInteger(value.currentBookNumber) || value.currentBookNumber < 1 || value.currentBookNumber > 66)
  ) {
    return { ok: false, error: 'bibleContext.currentBookNumber must be an integer between 1 and 66' };
  }

  const testamentResult = validateOptionalStringField(
    value.testament,
    'bibleContext.testament',
    32
  );
  if (!testamentResult.ok) {
    return testamentResult;
  }
  if (testamentResult.value && !ALLOWED_TESTAMENTS.has(testamentResult.value)) {
    return { ok: false, error: 'bibleContext.testament must be "old_testament" or "new_testament"' };
  }

  const selectedVerseReferenceResult = validateOptionalStringField(
    value.selectedVerseReference,
    'bibleContext.selectedVerseReference',
    MAX_CONTEXT_REFERENCE_LENGTH
  );
  if (!selectedVerseReferenceResult.ok) {
    return selectedVerseReferenceResult;
  }

  const selectedVerseTextResult = validateOptionalStringField(
    value.selectedVerseText,
    'bibleContext.selectedVerseText',
    MAX_CONTEXT_VERSE_TEXT_LENGTH
  );
  if (!selectedVerseTextResult.ok) {
    return selectedVerseTextResult;
  }

  const currentChapterTextResult = validateOptionalStringField(
    value.currentChapterText,
    'bibleContext.currentChapterText',
    MAX_CONTEXT_CHAPTER_TEXT_LENGTH
  );
  if (!currentChapterTextResult.ok) {
    return currentChapterTextResult;
  }

  if (
    value.currentChapterWasTruncated !== undefined &&
    typeof value.currentChapterWasTruncated !== 'boolean'
  ) {
    return { ok: false, error: 'bibleContext.currentChapterWasTruncated must be a boolean' };
  }

  const rawReferencedPassages = value.referencedPassages ?? [];
  if (!Array.isArray(rawReferencedPassages)) {
    return { ok: false, error: 'bibleContext.referencedPassages must be an array' };
  }
  if (rawReferencedPassages.length > MAX_REFERENCED_PASSAGES) {
    return {
      ok: false,
      error: `bibleContext.referencedPassages must contain at most ${MAX_REFERENCED_PASSAGES} items`,
    };
  }

  const referencedPassages = [];
  for (let index = 0; index < rawReferencedPassages.length; index++) {
    const passage = rawReferencedPassages[index];
    if (!passage || typeof passage !== 'object' || Array.isArray(passage)) {
      return {
        ok: false,
        error: `bibleContext.referencedPassages[${index}] must be an object`,
      };
    }

    const referenceResult = validateTextField(
      passage.reference,
      `bibleContext.referencedPassages[${index}].reference`,
      MAX_REFERENCED_PASSAGE_REFERENCE_LENGTH
    );
    if (!referenceResult.ok) {
      return referenceResult;
    }

    const textResult = validateTextField(
      passage.text,
      `bibleContext.referencedPassages[${index}].text`,
      MAX_REFERENCED_PASSAGE_TEXT_LENGTH
    );
    if (!textResult.ok) {
      return textResult;
    }

    if (passage.wasTruncated !== undefined && typeof passage.wasTruncated !== 'boolean') {
      return {
        ok: false,
        error: `bibleContext.referencedPassages[${index}].wasTruncated must be a boolean`,
      };
    }

    referencedPassages.push({
      reference: referenceResult.value,
      text: textResult.value,
      wasTruncated: passage.wasTruncated ?? false,
    });
  }

  return {
    ok: true,
    value: {
      currentReference: currentReferenceResult.value,
      currentBookName: currentBookNameResult.value,
      currentBookNumber: value.currentBookNumber ?? undefined,
      currentChapterNumber: value.currentChapterNumber,
      translationLanguage,
      translationLabel: translationLabelResult.value,
      testament: testamentResult.value,
      selectedVerseReference: selectedVerseReferenceResult.value,
      selectedVerseText: selectedVerseTextResult.value,
      currentChapterText: currentChapterTextResult.value,
      currentChapterWasTruncated: value.currentChapterWasTruncated ?? false,
      referencedPassages,
    },
  };
}

function buildGroundedUserMessage(message, bibleContext) {
  if (!bibleContext) {
    return message;
  }

  const sections = [
    'Answer the user using the provided Bible context as your primary grounding whenever it is relevant.',
    'Cite verse references inline when you quote or closely paraphrase scripture.',
    'Do not invent quotations or claim a passage was provided if it was not.',
    'If the provided context is incomplete or truncated, say that clearly.',
    '',
    'User question:',
    message,
    '',
    'Current Bible context:',
    `- Current reading reference: ${bibleContext.currentReference}`,
    `- Current book: ${bibleContext.currentBookName}`,
    `- Current chapter number: ${bibleContext.currentChapterNumber}`,
    `- Translation: ${bibleContext.translationLabel} (${bibleContext.translationLanguage})`,
  ];

  if (bibleContext.testament) {
    sections.push(`- Testament: ${bibleContext.testament}`);
  }

  if (bibleContext.selectedVerseReference && bibleContext.selectedVerseText) {
    sections.push('');
    sections.push(`Selected verse (${bibleContext.selectedVerseReference}):`);
    sections.push(bibleContext.selectedVerseText);
  }

  if (bibleContext.currentChapterText) {
    sections.push('');
    sections.push(
      `Current chapter excerpt${bibleContext.currentChapterWasTruncated ? ' (truncated)' : ''}:`
    );
    sections.push(bibleContext.currentChapterText);
  }

  if (bibleContext.referencedPassages.length > 0) {
    sections.push('');
    sections.push('Other passages explicitly referenced in the user question:');
    for (const passage of bibleContext.referencedPassages) {
      sections.push(
        `${passage.reference}${passage.wasTruncated ? ' (truncated excerpt)' : ''}:`
      );
      sections.push(passage.text);
      sections.push('');
    }
  }

  return sections.join('\n').trim();
}

function extractReferenceStringsFromText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }

  const referenceRegex =
    /\b(?:[1-3]\s*)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+\d{1,3}(?::\d{1,3})?\b/g;

  return [...new Set((text.match(referenceRegex) ?? []).map(match => match.trim()))];
}

function buildModelContents(conversationHistory, groundedMessage) {
  return [
    ...conversationHistory.map(message => ({
      role: message.role,
      parts: [{ text: message.content }],
    })),
    {
      role: 'user',
      parts: [{ text: groundedMessage }],
    },
  ];
}

function truncateForContext(text, maxChars = MAX_RECENT_CONTEXT_CHARS) {
  if (typeof text !== 'string') {
    return '';
  }

  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars - 3).trimEnd()}...`;
}

function tokenizeMeaningfulWords(text) {
  return new Set(
    normalizeComparisonText(text)
      .split(' ')
      .filter(token => token.length >= 4)
  );
}

function calculateWordOverlap(a, b) {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of a) {
    if (b.has(token)) {
      matches++;
    }
  }

  return matches / Math.max(1, Math.min(a.size, b.size));
}

function getLastMessageByRole(conversationHistory, role) {
  for (let index = conversationHistory.length - 1; index >= 0; index--) {
    if (conversationHistory[index]?.role === role) {
      return conversationHistory[index];
    }
  }

  return null;
}

function detectConversationMode(message, conversationHistory, bibleContext) {
  const trimmedMessage = message.trim();
  const explicitReferences = extractReferenceStringsFromText(trimmedMessage);
  const lastUserMessage = getLastMessageByRole(conversationHistory, 'user')?.content ?? '';
  const lastAssistantMessage = getLastMessageByRole(conversationHistory, 'model')?.content ?? '';
  const recentReferencePool = [
    ...(bibleContext?.selectedVerseReference ? [bibleContext.selectedVerseReference] : []),
    ...(bibleContext?.currentReference ? [bibleContext.currentReference] : []),
    ...extractReferenceStringsFromText(lastAssistantMessage),
    ...extractReferenceStringsFromText(lastUserMessage),
  ].map(reference => normalizeComparisonText(reference));

  const followUpPattern =
    /^(tell me more|go deeper|expand on that|what does that mean|what do you mean|what about|how about|and then|so what|why is that|how does that apply|how can i apply|can you explain further|continue)\b/i;
  const pronounFollowUpPattern =
    /\b(it|this|that|these|those|the verse|that verse|this verse|that passage|this passage|that promise|this promise)\b/i;
  const comparisonPattern = /\b(compare|comparison|contrast|versus|vs\.?|also compare)\b/i;

  const isLikelyFollowUp =
    conversationHistory.length > 0 &&
    explicitReferences.length === 0 &&
    (
      followUpPattern.test(trimmedMessage) ||
      (trimmedMessage.length <= 120 && pronounFollowUpPattern.test(trimmedMessage))
    );

  if (isLikelyFollowUp) {
    return {
      mode: 'follow_up',
      explicitReferences,
      recentFocus: {
        lastUserMessage: truncateForContext(lastUserMessage),
        lastAssistantMessage: truncateForContext(lastAssistantMessage),
      },
      selectedHistory: conversationHistory.slice(-8),
    };
  }

  const normalizedExplicitRefs = explicitReferences.map(reference => normalizeComparisonText(reference));
  const introducesNewReference =
    normalizedExplicitRefs.length > 0 &&
    normalizedExplicitRefs.every(reference => !recentReferencePool.includes(reference));

  const currentWords = tokenizeMeaningfulWords(trimmedMessage);
  const previousWords = tokenizeMeaningfulWords(`${lastUserMessage} ${lastAssistantMessage}`);
  const overlap = calculateWordOverlap(currentWords, previousWords);
  const isLikelyTopicShift =
    conversationHistory.length > 0 &&
    !comparisonPattern.test(trimmedMessage) &&
    (
      introducesNewReference ||
      (trimmedMessage.length >= 30 && overlap < 0.18 && explicitReferences.length === 0)
    );

  if (isLikelyTopicShift) {
    return {
      mode: 'topic_shift',
      explicitReferences,
      recentFocus: {
        lastUserMessage: truncateForContext(lastUserMessage),
        lastAssistantMessage: truncateForContext(lastAssistantMessage),
      },
      selectedHistory: [],
    };
  }

  return {
    mode: 'normal',
    explicitReferences,
    recentFocus: {
      lastUserMessage: truncateForContext(lastUserMessage),
      lastAssistantMessage: truncateForContext(lastAssistantMessage),
    },
    selectedHistory: conversationHistory.slice(-8),
  };
}

function buildContinuityInstructions(mode, recentFocus) {
  if (mode === 'follow_up') {
    const sections = [
      'Conversation continuity:',
      '- This message appears to be a follow-up to the current thread.',
      '- Resolve words like "it", "this", "that verse", or "that passage" against the most recent exchange unless the user clearly introduces a new passage.',
    ];

    if (recentFocus.lastUserMessage) {
      sections.push(`- Previous user question: ${recentFocus.lastUserMessage}`);
    }
    if (recentFocus.lastAssistantMessage) {
      sections.push(`- Previous assistant answer excerpt: ${recentFocus.lastAssistantMessage}`);
    }

    return sections.join('\n');
  }

  if (mode === 'topic_shift') {
    return [
      'Conversation continuity:',
      '- The user appears to be switching topics.',
      '- Treat earlier thread messages as background only.',
      '- Anchor your answer on the current request and the current Bible context, unless the user explicitly asks for a comparison with the earlier topic.',
    ].join('\n');
  }

  return '';
}

function validateStructuredChatResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Model returned an invalid structured response');
  }

  const answerResult = validateTextField(value.answer, 'answer', MAX_RESPONSE_ANSWER_LENGTH);
  if (!answerResult.ok) {
    throw new Error(answerResult.error);
  }

  const rawCitations = value.citations ?? [];
  if (!Array.isArray(rawCitations)) {
    throw new Error('citations must be an array');
  }

  const citations = [...new Set(
    rawCitations
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  )].slice(0, MAX_RESPONSE_CITATIONS);

  for (const citation of citations) {
    if (citation.length > MAX_CONTEXT_REFERENCE_LENGTH) {
      throw new Error('citation must be 120 characters or fewer');
    }
  }

  const rawFollowUps = value.followUpQuestions ?? [];
  if (!Array.isArray(rawFollowUps)) {
    throw new Error('followUpQuestions must be an array');
  }

  const followUpQuestions = rawFollowUps
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .map(question => (/[?!.]$/.test(question) ? question : `${question}?`))
    .slice(0, MAX_RESPONSE_FOLLOW_UPS);

  for (const question of followUpQuestions) {
    if (question.length > MAX_FOLLOW_UP_LENGTH) {
      throw new Error('followUpQuestions entry must be 200 characters or fewer');
    }
  }

  return {
    answer: answerResult.value,
    citations,
    followUpQuestions,
  };
}

function normalizeComparisonText(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFollowUpQuestions(userMessage, answer, questions) {
  const userNormalized = normalizeComparisonText(userMessage);
  const answerNormalized = normalizeComparisonText(answer);
  const seen = new Set();
  const normalizedQuestions = [];

  for (const question of questions) {
    const normalizedQuestion = normalizeComparisonText(question);
    if (!normalizedQuestion) {
      continue;
    }

    if (normalizedQuestion === userNormalized) {
      continue;
    }

    if (answerNormalized && answerNormalized.includes(normalizedQuestion)) {
      continue;
    }

    if (seen.has(normalizedQuestion)) {
      continue;
    }

    seen.add(normalizedQuestion);
    normalizedQuestions.push(question);
    if (normalizedQuestions.length >= MAX_RESPONSE_FOLLOW_UPS) {
      break;
    }
  }

  return normalizedQuestions;
}

function parseStructuredChatResponse(rawText) {
  const parsed = JSON.parse(rawText);
  return validateStructuredChatResponse(parsed);
}

function extractAnswerPreviewFromPartialJson(partialJson) {
  const answerKeyIndex = partialJson.indexOf('"answer"');
  if (answerKeyIndex === -1) {
    return '';
  }

  const colonIndex = partialJson.indexOf(':', answerKeyIndex);
  if (colonIndex === -1) {
    return '';
  }

  const openingQuoteIndex = partialJson.indexOf('"', colonIndex);
  if (openingQuoteIndex === -1) {
    return '';
  }

  let decoded = '';
  let escaping = false;

  for (let index = openingQuoteIndex + 1; index < partialJson.length; index++) {
    const character = partialJson[index];

    if (escaping) {
      switch (character) {
        case '"':
        case '\\':
        case '/':
          decoded += character;
          break;
        case 'b':
          decoded += '\b';
          break;
        case 'f':
          decoded += '\f';
          break;
        case 'n':
          decoded += '\n';
          break;
        case 'r':
          decoded += '\r';
          break;
        case 't':
          decoded += '\t';
          break;
        case 'u': {
          const unicodeHex = partialJson.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(unicodeHex)) {
            return decoded;
          }
          decoded += String.fromCharCode(Number.parseInt(unicodeHex, 16));
          index += 4;
          break;
        }
        default:
          decoded += character;
      }
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (character === '"') {
      return decoded;
    }

    decoded += character;
  }

  return decoded;
}

function wantsStreamingResponse(req) {
  const acceptHeader = req.headers.accept;
  return typeof acceptHeader === 'string' && acceptHeader.includes('text/event-stream');
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function getErrorStatus(error) {
  const candidates = [
    error?.status,
    error?.code,
    error?.cause?.status,
    error?.cause?.code,
    error?.error?.code,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number') {
      return candidate;
    }

    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
      return Number(candidate);
    }
  }

  return undefined;
}

function flattenErrorStrings(value, seen = new Set()) {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }

  if (typeof value !== 'object') {
    return [String(value)];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap(item => flattenErrorStrings(item, seen));
  }

  const parts = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'stack') {
      continue;
    }
    parts.push(...flattenErrorStrings(nestedValue, seen));
  }
  return parts;
}

function buildErrorSearchText(error) {
  return [
    error?.message,
    error?.status,
    error?.code,
    error?.cause,
    error?.error,
    ...flattenErrorStrings(error),
  ]
    .flatMap(value => flattenErrorStrings(value))
    .join(' | ')
    .toLowerCase();
}

function parseRetryDelayMs(error) {
  const searchText = buildErrorSearchText(error);
  const secondsMatch = searchText.match(/retry (?:after|in)\s+(\d+(?:\.\d+)?)s/);
  if (secondsMatch) {
    return Math.ceil(Number(secondsMatch[1]) * 1000);
  }

  const durationMatch = searchText.match(/retrydelay[^0-9]*(\d+)s/);
  if (durationMatch) {
    return Number(durationMatch[1]) * 1000;
  }

  return undefined;
}

function classifyGeminiError(error) {
  const status = getErrorStatus(error);
  const searchText = buildErrorSearchText(error);

  if (!process.env.GEMINI_API_KEY) {
    return {
      reason: 'missing_gemini_key',
      httpStatus: 503,
      retryable: false,
      clientMessage: 'AI backend is not configured correctly.',
    };
  }

  if (
    status === 401 ||
    searchText.includes('invalid api key') ||
    searchText.includes('api key not valid') ||
    searchText.includes('api_key_invalid')
  ) {
    return {
      reason: 'invalid_gemini_key',
      httpStatus: 503,
      retryable: false,
      clientMessage: 'AI backend is not configured correctly.',
    };
  }

  if (
    status === 403 ||
    searchText.includes('permission denied') ||
    searchText.includes('access denied') ||
    searchText.includes('api has not been used') ||
    searchText.includes('service disabled') ||
    searchText.includes('consumer invalid')
  ) {
    return {
      reason: 'gemini_access_denied',
      httpStatus: 503,
      retryable: false,
      clientMessage: 'AI backend is not configured correctly.',
    };
  }

  if (
    status === 429 ||
    searchText.includes('resource_exhausted') ||
    searchText.includes('quota') ||
    searchText.includes('rate limit') ||
    searchText.includes('too many requests')
  ) {
    return {
      reason: 'gemini_quota_exceeded',
      httpStatus: 429,
      retryable: false,
      retryDelayMs: parseRetryDelayMs(error),
      clientMessage: 'Gemini API quota or rate limit reached. Please try again later.',
    };
  }

  if (
    status === 503 ||
    searchText.includes('unavailable') ||
    searchText.includes('overloaded')
  ) {
    return {
      reason: 'gemini_unavailable',
      httpStatus: 503,
      retryable: true,
      clientMessage: 'AI service is temporarily overloaded. Please try again in a moment.',
    };
  }

  if (
    status === 504 ||
    searchText.includes('deadline_exceeded') ||
    searchText.includes('timed out') ||
    searchText.includes('timeout')
  ) {
    return {
      reason: 'gemini_timeout',
      httpStatus: 504,
      retryable: true,
      clientMessage: 'AI request timed out. Please try again.',
    };
  }

  if (
    status === 400 ||
    searchText.includes('invalid argument') ||
    searchText.includes('failed to parse') ||
    searchText.includes('response schema')
  ) {
    return {
      reason: 'gemini_invalid_request',
      httpStatus: 502,
      retryable: false,
      clientMessage: 'AI provider rejected the request.',
    };
  }

  return {
    reason: 'gemini_unknown_error',
    httpStatus: 500,
    retryable: false,
    clientMessage: 'Failed to process chat request',
  };
}

function logGeminiError(stage, error, classification, extra = {}) {
  console.error(stage, {
    reason: classification.reason,
    httpStatus: classification.httpStatus,
    upstreamStatus: getErrorStatus(error),
    message: error?.message,
    model: GEMINI_MODEL,
    ...extra,
  });
}

async function sendMessageWithRetry(executor) {
  let retries = 0;
  const MAX_RETRIES = 2;

  while (retries <= MAX_RETRIES) {
    try {
      return await executor();
    } catch (error) {
      const classification = classifyGeminiError(error);

      if (classification.retryable && retries < MAX_RETRIES) {
        retries++;
        const delayMs = Math.min(classification.retryDelayMs ?? 1000 * retries, 4000);
        console.warn(
          `Gemini request retry ${retries}/${MAX_RETRIES} after ${classification.reason} (${delayMs}ms)`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw error;
      }
    }
  }
}

function toCompleteConversationTurns(messages) {
  const completeTurns = [];
  let pendingUserMessage = null;

  for (const message of messages) {
    if (message.role === 'user') {
      pendingUserMessage = message;
      continue;
    }

    if (pendingUserMessage) {
      completeTurns.push(pendingUserMessage, message);
      pendingUserMessage = null;
    }
  }

  return completeTurns;
}

function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  const messageResult = validateTextField(body.message, 'message', MAX_MESSAGE_LENGTH);
  if (!messageResult.ok) {
    return messageResult;
  }

  const language = body.language ?? 'telugu';
  if (typeof language !== 'string' || !ALLOWED_LANGUAGES.has(language)) {
    return { ok: false, error: 'language must be either "english" or "telugu"' };
  }

  const rawHistory = body.conversationHistory ?? [];
  if (!Array.isArray(rawHistory)) {
    return { ok: false, error: 'conversationHistory must be an array' };
  }

  const normalizedHistory = [];
  const recentHistory = rawHistory.slice(-MAX_HISTORY_MESSAGES);
  for (let index = 0; index < recentHistory.length; index++) {
    const item = recentHistory[index];

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `conversationHistory[${index}] must be an object` };
    }

    if (typeof item.role !== 'string' || !ALLOWED_HISTORY_ROLES.has(item.role)) {
      return {
        ok: false,
        error: `conversationHistory[${index}].role must be "user" or "model"`,
      };
    }

    const contentResult = validateTextField(
      item.content,
      `conversationHistory[${index}].content`,
      MAX_HISTORY_CONTENT_LENGTH
    );
    if (!contentResult.ok) {
      return contentResult;
    }

    normalizedHistory.push({
      role: item.role,
      content: contentResult.value,
    });
  }
  const completeHistory = toCompleteConversationTurns(normalizedHistory);
  const bibleContextResult = validateBibleContext(body.bibleContext);
  if (!bibleContextResult.ok) {
    return bibleContextResult;
  }

  return {
    ok: true,
    value: {
      message: messageResult.value,
      language,
      conversationHistory: completeHistory,
      bibleContext: bibleContextResult.value,
    },
  };
}

/**
 * Format reset time into a human-readable message
 */
function formatResetTime(resetTimestamp) {
  const now = Date.now();
  const resetTime = resetTimestamp * 1000; // Convert to milliseconds
  const diffMs = resetTime - now;

  if (diffMs <= 0) return 'now';

  const diffMinutes = Math.ceil(diffMs / 60000);
  const diffHours = Math.ceil(diffMs / 3600000);

  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
  } else {
    return 'tomorrow';
  }
}

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
      const waitTime = formatResetTime(globalDailyResult.reset);
      return {
        allowed: false,
        reason: 'daily_limit',
        message: `Global daily limit reached (900 questions/day for all users). Please try again in ${waitTime}.`,
        resetTime: globalDailyResult.reset,
      };
    }

    // Check global RPM limit
    const globalRpmResult = await globalRpmRatelimit.limit('global');
    if (!globalRpmResult.success) {
      const waitTime = formatResetTime(globalRpmResult.reset);
      return {
        allowed: false,
        reason: 'rpm_limit',
        message: `Too many questions per minute (12/minute globally). Please wait ${waitTime} and try again.`,
        resetTime: globalRpmResult.reset,
      };
    }

    // Check per-user limit (by IP)
    const userResult = await perUserRatelimit.limit(ip);
    if (!userResult.success) {
      const waitTime = formatResetTime(userResult.reset);
      return {
        allowed: false,
        reason: 'user_limit',
        message: `You have reached your daily limit of 50 questions. Please try again in ${waitTime}.`,
        resetTime: userResult.reset,
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
    if (!process.env.GEMINI_API_KEY) {
      console.error('Missing required environment variable: GEMINI_API_KEY');
      return res.status(503).json({ error: 'AI backend is not configured correctly.' });
    }

    const appCheckResult = await verifyAppCheckToken(req);
    if (!appCheckResult.ok) {
      return res.status(appCheckResult.status).json({ error: appCheckResult.error });
    }

    const validationResult = validateChatRequest(req.body);
    if (!validationResult.ok) {
      return res.status(400).json({ error: validationResult.error });
    }
    const { message, conversationHistory, language, bibleContext } = validationResult.value;
    const conversationMode = detectConversationMode(message, conversationHistory, bibleContext);

    // Get client IP for rate limiting
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    // Check rate limit
    const rateLimitResult = await checkRateLimit(clientIp);
    if (!rateLimitResult.allowed) {
      console.log(`Rate limit hit: ${rateLimitResult.reason} for IP ${clientIp}`);
      if (rateLimitResult.resetTime) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(rateLimitResult.resetTime - Date.now() / 1000)
        );
        res.setHeader('Retry-After', String(retryAfterSeconds));
      }
      return res.status(429).json({
        error: rateLimitResult.message,
        reason: rateLimitResult.reason,
      });
    }

    // Optional: Verify app secret (simple security layer)
    // TEMPORARILY DISABLED FOR TESTING
    // const appSecret = req.headers['x-app-secret'];
    // if (process.env.APP_SECRET && appSecret !== process.env.APP_SECRET) {
    //   return res.status(403).json({ error: 'Unauthorized' });
    // }

    // Dynamic System Instruction based on requested language
    let systemPrompt;
    if (language === 'english') {
       systemPrompt = `You are a helpful Bible study assistant.
       
CRITICAL RULES:
1. ALWAYS respond in ENGLISH.
2. Be warm, patient, and encouraging.
3. Provide clear, accurate answers about Bible content.
4. Treat any provided Bible context as the primary grounding source for your answer.
5. Cite verse references inline when quoting or closely paraphrasing scripture.
6. If the provided Bible context is insufficient, say so plainly instead of inventing details.
7. Keep responses concise but thorough.
8. Return structured output that matches the requested schema exactly.
9. Only include citations for verses you actually relied on.
10. Provide 2 or 3 useful follow-up questions that the user can tap next. They should deepen, clarify, or apply the current topic instead of repeating the same question.

Remember: The user has explicitly requested English. Do not use Telugu.`;
    } else {
       // Default to Telugu
       systemPrompt = `You are a helpful Bible study assistant for Telugu-speaking users.

CRITICAL RULES:
1. ALWAYS respond in Telugu (తెలుగు)
2. Be warm, patient, and encouraging
3. Provide clear, accurate answers about Bible content
4. Use any provided Bible context as the primary grounding source for your answer
5. Quote or closely paraphrase scripture only with verse references included inline
6. If the provided Bible context is insufficient, say that clearly instead of making up details
7. Keep responses concise but thorough
8. Use simple, everyday Telugu that elderly users can understand
9. Return structured output that matches the requested schema exactly
10. Only include citations for verses you actually relied on
11. Provide 2 or 3 useful follow-up questions that the user can tap next. They should deepen, clarify, or apply the current topic instead of repeating the same question.

LANGUAGE EXAMPLES:
- "నేను మీకు సహాయం చేస్తాను" (I will help you)
- "బైబిల్ ప్రకారం..." (According to the Bible...)
- "ఈ అధ్యాయం గురించి..." (About this chapter...)

Remember: Always respond in Telugu, even if the user writes in English.`;
    }

    const groundedMessage = buildGroundedUserMessage(message, bibleContext);
    const continuityInstructions = buildContinuityInstructions(
      conversationMode.mode,
      conversationMode.recentFocus
    );
    const finalUserMessage = continuityInstructions
      ? `${continuityInstructions}\n\n${groundedMessage}`
      : groundedMessage;
    const contents = buildModelContents(conversationMode.selectedHistory, finalUserMessage);
    const modelConfig = {
      systemInstruction: systemPrompt,
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseJsonSchema: CHAT_RESPONSE_SCHEMA,
    };
    const streaming = wantsStreamingResponse(req);

    if (streaming) {
      res.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        const stream = await sendMessageWithRetry(() =>
          genAI.models.generateContentStream({
            model: GEMINI_MODEL,
            contents,
            config: modelConfig,
          })
        );
        let accumulatedJson = '';
        let emittedAnswer = '';

        for await (const chunk of stream) {
          const chunkText =
            chunk.text ??
            chunk.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('') ??
            '';
          if (!chunkText) {
            continue;
          }

          accumulatedJson += chunkText;
          const answerPreview = extractAnswerPreviewFromPartialJson(accumulatedJson);
          if (!answerPreview || answerPreview === emittedAnswer) {
            continue;
          }

          const delta = answerPreview.startsWith(emittedAnswer)
            ? answerPreview.slice(emittedAnswer.length)
            : answerPreview;
          if (!delta) {
            continue;
          }

          emittedAnswer = answerPreview;
          writeSseEvent(res, 'chunk', { text: delta });
        }

        const structured = parseStructuredChatResponse(accumulatedJson);
        const normalizedFollowUps = normalizeFollowUpQuestions(
          message,
          structured.answer,
          structured.followUpQuestions
        );
        writeSseEvent(res, 'done', {
          timestamp: new Date().toISOString(),
          citations: structured.citations,
          followUpQuestions: normalizedFollowUps,
        });
        return res.end();
      } catch (error) {
        const classification = classifyGeminiError(error);
        logGeminiError('Chat stream error', error, classification, {
          streaming: true,
        });
        writeSseEvent(res, 'error', {
          error: classification.clientMessage,
          reason: classification.reason,
          status: classification.httpStatus,
        });
        return res.end();
      }
    }

    const result = await sendMessageWithRetry(() =>
      genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: modelConfig,
      })
    );
    const structured = parseStructuredChatResponse(result.text);
    const normalizedFollowUps = normalizeFollowUpQuestions(
      message,
      structured.answer,
      structured.followUpQuestions
    );

    // Return response
    res.status(200).json({
      response: structured.answer,
      timestamp: new Date().toISOString(),
      citations: structured.citations,
      followUpQuestions: normalizedFollowUps,
    });

  } catch (error) {
    const classification = classifyGeminiError(error);
    logGeminiError('Chat API error', error, classification, {
      streaming: false,
    });
    if (classification.retryDelayMs) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(classification.retryDelayMs / 1000))));
    }

    res.status(classification.httpStatus).json({
      error: classification.clientMessage,
      reason: classification.reason,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

// Set CORS headers for all responses
export const config = {
  api: {
    bodyParser: true,
  },
};
