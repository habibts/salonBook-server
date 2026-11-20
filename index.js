import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import Stripe from 'stripe';

// ============================================
// SERVER CONFIGURATION
// ============================================
const port = process.env.PORT || 3001;
const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
app.use(cors());

// ============================================
// DATABASE CONNECTION
// ============================================
const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-bqzlc8s-shard-00-00.6my06uv.mongodb.net:27017,ac-bqzlc8s-shard-00-01.6my06uv.mongodb.net:27017,ac-bqzlc8s-shard-00-02.6my06uv.mongodb.net:27017/?ssl=true&replicaSet=atlas-14p3me-shard-0&authSource=admin`)

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db('salonBook');
const usersCollection = db.collection('user');
const servicesCollection = db.collection('services');
const appointmentsCollection = db.collection('appointments');
const transactionsCollection = db.collection('transactions');

// ============================================
// APPOINTMENTS APIs
// ============================================

// POST /appointments
// Purpose: Create a new appointment request
// Access: Customer (verified on frontend/backend as needed)
app.post('/appointments', express.json(), async (req, res) => {
  try {
    const { customerId, customerName, customerEmail, serviceId, appointmentDate, timeSlot, message } = req.body;
    const service = await servicesCollection.findOne({ _id: new (await import('mongodb')).ObjectId(serviceId) });
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
app.get('/appointments', async (req, res) => {
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
app.patch('/appointments/:id/cancel', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
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
app.get('/users', async (req, res) => {
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
app.post('/services', express.json(), async (req, res) => {
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

// ============================================
// GENERAL / HEALTH APIs
// ============================================

// GET /
// Purpose: Basic health check
// Access: Public
app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.delete('/services/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    await servicesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error deleting service');
  }
});

app.patch('/services/:id', express.json(), async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    await servicesCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: req.body });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error updating service');
  }
});

app.patch('/users/:id/status', express.json(), async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    const { status } = req.body;
    await usersCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error updating user status');
  }
});

app.delete('/users/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).send('Error deleting user');
  }
});

// GET /services/:id
// Purpose: Get a single service by MongoDB ID
// Access: Public
app.get('/transactions/:id/details', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
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

app.get('/transactions', async (req, res) => {
  try {
    const transactions = await transactionsCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json(transactions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/services/:id', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    if (!ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid ID');
    const service = await servicesCollection.findOne({ _id: new ObjectId(req.params.id) });
    if (!service) return res.status(404).send('Service not found');
    res.json(service);
  } catch (err) {
    res.status(500).send('Error retrieving service');
  }
});

// PATCH /services/:id/status
// Purpose: Update service status (Active/Inactive)
// Access: Admin only (frontend/backend authorization as existing)
app.patch('/services/:id/status', express.json(), async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
    if (!ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid ID');
    const { status } = req.body;
    if (!['active','inactive'].includes(status)) return res.status(400).send('Invalid status');
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
// Access: Customer (auth not enforced in this simple backend)
app.post('/payments/create-payment-intent', express.json(), async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
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
// Purpose: Confirm a pending appointment (Admin only in real auth)
// Access: Admin
app.patch('/appointments/:id/confirm', async (req, res) => {
  try {
    const { ObjectId } = await import('mongodb');
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
      const { ObjectId } = await import('mongodb');
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
