# Chat Buzz API

هذه حزمة الخادم الخلفي لتطبيق **شات بوز**. تعمل باستخدام Node.js وExpress وPostgreSQL، وتوفر الأساس العملي لتسجيل الحسابات، استكشاف الغرف، الانضمام إلى الغرفة، رسائل الغرف، قائمة الهدايا، وإرسال الهدايا مع خصم وإضافة النقاط داخل معاملة قاعدة بيانات واحدة.

> هذه النسخة جاهزة لخدمة REST على Railway. الصوت المباشر وLiveKit يحتاجان خدمة صوت مستقلة، وسيتم ربطهما لاحقاً عبر `roomId` وبيانات الجلسة الصوتية، من دون تغيير مسارات الحسابات والغرف والهدايا.

## محتويات المجلد

| المسار | الاستخدام |
|---|---|
| `src/server.js` | خادم Express وجميع مسارات API |
| `src/init-db.js` | تهيئة قاعدة PostgreSQL يدوياً عند الحاجة |
| `drizzle/schema.sql` | الجداول والفهارس والهدايا الافتراضية |
| `railway.json` | إعداد البناء والتشغيل وفحص `/health` |
| `Dockerfile` | تشغيل اختياري عبر Docker |
| `ENVIRONMENT.template` | أسماء متغيرات البيئة المطلوبة، بلا أسرار |
| `tests/api.test.js` | اختبارات المسارات الأساسية |

## التشغيل المحلي

من داخل هذا المجلد نفّذ:

```bash
npm install
cp ENVIRONMENT.template .env
# عدّل DATABASE_URL وJWT_SECRET داخل .env
npm run db:init
npm start
```

بعد التشغيل افتح:

```text
http://localhost:3000/health
```

يجب أن تحصل على استجابة JSON تحتوي على `"ok": true` و`"database": "ready"`.

## النشر على GitHub من الهاتف

أنشئ مستودعاً جديداً وفارغاً في GitHub باسم مثل `chat-buzz-api`. ارفع **محتويات مجلد `api` نفسها** إلى جذر المستودع، وليس المجلد الأب كاملاً. يجب أن يكون `package.json` ظاهراً مباشرة في الصفحة الرئيسية للمستودع.

لا ترفع ملف `.env` ولا أي قيمة حقيقية لـ `JWT_SECRET` أو `DATABASE_URL`. الملف المرفق `ENVIRONMENT.template` للتوضيح فقط.

## النشر على Railway

أنشئ مشروعاً جديداً في Railway، ثم أضف خدمتين: خدمة PostgreSQL، وخدمة API من مستودع GitHub. إذا طلب Railway تحديد Root Directory فاكتب `/` لأن ملفات API موجودة في جذر المستودع. أما إذا رفعت المشروع كاملاً وبقيت API داخل `api`، فحدّد Root Directory إلى `/api`.

بعد إضافة خدمة PostgreSQL، افتح متغيرات خدمة API وأضف أو تحقق من المتغيرات الآتية:

| المتغير | القيمة |
|---|---|
| `DATABASE_URL` | اربط مرجع PostgreSQL الذي ينشئه Railway تلقائياً، أو استخدم رابط الاتصال الذي يوفره لك Railway |
| `JWT_SECRET` | نص عشوائي طويل لا يعرفه أحد؛ لا تستخدم القيمة الافتراضية |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | `*` للتجربة الأولى، ثم نطاق الواجهة عند توفره |
| `PGSSL` | `false` افتراضياً، أو `true` إذا كان اتصال PostgreSQL لديك يتطلب SSL |

لا تضبط `PORT` يدوياً عادةً؛ الخادم يقرأ المنفذ الذي يحقنه Railway تلقائياً. بعد اكتمال النشر، أضف نطاقاً عاماً من إعدادات الخدمة، ثم اختبر أولاً مسار التشغيل الحي الذي يستخدمه Railway:

```text
https://YOUR-RAILWAY-DOMAIN/health/live
```

يجب أن يعيد هذا المسار الحالة `200` مع `"ok": true`. بعد ذلك اختبر جاهزية قاعدة البيانات عبر:

```text
https://YOUR-RAILWAY-DOMAIN/health
```

عند نجاح الربط، تظهر استجابة مثل:

```json
{
  "ok": true,
  "service": "chat-buzz-api",
  "version": "1.0.0",
  "database": "ready"
}
```

الخادم يهيئ الجداول تلقائياً عند الإقلاع. ويمكن تشغيل التهيئة يدوياً من مجلد API عند الحاجة عبر `npm run db:init`.

