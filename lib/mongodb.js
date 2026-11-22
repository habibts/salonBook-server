import { MongoClient } from 'mongodb';

let clientPromise = null;
let dbInstance = null;

const MONGODB_URI = `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-bqzlc8s-shard-00-00.6my06uv.mongodb.net:27017,ac-bqzlc8s-shard-00-01.6my06uv.mongodb.net:27017,ac-bqzlc8s-shard-00-02.6my06uv.mongodb.net:27017/?ssl=true&replicaSet=atlas-14p3me-shard-0&authSource=admin`;

if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
  throw new Error('DB_USER and DB_PASSWORD environment variables are required');
}

function createClient() {
  const client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 60000,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
    retryWrites: true,
    retryReads: true,
  });
  return client;
}

async function connectClient(client) {
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export async function getMongoClient() {
  if (!clientPromise) {
    const client = createClient();
    clientPromise = connectClient(client);
  }

  try {
    const client = await clientPromise;
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch {
    const client = createClient();
    clientPromise = connectClient(client);
    return clientPromise;
  }
}

export async function getDb() {
  if (dbInstance) {
    try {
      await dbInstance.command({ ping: 1 });
      return dbInstance;
    } catch {
      dbInstance = null;
    }
  }

  const client = await getMongoClient();
  dbInstance = client.db('salonBook');
  return dbInstance;
}

export async function closeMongoClient() {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = null;
    dbInstance = null;
  }
}