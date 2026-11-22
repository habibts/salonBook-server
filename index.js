import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import multer from 'multer';
import 'dotenv/config';
import { ObjectId } from 'mongodb';
import Stripe from 'stripe';
import { getDb, closeMongoClient } from './lib/mongodb.js';

// ============================================
// SERVER CONFIGURATION
// ============================================
const port = process.env.PORT || 3001;
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ============================================
// JWT / AUTH CONFIGURATION
// ============================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required: set it in the backend .env file.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const AUTH_COOKIE = 'salon_token';
const AUTH_COOKIE_ALT = 'salonbook_jwt';
const BETTER_AUTH_URL = (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');

// ============================================
// IMGBB CONFIGURATION
// ============================================
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

const IMGBB_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const IMGBB_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const IMGBB_ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMGBB_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    if (!IMGBB_ALLOWED_EXT.has(ext) || !IMGBB_ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Invalid file type. Only JPG, JPEG, PNG and WEBP images are allowed.'));
    }
    cb(null, true);
  },
});

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(cookieParser());

// ============================================
// DATABASE CONNECTION
// ============================================

// Database collections (initialized after DB connection)
let usersCollection;
let servicesCollection;
let appointmentsCollection;
let transactionsCollection;
let revokedTokensCollection;

export async function initializeDb() {
  const db = await getDb();
  usersCollection = db.collection('user');
  servicesCollection = db.collection('services');
  appointmentsCollection = db.collection('appointments');
  transactionsCollection = db.collection('transactions');
  revokedTokensCollection = db.collection('revoked_tokens');

  // Create TTL index for revoked tokens (expire after JWT_EXPIRES_IN)
  await revokedTokensCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  console.log('Database initialized successfully');
  return db;
}

// Initialize DB on startup
await initializeDb();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing MongoDB connection...');
  await closeMongoClient();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing MongoDB connection...');
  await closeMongoClient();
  process.exit(0);
});

// ============================================
// AUTH HELPERS / MIDDLEWARE
// ============================================

