// src/bot.js
const { Bot } = require("grammy");
const { connectDB } = require("./db");
const { User, Message, Application, DraftApplication, ThreadMap } = require("./models");
const M = require("./messages");
const KB = require("./keyboards"); // Reply keyboardlar + admin inline tugmalar
const { escapeHtml, formatFileSize, makeUserLink, getFileInfo } = require("./utils");

const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB

// === ENV ===
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("❌ BOT_TOKEN env yo'q");

const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID);
if (!ADMIN_GROUP_ID) throw new Error("❌ ADMIN_GROUP_ID env yo'q");

const MESSAGE_TOPIC_ID = process.env.MESSAGE_TOPIC_ID ? Number(process.env.MESSAGE_TOPIC_ID) : undefined;
const APPLICATION_TOPIC_ID = process.env.APPLICATION_TOPIC_ID ? Number(process.env.APPLICATION_TOPIC_ID) : undefined;

// === Bot ===
const bot = new Bot(BOT_TOKEN);
async function ensureBotInit() {
  await connectDB();
  await bot.init();
}

// === Helpers ===
function adminThreadOptions(topicId) {
  const opt = {};
  if (topicId) opt.message_thread_id = topicId;
  return opt;
}

// User -> Admin caption
function buildAdminCaptionFromUser(uFrom, text, file) {
  let s = `👤 Foydalanuvchi: ${makeUserLink(uFrom)} ${uFrom.username ? `@${escapeHtml(uFrom.username)}` : "(username yo'q)"}\n🆔 ID: ${uFrom.id}\n\n`;
  if (text) s += `💬 Xabar: ${escapeHtml(text)}\n`;
  if (file) {
    s += `📎 Fayl: ${escapeHtml(file.fileName)}\n`;
    s += `📊 Hajm: ${formatFileSize(file.fileSize)}\n`;
    s += `🗂 Tur: ${file.mediaType.toUpperCase()}`;
  }
  return s;
}

// --- Retry helpers: topic (thread) topilmasa mavzusiz yuborish ---
async function sendTextToAdminSafe(text, threadId, extra = {}) {
  try {
    return await bot.api.sendMessage(
      ADMIN_GROUP_ID,
      text,
      { ...(threadId ? { message_thread_id: threadId } : {}), parse_mode: "HTML", ...extra }
    );
  } catch (e) {
    if (e.error_code === 400 && /thread not found/i.test(e.description || "")) {
      return await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: "HTML", ...extra });
    }
    throw e;
  }
}

async function sendMediaToAdminSafe(file, options = {}) {
  const tryOnce = async (withThread) => {
    const base = { ...options };
    if (!withThread) delete base.message_thread_id;

    switch (file.mediaType) {
      case "photo":      return bot.api.sendPhoto(ADMIN_GROUP_ID, file.fileId, base);
      case "audio":      return bot.api.sendAudio(ADMIN_GROUP_ID, file.fileId, base);
      case "voice":      return bot.api.sendVoice(ADMIN_GROUP_ID, file.fileId, base);
      case "video":      return bot.api.sendVideo(ADMIN_GROUP_ID, file.fileId, base);
      case "document":   return bot.api.sendDocument(ADMIN_GROUP_ID, file.fileId, base);
      case "video_note": return bot.api.sendVideoNote(ADMIN_GROUP_ID, file.fileId, base);
      default:           return bot.api.sendDocument(ADMIN_GROUP_ID, file.fileId, base);
    }
  };

  try {
    return await tryOnce(Boolean(options.message_thread_id));
  } catch (e) {
    if (e.error_code === 400 && /thread not found/i.test(e.description || "")) {
      return await tryOnce(false);
    }
    throw e;
  }
}

// === /start ===
bot.command("start", async (ctx) => {
  try {
    await connectDB();
    const f = ctx.from;
    await User.findOneAndUpdate(
      { userId: f.id },
      {
        userId: f.id,
        username: f.username,
        firstName: f.first_name,
        lastName: f.last_name,
        state: "none",
        updatedAt: new Date()
      },
      { upsert: true }
    );
    await ctx.reply(M.WELCOME, { reply_markup: KB.mainMenuKeyboard() });
  } catch (e) {
    console.error("start error:", e);
    await ctx.reply(M.ERROR);
  }
});

