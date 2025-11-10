// index_fast.js — ускоренная версия генерации презентации
// Главное отличие: 1-я страница берётся из name.pdf (фон), текст (Dear/عزيزي + имя) рисуется canvas→PNG,
// затем сразу приклеивается «хвост» из внешней ссылки (DigitalOcean Spaces). Больше никаких обходов папок.
// Остальная логика (Green API, вебхук, UX-реплики) сохранена.

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { createCanvas, registerFont } from 'canvas';

dotenv.config();

const {
    GREEN_API_ID_INSTANCE,
    GREEN_API_API_TOKEN_INSTANCE,
    GREEN_MEDIA_URL = 'https://media.green-api.com',
    WEBHOOK_PORT = 3000,
    WEBHOOK_PATH = '/webhook',
    WEBSITE_URL = 'http://hickmetgroup.sa',
    SPREADSHEET_WEBAPP_URL,
    SPREADSHEET_SECRET,
    // новые переменные окружения для «хвоста»
    ENG_TAIL_URL = 'https://do-mediaout-7107.fra1.digitaloceanspaces.com/7107374016/48963020-8bd7-4e86-8e2f-e907866e3474.pdf',
    AR_TAIL_URL  = 'https://do-mediaout-7107.fra1.digitaloceanspaces.com/7107374016/ae16790f-6474-4eed-9338-bc33d06714d1.pdf',
    // параметры сетевых таймингов
    PDF_FETCH_TIMEOUT_MS = '60000',
    PDF_FETCH_RETRIES = '3',
    PDF_FETCH_BACKOFF_MS = '1000'
} = process.env;

if (!GREEN_API_ID_INSTANCE || !GREEN_API_API_TOKEN_INSTANCE || !SPREADSHEET_WEBAPP_URL || !SPREADSHEET_SECRET) {
    console.error('❌ Проверь .env: GREEN_API_ID_INSTANCE, GREEN_API_API_TOKEN_INSTANCE, SPREADSHEET_WEBAPP_URL, SPREADSHEET_SECRET');
    process.exit(1);
}

const GREEN_API_URL = `https://api.green-api.com/waInstance${GREEN_API_ID_INSTANCE}`;
const MEDIA_URL = GREEN_MEDIA_URL;

const extractPhone = (jid) => (jid || '').replace(/[@:\\D]/g, '');
const norm = (s = '') => s.toLowerCase().trim();

function getFormattedDateTime() {
    const now = new Date();
    const date = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;
    const time = `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}.${String(now.getSeconds()).padStart(2, '0')}`;
    return { date, time };
}

async function appendToSheetViaWebhook({ name, company, phone, language }) {
    const { date, time } = getFormattedDateTime();
    const payload = {
        secret: SPREADSHEET_SECRET,
        name: name || '—',
        company: company || '—',
        phone: phone || '—',
        language: language || '—',
        date,
        time
    };
    console.log('📤 Отправка данных в таблицу:', payload);
    try {
        const res = await fetch(SPREADSHEET_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'HICKMET-BOT/1.0' },
            body: JSON.stringify(payload),
        });
        const text = await res.text();
        try {
            const json = JSON.parse(text);
            if (json.success || json.ok) console.log('✅ Данные записаны в таблицу');
            else console.log('⚠️ Ответ Sheets:', json);
        } catch {
            console.warn('⚠️ appendToSheetViaWebhook: невалидный JSON:', text);
        }
    } catch (err) {
        console.warn('⚠️ Sheet request failed:', err.message);
    }
}

/* ========= Green API helpers ========= */
async function greenApiPost(method, body, timeoutMs = 10000) {
    const url = `${GREEN_API_URL}/${method}/${GREEN_API_API_TOKEN_INSTANCE}`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const text = await res.text();
        if (!res.ok) {
            console.error(`❌ Green API Error (${method}): ${res.status}`, text);
            return null;
        }

        try {
            const json = JSON.parse(text);
            if (json.sent === true || json.idMessage || json.urlFile || json.result) {
                console.log(`✅ Green API: ${method} successful.`);
            }
            return json;
        } catch (e) {
            console.warn('⚠️ greenApiPost: response is not JSON:', text);
            return null;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`❌ Green API Request Failed (${method}): Timeout after ${timeoutMs}ms`);
        } else {
            console.error(`❌ Green API Request Failed (${method}):`, error.message);
        }
        return null;
    }
}