## المسارات الأساسية

جميع المسارات التي تحمل علامة **محمية** تحتاج إلى رأس HTTP بهذا الشكل:

```text
Authorization: Bearer YOUR_TOKEN
```

| الطريقة | المسار | الحماية | الوظيفة |
|---|---|---:|---|
| `GET` | `/health/live` | لا | فحص تشغيل الخادم، ويستخدمه Railway |
| `GET` | `/health` | لا | فحص الخادم وقاعدة البيانات |
| `GET` | `/api/v1` | لا | عرض نسخة API والمسارات |
| `POST` | `/api/v1/auth/register` | لا | إنشاء حساب |
| `POST` | `/api/v1/auth/login` | لا | تسجيل الدخول وإرجاع JWT |
| `GET` | `/api/v1/me` | نعم | بيانات الحساب الحالي |
| `GET` | `/api/v1/users/search?q=` | نعم | البحث عن مستخدمين |
| `GET` | `/api/v1/rooms` | لا | استكشاف الغرف الحية |
| `POST` | `/api/v1/rooms` | نعم | إنشاء غرفة والانضمام إليها كمالك |
| `GET` | `/api/v1/rooms/:roomId` | لا | تفاصيل الغرفة والأعضاء |
| `POST` | `/api/v1/rooms/:roomId/join` | نعم | الانضمام إلى غرفة |
| `POST` | `/api/v1/rooms/:roomId/leave` | نعم | مغادرة غرفة |
| `GET` | `/api/v1/rooms/:roomId/messages` | نعم | قراءة رسائل الغرفة |
| `POST` | `/api/v1/rooms/:roomId/messages` | نعم | إرسال رسالة |
| `GET` | `/api/v1/gifts` | لا | عرض الهدايا والأسعار |
| `POST` | `/api/v1/gifts/send` | نعم | إرسال هدية واحتساب النقاط |
| `GET` | `/api/v1/gifts/history` | نعم | سجل الهدايا للمستخدم |

## أمثلة الطلبات

### إنشاء حساب

```json
POST /api/v1/auth/register
{
  "username": "ahmed_1",
  "displayName": "أحمد",
  "password": "ضع-كلمة-مرور-قوية"
}
```

تحتفظ بالتوكن الذي يرجعه الخادم، ثم ترسله مع الطلبات المحمية.

### إنشاء غرفة

```json
POST /api/v1/rooms
Authorization: Bearer YOUR_TOKEN
{
  "name": "غرفة الأصدقاء",
  "description": "جلسة دردشة ودية",
  "category": "عام",
  "maxMembers": 100
}
```

### إرسال رسالة

```json
POST /api/v1/rooms/ROOM_ID/messages
Authorization: Bearer YOUR_TOKEN
{
  "body": "أهلاً بالجميع"
}
```

### إرسال هدية

```json
POST /api/v1/gifts/send
Authorization: Bearer YOUR_TOKEN
{
  "giftId": "GIFT_UUID",
  "recipientId": "USER_UUID",
  "roomId": "ROOM_UUID",
  "quantity": 1
}
```

يجب أن يمتلك المرسل نقاطاً كافية. لا ينجح الطلب إذا كان المستقبل غير موجود أو لم يكن الطرفان عضوين في الغرفة عند إرسال هدية مرتبطة بغرفة.

## ربط تطبيق شات بوز

بعد حصولك على نطاق Railway، استخدم عنوان API الأساسي من دون `/health`، مثلاً:

```text
https://chat-buzz-api-production.up.railway.app
```

في تطبيق شات بوز اجعل قيمة السيرفر المحفوظة هي هذا العنوان، ثم أضف المسار المطلوب إليه. مثال:

```ts
const API_BASE_URL = `${serverUrl}/api/v1`;
const response = await fetch(`${API_BASE_URL}/rooms`);
```

وعند تسجيل الدخول خزّن `token` في تخزين آمن على الجهاز، وأرسل رأس `Authorization` مع المسارات المحمية. لا تضع `JWT_SECRET` داخل تطبيق الهاتف؛ هذه القيمة تبقى داخل Railway فقط.

## الاختبار

من داخل المجلد:

```bash
npm test
```

وللتحقق من النشر استخدم متصفح الهاتف لفتح `/health`، ثم افتح `/api/v1`. إذا ظهر `database: "error"`، راجع ربط PostgreSQL ومتغير `DATABASE_URL` في خدمة API، ثم أعد النشر.