// === /id === (chat/topic/user ID diagnostikasi)
bot.command("id", async (ctx) => {
  try {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const threadId = ctx.message?.message_thread_id;
    const chatTitle = ctx.chat?.title ? escapeHtml(ctx.chat.title) : "";
    const chatType = ctx.chat?.type;

    let text = "🧭 ID ma'lumotlari:\n";
    text += `• Chat ID: <code>${chatId}</code>\n`;
    if (typeof threadId === "number") text += `• Topic ID: <code>${threadId}</code>\n`;
    text += `• Sizning ID: <code>${userId}</code>\n`;
    if (chatTitle) text += `• Chat nomi: ${chatTitle}\n`;
    if (chatType) text += `• Chat turi: ${chatType}`;

    await ctx.reply(text, { parse_mode: "HTML" });
  } catch (e) {
    console.error("/id error:", e);
    await ctx.reply("❌ /id bajarishda xatolik.");
  }
});

/* ==========================
   Reply keyboard actions
   ========================== */

// 💬 Adminlarga yozish
bot.hears("💬 Adminlarga yozish", async (ctx) => {
  try {
    await connectDB();
    await User.updateOne({ userId: ctx.from.id }, { state: "messaging_admin", updatedAt: new Date() });
    await ctx.reply(M.MESSAGE_ADMIN_PROMPT, { reply_markup: KB.cancelKeyboard() });
  } catch (e) {
    console.error("hears message_admin error:", e);
    await ctx.reply(M.ERROR);
  }
});

// 📝 Ariza topshirish (statusga qarab yo'l)
bot.hears("📝 Ariza topshirish", async (ctx) => {
  try {
    await connectDB();
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
      await ctx.reply("Boshlash uchun /start yuboring.");
      return;
    }

    if (user.applicationStatus === "pending") {
      await ctx.reply(M.ALREADY_APPLIED, { reply_markup: KB.mainMenuKeyboard() });
      return;
    }
    if (user.applicationStatus === "approved") {
      await ctx.reply(M.APPROVED_USER, { reply_markup: KB.mainMenuKeyboard() });
      return;
    }

    // 'rejected' yoki 'none' => yangi draft va fayl yig'ish
    await DraftApplication.findOneAndUpdate(
      { userId: user.userId },
      { userId: user.userId, files: [], expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      { upsert: true }
    );
    await User.updateOne(
      { userId: user.userId },
      { state: "collecting_application", updatedAt: new Date() }
    );

    await ctx.reply(M.APPLY_PROMPT, { reply_markup: KB.cancelKeyboard() });
  } catch (e) {
    console.error("hears apply error:", e);
    await ctx.reply(M.ERROR);
  }
});

// ❌ Bekor qilish
bot.hears("❌ Bekor qilish", async (ctx) => {
  try {
    await connectDB();
    await User.updateOne({ userId: ctx.from.id }, { state: "none", updatedAt: new Date() });
    await ctx.reply(M.CANCELLED, { reply_markup: KB.mainMenuKeyboard() });
  } catch (e) {
    console.error("hears cancel error:", e);
    await ctx.reply(M.ERROR);
  }
});

// 🏠 Menuga qaytish
bot.hears("🏠 Menuga qaytish", async (ctx) => {
  try {
    await connectDB();
    await User.updateOne({ userId: ctx.from.id }, { state: "none", updatedAt: new Date() });
    await ctx.reply(M.WELCOME, { reply_markup: KB.mainMenuKeyboard() });
  } catch (e) {
    console.error("hears back_to_menu error:", e);
    await ctx.reply(M.ERROR);
  }
});

