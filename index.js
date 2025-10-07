const express = require("express");
const pino = require("pino");
const fs = require("fs-extra");
const path = require("path");
const { db } = require("./lib/blockDB");
const { ref, set, get, remove, child } = require("firebase/database");
const config = require("./config");
const NodeCache = require("node-cache");
const { Mutex } = require("async-mutex");
const mutex = new Mutex();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const { WhatsApp, manager, getSessionPath } = require("./lib/client");
const {
  saveSession,
  getAllSessions,
  deleteSession,
} = require("./lib/database");

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== UTILITY FUNCTIONS ====================
function sanitizeNumber(num) {
  return num ? num.replace(/[^0-9]/g, "") : null;
}

// Check if user is blocked
async function isBlocked(number) {
  try {
    const snapshot = await get(child(ref(db), `blocked/${number}`));
    return snapshot.exists();
  } catch (err) {
    console.error("Error checking block status:", err);
    return false;
  }
}

// ==================== PAIRING CONNECTOR ====================
var session;
const msgRetryCounterCache = new NodeCache();

async function connector(Num, res) {
  // Use the centralized path helper
  const sessionDir = getSessionPath(Num);
  await fs.ensureDir(sessionDir);

  console.log(`📂 Pairing - Session path: ${sessionDir}`);

  var { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  session = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: "fatal" }).child({ level: "fatal" })
      ),
    },
    logger: pino({ level: "fatal" }).child({ level: "fatal" }),
    browser: Browsers.macOS("Safari"),
    markOnlineOnConnect: false,
    msgRetryCounterCache,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: false,
  });

  if (!session.authState.creds.registered) {
    await delay(1500);
    Num = Num.replace(/[^0-9]/g, "");
    var code = await session.requestPairingCode(Num);
    console.log(`📱 Pairing code for ${Num}: ${code}`);
    res.send({ code: code?.match(/.{1,4}/g)?.join("-") });
  }

  //session.ev.on("creds.update", saveCreds);
  session.ev.on("creds.update", async () => {
    await saveCreds();
  });
  session.ev.on("connection.update", async (update) => {
    var { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`✅ Pairing successful for ${Num}`);

      try {
        // Verify credentials were saved
        const credsPath = path.join(sessionDir, "creds.json");
        const credExists = await fs.pathExists(credsPath);
        console.log(`📝 Credentials path: ${credsPath}`);
        console.log(`📝 Credentials exist: ${credExists ? "YES ✅" : "NO ❌"}`);

        if (credExists) {
          // List all files saved
          const files = await fs.readdir(sessionDir);
          console.log(
            `📁 Session files (${files.length}):`,
            files.slice(0, 5).join(", ")
          );
        }

        if (!credExists) {
          throw new Error("Credentials were not saved properly");
        }

        // Save to database
        await saveSession(Num);
        console.log(`💾 Session saved to database`);

        // Close pairing socket
        await delay(3000);
        session.end();
        session = null;
        console.log(`🔌 Pairing socket closed`);

        console.log(`⏳ Waiting 5 seconds before starting bot...`);
        await delay(5000);

        // Check if already connected
        if (manager.isConnected(Num) || manager.isConnecting(Num)) {
          console.log(`⚠️ ${Num} is already connecting/connected, skipping`);
          return;
        }

        console.log(`🚀 Starting bot connection for ${Num}...`);

        // Start the actual bot connection
        const bot = new WhatsApp(Num);
        await bot.connect();

        console.log(`✅ Bot started successfully for ${Num}`);
      } catch (err) {
        console.error(`❌ Failed to start bot for ${Num}:`, err.message);
        console.error(err.stack);
      }
    } else if (connection === "close") {
      var reason = lastDisconnect?.error?.output?.statusCode;
      reconn(reason, Num, res);
    }
  });
}

function reconn(reason, Num, res) {
  if (
    [
      DisconnectReason.connectionLost,
      DisconnectReason.connectionClosed,
      DisconnectReason.restartRequired,
    ].includes(reason)
  ) {
    console.log("Connection lost, reconnecting...");
    connector(Num, res); // pass the same number and response
  } else {
    console.log(`Disconnected! reason: ${reason}`);
    if (session) session.end();
  }
}

