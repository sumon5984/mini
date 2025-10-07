const EventEmitter = require("events");
const fs = require("fs-extra");
const path = require("path");
const pino = require("pino");
const axios = require("axios");
const os = require("os");
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  getContentType,
  normalizeMessageContent,
  proto,
  getAggregateVotesInPollMessage,
  getKeyAuthor,
  decryptPollVote,
} = require("@whiskeysockets/baileys");

const ffmpeg = require("fluent-ffmpeg");
optionalDependencies = {
  "@ffmpeg-installer/darwin-arm64": "4.1.5",
  "@ffmpeg-installer/darwin-x64": "4.1.0",
  "@ffmpeg-installer/linux-arm": "4.1.3",
  "@ffmpeg-installer/linux-arm64": "4.1.4",
  "@ffmpeg-installer/linux-ia32": "4.1.0",
  "@ffmpeg-installer/linux-x64": "4.1.0",
  "@ffmpeg-installer/win32-ia32": "4.1.0",
  "@ffmpeg-installer/win32-x64": "4.1.0",
};
let platform = os.platform() + "-" + os.arch();
let packageName = "@ffmpeg-installer/" + platform;
if (optionalDependencies[packageName]) {
  const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const config = require("../config");
const { platforms } = require("./base");
const { commands, serialize, WAConnection } = require("./main");
const { extractUrlsFromString } = require("./handler");
const { sleep } = require("i-nrl");
const { groupDB, personalDB, deleteSession } = require("./database");

const set_of_filters = new Set();
const store = { poll_message: { message: [] } };

// ==================== CONNECTION MANAGER ====================
class ConnectionManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.connecting = new Set();
    this.reconnectAttempts = new Map();
    this.scheduled = new Map();
    this.MAX_RECONNECT = 5;
    this.MIN_RECONNECT_DELAY = 10000; // 10s
    this.MAX_RECONNECT_DELAY = 120000; // 2min
  }

  isConnecting(id) {
    return this.connecting.has(id);
  }

  isConnected(id) {
    return this.connections.has(id) && this.connections.get(id)?.user;
  }

  setConnecting(id) {
    this.connecting.add(id);
    console.log(`🔐 [${id}] Marked as connecting`);
  }

  removeConnecting(id) {
    this.connecting.delete(id);
    console.log(`🔓 [${id}] Removed from connecting`);
  }

  addConnection(id, conn) {
    this.connections.set(id, conn);
    this.resetReconnect(id);
    this.clearScheduledReconnect(id);
    this.removeConnecting(id);
    console.log(`✅ [${id}] Added to active connections`);
  }

  removeConnection(id) {
    const conn = this.connections.get(id);
    if (conn) {
      try {
        if (typeof conn.end === "function") conn.end();
      } catch {}
    }
    this.connections.delete(id);
    console.log(`🗑️ [${id}] Removed from connections`);
  }

  getConnection(id) {
    return this.connections.get(id);
  }

  canReconnect(id) {
    const attempts = this.reconnectAttempts.get(id) || 0;
    return attempts < this.MAX_RECONNECT;
  }

  incrementReconnect(id) {
    const attempts = this.reconnectAttempts.get(id) || 0;
    this.reconnectAttempts.set(id, attempts + 1);
    console.log(
      `🔢 [${id}] Reconnect attempt: ${attempts + 1}/${this.MAX_RECONNECT}`
    );
  }

  resetReconnect(id) {
    this.reconnectAttempts.delete(id);
    console.log(`🔄 [${id}] Reconnect counter reset`);
  }

  getReconnectDelay(id) {
    const attempt = this.reconnectAttempts.get(id) || 1;
    const delay = Math.min(
      this.MIN_RECONNECT_DELAY * Math.pow(2, attempt - 1),
      this.MAX_RECONNECT_DELAY
    );
    const jitter = Math.floor(Math.random() * 1000);
    return delay + jitter;
  }

  shouldDelete(statusCode) {
    return [
      DisconnectReason.loggedOut,
      DisconnectReason.badSession,
      DisconnectReason.invalidSession,
      DisconnectReason.multideviceMismatch,
      DisconnectReason.forbidden,
      401,
      403,
    ].includes(statusCode);
  }

  scheduleReconnect(id, fn) {
    // Clear any existing scheduled reconnect first
    this.clearScheduledReconnect(id);

    if (!this.canReconnect(id)) {
      console.log(
        `❌ [${id}] Max reconnect attempts (${this.MAX_RECONNECT}) reached. Stopping.`
      );
      this.removeConnection(id);
      this.removeConnecting(id);
      this.resetReconnect(id);
      return;
    }

    this.incrementReconnect(id);
    const delay = this.getReconnectDelay(id);
    const attempt = this.reconnectAttempts.get(id);

    console.log(
      `🔄 [${id}] Scheduling reconnect (attempt ${attempt}/${
        this.MAX_RECONNECT
      }) in ${Math.round(delay / 1000)}s`
    );

    const timer = setTimeout(async () => {
      this.scheduled.delete(id);
      console.log(`⏰ [${id}] Reconnect timer fired`);

      try {
        await fn();
      } catch (err) {
        console.error(
          `❌ [${id}] Reconnect function failed:`,
          err?.message || err
        );
        this.removeConnecting(id);

        // Try again if still under max attempts
        if (this.canReconnect(id)) {
          console.log(`🔁 [${id}] Scheduling another reconnect attempt`);
          this.scheduleReconnect(id, fn);
        } else {
          console.log(`🛑 [${id}] No more reconnect attempts available`);
        }
      }
    }, delay);

    this.scheduled.set(id, timer);
  }

  clearScheduledReconnect(id) {
    const timer = this.scheduled.get(id);
    if (timer) {
      clearTimeout(timer);
      this.scheduled.delete(id);
      console.log(`🚫 [${id}] Cleared scheduled reconnect`);
    }
  }

  // Debug method
  getStatus(id) {
    return {
      connected: this.isConnected(id),
      connecting: this.isConnecting(id),
      reconnectAttempts: this.reconnectAttempts.get(id) || 0,
      hasScheduled: this.scheduled.has(id),
    };
  }
}