async function sendTextMessage(chatId, message) {
    return greenApiPost('sendMessage', { chatId, message });
}

async function uploadBufferToGreen(buffer, originalFilename, contentType = 'application/pdf') {
    const asciiName = toAsciiSlug(originalFilename, 'file');
    const uploadUrl = `${MEDIA_URL}/waInstance${GREEN_API_ID_INSTANCE}/uploadFile/${GREEN_API_API_TOKEN_INSTANCE}`;
    try {
        const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                'GA-Filename': asciiName
            },
            body: buffer
        });
        const text = await res.text();
        if (!res.ok) {
            console.warn('⚠️ uploadBufferToGreen failed', res.status, text);
            return null;
        }
        const json = JSON.parse(text);
        return json.urlFile || null;
    } catch (err) {
        console.error('❌ uploadBufferToGreen error', err.message);
        return null;
    }
}

/* =================== PDF / Canvas utils =================== */
const FONT_DIR = path.join(process.cwd(), 'fonts');
const FONT_EN_SEMIBOLD_PATH = path.join(FONT_DIR, 'Inter_18pt-SemiBold.ttf');
const FONT_EN_LIGHT_PATH   = path.join(FONT_DIR, 'Inter_18pt-Light.ttf');
const FONT_AR_BOLD_PATH    = path.join(FONT_DIR, 'Amiri-Bold.ttf');
const FONT_AR_REGULAR_PATH = path.join(FONT_DIR, 'Amiri-Regular.ttf');
const TEMPLATE_PATH        = path.join(process.cwd(), 'name.pdf'); // 1-я страница- фон

function fontString(sizePx, family) {
    return `${sizePx}px '${family}'`;
}
function figmaToPdfY(pageHeight, figmaTop, itemHeight = 0) {
    return pageHeight - figmaTop - itemHeight;
}

function loadFonts() {
    try {
        if (fs.existsSync(FONT_EN_SEMIBOLD_PATH)) registerFont(FONT_EN_SEMIBOLD_PATH, { family: 'Inter-SemiBold' });
        if (fs.existsSync(FONT_EN_LIGHT_PATH))   registerFont(FONT_EN_LIGHT_PATH,   { family: 'Inter-Light' });
        if (fs.existsSync(FONT_AR_BOLD_PATH))    registerFont(FONT_AR_BOLD_PATH,    { family: 'Amiri-Bold' });
        if (fs.existsSync(FONT_AR_REGULAR_PATH)) registerFont(FONT_AR_REGULAR_PATH, { family: 'Amiri-Regular' });
        console.log('✅ Шрифты зарегистрированы (Inter + Amiri).');
    } catch (err) {
        console.warn('⚠️ Ошибка регистрации шрифтов — продолжим, но результат может отличаться.', err.message);
    }
}

/* Надёжный рендер одной строки */
function renderTextToPng(text, fontSizePx, family, color, direction = 'ltr') {
    try {
        text = String(text || '');
        const probe = createCanvas(10, 10).getContext('2d');
        probe.direction = direction;
        probe.font = fontString(fontSizePx, family);
        const metrics = probe.measureText(text);

        const measuredWidth = typeof metrics.width === 'number' ? metrics.width : 0;
        const asc  = typeof metrics.actualBoundingBoxAscent  === 'number' ? metrics.actualBoundingBoxAscent  : Math.ceil(fontSizePx * 0.9);
        const desc = typeof metrics.actualBoundingBoxDescent === 'number' ? metrics.actualBoundingBoxDescent : Math.ceil(fontSizePx * 0.35);
        const left = typeof metrics.actualBoundingBoxLeft    === 'number' ? metrics.actualBoundingBoxLeft    : 0;
        const right= typeof metrics.actualBoundingBoxRight   === 'number' ? metrics.actualBoundingBoxRight   : measuredWidth;

        const glyphWidth = Math.max(right - left, measuredWidth, Math.ceil(fontSizePx * 0.4));
        const padX = Math.ceil(fontSizePx * 0.20);
        const padY = Math.ceil(fontSizePx * 0.18);

        const width  = Math.max(1, Math.ceil(glyphWidth + padX * 2));
        const height = Math.max(1, Math.ceil(asc + desc + padY * 2));

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.direction = direction;
        ctx.font = fontString(fontSizePx, family);
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = color;

        const y = padY + asc;
        if (direction === 'rtl') {
            ctx.textAlign = 'right';
            const x = width - padX;
            ctx.fillText(text, x, y);
        } else {
            ctx.textAlign = 'left';
            const x = padX - left;
            ctx.fillText(text, x, y);
        }

        return canvas.toBuffer('image/png');
    } catch (err) {
        console.error('renderTextToPng ERROR:', err.message);
        const c = createCanvas(1, 1);
        return c.toBuffer('image/png');
    }
}