// ==================== SESSION RESTORATION ====================
async function restoreSessions() {
  try {
    console.log("🔄 Starting session restoration...");

    await config.DATABASE.sync();

    // Sessions are at workspace/sessions/
    const baseDir = path.join(__dirname, "sessions");
    await fs.ensureDir(baseDir);

    console.log(`📂 Scanning sessions in: ${baseDir}`);

    const folders = await fs.readdir(baseDir);
    const validSessions = [];

    console.log(`🔍 Found ${folders.length} folders in sessions directory`);

    for (const folder of folders) {
      // Skip non-directory items
      const folderPath = path.join(baseDir, folder);

      try {
        const stat = await fs.stat(folderPath);
        if (!stat.isDirectory()) {
          console.log(`⏭️ Skipping non-directory: ${folder}`);
          continue;
        }
      } catch (err) {
        console.log(`⏭️ Skipping invalid item: ${folder}`);
        continue;
      }

      const credPath = path.join(folderPath, "creds.json");
      const credExists = await fs.pathExists(credPath);

      console.log(
        `🔍 ${folder}: ${credExists ? "✅ Has creds.json" : "❌ No creds.json"}`
      );

      if (credExists) {
        if (manager.isConnected(folder)) {
          console.log(`⚠️ ${folder} already connected, skipping`);
          continue;
        }

        const blocked = await isBlocked(folder);
        if (!blocked) {
          validSessions.push(folder);
        } else {
          console.log(`⛔ ${folder} is blocked, skipping`);
        }
      }
    }

    if (!validSessions.length) {
      console.log("⚠️ No valid sessions to restore");
      return;
    }

    console.log(`♻️ Found ${validSessions.length} sessions to restore:`);
    validSessions.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));

    const BATCH_SIZE = 2;
    const BATCH_DELAY = 10000;
    const SESSION_DELAY = 5000;

    for (let i = 0; i < validSessions.length; i += BATCH_SIZE) {
      const batch = validSessions.slice(i, i + BATCH_SIZE);

      console.log(
        `\n📦 Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
          validSessions.length / BATCH_SIZE
        )}: ${batch.join(", ")}`
      );

      for (const number of batch) {
        try {
          if (manager.isConnected(number) || manager.isConnecting(number)) {
            console.log(`⚠️ ${number} already connected/connecting`);
            continue;
          }

          console.log(`🔌 Restoring: ${number}`);
          const bot = new WhatsApp(number);
          await bot.connect();

          await new Promise((r) => setTimeout(r, SESSION_DELAY));
        } catch (err) {
          console.error(`❌ Failed to restore ${number}:`, err.message);
        }
      }

      if (i + BATCH_SIZE < validSessions.length) {
        console.log(`⏳ Waiting ${BATCH_DELAY}ms before next batch...`);
        await new Promise((r) => setTimeout(r, BATCH_DELAY));
      }
    }

    console.log(
      `\n✅ Restoration complete. Active: ${manager.connections.size}/${validSessions.length}`
    );
  } catch (err) {
    console.error("❌ Session restoration failed:", err);
    console.error(err.stack);
  }
}

// ==================== API ROUTES ====================

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    uptime: process.uptime(),
    active_sessions: manager.connections.size,
    timestamp: new Date().toISOString(),
  });
});