// Ask Better Auth (Next.js app) who owns the session cookie. The cookie is
// forwarded as-is; Better Auth validates its own signature and returns the
// session or null, so no session data is trusted from the client.
async function getBetterAuthSession(req) {
  if (!req.headers.cookie) return null;

  const response = await fetch(`${BETTER_AUTH_URL}/api/auth/get-session`, {
    headers: { cookie: req.headers.cookie },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;

  const session = await response.json();
  return session && session.user ? session : null;
}

function generateJti() {
  return crypto.randomBytes(16).toString('hex');
}

function signUserToken(user) {
  const jti = generateJti();
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'customer',
      jti,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function readToken(req) {
  // Check Express cookie first
  if (req.cookies?.[AUTH_COOKIE]) return req.cookies[AUTH_COOKIE];
  // Fallback to Next.js cookie name (for cross-origin scenarios where cookie is shared)
  if (req.cookies?.[AUTH_COOKIE_ALT]) return req.cookies[AUTH_COOKIE_ALT];
  // Check Authorization header
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function isTokenRevoked(jti) {
  if (!jti) return false;
  const revoked = await revokedTokensCollection.findOne({ jti });
  return !!revoked;
}

async function revokeToken(jti, expiresAt) {
  if (!jti) return;
  await revokedTokensCollection.updateOne(
    { jti },
    { $set: { jti, revokedAt: new Date(), expiresAt } },
    { upsert: true }
  );
}

async function getUserFromDatabase(userId) {
  try {
    const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
    return user;
  } catch {
    return null;
  }
}

async function verifyJWT(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check token revocation
  if (payload.jti && await isTokenRevoked(payload.jti)) {
    return res.status(401).json({ error: 'Token revoked' });
  }

  // Fetch current user from database
  try {
    const user = await getUserFromDatabase(payload.userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check account status
    const status = user.status || 'active';
    if (status === 'blocked' || status === 'deleted' || status === 'deactivated') {
      return res.status(403).json({ error: 'Account inactive' });
    }

    // Attach trusted database user to request
    req.user = {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role || 'customer',
      status: user.status || 'active',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function verifyAdmin(req, res, next) {
  // req.user is already populated by verifyJWT with trusted database data
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Double-check status (verifyJWT already checked, but defense in depth)
  if (req.user?.status === 'blocked' || req.user?.status === 'deleted' || req.user?.status === 'deactivated') {
    return res.status(403).json({ error: 'Account inactive' });
  }

  next();
}

// POST /auth/token
// Purpose: Exchange a valid Better Auth session for an HTTP-only JWT cookie
// Access: Signed-in user (Better Auth session required)
app.post('/auth/token', async (req, res) => {
  try {
    const session = await getBetterAuthSession(req);
    if (!session) return res.status(401).json({ error: 'No Better Auth session' });

    const { user } = session;
    const token = signUserToken(user);
    res.cookie(AUTH_COOKIE, token, cookieOptions);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role || 'customer',
      },
    });
  } catch (err) {
    console.error('Error issuing JWT:', err);
    res.status(500).json({ error: 'Error issuing token' });
  }
});

// POST /auth/logout
// Purpose: Clear the backend JWT cookie and revoke the token
// Access: Public (idempotent)
app.post('/auth/logout', (req, res) => {
  const token = readToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
      if (payload.jti) {
        // Calculate expiry from exp claim (seconds since epoch)
        const expiresAt = payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        revokeToken(payload.jti, expiresAt);
      }
    } catch {
      // Ignore verification errors on logout
    }
  }
  res.clearCookie(AUTH_COOKIE, cookieOptions);
  res.json({ success: true });
});

// GET /auth/me
// Purpose: Return the JWT payload for the current request
// Access: Signed-in user
app.get('/auth/me', verifyJWT, (req, res) => {
  res.json({ user: req.user });
});

// ============================================
// APPOINTMENTS APIs
// ============================================

// POST /appointments
// Purpose: Create a new appointment request
// Access: Customer (verified on frontend/backend as needed)
app.post('/appointments', express.json(), verifyJWT, async (req, res) => {
  try {
    const { customerId, customerName, customerEmail, serviceId, appointmentDate, timeSlot, message } = req.body;
    const service = await servicesCollection.findOne({ _id: new ObjectId(serviceId) });
    if (!service || service.status !== 'active') return res.status(400).send('Invalid service');
    const exists = await appointmentsCollection.findOne({ serviceId, appointmentDate, timeSlot, status: { $ne: 'cancelled' } });
    if (exists) return res.status(409).send('Slot unavailable');
    const appointment = {
      customerId, customerName, customerEmail, serviceId,
      serviceName: service.serviceName,
      serviceImage: service.image,
      appointmentDate, timeSlot,
      price: service.price,
      duration: service.duration,
      message: message || '',
      status: 'Pending',
      paymentStatus: 'Unpaid',
      createdAt: new Date().toISOString(),
    };
    await appointmentsCollection.insertOne(appointment);
    res.json(appointment);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating appointment');
  }
});

// GET /appointments
// Purpose: Get all appointments
// Access: Admin / system use
app.get('/appointments', verifyJWT, async (req, res) => {
  try {
    const appointments = await appointmentsCollection.find().toArray();
    res.json(appointments);
  } catch (err) {
    res.status(500).send('Error retrieving appointments');
  }
});

// PATCH /appointments/:id/cancel
// Purpose: Cancel a pending appointment
// Access: Customer (owner) / Admin
app.patch('/appointments/:id/cancel', verifyJWT, async (req, res) => {
  try {
    const result = await appointmentsCollection.updateOne(
      { _id: new ObjectId(req.params.id), status: 'Pending' },
      { $set: { status: 'Cancelled', updatedAt: new Date().toISOString() } }
    );
    if (result.matchedCount === 0) return res.status(400).send('Cannot cancel');
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error cancelling appointment');
  }
});

// ============================================
// USERS / ADMIN APIs
// ============================================

// GET /users
// Purpose: Get all users
// Access: Admin
app.get('/users', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const users = await usersCollection.find().toArray();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving users');
  }
});

// ============================================
// SERVICES APIs
// ============================================

// GET /services
// Purpose: Get all salon services
// Access: Public
app.get('/services', async (req, res) => {
  try {
    const services = await servicesCollection.find().toArray();
    res.json(services);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving services');
  }
});

// POST /services
// Purpose: Create a new salon service
// Access: Admin only
app.post('/services', express.json(), verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const { serviceName, category, description, price, duration, image, status } = req.body;
    const doc = {
      serviceName, category, description,
      price: Number(price), duration: Number(duration),
      image, status: status || 'active',
      createdAt: new Date().toISOString(),
    };
    await servicesCollection.insertOne(doc);
    res.json(doc);
  } catch (err) {
    res.status(500).send('Error creating service');
  }
});

// POST /services/upload-image
// Purpose: Upload an image to ImgBB and return the direct image URL
// Access: Admin only
app.post('/services/upload-image', verifyJWT, verifyAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided.' });
    }

    if (!IMGBB_API_KEY) {
      return res.status(500).json({ error: 'Image upload service is not configured.' });
    }

    const formData = new FormData();
    formData.append('key', IMGBB_API_KEY);
    formData.append('image', req.file.buffer.toString('base64'));

    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: formData,
    });

    if (!imgbbRes.ok) {
      const errText = await imgbbRes.text().catch(() => 'Unknown ImgBB error');
      return res.status(502).json({ error: `ImgBB upload failed: ${errText}` });
    }

    const imgbbData = await imgbbRes.json();

    if (!imgbbData.success || !imgbbData.data?.url) {
      return res.status(502).json({ error: 'ImgBB did not return a valid image URL.' });
    }

    res.json({ url: imgbbData.data.url });
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ error: 'Image upload failed.' });
  }
});

// Error handler for multer upload errors (file type, size limits)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5 MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message && err.message.includes('Invalid file type')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ============================================
// GENERAL / HEALTH APIs
// ============================================

// GET /
// Purpose: Basic health check
// Access: Public
app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.delete('/services/:id', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    await servicesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error deleting service');
  }
});

