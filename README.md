# Simple Telugu Bible - Backend API

Backend API proxy for Simple Telugu Bible app. Securely proxies Gemini AI requests without exposing API keys in the mobile app.

## Features

- ✅ Gemini AI chat proxy
- ✅ Rate limiting (100 requests/hour per IP)
- ✅ CORS enabled for mobile apps
- ✅ Simple app secret authentication
- ✅ Serverless deployment on Vercel (free tier)

## API Endpoints

### POST `/api/chat`

Send a chat message and receive AI response.

**Headers:**
```
Content-Type: application/json
X-App-Secret: your_app_secret
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
  "timestamp": "2025-10-24T13:52:00.000Z"
}
```

## Deployment to Vercel

### Prerequisites
1. Vercel account (free): https://vercel.com/signup
2. Vercel CLI: `npm install -g vercel`
3. Gemini API key: https://aistudio.google.com/app/apikey

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
   - Add `APP_SECRET` = a random secret string (e.g., `stb_secret_2024_xyz`)

5. **Your API will be live at:**
   ```
   https://your-project.vercel.app/api/chat
   ```

## Security

- **Rate Limiting:** 100 requests per IP per hour
- **App Secret:** Optional authentication header
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
# APP_SECRET=...

# Run locally
npm run dev

# API available at http://localhost:3000/api/chat
```

## Usage from Android App

```kotlin
// In your app, call the backend instead of Gemini directly
val response = httpClient.post("https://your-project.vercel.app/api/chat") {
    headers {
        append("X-App-Secret", "your_app_secret")
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