// Get pairing code
app.get("/pair", async (req, res) => {
  var Num = req.query.code;
  if (!Num) {
    return res.status(418).json({
      status: "error",
      message: "Phone number is required. Use: /pair?code=1234567890",
    });
  }

  // Sanitize number
  Num = Num.replace(/[^0-9]/g, "");

  if (!Num || Num.length < 10) {
    return res.status(400).json({
      status: "error",
      message: "Invalid phone number format",
    });
  }

  // Check if already blocked
  try {
    const blocked = await isBlocked(Num);
    if (blocked) {
      return res.status(403).json({
        status: "error",
        message: "This number is blocked",
      });
    }
  } catch (err) {
    console.error(`Error checking block status for ${Num}:`, err);
  }

  // Check if already connected
  if (manager.isConnected(Num)) {
    return res.status(409).json({
      status: "error",
      message: "This number is already connected",
      connected: true,
    });
  }

  // Check if already connecting
  if (manager.isConnecting(Num)) {
    return res.status(409).json({
      status: "error",
      message: "This number is already in pairing process",
      connecting: true,
    });
  }

  var release = await mutex.acquire();
  try {
    console.log(`\n🔐 Pairing request for: ${Num}`);
    await connector(Num, res);
  } catch (error) {
    console.error(`❌ Pairing error for ${Num}:`, error);
    res.status(500).json({
      status: "error",
      error: "Failed to connect",
      details: error.message,
    });
  } finally {
    release();
  }
});

// List active sessions
app.get("/sessions", (req, res) => {
  const sessions = {};
  for (const [num, conn] of manager.connections) {
    sessions[num] = {
      connected: !!conn?.user,
      user: conn?.user?.id || "unknown",
      jid: conn?.user?.id || null,
    };
  }
  res.json({
    total: manager.connections.size,
    sessions,
    server_uptime: process.uptime(),
  });
});

// Check specific session status
app.get("/status", async (req, res) => {
  const num = sanitizeNumber(req.query.number);
  if (!num) {
    return res.status(400).json({
      error: "Please provide ?number=XXXXXXXXXX",
    });
  }

  const isConnected = manager.isConnected(num);
  const isConnecting = manager.isConnecting(num);
  const connection = manager.getConnection(num);
  const sessionPath = path.join(__dirname, "sessions", num);
  const sessionExists = await fs.pathExists(sessionPath);
  const credExists = await fs.pathExists(path.join(sessionPath, "creds.json"));

  res.json({
    number: num,
    connected: isConnected,
    connecting: isConnecting,
    user: connection?.user?.id || null,
    status: isConnected ? "online" : isConnecting ? "connecting" : "offline",
    session_exists: sessionExists,
    credentials_exist: credExists,
  });
});