// ✅ Arizani topshirish
bot.hears("✅ Arizani topshirish", async (ctx) => {
  try {
    await connectDB();
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
      await ctx.reply("Boshlash uchun /start yuboring.");
      return;
    }

    const draft = await DraftApplication.findOne({ userId: user.userId });
    const files = draft?.files || [];
    if (files.length === 0) {
      await ctx.reply(M.NEED_FILE);
      return;
    }

    // Application yaratamiz
    const app = await Application.create({
      userId: user.userId,
      files,
      status: "submitted",
      submittedAt: new Date()
    });

    // Admin guruhga summary (inline Approve/Reject bilan)
    let summary = `📋 YANGI ARIZA\n\n👤 Foydalanuvchi: ${escapeHtml(user.firstName || "")} ${escapeHtml(user.lastName || "")}\n🆔 ID: ${user.userId}\n📁 Fayllar soni: ${files.length}\n`;
    files.forEach((f, i) => {
      summary += `\n${i + 1}. ${f.fileName} (${formatFileSize(f.fileSize)})`;
    });

    const root = await sendTextToAdminSafe(
      summary,
      APPLICATION_TOPIC_ID,
      { reply_markup: KB.adminApplicationActions(String(app._id)) }
    );

    // Map: admin post ↔ user
    await ThreadMap.create({
      groupMessageId: root.message_id,
      userId: user.userId,
      kind: "application",
      applicationId: app._id
    });

    // Fayllarni reply qilib yuboramiz
    for (const f of files) {
      try {
        await sendMediaToAdminSafe(f, {
          ...(APPLICATION_TOPIC_ID ? { message_thread_id: APPLICATION_TOPIC_ID } : {}),
          reply_to_message_id: root.message_id
        });
      } catch (err) {
        console.error("File send error:", err);
      }
    }

    // Log
    await Message.create({
      userId: user.userId,
      direction: "to_admin",
      kind: "application",
      content: `Application ${app._id} yuborildi (${files.length} fayl)`,
      groupMessageId: root.message_id,
      topicId: APPLICATION_TOPIC_ID
    });

    // Clean up draft / user status
    await DraftApplication.deleteOne({ userId: user.userId });
    await User.updateOne(
      { userId: user.userId },
      { state: "none", applicationStatus: "pending", updatedAt: new Date() }
    );

    await ctx.reply(M.APPLICATION_RECEIVED, { reply_markup: KB.mainMenuKeyboard() });
  } catch (e) {
    console.error("hears submit_application error:", e);
    await ctx.reply(M.ERROR);
  }
});

/* ==========================
   Admin inline callbacks
   ========================== */

bot.callbackQuery(/app:(approve|reject):(.+)/, async (ctx) => {
  try {
    await connectDB();
    const [, action, appId] = ctx.match;
    const app = await Application.findById(appId);
    if (!app) return ctx.answerCallbackQuery({ text: "Ariza topilmadi.", show_alert: true });

    const user = await User.findOne({ userId: app.userId });
    if (!user) return ctx.answerCallbackQuery({ text: "Foydalanuvchi topilmadi.", show_alert: true });

    if (action === "approve") {
      app.status = "approved";
      app.processedAt = new Date();
      await app.save();

      await User.updateOne({ userId: user.userId }, { applicationStatus: "approved", updatedAt: new Date() });
      await bot.api.sendMessage(user.userId, M.APPROVED_USER);

      await ctx.editMessageReplyMarkup(); // tugmalarni olib tashlash
      await ctx.answerCallbackQuery({ text: "Approved ✅" });
    } else {
      app.status = "rejected";
      app.processedAt = new Date();
      await app.save();

      await User.updateOne({ userId: user.userId }, { applicationStatus: "rejected", updatedAt: new Date() });
      await bot.api.sendMessage(user.userId, M.REJECTED_USER());

      await ctx.editMessageReplyMarkup();
      await ctx.answerCallbackQuery({ text: "Rejected ❌" });
    }
  } catch (e) {
    console.error("admin app action error:", e);
    await ctx.answerCallbackQuery({ text: "Xatolik.", show_alert: true });
  }
});

/* ==========================
   Message handler
   ========================== */

