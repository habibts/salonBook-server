# SalonBook — Backend API

SalonBook Backend provides the REST API for the SalonBook salon appointment booking platform. It handles application data, services, appointments, authentication-related verification, payments, and administrative operations.

## Important Features

- REST API built with Express.js
- MongoDB database integration
- Authentication and authorization middleware
- Protected API routes
- Customer and admin role support
- Service CRUD operations
- Appointment creation and management
- Appointment status management
- Payment processing integration
- Payment status tracking
- Stripe integration and webhook handling (if configured in this deployment)
- Image hosting integration with ImgBB
- Customer management
- Dashboard statistics
- CORS configuration
- Environment-based configuration

## Technology Stack

- Node.js
- Express.js
- MongoDB
- JWT
- Stripe
- ImgBB API
- dotenv
- CORS
- Vercel

## Installation Instructions

1. Clone the server repository:

   ```bash
   git clone YOUR_SERVER_REPOSITORY_URL
   ```

2. Navigate to the project directory:

   ```bash
   cd salon-book-server
   ```

3. Install dependencies:

   ```bash
   npm install
   ```

4. Create a `.env` file in the root directory and configure the required environment variables.

5. Start the development server:

   ```bash
   npm run dev
   ```

## How to Run Locally

The backend development server runs at:

http://localhost:3001

Start the server:

```bash
npm run dev
```

If the project uses a different development script, check `package.json` and use the configured script.

## Required Environment Variables

Add the required variable names to `.env`. Never publish actual secret values.

```env
PORT=
MONGODB_URI=
JWT_SECRET=
FRONTEND_URL=
IMGBB_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

> Verify these names against the actual backend configuration. Include any additional required variables, but never put real credentials in this README.

## Live Website

https://salon-book-client-wine.vercel.app/

## Client Repository

https://github.com/habibts/salonBook-client

## Server Repository

https://github.com/habibts/salonBook-server