// Delete session
app.get("/delete", async (req, res) => {
  const num = sanitizeNumber(req.query.number);
  if (!num) {
    return res.status(400).json({
      error: "Please provide ?number=XXXXXXXXXX",
    });
  }

  try {
    const sessionPath = path.join(__dirname, "sessions", num);
    console.log(`🗑️ Deleting session at: ${sessionPath}`);

    if (!(await fs.pathExists(sessionPath))) {
      return res.status(404).json({
        status: "error",
        message: "No session found",
        path: sessionPath,
      });
    }

    // Disconnect and remove from manager
    manager.removeConnection(num);

    // Delete from database
    await deleteSession(num);

    // Delete session files
    await fs.remove(sessionPath);

    res.json({
      status: "success",
      message: `Deleted session for ${num}`,
    });
  } catch (err) {
    console.error(`❌ Failed to delete session for ${num}:`, err);
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

// Block user
app.get("/block", async (req, res) => {
  const num = sanitizeNumber(req.query.number);
  if (!num) {
    return res.status(400).json({
      error: "Please provide ?number=XXXXXXXXXX",
    });
  }

  try {
    // Mark as blocked in DB
    await set(ref(db, `blocked/${num}`), {
      blocked: true,
      timestamp: Date.now(),
    });

    // Disconnect and delete session
    manager.removeConnection(num);

    const sessionPath = path.join(__dirname, "sessions", num);
    if (await fs.pathExists(sessionPath)) {
      await deleteSession(num);
      await fs.remove(sessionPath);
    }

    res.json({
      status: "success",
      message: `${num} blocked and session removed`,
    });
  } catch (err) {
    console.error(`❌ Block failed for ${num}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Unblock user
app.get("/unblock", async (req, res) => {
  const num = sanitizeNumber(req.query.number);
  if (!num) {
    return res.status(400).json({
      error: "Please provide ?number=XXXXXXXXXX",
    });
  }

  try {
    await remove(ref(db, `blocked/${num}`));
    res.json({
      status: "success",
      message: `${num} unblocked`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get blocklist
app.get("/blocklist", async (req, res) => {
  try {
    const snapshot = await get(ref(db, "blocked"));
    if (snapshot.exists()) {
      res.json(snapshot.val());
    } else {
      res.json({ message: "No blocked users" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart specific session
app.get("/restart", async (req, res) => {
  const num = sanitizeNumber(req.query.number);
  if (!num) {
    return res.status(400).json({
      error: "Please provide ?number=XXXXXXXXXX",
    });
  }

  try {
    console.log(`🔄 Restarting session: ${num}`);

    // Remove existing connection
    manager.removeConnection(num);

    await delay(2000);

    // Check if session exists
    const sessionPath = path.join(__dirname, "sessions", num);
    const credExists = await fs.pathExists(
      path.join(sessionPath, "creds.json")
    );

    if (!credExists) {
      return res.status(404).json({
        status: "error",
        message: "No session credentials found. Please pair the device first.",
      });
    }

    // Start new connection
    const bot = new WhatsApp(num);
    await bot.connect();

    res.json({
      status: "success",
      message: `Restarted session for ${num}`,
    });
  } catch (err) {
    console.error(`❌ Restart failed for ${num}:`, err);
    res.status(500).json({
      status: "error",
      error: err.message,
    });
  }
});

// Debug endpoint
app.get("/debug-paths", async (req, res) => {
  const num = sanitizeNumber(req.query.number) || "TEST";
  const sessionPath = path.join(__dirname, "sessions", num);
  const credPath = path.join(sessionPath, "creds.json");

  let allSessions = [];
  try {
    allSessions = await fs.readdir(path.join(__dirname, "sessions"));
  } catch {}

  res.json({
    baseDir: __dirname,
    sessionPath: sessionPath,
    credPath: credPath,
    sessionExists: await fs.pathExists(sessionPath),
    credExists: await fs.pathExists(credPath),
    allSessions: allSessions,
    manager: {
      connected: manager.isConnected(num),
      connecting: manager.isConnecting(num),
      totalConnections: manager.connections.size,
    },
  });
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    available_routes: [
      "GET /",
      "GET /pair?number=NUMBER",
      "GET /sessions",
      "GET /status?number=NUMBER",
      "GET /delete?number=NUMBER",
      "GET /block?number=NUMBER",
      "GET /unblock?number=NUMBER",
      "GET /blocklist",
      "GET /restart?number=NUMBER",
      "GET /debug-paths?number=NUMBER",
    ],
  });
});

// ==================== GRACEFUL SHUTDOWN ====================
async function shutdown() {
  console.log("\n👋 Shutting down gracefully...");

  // Disconnect all bots
  for (const [num] of manager.connections) {
    console.log(`🔌 Disconnecting: ${num}`);
    manager.removeConnection(num);
  }

  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

// ==================== START SERVER ====================
app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🚀 Multi-User WhatsApp Bot Server   ║
║   🌐 Port: ${PORT.toString().padEnd(28)}║
║   📅 ${new Date().toLocaleString().padEnd(34)}║
╚═══════════════════════════════════════╝
  `);

  // Restore all sessions
  await restoreSessions();

  console.log(`
✅ Server ready!
📊 Active sessions: ${manager.connections.size}
🔗 Endpoints:
   - GET  /                    (Health check)
   - GET  /pair?code=NUM    (Get pairing code)
   - GET  /sessions            (List active sessions)
   - GET  /status?number=NUM   (Check session status)
   - GET  /delete?number=NUM   (Delete session)
   - GET  /block?number=NUM    (Block user)
   - GET  /unblock?number=NUM  (Unblock user)
   - GET  /blocklist           (View blocked users)
   - GET  /restart?number=NUM  (Restart session)
   - GET  /debug-paths?num=NUM (Debug paths)
  `);
});