bot.on("message", async (ctx) => {
  try {
    await connectDB();
    const chatId = ctx.chat.id;

    // Admin guruhida: reply bo'lsa userga yuboramiz
    if (chatId === ADMIN_GROUP_ID) {
      const reply = ctx.message.reply_to_message;
      if (!reply) return;

      const rootId = reply.message_id;
      const map = await ThreadMap.findOne({ groupMessageId: rootId });
      if (!map) return;

      const targetUserId = map.userId;
      const file = getFileInfo(ctx.message);
      const textOrCaption = ctx.message.text || ctx.message.caption || "";

      if (file) {
        // admindan kelgan media -> userga
        switch (file.mediaType) {
          case "photo":      await bot.api.sendPhoto(targetUserId, file.fileId, { caption: textOrCaption || undefined }); break;
          case "audio":      await bot.api.sendAudio(targetUserId, file.fileId, { caption: textOrCaption || undefined }); break;
          case "voice":      await bot.api.sendVoice(targetUserId, file.fileId, { caption: textOrCaption || undefined }); break;
          case "video":      await bot.api.sendVideo(targetUserId, file.fileId, { caption: textOrCaption || undefined }); break;
          case "document":   await bot.api.sendDocument(targetUserId, file.fileId, { caption: textOrCaption || undefined }); break;
          case "video_note": await bot.api.sendVideoNote(targetUserId, file.fileId); break;
          default:           await bot.api.sendDocument(targetUserId, file.fileId, { caption: textOrCaption || undefined }); break;
        }
      } else {
        await bot.api.sendMessage(
          targetUserId,
          textOrCaption ? `📨 Admin javobi:\n\n${textOrCaption}` : "📨 Admin sizga javob yubordi."
        );
      }

      await Message.create({
        userId: targetUserId,
        direction: "to_user",
        content: textOrCaption,
        mediaType: file?.mediaType,
        mediaFileId: file?.fileId,
        fileName: file?.fileName,
        fileSize: file?.fileSize,
        groupMessageId: ctx.message.message_id,
        replyToGroupMessageId: rootId,
        topicId: MESSAGE_TOPIC_ID
      });

      return;
    }

    // Foydalanuvchi chatida holatlarni boshqaramiz
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
      await ctx.reply("Boshlash uchun /start yuboring.");
      return;
    }

    if (user.state === "messaging_admin") {
      const file = getFileInfo(ctx.message);
      const textOrCaption = ctx.message.text || ctx.message.caption || "";
      const caption = buildAdminCaptionFromUser(ctx.from, textOrCaption, file);

      let sent;
      if (file) {
        sent = await sendMediaToAdminSafe(file, {
          ...(MESSAGE_TOPIC_ID ? { message_thread_id: MESSAGE_TOPIC_ID } : {}),
          caption
        });
      } else {
        sent = await sendTextToAdminSafe(caption, MESSAGE_TOPIC_ID);
      }

      // Map: admin post ↔ user
      await ThreadMap.create({
        groupMessageId: sent.message_id,
        userId: user.userId,
        kind: "message"
      });

      await Message.create({
        userId: user.userId,
        direction: "to_admin",
        content: textOrCaption,
        mediaType: file?.mediaType || "text",
        mediaFileId: file?.fileId,
        fileName: file?.fileName,
        fileSize: file?.fileSize,
        groupMessageId: sent.message_id,
        topicId: MESSAGE_TOPIC_ID
      });

      await User.updateOne({ userId: user.userId }, { state: "none", updatedAt: new Date() });
      await ctx.reply(M.MESSAGE_SENT, { reply_markup: KB.mainMenuKeyboard() });
      return;
    }

    if (user.state === "collecting_application") {
      const file = getFileInfo(ctx.message);
      if (!file) {
        await ctx.reply(M.NEED_FILE);
        return;
      }
      if (file.fileSize > MAX_FILE_SIZE) {
        await ctx.reply(M.FILE_TOO_LARGE);
        return;
      }

      await DraftApplication.findOneAndUpdate(
        { userId: user.userId },
        { $push: { files: file }, $set: { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } },
        { upsert: true }
      );

      await ctx.reply(M.APPLICATION_DRAFT_ADDED(file.fileName), { reply_markup: KB.submitApplicationKeyboard() });
      return;
    }

    // Fallback: foydalanuvchi tugmani bosmagan bo'lsa ham javob beramiz
    await ctx.reply("⚠️ Iltimos, quyidagi tugmalardan birini tanlang:", {
      reply_markup: KB.mainMenuKeyboard()
    });
  } catch (e) {
    console.error("message handler error:", e);
    try {
      await ctx.reply(M.ERROR);
    } catch (_) {}
  }
});

// Global error handler
bot.catch((e) => {
  console.error("Bot error:", e);
});

module.exports = { bot, ensureBotInit };