const NAME_MAX_WIDTH = 968;
const NAME_MIN_FONT_SIZE = 56;
function renderNamePng(name, baseFontSizePx, families, colors, direction = 'ltr') {
    const { boldFamily, regularFamily } = families;
    const { colorPart1, colorPart2 } = colors;

    if (direction === 'rtl') {
        let fontSize = baseFontSizePx;
        const probe = createCanvas(10, 10).getContext('2d');
        probe.direction = 'rtl';
        while (true) {
            probe.font = fontString(fontSize, boldFamily);
            const m = probe.measureText(name);
            const measuredWidth = typeof m.width === 'number' ? m.width : 0;
            const right = typeof m.actualBoundingBoxRight === 'number' ? m.actualBoundingBoxRight : measuredWidth;
            const left  = typeof m.actualBoundingBoxLeft  === 'number' ? m.actualBoundingBoxLeft  : 0;
            const glyphWidth = Math.max(right - left, measuredWidth, Math.ceil(fontSize * 0.4));
            if (glyphWidth <= NAME_MAX_WIDTH || fontSize <= NAME_MIN_FONT_SIZE) {
                return renderTextToPng(name, fontSize, boldFamily, colorPart2, 'rtl');
            }
            fontSize = Math.floor(fontSize * 0.9);
        }
    }

    const parts = String(name || '').split(' ');
    const part1 = parts.shift() || '';
    const part2 = parts.join(' ') || '';

    let fontSize = baseFontSizePx;
    const probe = createCanvas(10, 10).getContext('2d');
    while (true) {
        probe.font = fontString(fontSize, boldFamily);
        const m1 = probe.measureText(part1);
        const w1 = Math.max(
            typeof m1.actualBoundingBoxRight === 'number' && typeof m1.actualBoundingBoxLeft === 'number' ? m1.actualBoundingBoxRight - m1.actualBoundingBoxLeft : 0,
            m1.width || 0,
            Math.ceil(fontSize * 0.4)
        );
        probe.font = fontString(fontSize, regularFamily);
        const m2 = probe.measureText(part2);
        const w2 = Math.max(
            typeof m2.actualBoundingBoxRight === 'number' && typeof m2.actualBoundingBoxLeft === 'number' ? m2.actualBoundingBoxRight - m2.actualBoundingBoxLeft : 0,
            m2.width || 0,
            Math.ceil(fontSize * 0.4)
        );
        const space = probe.measureText(' ').width || Math.ceil(fontSize * 0.2);
        const total = Math.ceil(w1 + (part2 ? space + w2 : 0));

        if (total <= NAME_MAX_WIDTH || fontSize <= NAME_MIN_FONT_SIZE) {
            const height = Math.ceil(fontSize * 1.4);
            const canvas = createCanvas(Math.max(1, total), Math.max(1, height));
            const ctx = canvas.getContext('2d');
            ctx.direction = 'ltr';
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';

            ctx.font = fontString(fontSize, boldFamily);
            ctx.fillStyle = colorPart1;
            ctx.fillText(part1, 0, 0);

            if (part2) {
                const m1w = ctx.measureText(part1).width;
                const spaceW = ctx.measureText(' ').width || Math.ceil(fontSize * 0.2);
                ctx.font = fontString(fontSize, regularFamily);
                ctx.fillStyle = colorPart2;
                ctx.fillText(part2, m1w + spaceW, 0);
            }
            return canvas.toBuffer('image/png');
        }
        fontSize = Math.floor(fontSize * 0.9);
    }
}

