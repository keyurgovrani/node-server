const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic GET route
app.get("/", (_req, res) => {
	res.json({ message: "Server is running!" });
});

// POST route that accepts body
app.post("/api/data", (req, res) => {
	console.log("Received body:", req.body);
	res.json({
		success: true,
		receivedData: req.body,
		message: "Data received successfully",
	});
});

// Start server
app.listen(PORT, () => {
	console.log("Environment:", process.env.NODE_ENV);
	console.log("Print Port:", PORT);
	console.log(`Server is running on http://localhost:${PORT}`);
});
