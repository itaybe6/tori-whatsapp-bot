# 🤖 Tori WhatsApp Sales Bot

צ'אטבוט מכירות לוואטסאפ עם AI (Claude) המבוסס על בסיס הידע של Tori.

---

## 📁 מבנה הפרויקט

```
tori-whatsapp-bot/
├── server.js          # שרת ראשי + webhook
├── src/
│   ├── agent.js       # לוגיקת AI + ניהול שיחות
│   ├── whatsapp.js    # שליחת הודעות ל-API של Meta
│   └── knowledge.md   # בסיס הידע של Tori (ניתן לעדכן)
├── .env.example       # תבנית לקובץ .env
├── .gitignore
└── package.json
```

---

## 🚀 הפעלה ראשונה

### שלב 1 — התקנת תלויות
```bash
cd tori-whatsapp-bot
npm install
```

### שלב 2 — יצירת קובץ .env
```bash
cp .env.example .env
```
פתח את `.env` ומלא את הערכים (ראה שלב 4 למטה).

### שלב 3 — הפעלת השרת
```bash
# מצב פיתוח (reload אוטומטי)
npm run dev

# מצב רגיל
npm start
```

### שלב 4 — ngrok (חשיפת localhost)
הורד ngrok מ-https://ngrok.com וסגור אותו:
```bash
ngrok http 3000
```
תקבל URL כמו: `https://abc123.ngrok-free.app`
שמור אותו — תצטרך אותו ב-Meta.

---

## 🔧 הגדרת Meta (WhatsApp Cloud API)

### איפה מוצאים את הערכים ל-.env?

1. נכנס ל: https://developers.facebook.com
2. בוחר את האפליקציה שלך
3. בצד שמאל: **WhatsApp → API Setup**

**PHONE_NUMBER_ID:**
מופיע בעמוד API Setup תחת "From"

**WHATSAPP_TOKEN:**
בעמוד API Setup — לחץ "Generate token" (זמני לבדיקות)
לפרודקשן: צור System User Token קבוע ב-Meta Business Settings

**VERIFY_TOKEN:**
כבר מוגדר ב-.env כ: `tori_verify_secret_2024`
(אל תשנה אלא אם תשנה גם ב-Meta)

### הגדרת Webhook ב-Meta:

1. בעמוד API Setup → **Webhooks**
2. לחץ **Configure Webhooks** (או Edit)
3. מלא:
   - **Callback URL:** `https://abc123.ngrok-free.app/webhook`
   - **Verify Token:** `tori_verify_secret_2024`
4. לחץ **Verify and Save**
5. סמן subscribe על: ✅ **messages**

---

## 📤 שליחה יזומה ללקוח (Outbound)

כשלקוח השאיר פרטים בדף הנחיתה, תשלח POST request:

```bash
curl -X POST http://localhost:3000/send-opening \
  -H "Content-Type: application/json" \
  -d '{"phone": "9725XXXXXXXX", "name": "ישראל ישראלי"}'
```

**פורמט מספר טלפון:** קידומת מדינה + מספר, בלי + ובלי 0 בהתחלה.
- ישראל: `972501234567` (במקום 0501234567)

---

## 🔑 מפתח Anthropic (Claude AI)

1. נכנס ל: https://console.anthropic.com
2. API Keys → Create Key
3. מעתיק ל-.env תחת `ANTHROPIC_API_KEY`

---

## ✏️ עדכון בסיס הידע

כל המידע על Tori נמצא ב: `src/knowledge.md`
ניתן לערוך בכל זמן — השינויים ייכנסו לתוקף בהפעלה הבאה של השרת.

---

## 🟢 בדיקת סטטוס

פתח בדפדפן: http://localhost:3000
תראה:
```json
{ "status": "🟢 Tori Bot פועל", "activeConversations": 0 }
```

---

## ⚠️ חשוב לדעת

- **ngrok URL מתחלף** בכל הפעלה (גרסה חינמית) — צריך לעדכן ב-Meta בכל פעם
- **24-hour rule:** אחרי 24 שעות ללא הודעה מהלקוח, אפשר לשלוח רק template messages מאושרים
- **זיכרון שיחות** מאוחסן בזיכרון בלבד — מתאפס כשהשרת מופעל מחדש. לפרודקשן מומלץ להוסיף Supabase.
- לפרודקשן — העלה ל-Railway.app במקום להשאיר על המחשב

---

## 📞 תמיכה

שאלות? פנה לצוות הפיתוח.
