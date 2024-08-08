// index.js
const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const { Queue, Worker } = require('bullmq');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CLIENT_REDIRECT_URL
);

oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const cohereApiKey = process.env.COHERE_API_KEY;
const emailQueue = new Queue('emailQueue', { connection: { url: process.env.REDIS_URL } });

const worker = new Worker('emailQueue', async job => {
    await processEmail(job.data);
}, { connection: { url: process.env.REDIS_URL } });

// Routes
app.get('/', (req, res) => {
    res.render('index');
});

app.get('/auth/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify'
    ];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes
    });
    res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        res.redirect('/emails');
    } catch (error) {
        console.error('Error exchanging authorization code for tokens:', error);
        res.status(500).send('Error exchanging authorization code for tokens');
    }
});
app.get('/emails', async (req, res) => {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const gmailResponse = await gmail.users.messages.list({
            userId: 'me',
            labelIds: ['UNREAD']
        });
        const gmailMessages = gmailResponse.data.messages || [];

        const gmailEmailDetails = await Promise.all(gmailMessages.map(async (msg) => {
            try {
                const email = await gmail.users.messages.get({ userId: 'me', id: msg.id });
                const headers = email.data.payload.headers;
                const fromHeader = headers.find(header => header.name === 'From');
                const from = fromHeader ? fromHeader.value : 'Unknown';
                const subject = headers.find(header => header.name === 'Subject').value;
                const body = email.data.snippet;

                const classification = await classifyEmail(body);
                const replyContent = await generateReply(classification);

                await emailQueue.add('processEmail', { emailId: msg.id, from, subject, classification, replyContent });

                const labelId = await getLabelId(classification);
                if (labelId) {
                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: msg.id,
                        requestBody: {
                            removeLabelIds: ['UNREAD'],
                            addLabelIds: [labelId]
                        }
                    });
                }

                return { from, subject, body, classification, replyContent };
            } catch (error) {
                console.error('Error fetching email details:', error);
                return { from: 'Unknown', subject: 'Unknown', body: 'Error fetching body', classification: 'No Classification', replyStatus: 'Error', replyContent: 'Error generating reply' };
            }
        }));

        res.render('emails', { gmailEmailDetails });
    } catch (error) {
        console.error('Error fetching emails:', error);
        res.status(500).send('Error fetching emails');
    }
});



async function classifyEmail(emailContent) {
    try {
        const response = await axios.post(
            'https://api.cohere.ai/v1/generate',
            {
                model: 'command-light',
                prompt: `Classify the following email content into one of the following categories: Interested, Not Interested, or Requires More Information.\nEmail content: ${emailContent} . Just give me only the category. Nothing above it!`,
                max_tokens: 10,
                temperature: 0.5
            },
            {
                headers: {
                    'Authorization': `Bearer ${cohereApiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const classification = response.data.generations[0].text.trim().toLowerCase();
        
        // Normalize and validate classification
        if (['interested', 'not interested', 'requires more information'].includes(classification)) {
            return classification.charAt(0).toUpperCase() + classification.slice(1);
        } else {
            console.warn(`Unexpected classification: ${classification}. Defaulting to 'Requires More Information'.`);
            return 'Requires More Information';
        }
    } catch (error) {
        console.error('Error classifying email:', error.response ? error.response.data : error.message);
        if (error.response && error.response.status === 429) {
            console.log('Rate limit exceeded. Retrying in 1 minute...');
            await new Promise(resolve => setTimeout(resolve, 60000));
            return classifyEmail(emailContent);
        }
        return 'Requires More Information'; // Default fallback
    }
}


async function generateReply(classification) {
    const normalizedClassification = classification.toLowerCase();

    switch (normalizedClassification) {
        case 'interested':
            return `Thank you for your interest! We would love to discuss further. Are you available for a demo call? Please suggest a time that works for you.`;
        case 'not interested':
            return `Thank you for your response. If you change your mind or have any questions in the future, feel free to reach out.`;
        case 'requires more information':
            return `Thank you for reaching out. Could you please provide more details about what you need more information on? We're here to help.`;
    }
}



async function sendReply(emailId, from, subject, replyContent) {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const rawMessage = [
            `To: ${from}`,
            `Subject: Re: ${subject}`,
            'Content-Type: text/plain; charset="UTF-8"',
            '',
            replyContent
        ].join('\n');

        const base64EncodedEmail = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: base64EncodedEmail
            }
        });

        console.log('Reply sent successfully!');
    } catch (error) {
        console.error('Error sending reply:', error);
    }
}

// Helper function to get label ID by name
async function getLabelId(labelName) {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const response = await gmail.users.labels.list({ userId: 'me' });
        const labels = response.data.labels || [];
        const label = labels.find(l => l.name === labelName);
        if (!label) {
            console.error(`Label '${labelName}' not found.`);
        }
        return label ? label.id : null;
    } catch (error) {
        console.error('Error fetching label ID:', error);
        return null;
    }
}

// Function to process email
async function processEmail({ emailId, from, subject, classification, replyContent }) {
    try {
        // Get label ID for classification
        const labelId = await getLabelId(classification);
        if (labelId) {
            // Assign label to the email
            await modifyEmailLabels(emailId, labelId);
        } else {
            console.error(`No label ID found for classification '${classification}'.`);
        }

        // Send a reply to the email
        await sendReply(emailId, from, subject, replyContent);

        // Mark the email as read
        await markAsRead(emailId);

        console.log('Processing completed for:', emailId);
    } catch (error) {
        console.error('Error processing email:', error);
    }
}

// Function to modify email labels
async function modifyEmailLabels(emailId, labelId) {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        await gmail.users.messages.modify({
            userId: 'me',
            id: emailId,
            requestBody: {
                removeLabelIds: ['UNREAD'], // Removing UNREAD label
                addLabelIds: [labelId] // Adding new label
            }
        });
        console.log(`Labels updated for email ID ${emailId}`);
    } catch (error) {
        console.error('Error modifying email labels:', error);
    }
}

// Function to mark email as read
async function markAsRead(emailId) {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        await gmail.users.messages.modify({
            userId: 'me',
            id: emailId,
            requestBody: {
                removeLabelIds: ['UNREAD'] 
            }
        });
        console.log(`Email ID ${emailId} marked as read.`);
    } catch (error) {
        console.error('Error marking email as read:', error);
    }
}


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
