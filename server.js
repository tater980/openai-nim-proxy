'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());

const ENABLE_THINKING_MODE = true;

app.post('/api/chat', async (req, res) => {
  const incomingMessages = req.body.messages;
  let nimMessages = [...incomingMessages];

  if (ENABLE_THINKING_MODE) {
    nimMessages.unshift({ content: 'detailed thinking on', role: 'system' });
  }

  try {
    const response = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
      model: 'z-ai/glm5',
      messages: nimMessages,
      temperature: req.body.temperature || 0.7,
      max_tokens: req.body.max_tokens || 4096,
      stream: false
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.NIM_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
