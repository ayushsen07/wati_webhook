import express from 'express';
import { createServer } from 'node:http';
import cors from 'cors';
import { Timestamp } from 'firebase-admin/firestore';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import axios from 'axios';
import { URL } from 'url';
import { parse } from 'querystring';

dotenv.config();

// Express setup
const server = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server
const httpServer = createServer(server);

// Middleware
server.use(cors());
server.use(express.json());

// Firebase initialization
console.log("🔥 Initializing Firebase...");
console.log("🔥 FIREBASE_PROJECT_ID:", process.env.FIREBASE_PROJECT_ID);
console.log("🔥 FIREBASE_CLIENT_EMAIL:", process.env.FIREBASE_CLIENT_EMAIL);
console.log("🔥 FIREBASE_PRIVATE_KEY (partial):", process.env.FIREBASE_PRIVATE_KEY?.slice(0, 30), "...");

if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    console.error("❌ Missing Firebase environment variables.");
    process.exit(1);
}

let db;
try {
    const firebaseApp = initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
    });
    console.log("✅ Firebase initialized successfully.");

    db = getFirestore(firebaseApp);
    server.locals.db = db; // Make db available in routes
} catch (error) {
    console.error("❌ Firebase initialization error:", error);
    process.exit(1);
}

// WATI Configuration
const WATI_BASE_URL = 'https://live-mt-server.wati.io/361402/api/v1';
const WATI_API_TOKEN = process.env.WATI_API_TOKEN;

const supportedMediaTypes = ['image', 'audio', 'video', 'voice', 'document', 'sticker'];

// Improved safe timestamp conversion function
function safeTimestampConversion(timestamp) {
    try {
        // If it's already a Firestore Timestamp
        if (timestamp instanceof Timestamp) {
            return timestamp;
        }

        // If it's undefined or null, return current time
        if (timestamp === undefined || timestamp === null) {
            return Timestamp.now();
        }

        // If it's a string
        if (typeof timestamp === 'string') {
            // Try to parse as number first
            const numericTimestamp = parseInt(timestamp);
            
            if (!isNaN(numericTimestamp)) {
                // Check if it's in seconds (10 digits) or milliseconds (13 digits)
                if (timestamp.length === 10) {
                    return Timestamp.fromMillis(numericTimestamp * 1000);
                } else {
                    return Timestamp.fromMillis(numericTimestamp);
                }
            }
            
            // If string parsing failed, try to parse as Date
            const date = new Date(timestamp);
            if (!isNaN(date.getTime())) {
                return Timestamp.fromDate(date);
            }
            
            return Timestamp.now();
        }

        // If it's a number
        if (typeof timestamp === 'number') {
            // Check if it's in seconds (typically < 1e10) or milliseconds
            if (timestamp < 10000000000) { // 10-digit number (seconds since epoch)
                return Timestamp.fromMillis(timestamp * 1000);
            } else {
                return Timestamp.fromMillis(timestamp);
            }
        }

        // Fallback to current time
        return Timestamp.now();
    } catch (error) {
        console.error('Timestamp conversion error:', error);
        return Timestamp.now();
    }
}


async function handleMediaMessage(db, event) {
    const msgType = event.type;
    const dataObj = event;

    if (!supportedMediaTypes.includes(msgType)) {
        await db.collection('webhook_responses').add({
            response: `⚠️ Unhandled type: ${msgType}`,
            rawData: event,
            timestamp: Timestamp.now()
        });
        return { status: 'unhandled_media_type', type: msgType };
    }

    const dataUrl = dataObj.data || '';
    let filename;

    try {
        const parsedUrl = new URL(dataUrl);
        const queryParams = parse(parsedUrl.search.slice(1));
        filename = queryParams.fileName || parsedUrl.pathname.split('/').pop();
    } catch (e) {
        filename = dataUrl.split('/').pop() || `media_${Date.now()}`;
    }

    let caption = '';
    if (dataObj[msgType]?.caption) {
        caption = dataObj[msgType].caption;
    } else if (dataObj.caption) {
        caption = dataObj.caption;
    }

    const attachmentData = {
        caption,
        sha256: dataUrl,
        attachment_id: filename,
        type: msgType,
        whatsapp_message_id: event.id || null,
        timestamp: Timestamp.now(),
        attachment_url: dataUrl // Use the original URL directly
    };

    await db.collection('webhook_responses').add({
        response: `Attachment handled: ${JSON.stringify(attachmentData)}`,
        timestamp: Timestamp.now()
    });

    try {
        const attachmentRef = await db.collection('whatsapp_attachments').add(attachmentData);
        console.log(`Attachment saved with ID: ${attachmentRef.id}`);
        return {
            status: 'media_processed',
            attachmentId: attachmentRef.id,
            type: msgType
        };
    } catch (error) {
        console.error('Attachment insert failed:', error);
        return {
            status: 'media_insert_failed',
            error: error.message,
            type: msgType
        };
    }
}

