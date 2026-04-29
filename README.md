# Simple Telugu Bible - Backend API

Backend API proxy for Simple Telugu Bible app. Securely proxies Gemini AI requests without exposing API keys in the mobile app.

## Features

- ✅ Gemini AI chat proxy
- ✅ Rate limiting (100 requests/hour per IP)
- ✅ CORS enabled for mobile apps
- ✅ Firebase App Check verification for Android clients
- ✅ Serverless deployment on Vercel (free tier)

## API Endpoints

### POST `/api/chat`

Send a chat message and receive AI response.

**Headers:**
```
Content-Type: application/json
X-Firebase-AppCheck: firebase_app_check_token
X-App-Secret: legacy_app_secret_if_enabled
```

**Request Body:**
```json
{
  "message": "Who was Moses?",
  "conversationHistory": [
    {
      "role": "user",
      "content": "Tell me about Genesis"
    },
    {
      "role": "model",
      "content": "Genesis is the first book..."
    }
  ]
}
```

**Response:**
```json
{
  "response": "Moses was a prophet who led...",
  "timestamp": "2025-10-24T13:52:00.000Z",
  "citations": ["Exodus 3:10", "Exodus 14:21"],
  "followUpQuestions": ["What can we learn from Moses' obedience?"]
}
```

**Validation:**
- `message` must be a non-empty string up to 8,000 characters.
- `language` must be `english` or `telugu`; omitted language defaults to `telugu`.
- `conversationHistory` must be an array of `{ "role": "user" | "model", "content": "..." }`.
- The backend keeps at most the latest 30 history messages and normalizes them into complete `user -> model` turns before sending them to Gemini.
- The backend requests structured JSON output from Gemini so citations and follow-up questions are returned as explicit fields instead of being inferred from freeform text.

## Deployment to Vercel

### Prerequisites
1. Vercel account (free): https://vercel.com/signup
2. Vercel CLI: `npm install -g vercel`
3. Gemini API key: https://aistudio.google.com/app/apikey
4. Firebase project with the Android app registered for `com.ratchet.simpletelugubible`
5. App Check enabled with the Play Integrity provider for the Android app

### Steps

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Login to Vercel:**
   ```bash
   vercel login
   ```

3. **Deploy:**
   ```bash
   vercel --prod
   ```

4. **Set environment variables in Vercel dashboard:**
   - Go to your project settings
   - Add `GEMINI_API_KEY` = your Gemini API key
   - Add `FIREBASE_PROJECT_ID` = your Firebase project ID
   - Add `FIREBASE_SERVICE_ACCOUNT_BASE64` = base64-encoded Firebase service account JSON
   - `APP_SECRET` is legacy-only and is no longer the production protection layer

5. **Your API will be live at:**
   ```
   https://your-project.vercel.app/api/chat
   ```

## Security

- **App Check:** Requests must include a valid `X-Firebase-AppCheck` token from the Android app
- **Rate Limiting:** Redis-backed request limits
- **No API key exposure:** Key stays on server only
- **CORS:** Configured for mobile apps

## Local Development

```bash
# Install dependencies
npm install

# Create .env file (copy from .env.example)
cp .env.example .env

# Add your keys to .env
# GEMINI_API_KEY=...
# FIREBASE_PROJECT_ID=...
# FIREBASE_SERVICE_ACCOUNT_BASE64=...

# Run locally
npm run dev

# API available at http://localhost:3000/api/chat
```

## Usage from Android App

```kotlin
// In your app, call the backend instead of Gemini directly
val response = httpClient.post("https://your-project.vercel.app/api/chat") {
    headers {
        append("X-Firebase-AppCheck", appCheckToken)
    }
    setBody(ChatRequest(
        message = userMessage,
        conversationHistory = history
    ))
}
```

## Future Enhancements

- [ ] Add iOS support
- [ ] Add web support
- [ ] Implement user authentication (Firebase Auth)
- [ ] Add usage analytics
- [ ] Add caching for common queries

## License

MIT