app.patch('/services/:id', express.json(), verifyJWT, verifyAdmin, async (req, res) => {
  try {
    await servicesCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error updating service');
  }
});

app.patch('/users/:id/status', express.json(), verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error updating user status');
  }
});

app.delete('/users/:id', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error deleting user');
  }
});

// GET /services/:id
// Purpose: Get a single service by MongoDB ID
// Access: Public
app.get('/services/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid ID');
    const service = await servicesCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!service) return res.status(404).send('Service not found');
    res.json(service);
  } catch (err) {
    res.status(500).send('Error retrieving service');
  }
});

// GET /transactions/:id/details
// Purpose: Get transaction details with appointment and service
// Access: Admin
app.get('/transactions/:id/details', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const t = await transactionsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!t) return res.status(404).json({ error: 'Not found' });
    const appt = await appointmentsCollection.findOne({ _id: new ObjectId(t.appointmentId) });
    let service = null;
    if (appt?.serviceId) service = await servicesCollection.findOne({ _id: new ObjectId(appt.serviceId) });
    res.json({ transaction: t, appointment: appt, service });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /transactions
// Purpose: Get all transactions
// Access: Admin (verifyJWT + verifyAdmin)
app.get('/transactions', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    const transactions = await transactionsCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(transactions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /services/:id/status
// Purpose: Update service status (Active/Inactive)
// Access: Admin only
app.patch('/services/:id/status', express.json(), verifyJWT, verifyAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid ID');
    const { status } = req.body;
    if (!['active', 'inactive'].includes(status)) return res.status(400).send('Invalid status');
    const result = await servicesCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
    if (result.matchedCount === 0) return res.status(404).send('Service not found');
    const updated = await servicesCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.json(updated);
  } catch (err) {
    res.status(500).send('Error updating status');
  }
});

// POST /payments/create-payment-intent
// Purpose: Create Stripe PaymentIntent for an appointment
// Access: Customer (auth enforced via verifyJWT)
app.post('/payments/create-payment-intent', express.json(), verifyJWT, async (req, res) => {
  try {
    const { appointmentId } = req.body;
    if (!ObjectId.isValid(appointmentId)) return res.status(400).send('Invalid ID');
    const appointment = await appointmentsCollection.findOne({ _id: new ObjectId(appointmentId) });
    if (!appointment) return res.status(404).send('Appointment not found');
    if (appointment.status !== 'Confirmed') return res.status(400).send('Appointment not confirmed');
    if (appointment.paymentStatus === 'Paid') return res.status(400).send('Already paid');
    const amount = Math.round(Number(appointment.price) * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      metadata: { appointmentId, customerId: appointment.customerId },
    });
    res.json({ success: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (err) {
    res.status(500).send('Error creating payment intent');
  }
});

// PATCH /appointments/:id/confirm
// Purpose: Confirm a pending appointment (Admin only)
// Access: Admin
app.patch('/appointments/:id/confirm', verifyJWT, verifyAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid ID');
    const appointment = await appointmentsCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!appointment) return res.status(404).send('Appointment not found');
    if (appointment.status !== 'Pending') return res.status(400).send('Cannot confirm');
    await appointmentsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'Confirmed' } });
    const updated = await appointmentsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.json(updated);
  } catch (err) {
    res.status(500).send('Error confirming appointment');
  }
});

// POST /payments/webhook
// Purpose: Handle Stripe webhook events
// Access: Stripe (signature verified)
app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Webhook signature verification failed');
  }

  console.log('Webhook received:', event.type);
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    console.log('PaymentIntent ID:', paymentIntent.id);
    const appointmentId = paymentIntent.metadata?.appointmentId;
    console.log('Appointment ID from metadata:', appointmentId);
    if (appointmentId) {
      const appointment = await appointmentsCollection.findOne({ _id: new ObjectId(appointmentId) });
      console.log('Appointment found:', !!appointment);
      if (appointment) {
        const expectedAmount = Math.round(Number(appointment.price) * 100);
        console.log('Expected:', expectedAmount, 'Actual:', paymentIntent.amount);
        if (expectedAmount === paymentIntent.amount) {
          const updateResult = await appointmentsCollection.updateOne(
            { _id: new ObjectId(appointmentId) },
            { $set: { paymentStatus: 'Paid', updatedAt: new Date().toISOString() } }
          );
          console.log('Update matched:', updateResult.matchedCount, 'modified:', updateResult.modifiedCount);
          const existing = await transactionsCollection.findOne({ paymentIntentId: paymentIntent.id });
          if (!existing) {
            await transactionsCollection.insertOne({
              appointmentId,
              customerId: appointment.customerId,
              paymentIntentId: paymentIntent.id,
              amount: paymentIntent.amount,
              currency: paymentIntent.currency,
              status: 'Paid',
              createdAt: new Date().toISOString(),
            });
            console.log('Transaction created');
          } else {
            console.log('Transaction already exists');
          }
        }
      }
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    // Do not mark as paid
  }

  res.json({ received: true });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export default app;