// Event Handlers
async function handleMessage(db, event) {
    // Extract text from various possible locations
    let text = event.text || '';
    if (!text && event.message) {
        text = event.message.text || '';
    }
    if (!text && event.rawData?.text) {
        text = event.rawData.text;
    }

    const messageData = {
        id: event.id,
        waId: event.waId,
        text: text,
        type: event.type,
        timestamp: safeTimestampConversion(event.timestamp),
        status: 'received',
        direction: 'incoming',
        rawData: event,
        updatedAt: Timestamp.now()
    };

    // Use set with merge to avoid duplicates
    await db.collection('whatsapp_messages').doc(event.id).set(messageData, { merge: true });
    return { status: 'message_processed' };
}

async function handleTemplateMessage(db, event) {
    // For template messages, extract template name and use it as text if needed
    const templateName = event.templateName || 'unknown_template';
    const text = event.text || `Template: ${templateName}`;

    const messageData = {
        id: event.id,
        waId: event.waId,
        text: text,
        type: 'template',
        templateName: templateName,
        timestamp: safeTimestampConversion(event.timestamp || event.created),
        status: (event.statusString?.toLowerCase() || 'sent'),
        direction: 'outgoing',
        rawData: event,
        updatedAt: Timestamp.now()
    };

    await db.collection('whatsapp_messages').doc(event.id).set(messageData, { merge: true });
    return { status: 'template_processed' };
}

async function handleSessionMessage(db, event) {
    const messageData = {
        id: event.id,
        waId: event.waId,
        text: event.text || '',
        type: 'session',
        timestamp: safeTimestampConversion(event.timestamp),
        status: event.statusString?.toLowerCase() || 'sent',
        direction: 'outgoing',
        rawData: event,
        updatedAt: Timestamp.now()
    };

    await db.collection('whatsapp_messages').doc(event.id).set(messageData, { merge: true });
    return { status: 'session_message_processed' };
}

async function handleDeliveryStatus(db, event) {
    const updateData = {
        status: 'delivered',
        deliveredAt: safeTimestampConversion(event.timestamp),
        rawDeliveryData: event,
        updatedAt: Timestamp.now()
    };

    // Use set with merge to update or create the document
    await db.collection('whatsapp_messages').doc(event.id).set(updateData, { merge: true });
    return { status: 'delivery_status_updated' };
}

async function handleReadStatus(db, event) {
    const updateData = {
        status: 'read',
        readAt: safeTimestampConversion(event.timestamp),
        rawReadData: event,
        updatedAt: Timestamp.now()
    };

    await db.collection('whatsapp_messages').doc(event.id).set(updateData, { merge: true });
    return { status: 'read_status_updated' };
}

// New handler for replied messages
async function handleRepliedMessage(db, event) {
    const messageData = {
        id: event.id,
        waId: event.waId,
        text: event.text || 'Replied to message',
        type: event.type || 'text',
        timestamp: safeTimestampConversion(event.timestamp),
        status: 'replied',
        direction: 'incoming',
        rawData: event,
        updatedAt: Timestamp.now()
    };

    await db.collection('whatsapp_messages').doc(event.id).set(messageData, { merge: true });
    return { status: 'replied_message_processed' };
}

