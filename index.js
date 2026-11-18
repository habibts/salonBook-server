import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const port = process.env.PORT || 3001;
const app = express();
app.use(cors());

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

app.get('/users', async (req, res) => {
  try {
    const users = await usersCollection.find().toArray();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving users');
  }
});

app.get('/services', async (req, res) => {
  try {
    const services = await servicesCollection.find().toArray();
    res.json(services);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving services');
  }
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 