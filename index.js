const express = require('express');
const bodyParser = require('body-parser');
const { YoutubeTranscript } = require('youtube-transcript');
const cors = require('cors');
const he = require('he'); // To decode HTML entities
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const cors = require('cors');
app.use(cors({
  origin: '*', // Allow all origins
}));

app.use(bodyParser.json());

// Replace with your OpenRouter API key
const OPENROUTER_API_KEY = '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'; // Replace with your actual OpenRouter API Key

// OpenRouter API endpoint
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Apply rate-limiting middleware
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5, // Limit each IP to 5 requests per minute
  message: 'Too many requests from this IP, please try again after a minute.',
});
app.use(limiter);

// Function to extract video ID
function extractVideoId(url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname !== 'www.youtube.com' && parsedUrl.hostname !== 'youtu.be') {
      return null; // Not a YouTube URL
    }

    if (parsedUrl.pathname === '/watch') {
      return parsedUrl.searchParams.get('v'); // Extract `v` parameter
    }

    if (parsedUrl.hostname === 'youtu.be') {
      return parsedUrl.pathname.slice(1); // Extract path for shortened URLs
    }

    return null; // Not a video URL
  } catch (err) {
    return null; // Invalid URL
  }
}

// Basic Extractive Summarization
function summarizeText(text, sentenceCount = 5) {
  const sentences = text.split('. ');
  if (sentences.length <= sentenceCount) {
    return text; // Return the full text if it's already short
  }

  // Rank sentences by length (as a simple heuristic)
  const rankedSentences = sentences
    .map((sentence) => ({ sentence, length: sentence.length }))
    .sort((a, b) => b.length - a.length);

  // Select top-ranked sentences
  const summary = rankedSentences.slice(0, sentenceCount).map((item) => item.sentence).join('. ');

  return summary;
}

// Function to summarize text using OpenRouter API and the Gemini model
async function summarizeWithGemini(text) {
  try {
    if (!text || text.trim().length === 0) {
      throw new Error('Input text is empty or invalid');
    }

    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: 'google/gemini-2.0-flash-thinking-exp:free',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text }],
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.choices?.length) {
      return response.data.choices[0].message.content;
    }

    throw new Error('No summary returned from OpenRouter API.');
  } catch (error) {
    if (error.response?.status === 429) {
      throw new Error('Quota exceeded. Please try again later or check your API plan.');
    }
    throw new Error(error.response?.data?.error?.message || 'Failed to summarize text.');
  }
}

// Route to summarize video transcript
app.post('/api/summarize', async (req, res) => {
  try {
    console.log(req)
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);

    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube video URL' });
    }

    // Fetch the transcript
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    // Combine transcript text
    const rawText = transcript.map((item) => he.decode(item.text)).join(' ');

    // Summarize text
    const data = summarizeText(rawText, 5); // Limit to 5 sentences

    try {
      const summary = await summarizeWithGemini(data);
      res.json({ summary });
    } catch (error) {
      console.error('OpenRouter AI failed, using fallback summarization:', error.message);
      const fallbackSummary = summarizeText(data, 5);
      res.json({ summary: fallbackSummary });
    }
  } catch (error) {
    console.error(error);

    if (error.message.includes('Transcript is disabled')) {
      return res.status(400).json({ error: 'Transcripts are disabled or unavailable for this video' });
    }

    res.status(500).json({ error: 'An error occurred while processing the video' });
  }
});


// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