// Remove the initiateChatWithTemplate function and add this endpoint instead:
server.post('/api/wati/send-template', async (req, res) => {
    try {
        const { phone, templateName = "missed_appointment" } = req.body;

        // Validate required fields
        if (!phone) {
            return res.status(400).json({ error: "Phone number is required" });
        }

        // Send template message via WATI API
        const response = await axios.post(
            `${WATI_BASE_URL}/sendTemplateMessage?whatsappNumber=${phone}`,
            {
                template_name: templateName,
                broadcast_name: `init_${Date.now()}`,
                parameters: [{ name: "name", value: "Customer" }],
                channel_number: "27772538155"
            },
            {
                headers: {
                    Authorization: `Bearer ${WATI_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // Create a record in Firestore
        const messageData = {
            waId: phone,
            direction: "outgoing",
            status: "sent",
            type: "template",
            templateName: templateName,
            timestamp: Timestamp.now(),
            rawData: {
                eventType: "templateMessageSent",
                templateName: templateName,
                watiResponse: response.data
            }
        };

        await db.collection('whatsapp_messages').add(messageData);

        return res.status(200).json({
            success: true,
            message: "Template message sent successfully",
            templateUsed: templateName,
            watiResponse: response.data
        });

    } catch (error) {
        console.error('Error sending template:', error);

        const errorResponse = {
            error: "Failed to send template message",
            details: error.message,
            templateName: req.body.templateName || "missed_appointment"
        };

        if (error.response) {
            errorResponse.watiError = {
                status: error.response.status,
                data: error.response.data
            };
        }

        return res.status(500).json(errorResponse);
    }
});

// Webhook endpoint
server.post('/webhook', async (req, res) => {
    try {
        console.log('Received WATI webhook:', JSON.stringify(req.body, null, 2));
        const event = req.body;

        // Check if this event was already processed
        const existingEvent = await db.collection('wati_webhook_events')
            .where('id', '==', event.id)
            .where('eventType', '==', event.eventType)
            .limit(1)
            .get();

        if (!existingEvent.empty) {
            console.log('Duplicate event detected, skipping processing:', event.id, event.eventType);
            return res.status(200).json({ success: true, message: 'Duplicate event skipped' });
        }

        // Store raw event in Firestore
        const eventRef = await db.collection('wati_webhook_events').add({
            ...event,
            receivedAt: Timestamp.now(),
            processed: false
        });

        // Process event type
        let result;
        switch (event.eventType) {
            case 'message':
                if (supportedMediaTypes.includes(event.type)) {
                    result = await handleMediaMessage(db, event);
                } else {
                    result = await handleMessage(db, event);
                }
                break;
            case 'templateMessageSent':
            case 'templateMessageSent_v2':
                result = await handleTemplateMessage(db, event);
                break;
            case 'sessionMessageSent':
            case 'sessionMessageSent_v2':
                result = await handleSessionMessage(db, event);
                break;
            case 'sentMessageDELIVERED':
            case 'sentMessageDELIVERED_v2':
                result = await handleDeliveryStatus(db, event);
                break;
            case 'sentMessageREAD':
            case 'sentMessageREAD_v2':
                result = await handleReadStatus(db, event);
                break;
            case 'sentMessageREPLIED_v2':
                result = await handleRepliedMessage(db, event);
                break;
            default:
                console.log('Unhandled event type:', event.eventType);
                result = { status: 'unhandled', eventType: event.eventType };
        }

        // Update event as processed
        await eventRef.update({
            processed: true,
            processingResult: result,
            processedAt: Timestamp.now()
        });

        res.status(200).json({ success: true, eventId: eventRef.id });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API endpoint to get messages
server.get('/api/messages/:waNumber', async (req, res) => {
    try {
      const { waNumber } = req.params;
  
      if (!waNumber) {
        return res.status(400).json({ error: "WhatsApp number is required" });
      }
  
      // main query: get ALL messages for this waId ordered by timestamp
      const query = db.collection('whatsapp_messages')
        .where('waId', '==', waNumber)
        .orderBy('timestamp', 'asc');
  
      const snapshot = await query.get();
  
      if (snapshot.empty) {
        return res.status(200).json([]);
      }
  
      const messages = snapshot.docs.map(doc => {
        const data = doc.data();
  
        // safe timestamp conversion
        let timestampMillis;
        if (data.timestamp?.toMillis) {
          timestampMillis = data.timestamp.toMillis();
        } else if (typeof data.timestamp === 'string') {
          timestampMillis = isNaN(data.timestamp)
            ? new Date(data.timestamp).getTime()
            : parseInt(data.timestamp) * 1000;
        } else if (typeof data.timestamp === 'number') {
          timestampMillis = data.timestamp > 9999999999
            ? data.timestamp
            : data.timestamp * 1000;
        } else {
          timestampMillis = Date.now();
        }
  
        let formattedDate;
        try {
          formattedDate = new Date(timestampMillis).toISOString();
        } catch (e) {
          formattedDate = new Date().toISOString();
        }
  
        return {
          id: doc.id,
          text: data.text,
          direction: data.direction,
          status: data.status,
          timestamp: timestampMillis,
          formattedDate,
          waId: data.waId
        };
      });
  
      // final sort safeguard
      messages.sort((a, b) => a.timestamp - b.timestamp);
  
      return res.status(200).json(messages);
  
    } catch (error) {
      console.error('Fetch messages error:', error);
      res.status(500).json({
        error: 'Failed to fetch messages',
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
      });
    }
  });
  
// API endpoint to send messages
server.post('/api/wati/send-message', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: "Phone and message are required" });
        }

        // 1. First send to WATI API
        const watiResponse = await axios.post(
            `https://live-mt-server.wati.io/361402/api/v1/sendSessionMessage/${phone}?messageText=${encodeURIComponent(message)}`,
            null, // No body needed for this request
            {
                headers: {
                    "Authorization": `Bearer ${process.env.WATI_API_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        // 2. Save to Firestore
        const messageData = {
            text: message,
            waId: phone,
            direction: "outgoing",
            status: "sent",
            timestamp: Timestamp.now(), // Use Firestore Timestamp
            rawData: {
                eventType: "sessionMessageSent",
                whatsappResponse: watiResponse.data
            }
        };

        await db.collection('whatsapp_messages').add(messageData);

        res.status(200).json({
            success: true,
            messageId: watiResponse.data.id
        });

    } catch (error) {
        console.error("Error sending message:", error);

        // Determine if the error is from WATI or our system
        const errorMessage = error.response?.data?.message ||
            error.message ||
            "Failed to send message";

        res.status(500).json({
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// GET /api/contacts
server.get('/api/contacts', async (req, res) => {
    try {
        const snapshot = await db.collection('whatsapp_messages').get();
        const messages = snapshot.docs.map(doc => doc.data());

        const contactMap = new Map();

        console.log("Total messages fetched:", messages.length);

        // Process each message to extract contact information
        for (const msg of messages) {
            const rawData = msg.rawData || {};
            const waId = msg.waId;
            const name =
                rawData.senderName ||
                rawData.watiResponse?.contact?.fullName ||
                rawData.watiResponse?.contact?.firstName ||
                waId;
            const timestamp = msg.timestamp?.toMillis?.() || Date.now();
            const text = msg.text || "";

            if (
                !contactMap.has(waId) ||
                timestamp > contactMap.get(waId).timestamp
            ) {
                contactMap.set(waId, {
                    waId,
                    name,
                    lastMessage: text,
                    timestamp,
                });
            }
        }

        const contacts = Array.from(contactMap.values()).sort(
            (a, b) => b.timestamp - a.timestamp
        );

        res.status(200).json(contacts);
    } catch (error) {
        console.error('Error fetching contacts:', error);
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});


// Start the server
httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("SIGTERM signal received: closing HTTP server");
    httpServer.close(() => {
        console.log("HTTP server closed");
    });
});

process.on("SIGINT", () => {
    console.log("SIGINT signal received: closing HTTP server");
    httpServer.close(() => {
        console.log("HTTP server closed");
    });
});