async function fetchPdfBytes(url, { timeoutMs = Number(PDF_FETCH_TIMEOUT_MS || 60000), retries = Number(PDF_FETCH_RETRIES || 3), backoffMs = Number(PDF_FETCH_BACKOFF_MS || 1000) } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'HickmetPDF/1.0 (+node-fetch)' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            clearTimeout(t);
            return new Uint8Array(buf);
        } catch (e) {
            clearTimeout(t);
            lastErr = e;
            const isAbort = e?.name === 'AbortError' || e?.type === 'aborted';
            const wait = backoffMs * Math.pow(2, attempt - 1);
            console.warn(`⚠️ fetchPdfBytes attempt ${attempt}/${retries} failed (${isAbort ? 'timeout' : e.message}). Retrying in ${wait}ms...`);
            if (attempt < retries) await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastErr || new Error('Unknown fetchPdfBytes error');
}

async function appendTail(mainDoc, tailBytes) {
    const tailDoc = await PDFDocument.load(tailBytes);
    const indices = tailDoc.getPageIndices();
    const pages = await mainDoc.copyPages(tailDoc, indices);
    pages.forEach((p) => mainDoc.addPage(p));
}

/* дизайн-константы */
const TEXTS = { English: { dear: 'Dear' }, Arabic: { dear: 'عزيزي' } };
const DEAR_COLOR = '#967E5A';
const DEAR_FONT_SIZE = 64;
const DEAR_FIGMA_TOP = 1006;
const DEAR_FIGMA_LEFT = 126;
const PAGE_RIGHT_MARGIN = 126;
const NAME_FONT_SIZE = 128;
const NAME_PART1_COLOR = DEAR_COLOR;
const NAME_PART2_COLOR = '#302525';
const NAME_FIGMA_TOP = 1059;

/* === НОВАЯ БЫСТРАЯ ГЕНЕРАЦИЯ === */
async function generateAndAssemblePdf(name, language) {
    console.log(`🖌️ Сборка PDF: ${language}, ${name}`);

    // 0) Проверяем шаблон
    if (!fs.existsSync(TEMPLATE_PATH)) throw new Error(`Шаблон name.pdf не найден по пути: ${TEMPLATE_PATH}`);

    // 1) Загружаем шаблон и готовим первую страницу
    const templateBytes = fs.readFileSync(TEMPLATE_PATH);
    const templateDoc = await PDFDocument.load(templateBytes);
    const pdfDoc = await PDFDocument.create();
    const [firstPage] = await pdfDoc.copyPages(templateDoc, [0]);
    pdfDoc.addPage(firstPage);

    const { width: pageWidth, height: pageHeight } = firstPage.getSize();

    const isArabic = language === 'Arabic';
    const families = isArabic
        ? { boldFamily: 'Amiri-Bold', regularFamily: 'Amiri-Regular' }
        : { boldFamily: 'Inter-SemiBold', regularFamily: 'Inter-Light' };
    const direction = isArabic ? 'rtl' : 'ltr';

    // 2) Dear/عزيزي
    const dearText = TEXTS[language].dear;
    const dearPng = renderTextToPng(dearText, DEAR_FONT_SIZE, families.boldFamily, DEAR_COLOR, direction);
    const dearImage = await pdfDoc.embedPng(dearPng);
    const dearDims = dearImage.scale(1);
    const dearY = figmaToPdfY(pageHeight, DEAR_FIGMA_TOP, dearDims.height);
    const dearX = isArabic ? pageWidth - PAGE_RIGHT_MARGIN - dearDims.width : DEAR_FIGMA_LEFT;
    firstPage.drawImage(dearImage, { x: dearX, y: dearY, width: dearDims.width, height: dearDims.height });

    // 3) Имя
    const namePng = renderNamePng(
        String(name || ''),
        NAME_FONT_SIZE,
        families,
        { colorPart1: NAME_PART1_COLOR, colorPart2: NAME_PART2_COLOR },
        direction
    );
    const nameImage = await pdfDoc.embedPng(namePng);
    let nameDims = nameImage.scale(1);
    if (nameDims.width > NAME_MAX_WIDTH) {
        const k = NAME_MAX_WIDTH / nameDims.width;
        nameDims = nameImage.scale(k);
    }
    const nameY = figmaToPdfY(pageHeight, NAME_FIGMA_TOP, nameDims.height);
    const nameX = isArabic ? pageWidth - PAGE_RIGHT_MARGIN - nameDims.width : DEAR_FIGMA_LEFT;
    firstPage.drawImage(nameImage, { x: nameX, y: nameY, width: nameDims.width, height: nameDims.height });

    console.log('✅ Первая страница готова, тянем хвост…');

    // 4) «Хвост» из ссылки
    const tailUrl = isArabic ? AR_TAIL_URL : ENG_TAIL_URL;
    const tailBytes = await fetchPdfBytes(tailUrl);
    await appendTail(pdfDoc, tailBytes);

    // 5) Сохраняем
    const finalBytes = await pdfDoc.save();
    return Buffer.from(finalBytes);
}

