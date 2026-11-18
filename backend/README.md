# IMEDHUB payment server

1. Install Node.js 18 or newer (https://nodejs.org). Nothing else to install - no `npm install` needed.
2. Check `backend/.env` has your Razorpay Key ID and Key Secret.
3. In a terminal, from the project folder (the one containing `backend` and `IMED HUB`) run:  `npm start`   (or: `cd backend` then `node server.js`)
4. Open  http://localhost:3000/fees.html   (recommended)
   Live Server (127.0.0.1:5500) also works as long as the server above is running.

Razorpay test card: 4111 1111 1111 1111, any future expiry, any CVV, OTP 1234 (or use test UPI: success@razorpay).

API: POST /api/create-order {amount}  |  POST /api/verify-payment {razorpay_order_id, razorpay_payment_id, razorpay_signature}  |  GET /api/health
Never put the Key Secret in any file inside the "IMED HUB" folder - Live Server publishes everything in there.
