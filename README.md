# Reagent Log — دليل الإعداد من الصفر (النسخة الكاملة والنهائية)

## 1) Supabase (مشروع جديد)
1. supabase.com/dashboard/new → أنشئ مشروع جديد باسم مختلف تمامًا عن أي مشروع سابق
2. انتظر لين تصير حالته **Healthy**
3. افتح ملف `supabase_schema.sql` من هذا المجلد → **قبل النسخ**، غيّر القيم اللي مكتوب فيها `CHANGE_ME_owner_user` / `CHANGE_ME_owner_pass` (يوزر وباسورد الـ Owner) للقيم اللي تبيها إنت
4. SQL Editor → New query → انسخ **الكل** والصقه → Run
   - المفروض يطلع **Success. No rows returned** بدون أي أخطاء (لأنه مشروع فاضي جديد)
5. Project Settings → Data API → انسخ **API URL** (بدون `/rest/v1/` بالآخر)
6. Project Settings → API Keys → انسخ **Publishable key**

## 2) GitHub (مستودع جديد)
1. github.com/new → اسم جديد → Public → Create repository
2. "uploading an existing file" → اسحب **كل الملفات** بهذا المجلد (12 ملف):
   App.jsx, BarcodeScanner.jsx, Login.jsx, ReceiveWizard.jsx, Settings.jsx,
   index.html, main.jsx, supabaseClient.js, package.json, vite.config.js, .env.example
3. Commit changes

## 3) Vercel (مشروع جديد)
1. vercel.com → Add New → Project → استورد نفس المستودع
2. Environment Variables:
   - `VITE_SUPABASE_URL` = رابط الـ API من خطوة 1
   - `VITE_SUPABASE_ANON_KEY` = الـ Publishable key من خطوة 1
3. Deploy

## 4) أول دخول (Owner + حسابات مخصصة)
- **Owner**: اليوزر/الباسورد اللي حطيتهم بدل `CHANGE_ME_owner_user` / `CHANGE_ME_owner_pass` — الحساب الوحيد الجاهز، وعنده كل الصلاحيات دايمًا: كل الصفحات، استقبال، تسجيل استهلاك، تعديل، حذف، مسح نهائي، صفحة Activity، وإدارة كل حسابات الموظفين
- **أي حساب ثاني** (موظفين) يسويه الـ Owner بنفسه من Settings → "Employee accounts & permissions". لكل حساب Owner يحدد بالضبط شنو يوصله، عن طريق checkboxes:
  - الصفحات: Dashboard / Reports / Charts / Settings
  - الأفعال: Receive stock / Log use / Edit entries / Delete entries
  - يقدر يغيّرها في أي وقت بعدين (زر Save يطلع تلقائي إذا سوّيت تغيير)
  - المسح النهائي (Erase permanently) وصفحة Activity وإدارة اليوزرات تبقى حصرية لـ Owner فقط، ما تنعطى لأي حساب موظف

⚠️ لازم تحط يوزر وباسورد الـ Owner بنفسك في ملف `supabase_schema.sql` قبل ما تشغّله (بدّل `CHANGE_ME_owner_user` / `CHANGE_ME_owner_pass`) — كل الحسابات الثانية تتضاف من داخل التطبيق بعدين.
عندك مشروع Supabase شغّال من قبل بنظام الأدوار القديم (lab/admin/super أو viewer)؟ شغّل `ADD_CUSTOM_PERMISSIONS.sql` عشان تنتقل لنظام الصلاحيات المخصصة بدون ما تفقد بياناتك.

## 5) قبل ما يستخدمه الفريق
من Settings (بحساب Owner):
- أضف قائمة أسماء الريجنت الجاهزة (Presets) اللي يختار منها الفريق وقت الاستقبال
- أضف أي أقسام إضافية غير الافتراضية (Chemistry, Hematology, Blood Bank, Microbiology)
- (اختياري) Owner يقدر يضيف حساب خاص لكل موظف من "Employee accounts & permissions"، ويحدد له بالضبط أي صفحات وأفعال يقدر يوصلها

## الميزات الكاملة بهذي النسخة
- استقبال بـ3 خطوات: التفاصيل (مع خيار Reagent/QC/Cal) → الفحص (Inspection) → ملاحظات
- تسجيل استهلاك يومي مع QC testing وقت الاستخدام + مسح باركود/QR
- Dashboard بالألوان (حرج/تحذير/مستقر) مقسّم حسب القسم
- تعديل وحذف (إخفاء) حسب صلاحية كل حساب، مسح نهائي لـ Owner بس
- صفحة Activity: سجل كامل زمني لكل تعديل/حذف/مسح نهائي + زر مسح السجل كامل
- Reports: بحث برقم اللوت، فلترة بالقسم، فترة زمنية، تفاصيل كاملة (استقبال+فحص+QC+من استخدم)، تصدير Excel
- إعدادات: أقسام قابلة للتعديل، قائمة ريجنت جاهزة، حسابات موظفين، حد التنبيه الافتراضي

## دومين خاص (اختياري)
Vercel → Project → Settings → Domains → أضف الدومين اللي تملكه.