async function sendPdfByUrlOrUpload({ chatId, pdfBuffer, niceFileName, externalPdfUrl, caption }) {
    let urlFile = externalPdfUrl || null;
    if (!urlFile) {
        urlFile = await uploadBufferToGreen(pdfBuffer, niceFileName, 'application/pdf');
        if (!urlFile) throw new Error('upload failed');
    }
    const res = await greenApiPost('sendFileByUrl', { chatId, urlFile, fileName: niceFileName, caption }, 20000);
    if (!res) throw new Error('sendFileByUrl failed');
    return res;
}

/* caption под файлом и минимум сообщений */
async function sendMaterialsFast(from, language, name = '', company = '') {
    try {
        const confirmationText = language === 'English'
            ? `✅ *Your inquiry has been received*\n\nOur specialist will contact you shortly to discuss your requests.\n\n*Hickmet Group* — your gateway to Saudi Arabia`
            : `✅ *تم استلام استفساركم*\n\nسيتواصل معكم أحد متخصصينا قريباً لمناقشة طلباتكم.\n\n*Hickmet Group* — بوابتكم إلى المملكة العربية السعودية`;
        await sendTextMessage(from, confirmationText);

        if (WEBSITE_URL) {
            const websiteText = language === 'English'
                ? `🌐 Visit Our Website\n\n${WEBSITE_URL}\n\nFor immediate assistance, message us anytime! 🕋`
                : `🌐 زوروا موقعنا\n\n${WEBSITE_URL}\n\nللحصول على مساعدة فورية، راسلونا في أي وقت! 🕋`;
            await sendTextMessage(from, websiteText);
        }

        try {
            const pdfBuffer = await generateAndAssemblePdf(name || 'Guest', language);
            const fileName = `${(name || 'Client').replace(/\s+/g, '_')}_HGS.pdf`;
            const caption = language === 'English'
                ? (name ? `Welcome, ${name}${company ? ` — ${company}’s reliable bridge to Saudi Arabia.` : ` — your reliable bridge to Saudi Arabia.`}` : `Welcome — your reliable bridge to Saudi Arabia.`)
                : (name ? `مرحبًا، ${name}${company ? ` — جسر ${company} الموثوق إلى المملكة العربية السعودية.` : ' — جسرُك الموثوق إلى المملكة العربية السعودية.'}` : 'مرحبًا — جسرُك الموثوق إلى المملكة العربية السعودية.');

            await sendPdfByUrlOrUpload({ chatId: from, pdfBuffer, niceFileName: fileName, externalPdfUrl: null, caption });
        } catch (err) {
            console.error('❌ Ошибка генерации/отправки PDF:', err);
            await sendTextMessage(from, language === 'English'
                ? 'We are preparing your presentation. Our specialist will send it to you shortly.'
                : 'نحن نقوم بإعداد العرض التقديمي الخاص بك. سيرسله لك متخصصنا قريباً.');
        }
    } catch (error) {
        console.error('❌ Error in sendMaterialsFast:', error);
    }
}

