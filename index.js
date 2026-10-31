import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app = express();

// middleware runs in the order it is added, so it must come before the routes
app.use(cors({ origin: process.env.FRONTEND_URL}));
// keep the raw body so the webhook signature can be checked
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get("/", (req, res) => {
    res.json({ ok : true});
});

const CHAPA_API = "https://api.chapa.co/v1";

// make an http request to chapa api with the given path and options, and return the response data
const chapa = async (path, options = {}) => {
    const response = await fetch(`${CHAPA_API}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
            "Content-Type": "application/json",
        },
    });
    const data = await response.json();
    if (!response.ok) {
        const error = new Error(data.message || "Chapa error");
        error.details = data;
        throw error;
    }
    return data;
};

// calculate the price on the server side, and return the amount in ETB
const Free_SHIPPING_THRESHOLD = 50; // USD
const SHIPPING_FEE = 4.99;

const priceCart = async (items) => {
    let subtotal = 0;
    for (const { id, quantity} of items){
        // fetch the product price from databasea
        const response = await fetch(`https://dummyjson.com/products/${id}`);
        if (!response.ok) throw new Error(`Failed to fetch product ${id}`);
        const product = await response.json();
        subtotal += product.price * (1- product.discountPercentage / 100) * quantity;
    }
    const shipping = subtotal >= Free_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
    const totalUsd = subtotal + shipping;
    return (totalUsd * Number(process.env.USD_TO_ETB)).toFixed(2);
}


app.post("/api/payments/initialize", async (req, res) => {
    const { items, customer } = req.body;

    if (!Array.isArray(items) || items.length === 0 || !customer?.email){
        return res.status(400).json({ message: "Cart items and customer email are required" });
    }

    try {
        const amount = await priceCart(items);
        const txRef = `order-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        
        const result = await chapa("/transaction/initialize", {
            method: "POST",
            body: JSON.stringify({
                amount,
                currency: "ETB",
                email: customer.email,
                first_name: customer.firstName,
                last_name: customer.lastName,
                tx_ref: txRef,
                return_url: `${process.env.FRONTEND_URL}/payment/result?tx_ref=${txRef}`,
                callback_url: `${process.env.BACKEND_URL}/api/payments/callback`,
            }),
        });
        res.json({ checkoutUrl: result.data.checkout_url, txRef});
    } catch(err) {
        console.error(err.details ?? err);
        res.status(502).json({message: err.message});
    }
});

// verify the route 

app.get("/api/payments/verify/:txRef", async (req, res) => {
    try {
        const result = await chapa(`/transaction/verify/${encodeURIComponent(req.params.txRef)}`);
        const { status, amount, currency } = result.data;
        res.json({ status, amount, currency });
    } catch(err) {
        console.error(err.details ?? err);
        res.status(502).json({message: err.message});
    }
});

// callback and webhook
app.get("/api/payments/callback", async (req, res) => {
    const txRef = req.query.trx_ref ?? req.query.tx_ref;
    console.log("chapa callback for", txRef);
    res.sendStatus(200);
});

app.post("/api/payments/webhook", (req, res) => {
    const expected = crypto
        .createHmac("sha256", process.env.CHAPA_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest("hex");
    const received = req.get("x-chapa-signature");

    if (received !== expected) return res.sendStatus(401);

    console.log("Webhook:", req.body.tx_ref, req.body.status);
    res.sendStatus(200);
});

// Vercel imports the app and runs it itself; locally we start the server
if (!process.env.VERCEL) {
    app.listen(4000, () => console.log("Backend on http://localhost:4000"));
}

export default app;