const manager = new ConnectionManager();

// ==================== UTILITY FUNCTIONS ====================
function insertSudo() {
  if (config.SUDO == "null" || config.SUDO == "false" || !config.SUDO)
    return [];
  config.SUDO = config.SUDO.replaceAll(" ", "");
  return config.SUDO.split(/[;,|]/) || [config.SUDO];
}

function toMessage(msg) {
  return !msg
    ? false
    : msg == "null"
    ? false
    : msg == "false"
    ? false
    : msg == "off"
    ? false
    : msg;
}

const PREFIX_FOR_POLL =
  !config.PREFIX || config.PREFIX == "false" || config.PREFIX == "null"
    ? ""
    : config.PREFIX.includes("[") && config.PREFIX.includes("]")
    ? config.PREFIX[2]
    : config.PREFIX.trim();

const MOD =
  (config.WORKTYPE && config.WORKTYPE.toLowerCase().trim()) == "public"
    ? "public"
    : "private";
let ext_plugins = 0;
let CACHED_BOT_JID = null;

function getSessionPath(number) {
  return path.join(__dirname, "..", "sessions", number);
}

// ==================== CONNECT FUNCTION ====================
const connect = async (file_path) => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📞 [${file_path}] Connection request received`);

  // Only check if already connected
  if (manager.isConnected(file_path)) {
    console.log(
      `✅ [${file_path}] Already connected, returning existing connection`
    );
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    return manager.getConnection(file_path);
  }

  // Check if currently connecting
  if (manager.isConnecting(file_path)) {
    console.log(`⚠️ [${file_path}] Already in connection process, waiting...`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    // Wait for existing connection attempt
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (manager.isConnected(file_path)) {
          clearInterval(checkInterval);
          resolve(manager.getConnection(file_path));
        } else if (!manager.isConnecting(file_path)) {
          clearInterval(checkInterval);
          reject(new Error("Connection attempt failed"));
        }
      }, 1000);
    });
  }

  manager.setConnecting(file_path);

  try {
    const sessionDir = getSessionPath(file_path);

    if (!sessionDir) {
      console.error(`❌ [${file_path}] Invalid session path`);
      manager.removeConnecting(file_path);
      throw new Error("Invalid session path");
    }

    await fs.ensureDir(sessionDir);
    console.log(`📂 [${file_path}] Session directory: ${sessionDir}`);

    // Check if credentials exist
    const credsPath = path.join(sessionDir, "creds.json");
    const credExists = await fs.pathExists(credsPath);

    if (!credExists) {
      console.error(`❌ [${file_path}] Credentials not found at: ${credsPath}`);
      manager.removeConnecting(file_path);

      try {
        const files = await fs.readdir(sessionDir);
        console.log(
          `📁 [${file_path}] Files in session dir (${files.length}):`,
          files.slice(0, 5).join(", ")
        );
      } catch {}

      throw new Error(`No credentials found for ${file_path}`);
    }

    console.log(`✅ [${file_path}] Credentials found`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(
      `📱 [${file_path}] Using WhatsApp version: ${version.join(".")}`
    );

    let conn = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      browser: Browsers.macOS("Firefox"),
      printQRInTerminal: false,
      auth: state,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 30000,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 3,
      getMessage: async () => {},
      shouldSyncHistoryMessage: () => false,
    });

    conn.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        console.log(`💾 [${file_path}] Credentials updated`);
      } catch (err) {
        console.error(
          `❌ [${file_path}] Failed to save credentials:`,
          err.message
        );
      }
    });

    if (!conn.wcg) conn.wcg = {};
    conn = new WAConnection(conn);

    conn.ev.on(
      "connection.update",
      async ({ connection, lastDisconnect, isNewLogin }) => {
        console.log(`🔔 [${file_path}] Connection status: ${connection}`);

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message;

          console.log(`🛑 [${file_path}] Connection closed`);
          console.log(`   Status Code: ${statusCode || "undefined"}`);
          console.log(`   Error: ${errorMsg || "unknown"}`);

          // Critical errors: delete session and stop
          if (manager.shouldDelete(statusCode)) {
            console.log(
              `🗑️ [${file_path}] Critical error (${statusCode}), deleting session...`
            );

            manager.removeConnection(file_path);
            manager.clearScheduledReconnect(file_path);
            manager.removeConnecting(file_path);

            try {
              await deleteSession(file_path);
              await fs.remove(sessionDir);
              console.log(`✅ [${file_path}] Session deleted successfully`);
            } catch (err) {
              console.error(
                `❌ [${file_path}] Failed to delete session:`,
                err.message
              );
            }
            return;
          }

          // All other errors: attempt reconnect
          console.log(`🔄 [${file_path}] Preparing to reconnect...`);
          manager.removeConnection(file_path);
          manager.removeConnecting(file_path);

          manager.scheduleReconnect(file_path, async () => {
            await connect(file_path);
          });
        } else if (connection === "connecting") {
          console.log(`🔌 [${file_path}] Connecting to WhatsApp...`);
        } else if (connection === "open") {
          manager.addConnection(file_path, conn);
          console.log(`✅ [${file_path}] Connected successfully!`);
          console.log(`   User: ${conn.user?.id || "unknown"}`);
          console.log(`   Name: ${conn.user?.name || "N/A"}`);

          if (isNewLogin) {
            console.log(`🆕 [${file_path}] New login detected`);
          }

          console.log(`🎯 [${file_path}] Setting up message handlers...`);
          await setupMessageHandlers(conn, file_path);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        }
      }
    );

    // Don't remove connecting here - let connection.update handle it
    console.log(`⏳ [${file_path}] Waiting for connection...`);
    return conn;
  } catch (err) {
    console.error(`❌ [${file_path}] Connection failed:`, err.message);
    console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    manager.removeConnecting(file_path);

    // Schedule reconnect on error
    manager.scheduleReconnect(file_path, async () => {
      await connect(file_path);
    });

    throw err;
  }
};
// ==================== MESSAGE HANDLERS ====================
async function setupMessageHandlers(conn, file_path) {
  const reactArray = ["🤍", "🍓", "🍄", "🎐", "🌸", "🍁", "🪼"];
  const fullJid = conn.user.id;
  CACHED_BOT_JID = conn.user.id.split(":")[0] + "@s.whatsapp.net";
  const botNumber = fullJid.split(":")[0];
  const {
    ban = false,
    plugins = {},
    toggle = {},
    sticker_cmd = {},
    shutoff = false,
    login = false,
  } = (await personalDB(
    ["ban", "toggle", "sticker_cmd", "plugins", "shutoff", "login"],
    {},
    "get",
    botNumber
  )) || {};

  for (const p in plugins) {
    try {
      const { data } = await axios(plugins[p] + "/raw");
      fs.writeFileSync("./plugins/" + p + ".js", data);
      ext_plugins += 1;
      require("./plugins/" + p + ".js");
    } catch (e) {
      ext_plugins = 1;
      await personalDB(
        ["plugins"],
        { content: { id: p } },
        "delete",
        botNumber
      );
      console.log("there is an error in plugin\nplugin name: " + p);
      console.log(e);
    }
  }
  console.log("🎀 external plugins installed successfully");
  fs.readdirSync("./plugins").forEach((plugin) => {
    if (path.extname(plugin).toLowerCase() == ".js") {
      try {
        require("../plugins/" + plugin);
      } catch (e) {
        console.log(e);
        fs.unlinkSync("./plugins/" + plugin);
      }
    }
  });
  console.log("🏓 plugin installed successfully");
  //=================================================================================
  if (login !== "true" && shutoff !== "true") {
    let start_msg;
    if (shutoff !== "true") {
      await personalDB(["login"], { content: "true" }, "set", botNumber);
      const { version } = require("../package.json");

      const mode = config.WORKTYPE;
      const prefix = config.PREFIX;
      start_msg = `
      *╭━━━〔🍓FREE 𝗕𝗢𝗧 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃〕━━━✦*
      *┃🌱 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃 : ${botNumber}*
      *┃👻 𝐏𝐑𝐄𝐅𝐈𝐗        : ${prefix}*
      *┃🔮 𝐌𝐎𝐃𝐄        : ${mode}*
      *┃☁️ 𝐏𝐋𝐀𝐓𝐅𝐎𝐑𝐌    : ${platforms()}*
      *┃🍉 PLUGINS      : ${commands.length}*
      *┃🎐 𝐕𝐄𝐑𝐒𝐈𝐎𝐍      : ${version}*
      *╰━━━━━━━━━━━━━━━━━━╯*
      
      *╭━━━〔🛠️ 𝗧𝗜𝗣𝗦〕━━━━✦*
      *┃✧ 𝐓𝐘𝐏𝐄 .menu 𝐓𝐎 𝐕𝐈𝐄𝐖 𝐀𝐋𝐋*
      *┃✧ 𝐈𝐍𝐂𝐋𝐔𝐃𝐄𝐒 𝐅𝐔𝐍, 𝐆𝐀𝐌𝐄, 𝐒𝐓𝐘𝐋𝐄*
      *╰━━━━━━━━━━━━━━━━━╯*
      
      *╭━━━〔📞 𝗖𝗢𝗡𝗧𝗔𝗖𝗧〕━━━✦*
      *┃🍓 𝐃𝐄𝐕𝐄𝐋𝐎𝐏𝐄𝐑 :* +917003816486
      *┃❤️‍🩹 𝐒𝐔𝐏𝐏𝐎𝐑𝐓    :* https://chat.whatsapp.com/GrNaLGf4LbX8VOCmigDFw3
      *╰━━━━━━━━━━━━━━━━━╯*
      `;
      if (start_msg) {
        await conn.sendMessage(conn.user.id, {
          text: start_msg,
          contextInfo: {
            mentionedJid: [conn.user.id],
            externalAdReply: {
              title: "𝐓𝐇𝐀𝐍𝐊𝐒 𝐅𝐎𝐑 𝐂𝐇𝐎𝐎𝐒𝐈𝐍𝐆 KAISEN MD FREE BOT",
              body: "",
              thumbnailUrl: "https://files.catbox.moe/9whky8.jpg",
              sourceUrl:
                "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h",
              mediaType: 1,
              renderLargerThumbnail: true,
            },
          },
        });
      }
    }
  } else if (shutoff !== "true") {
    console.log(`🍉 Connecting to WhatsApp ${botNumber}`);
  }
  const createrS = await insertSudo();

  const handleAnti = require("./antilink");
  const { mention } = require("./mention"); // Add mention handler

  conn.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const mentions =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    const botJid = conn.user.id.split(":")[0] + "@s.whatsapp.net";
    const botLid = conn.user.lid?.split(":")[0] + "@lid";

    const botNumbers = [botJid.split("@")[0], botLid?.split("@")[0]].filter(
      Boolean
    );

    const isMentioned = mentions.some((mention) => {
      const mentionNumber = mention.split("@")[0];
      return botNumbers.includes(mentionNumber);
    });

    if (isMentioned) {
      try {
        // Send initial acknowledgment
        await conn.sendMessage(
          from,
          { text: `You mentioned me 👀` },
          { quoted: msg }
        );

        // Fetch mention data from database
        const { mention: mentionData } = await personalDB(
          ["mention"],
          { content: {} },
          "get",
          botNumber
        );

        // Validate mention feature is enabled
        if (
          !mentionData?.status ||
          mentionData.status !== "true" ||
          !mentionData.message
        ) {
          console.log("⚠️ Mention feature disabled or no message set");
          return; // Exit early if feature is disabled
        }

        // Prepare sender information
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const senderNumber = senderJid.split("@")[0];

        const mentionMsg = {
          client: conn,
          jid: msg.key.remoteJid,
          sender: senderJid,
          number: senderNumber,
          key: msg.key,
          message: msg.message,
        };

        // Call mention handler
        await mention(mentionMsg, mentionData.message);
      } catch (error) {
        console.error("Error handling mention:", error);
      }
    }
  });
  //=================================================================================
  // Unified Messages & Group Update Handler
  //=================================================================================
  conn.ev.on("messages.upsert", async (m) => {
    try {
      if (m.type !== "notify") return;
      for (let msg of m.messages) {
        if (!msg?.message) continue;
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        const participant = msg.key.participant || jid;
        const mtype = getContentType(msg.message);

        // ==============================
        // 🔹 Handle AntiLink & AntiWord
        // ==============================
        try {
          await handleAnti(conn, msg);
        } catch (err) {
          console.error("❌ Anti Handler Error:", err);
        }

        // ==============================
        // 🔹 Handle Ephemeral Message
        // ==============================
        msg.message =
          mtype === "ephemeralMessage"
            ? msg.message.ephemeralMessage.message
            : msg.message;
      }
    } catch (err) {
      console.error("❌ Unified messages.upsert error:", err);
    }
  });

  //=================================================================================
  // Unified Group Participants Handler (Welcome + Goodbye)
  //=================================================================================

  const name = config.CMD_NAME;
  function externalPreview(profileImage, options = {}) {
    return {
      showAdAttribution: true,
      title: options.title || "Welcome Message",
      body: options.body || name,
      thumbnailUrl: profileImage || "https://i.imgur.com/U6d9F1v.png",
      sourceUrl:
        options.sourceUrl ||
        "https://whatsapp.com/channel/0029VaAKCMO1noz22UaRdB1Q",
      mediaType: 1,
      renderLargerThumbnail: true,
    };
  }
  conn.ev.on("group-participants.update", async (update) => {
    const { id: groupJid, participants, action } = update;
    if (action !== "add") return;

    // Get group metadata
    const groupMetadata = await conn.groupMetadata(groupJid).catch(() => {});
    const groupName = groupMetadata?.subject || "Group";
    const groupSize = groupMetadata?.participants?.length || "Unknown";

    // Check welcome config
    const { welcome } =
      (await groupDB(["welcome"], { jid: groupJid, content: {} }, "get")) || {};
    if (welcome?.status !== "true") return;

    const rawMessage = welcome.message || "";

    for (const user of participants) {
      const mentionTag = `@${user.split("@")[0]}`;

      // Get user profile pic or fallback
      let profileImage;
      try {
        profileImage = await conn.profilePictureUrl(user, "image");
      } catch {
        profileImage = "https://i.imgur.com/U6d9F1v.png";
      }

      // Replace placeholders
      let text = rawMessage
        .replace(/&mention/g, mentionTag)
        .replace(/&size/g, groupSize)
        .replace(/&name/g, groupName)
        .replace(/&pp/g, ""); // Remove &pp from message

      // Send welcome message
      if (rawMessage.includes("&pp")) {
        await conn.sendMessage(groupJid, {
          text,
          mentions: [user],
          contextInfo: {
            externalAdReply: externalPreview(profileImage),
          },
        });
      } else {
        await conn.sendMessage(groupJid, {
          text,
          mentions: [user],
        });
      }
    }
  });

  //=================================================================================

  function externalGoodbyePreview(profileImage, options = {}) {
    return {
      showAdAttribution: true,
      title: options.title || "Goodbye Message",
      body: options.body || name,
      thumbnailUrl: profileImage || "https://i.imgur.com/U6d9F1v.png",
      sourceUrl:
        options.sourceUrl ||
        "https://whatsapp.com/channel/0029VaAKCMO1noz22UaRdB1Q",
      mediaType: 1,
      renderLargerThumbnail: true,
    };
  }
  const sentGoodbye = new Set();

  conn.ev.on("group-participants.update", async (update) => {
    const { id: groupJid, participants, action } = update;

    if (action !== "remove") return; // ✅ Only on user left

    const groupMetadata = await conn.groupMetadata(groupJid).catch(() => {});
    const groupName = groupMetadata?.subject || "Group";
    const groupSize = groupMetadata?.participants?.length || "Unknown";

    const { exit } =
      (await groupDB(["exit"], { jid: groupJid, content: {} }, "get")) || {};

    if (exit?.status !== "true") return;

    const rawMessage = exit.message || "Goodbye &mention!";

    for (const user of participants) {
      const key = `${groupJid}_${user}`;
      if (sentGoodbye.has(key)) return;
      sentGoodbye.add(key);
      setTimeout(() => sentGoodbye.delete(key), 10_000);

      const mentionTag = `@${user.split("@")[0]}`;
      let profileImage;

      try {
        profileImage = await conn.profilePictureUrl(user, "image");
      } catch {
        profileImage = "https://i.imgur.com/U6d9F1v.png";
      }

      const text = rawMessage
        .replace(/&mention/g, mentionTag)
        .replace(/&name/g, groupName)
        .replace(/&size/g, groupSize)
        .replace(/&pp/g, "");

      if (rawMessage.includes("&pp")) {
        await conn.sendMessage(groupJid, {
          text,
          mentions: [user],
          contextInfo: {
            externalAdReply: externalGoodbyePreview(profileImage),
          },
        });
      } else {
        await conn.sendMessage(groupJid, {
          text,
          mentions: [user],
        });
      }
    }
  });
  // ==============================
  // 🔹 ANTI CALL (Reject any incoming call
  // ==============================
  const callEvents = ["call", "CB:call", "calls.upsert", "calls.update"];

  callEvents.forEach((eventName) => {
    conn.ev.on(eventName, async (callData) => {
      const anticallData = await personalDB(["anticall"], {}, "get", botNumber);
      if (anticallData?.anticall !== "true") return;

      try {
        const calls = Array.isArray(callData) ? callData : [callData];

        for (const call of calls) {
          console.log("Call object:", call);

          if (call.isOffer || call.status === "offer") {
            const from = call.from || call.chatId;

            await conn.sendMessage(from, {
              text: "❌ Please don't call me. I'm a bot.",
            });

            // Try different reject methods
            if (conn.rejectCall) {
              await conn.rejectCall(call.id, from);
            } else if (conn.updateCallStatus) {
              await conn.updateCallStatus(call.id, "reject");
            }

            console.log(`❌ Rejected call from ${from}`);
          }
        }
      } catch (err) {
        console.error(`❌ Error in ${eventName} handler:`, err);
      }
    });
  });
  conn.ev.on("messages.upsert", async (chatUpdate) => {
    if (set_of_filters.has(chatUpdate.messages[0].key.id)) {
      set_of_filters.delete(chatUpdate.messages[0].key.id);
      return;
    }
    const { antipromote, antidemote, filter, antidelete } = await groupDB(
      ["antidemote", "antipromote", "filter", "antiword", "antidelete"],
      {
        jid: chatUpdate.messages[0].key.remoteJid,
      },
      "get"
    );

    if (chatUpdate.messages[0]?.messageStubType && shutoff != "true") {
      const jid = chatUpdate.messages[0]?.key.remoteJid;
      const participant = chatUpdate.messages[0].messageStubParameters[0];
      const actor = chatUpdate.messages[0]?.participant;
      if (!jid || !participant || !actor) return;

      const botadmins = createrS.map((a) => !!a);
      const botJid = jidNormalizedUser(conn.user.id);
      const groupMetadata = await conn.groupMetadata(jid).catch(() => ({
        participants: [],
      }));
      const admins = (jid) =>
        groupMetadata.participants
          .filter((v) => v.admin !== null)
          .map((v) => v.id)
          .includes(jid);

      // PDM always ON
      const shouldShowPDM = true;

      if (
        chatUpdate.messages[0].messageStubType ==
        proto?.WebMessageInfo?.StubType?.GROUP_PARTICIPANT_DEMOTE
      ) {
        if (shouldShowPDM) {
          await conn.sendMessage(jid, {
            text:
              "_" +
              `@${actor.split("@")[0]} demoted @${
                participant.split("@")[0]
              } from admin` +
              "_",
            mentions: [actor, participant],
          });
        }
        await sleep(500);

        if (
          antidemote == "true" &&
          groupMetadata?.owner != actor &&
          botJid != actor &&
          admins(botJid) &&
          !botadmins.map((j) => j + "@s.whatsapp.net").includes(actor) &&
          admins(actor) &&
          !admins(participant)
        ) {
          await conn.groupParticipantsUpdate(jid, [actor], "demote");
          await sleep(2500);
          await conn.groupParticipantsUpdate(jid, [participant], "promote");
          await conn.sendMessage(jid, {
            text:
              "_" +
              `*Hmm! Why* @${actor.split("@")[0]} *did you demoted* @${
                participant.split("@")[0]
              }` +
              "_",
            mentions: [actor, participant],
          });
        }
      } else if (
        chatUpdate.messages[0].messageStubType ==
        proto?.WebMessageInfo?.StubType?.GROUP_PARTICIPANT_PROMOTE
      ) {
        if (shouldShowPDM) {
          await conn.sendMessage(jid, {
            text:
              "_" +
              `@${actor.split("@")[0]} promoted @${
                participant.split("@")[0]
              } as admin` +
              "_",
            mentions: [actor, participant],
          });
        }

        if (
          antipromote == "true" &&
          groupMetadata?.owner != actor &&
          botJid != actor &&
          admins(botJid) &&
          !botadmins.map((j) => j + "@s.whatsapp.net").includes(actor) &&
          admins(actor) &&
          admins(participant)
        ) {
          await conn.groupParticipantsUpdate(jid, [actor], "demote");
          await sleep(100);
          await conn.groupParticipantsUpdate(jid, [participant], "demote");
          await conn.sendMessage(jid, {
            text:
              "_" +
              `*Hmm! Why* @${actor.split("@")[0]} *did you promoted* @${
                participant.split("@")[0]
              }` +
              "_",
            mentions: [actor, participant],
          });
        }
      }
    }

    if (chatUpdate.messages[0]?.messageStubType) return;
    let em_ed = false,
      m;
    if (
      chatUpdate.messages[0]?.message?.pollUpdateMessage &&
      store.poll_message.message[0]
    ) {
      const content = normalizeMessageContent(chatUpdate.messages[0].message);
      const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey;
      let count = 0,
        contents_of_poll;
      for (let i = 0; i < store.poll_message.message.length; i++) {
        if (
          creationMsgKey.id == Object.keys(store.poll_message.message[i])[0]
        ) {
          contents_of_poll = store.poll_message.message[i];
          break;
        } else count++;
      }
      if (!contents_of_poll) return;
      const poll_key = Object.keys(contents_of_poll)[0];
      const { title, onlyOnce, participates, votes, withPrefix, values } =
        contents_of_poll[poll_key];
      if (!participates[0]) return;
      const pollCreation = await toMessage(creationMsgKey);
      try {
        if (pollCreation) {
          const meIdNormalised = jidNormalizedUser(conn.authState.creds.me.id);
          const voterJid = getKeyAuthor(
            chatUpdate.messages[0].key,
            meIdNormalised
          );
          if (!participates.includes(voterJid)) return;
          if (onlyOnce && votes.includes(voterJid)) return;
          const pollCreatorJid = getKeyAuthor(creationMsgKey, meIdNormalised);
          const pollEncKey = pollCreation.messageContextInfo?.messageSecret;
          const voteMsg = decryptPollVote(content.pollUpdateMessage.vote, {
            pollEncKey,
            pollCreatorJid,
            pollMsgId: creationMsgKey.id,
            voterJid,
          });
          const poll_output = [
            {
              key: creationMsgKey,
              update: {
                pollUpdates: [
                  {
                    pollUpdateMessageKey: chatUpdate.messages[0].key,
                    vote: voteMsg,
                    senderTimestampMs: chatUpdate.messages[0].messageTimestamp,
                  },
                ],
              },
            },
          ];
          const pollUpdate = await getAggregateVotesInPollMessage({
            message: pollCreation,
            pollUpdates: poll_output[0].update.pollUpdates,
          });
          const toCmd = pollUpdate.filter((v) => v.voters.length !== 0)[0]
            ?.name;
          if (!toCmd) return;
          const reg = new RegExp(toCmd, "gi");
          const cmd_msg = values.filter((a) => a.name.match(reg));
          if (!cmd_msg[0]) return;
          const poll = await conn.appenTextMessage(
            creationMsgKey.remoteJid,
            cmd_msg[0].id,
            poll_output,
            chatUpdate.messages[0],
            voterJid
          );
          m = new serialize(conn, poll.messages[0], createrS, store);
          m.isBot = false;
          m.body = m.body + " " + pollCreation.pollCreationMessage.name;
          if (withPrefix) m.body = PREFIX_FOR_POLL + m.body;
          m.isCreator = true;
          if (onlyOnce && participates.length == 1)
            delete store.poll_message.message[count][poll_key];
          else if (
            !store.poll_message.message[count][poll_key].votes.includes(
              m.sender
            )
          )
            store.poll_message.message[count][poll_key].votes.push(m.sender);
        }
      } catch (e) {}
    } else {
      m = new serialize(conn, chatUpdate.messages[0], createrS, store);
    }
    if (!m) await sleep(500);
    if (!m) return;
    // Get always online setting from database
    const alwaysOnlineData = await personalDB(
      ["always_online"],
      {},
      "get",
      botNumber
    );
    await conn.sendPresenceUpdate(
      alwaysOnlineData?.always_online === "true" ? "available" : "unavailable",
      m.jid
    );

    // Handle status broadcasts
    if (chatUpdate.messages[0].key.remoteJid == "status@broadcast") {
      // Get status view setting from database
      const statusViewData = await personalDB(
        ["status_view"],
        {},
        "get",
        botNumber
      );

      if (statusViewData?.status_view === "true") {
        await conn.readMessages([m.key]);

        // Get auto status react setting from database

        const emojis = [
          "🍉",
          "❤️‍🩹",
          "💔",
          "🥰",
          "💀",
          "👻",
          "🎉",
          "🍂",
          "🍄",
          "🌾",
          "🌸",
          "🌱",
          "🍀",
          "🪴",
          "🌀",
          "🌈",
          "🏖️",
          "🌨️",
          "🌧️",
          "⛈️",
          "🐽",
          "🪼",
          "🍓",
          "🍒",
          "🍏",
          "🎀",
          "🎁",
          "🎐",
          "🪀",
          "🏓",
          "💝",
          "💖",
          "💘",
          "💕",
          "✨",
          "🌙",
          "⭐",
          "🌌",
          "🔥",
          "⚡",
          "🌪️",
          "🌊",
          "🌻",
          "🌷",
          "🌹",
          "🌼",
          "🐼",
          "🐧",
          "🦋",
          "🐇",
          "🍫",
          "🍩",
          "🍪",
          "🍦",
        ];

        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];

        await conn.sendMessage("status@broadcast", {
          react: {
            text: randomEmoji,
            key: m.key,
          },
        });
      }

      // Get save status setting from database
      const saveStatusData = await personalDB(
        ["save_status"],
        {},
        "get",
        botNumber
      );

      if (
        saveStatusData?.save_status === "true" &&
        !m.message.protocolMessage
      ) {
        await m.forwardMessage(conn.user.id, m.message, {
          caption: m.caption,
          linkPreview: {
            title: "status saver",
            body: "from: " + (m.pushName || "") + ", " + m.number,
          },
        });
      }
    }

    let handler =
      !config.PREFIX || config.PREFIX == "false" || config.PREFIX == "null"
        ? false
        : config.PREFIX.trim();
    let noncmd = handler == false ? false : true;
    if (handler != false && handler.startsWith("[") && handler.endsWith("]")) {
      let handl = handler.replace("[", "").replace("]", "");
      handl.split("").map((h) => {
        if (m.body.startsWith(h)) {
          m.body = m.body.replace(h, "").trim();
          noncmd = false;
          handler = h;
        } else if (h == " ") {
          m.body = m.body.trim();
          noncmd = false;
          handler = h;
        }
      });
    } else if (
      handler != false &&
      m.body.toLowerCase().startsWith(handler.toLowerCase())
    ) {
      m.body = m.body.slice(handler.length).trim();
      noncmd = false;
    }
    if (m.msg && m.msg.fileSha256 && m.type === "stickerMessage") {
      for (const cmd in sticker_cmd) {
        if (sticker_cmd[cmd] == m.msg.fileSha256.join("")) {
          m.body = cmd;
          noncmd = false;
        }
      }
    }
    let resWithText = false,
      resWithCmd = false;
    if (
      m.reply_message.fromMe &&
      m.reply_message.text &&
      m.body &&
      !isNaN(m.body)
    ) {
      let textformat = m.reply_message.text.split("\n");
      if (textformat[0]) {
        textformat.map((s) => {
          if (s.includes("```") && s.split("```").length == 3 && s.match(".")) {
            const num = s.split(".")[0].replace(/[^0-9]/g, "");
            if (num && num == m.body) {
              resWithCmd += s.split("```")[1];
            }
          }
        });
        if (
          m.reply_message.text.includes("*_") &&
          m.reply_message.text.includes("_*")
        ) {
          resWithText +=
            " " + m.reply_message.text.split("*_")[1].split("_*")[0];
        }
      }
    }
    if (resWithCmd != false && resWithText != false) {
      m.body = resWithCmd.replace(false, "") + resWithText.replace(false, "");
      noncmd = false;
      m.isBot = false;
      resWithCmd = false;
      resWithText = false;
    }
    let isReact = false;

    commands.map(async (command) => {
      if (shutoff == "true" && !command.root) return;
      if (shutoff == "true" && !m.isCreator) return;
      if (ban && ban.includes(m.jid) && !command.root) return;
      let runned = false;
      if (em_ed == "active") em_ed = false;
      if (MOD == "private" && !m.isCreator && command.fromMe) em_ed = "active";
      if (MOD == "public" && command.fromMe == true && !m.isCreator)
        em_ed = "active";
      for (const t in toggle) {
        if (toggle[t].status != "false" && m.body.toLowerCase().startsWith(t))
          em_ed = "active";
      }
      if (command.onlyPm && m.isGroup) em_ed = "active";
      if (command.onlyGroup && !m.isGroup) em_ed = "active";
      if (!command.pattern && !command.on) em_ed = "active";
      if (m.isBot && !command.allowBot) em_ed = "active";
      if (command.pattern) {
        EventCmd = command.pattern.replace(/[^a-zA-Z0-9-|+]/g, "");
        if (
          ((EventCmd.includes("|") &&
            EventCmd.split("|")
              .map((a) => m.body.startsWith(a))
              .includes(true)) ||
            m.body.toLowerCase().startsWith(EventCmd)) &&
          (command.DismissPrefix || !noncmd)
        ) {
          m.command = handler + EventCmd;
          m.text = m.body.slice(EventCmd.length).trim();
          if (toMessage(config.READ) == "command")
            await conn.readMessages([m.key]);
          if (!em_ed) {
            if (command.media == "text" && !m.displayText) {
              return await m.send(
                "this plugin only response when data as text"
              );
            } else if (command.media == "sticker" && !/webp/.test(m.mime)) {
              return await m.send(
                "this plugin only response when data as sticker"
              );
            } else if (command.media == "image" && !/image/.test(m.mime)) {
              return await m.send(
                "this plugin only response when data as image"
              );
            } else if (command.media == "video" && !/video/.test(m.mime)) {
              return await m.send(
                "this plugin only response when data as video"
              );
            } else if (command.media == "audio" && !/audio/.test(m.mime)) {
              return await m.send(
                "this plugin only response when data as audio"
              );
            }
            runned = true;
            const pkg = require("../package.json");
            const DEVjid = "919088873712@s.whatsapp.net";
            await command
              .function(m, m.text, m.command, store)
              .catch(async (e) => {
                if (config.ERROR_MSG) {
                  return await m.client.sendMessage(
                    DEVjid,
                    {
                      text:
                        "                *_ERROR REPORT 🥲_* \n\n```command: " +
                        m.command +
                        "```\n```version: " +
                        pkg.version +
                        "```\n```user: @" +
                        m.sender.replace(/[^0-9]/g, "") +
                        "```\n\n```message: " +
                        m.body +
                        "```\n```error: " +
                        e.message +
                        "```",
                      mentions: [m.sender],
                    },
                    {
                      quoted: m.data,
                    }
                  );
                }
                console.error(e);
              });
          }
          await conn.sendPresenceUpdate(config.BOT_PRESENCE, m.from);
          if (toMessage(config.REACT) == "true") {
            isReact = true;
            await sleep(100);
            await m.send(
              {
                text:
                  command.react ||
                  reactArray[Math.floor(Math.random() * reactArray.length)],
                key: m.key,
              },
              {},
              "react"
            );
          } else if (toMessage(config.REACT) == "command" && command.react) {
            isReact = true;
            await sleep(100);
            await m.send(
              {
                text: command.react,
                key: m.key,
              },
              {},
              "react"
            );
          }
        }
      }
      if (!em_ed && !runned) {
        if (command.on === "all" && m) {
          command.function(m, m.text, m.command, chatUpdate, store);
        } else if (command.on === "text" && m.displayText) {
          command.function(m, m.text, m.command);
        } else if (command.on === "sticker" && m.type === "stickerMessage") {
          command.function(m, m.text, m.command);
        } else if (command.on === "image" && m.type === "imageMessage") {
          command.function(m, m.text, m.command);
        } else if (command.on === "video" && m.type === "videoMessage") {
          command.function(m, m.text, m.command);
        } else if (command.on === "audio" && m.type === "audioMessage") {
          command.function(m, m.text, m.command);
        }
      }
    });
    // some externel function
    if (
      config.AJOIN &&
      (m.type == "groupInviteMessage" ||
        m.body.match(/^https:\/\/chat\.whatsapp\.com\/[a-zA-Z0-9]/))
    ) {
      if (m.body.match(/^https:\/\/chat\.whatsapp\.com\/[a-zA-Z0-9]/))
        await conn.groupAcceptInvite(
          extractUrlsFromString(m.body)[0].split("/")[3]
        );
      if (m.type == "groupInviteMessage")
        await conn.groupAcceptInviteV4(
          chatUpdate.messages[0].key.remoteJid,
          chatUpdate.messages[0].message
        );
    }

    //end
    //automatic reaction
    if (!em_ed && shutoff != "true") {
      if (m && toMessage(config.REACT) == "emoji" && !isReact) {
        if (m.body.match(/\p{EPres}|\p{ExtPict}/gu)) {
          await m.send(
            {
              text: m.body.match(/\p{EPres}|\p{ExtPict}/gu)[0],
              key: m._key,
            },
            {},
            "react"
          );
        }
      }
    }
  });
}

// ==================== WHATSAPP CLASS ====================
class WhatsApp {
  constructor(fp) {
    this.path = fp;
    this.conn = null;
  }

  async connect() {
    console.log(`🚀 WhatsApp class: Initiating connection for ${this.path}`);
    this.conn = await connect(this.path);
    return this.conn;
  }

  disconnect() {
    console.log(`🔌 WhatsApp class: Disconnecting ${this.path}`);
    manager.removeConnection(this.path);
  }

  getStatus() {
    return manager.getStatus(this.path);
  }
}

module.exports = { WhatsApp, connect, manager, getSessionPath };