/* ========= Dialog state & prompts ========= */
const sessions = {};
const processedMessages = new Set();

function sendLanguagePrompt(to) {
    const message = [
        '🕋 Wa alaykum as-salām wa raḥmatullāhi wa barakātuh',
        '',
        'Welcome to Hickmet Group — your trusted DMC partner in Saudi Arabia.',
        '',
        'Please choose your language:',
        'English — type 1 or english',
        'Arabic — اكتب 2 أو arabic'
    ].join('\n');
    return sendTextMessage(to, message);
}

function toAsciiSlug(s, fallback = 'file') {
    const ascii = (s || '')
        .normalize('NFKD')
        .replace(/[^\x00-\x7F]/g, '_')
        .replace(/[_\s]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return ascii || fallback;
}

/* ========= Server start (webhook handling) ========= */
async function start() {
    loadFonts();
    console.log('⏱️ fetch cfg:', { PDF_FETCH_TIMEOUT_MS, PDF_FETCH_RETRIES, PDF_FETCH_BACKOFF_MS });

    console.log('🚀 Запуск Express-сервера для Green API...');
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    app.post(WEBHOOK_PATH, async (req, res) => {
        let from = null;
        try {
            res.status(200).send('OK');
            const data = req.body;
            if (!data || data.typeWebhook !== 'incomingMessageReceived' || !data.messageData) return;

            const msgType = data.messageData.typeMessage;
            if (msgType !== 'textMessage' && msgType !== 'extendedTextMessage') {
                console.log(`[Webhook] Пропускаем тип сообщения: ${msgType}`);
                return;
            }

            from = data.senderData.chatId;
            const messageId = data.idMessage;
            const phone = extractPhone(from);

            if (processedMessages.has(messageId)) {
                console.log(`🔄 Пропускаем дубликат сообщения от [${phone}]`);
                return;
            }
            processedMessages.add(messageId);
            setTimeout(() => processedMessages.delete(messageId), 5000);

            let text = '';
            if (msgType === 'textMessage') text = data.messageData.textMessageData.textMessage;
            else if (msgType === 'extendedTextMessage') text = data.messageData.extendedTextMessageData.text;
            const body = norm(text || '');
            console.log(`[${phone}] ${body}`);

            if (!sessions[from]) {
                sessions[from] = { step: 'chooseLanguage' };
                await sendLanguagePrompt(from);
                return;
            }

            // выбор языка
            if (sessions[from]?.step === 'chooseLanguage') {
                if (body === '1' || body.startsWith('english') || body.includes('eng') || body === 'en') {
                    sessions[from].language = 'English';
                    sessions[from].step = 'askName';
                    await sendTextMessage(from,
                        `🕋 Thank you for reaching out to *Hickmet Group* — we provide extensive travel services across Saudi Arabia.\n\nTo prepare the best offer for you, please provide:\n\n1️⃣ *Your full name*`);
                    return;
                }
                if (body === '2' || body.startsWith('arabic') || body.includes('عربي') || body.includes('араб') || body === 'ar') {
                    sessions[from].language = 'Arabic';
                    sessions[from].step = 'askName';
                    await sendTextMessage(from,
                        `🕋 شكراً لتواصلكم مع *Hickmet Group* — نقدم خدمات سياحية شاملة في جميع أنحاء المملكة العربية السعودية.\n\nلإعداد أفضل عرض لكم، يرجى تقديم:\n\n1️⃣ *الاسم الكامل*`);
                    return;
                }
                await sendLanguagePrompt(from);
                return;
            }

            // English flow
            if (sessions[from]?.language === 'English') {
                const s = sessions[from];
                if (s.step === 'askName') {
                    if ((text || '').length < 2 || (text || '').length > 120) {
                        await sendTextMessage(from, '📝 *Please provide your full name* (2-120 characters)');
                        return;
                    }
                    s.name = text.trim();
                    s.step = 'askClientType';
                    await sendTextMessage(from, `Nice to meet you, *${s.name}*!\n\n*Are you contacting us as:*\n\n👤 *Individual* — type *individual* or *1*\n\n🏢 *Company/Group* — type *company* or *2*`);
                    return;
                }
                if (s.step === 'askClientType') {
                    const normalized = norm(text || '');
                    if (normalized === '1' || normalized.includes('individual') || normalized.includes('person')) {
                        const company = '';
                        const name = s.name || '—';
                        try {
                            await sendMaterialsFast(from, 'English', name, company);
                            await appendToSheetViaWebhook({ name, company: 'Individual', phone, language: 'English' });
                        } finally {
                            delete sessions[from];
                        }
                        return;
                    } else if (normalized === '2' || normalized.includes('company') || normalized.includes('business') || normalized.includes('group')) {
                        s.step = 'askCompany';
                        await sendTextMessage(from, '🏢 *Please tell us the name of your company or organization:*');
                        return;
                    } else {
                        await sendTextMessage(from, `*Please choose:*\n\n👤 *Individual* — type *individual* or *1*\n\n🏢 *Company/Group* — type *company* or *2*`);
                        return;
                    }
                }
                if (s.step === 'askCompany') {
                    const company = (text || '').trim() || '';
                    const name = s.name || '—';
                    try {
                        await sendMaterialsFast(from, 'English', name, company);
                        await appendToSheetViaWebhook({ name, company: company || '—', phone, language: 'English' });
                    } finally {
                        delete sessions[from];
                    }
                    return;
                }
            }

            // Arabic flow
            if (sessions[from]?.language === 'Arabic') {
                const s = sessions[from];
                if (s.step === 'askName') {
                    if ((text || '').length < 2 || (text || '').length > 120) {
                        await sendTextMessage(from, '📝 *يرجى تقديم الاسم الكامل* (2-120 حرفاً)');
                        return;
                    }
                    s.name = text.trim();
                    s.step = 'askClientType';
                    await sendTextMessage(from, `تشرفنا بمعرفتك، *${s.name}*!\n\n*هل تتواصل معنا كـ:*\n\n👤 *فرد* — اكتب *فرد* أو *1*\n\n🏢 *شركة/مجموعة* — اكتب *شركة* أو *2*`);
                    return;
                }
                if (s.step === 'askClientType') {
                    const normalized = norm(text || '');
                    if (normalized === '1' || normalized.includes('فرد') || normalized.includes('شخص')) {
                        const company = '';
                        const name = s.name || '—';
                        try {
                            await sendMaterialsFast(from, 'Arabic', name, company);
                            await appendToSheetViaWebhook({ name, company: 'فرد', phone, language: 'Arabic' });
                        } finally {
                            delete sessions[from];
                        }
                        return;
                    } else if (normalized === '2' || normalized.includes('شركة') || normalized.includes('مجموعة') || normalized.includes('عمل')) {
                        s.step = 'askCompany';
                        await sendTextMessage(from, '🏢 *يرجى إخبارنا باسم شركتكم أو مجموعتكم:*');
                        return;
                    } else {
                        await sendTextMessage(from, `*يرجى الاختيار:*\n\n👤 *فرد* — اكتب *فرد* أو *1*\n\n🏢 *شركة/مجموعة* — اكتب *شركة* أو *2*`);
                        return;
                    }
                }
                if (s.step === 'askCompany') {
                    const company = (text || '').trim() || '';
                    const name = s.name || '—';
                    try {
                        await sendMaterialsFast(from, 'Arabic', name, company);
                        await appendToSheetViaWebhook({ name, company: company || '—', phone, language: 'Arabic' });
                    } finally {
                        delete sessions[from];
                    }
                    return;
                }
            }

        } catch (err) {
            console.error('❗ Webhook error:', err);
            if (from) delete sessions[from];
        }
    });

    app.get('/', (req, res) => res.send('Hickmet Bot (Green API) is running!'));

    app.listen(WEBHOOK_PORT, () => {
        console.log(`✅ HICKMET Assistant (Green API) is READY.`);
        console.log(`Server listening for webhooks at http://localhost:${WEBHOOK_PORT}${WEBHOOK_PATH}`);
    });
}

process.on('unhandledRejection', (reason, promise) => console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason));
process.on('uncaughtException', (error) => console.error('❌ Uncaught Exception:', error));

start().catch(err => console.error('❌ Startup error:', err));
