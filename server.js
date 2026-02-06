'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const { nimRequest } = require('./nim');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());

const ENABLE_THINKING_MODE = true; // Set this to true to enable thinking mode

app.post('/api/chat', async (req, res) => {
    const incomingMessages = req.body.messages;
    let nimMessages = [...incomingMessages]; // Copy of incoming messages

    if (ENABLE_THINKING_MODE) {
        nimMessages.unshift({ content: 'detailed thinking on', role: 'system' }); // Prepend system message
    }
    
    try {
        const response = await nimRequest(nimMessages);
        res.json(response);
    } catch (error) {
        console.error('Error in nimRequest:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
