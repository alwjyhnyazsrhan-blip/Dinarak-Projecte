require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const SITE_NAME = 'دينارك';
const DEFAULT_PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const levelSeeds = [
  {
    name: 'مستوى البداية',
    priceUsd: 50,
    dailyTaskCount: 3,
    dailyProfitUsd: 1.5,
    benefits: 'مهام يومية ثابتة، ربح يومي واضح، دعم ذكي أساسي، رابط إحالة شخصي',
    sortOrder: 1,
  },
  {
    name: 'المستوى الفضي',
    priceUsd: 150,
    dailyTaskCount: 5,
    dailyProfitUsd: 5,
    benefits: 'عدد مهام أعلى، أولوية مراجعة أسرع، عمولة إحالة أفضل، لوحة أرباح أوضح',
    sortOrder: 2,
  },
  {
    name: 'المستوى الذهبي',
    priceUsd: 300,
    dailyTaskCount: 7,
    dailyProfitUsd: 12,
    benefits: 'ربح يومي أعلى، مهام مميزة، معالجة أسرع للسحب، دعم متقدم',
    sortOrder: 3,
  },
  {
    name: 'المستوى البلاتيني',
    priceUsd: 600,
    dailyTaskCount: 10,
    dailyProfitUsd: 25,
    benefits: 'أفضلية كاملة، ربح يومي ثابت أعلى، إحالات أقوى، متابعة من لوحة الأدمن',
    sortOrder: 4,
  },
];

function makeTasksForLevel(level) {
  const titles = [
    'تنفيذ مهمة تفاعل يومية',
    'مراجعة عرض ممول',
    'إتمام نشاط تسويقي قصير',
    'تأكيد متابعة إعلان',
    'فحص حملة جديدة',
    'إتمام مهمة تقييم',
    'مهمة ولاء يومية',
    'مراجعة نشاط الشريك',
    'إكمال تنشيط الحساب',
    'إرسال تأكيد المهمة',
  ];

  const reward = Number((level.dailyProfitUsd / level.dailyTaskCount).toFixed(2));
  return Array.from({ length: level.dailyTaskCount }).map((_, index) => ({
    title: `${titles[index] || 'مهمة يومية'} ${index + 1}`,
    description: `هذه المهمة مرتبطة مباشرة بمستوى ${level.name} وربحها اليومي ثابت وغير عشوائي.`,
    rewardUsd: index === level.dailyTaskCount - 1
      ? Number((level.dailyProfitUsd - reward * (level.dailyTaskCount - 1)).toFixed(2))
      : reward,
    sortOrder: index + 1,
  }));
}

function makeReferralCode(name = 'DNR') {
  const slug = String(name).replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').slice(0, 4) || 'DNR';
  return `${slug.toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getPublicBaseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function signToken(user) {
  return jwt.sign({ userId: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

async function buildUserPayload(userId, req) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      referrals: true,
      subscriptions: {
        include: { level: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!user) return null;

  const activeSubscription = user.subscriptions.find((sub) => sub.status === 'ACTIVE') || null;
  const pendingSubscription = user.subscriptions.find((sub) => sub.status === 'PENDING') || null;

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    balance: user.balance,
    totalEarned: user.totalEarned,
    referralCode: user.referralCode,
    referralLink: `${getPublicBaseUrl(req)}/?ref=${user.referralCode}`,
    referralsCount: user.referrals.length,
    activeSubscription: activeSubscription
      ? {
          id: activeSubscription.id,
          status: activeSubscription.status,
          name: activeSubscription.level.name,
          dailyTaskCount: activeSubscription.level.dailyTaskCount,
          dailyProfitUsd: activeSubscription.level.dailyProfitUsd,
          startedAt: activeSubscription.startedAt,
        }
      : null,
    pendingSubscription: pendingSubscription
      ? {
          id: pendingSubscription.id,
          status: pendingSubscription.status,
          name: pendingSubscription.level.name,
          priceUsd: pendingSubscription.level.priceUsd,
          createdAt: pendingSubscription.createdAt,
        }
      : null,
  };
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      return res.status(401).json({ error: 'الجلسة غير صالحة.' });
    }
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'انتهت صلاحية الجلسة. سجل الدخول مرة أخرى.' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'هذه العملية متاحة للأدمن فقط.' });
  }
  next();
}

function parsePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function generateAiReply(message, user) {
  const text = String(message || '').trim();
  if (!text) return 'أرسل رسالتك وسأساعدك فوراً.';

  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await fetch(process.env.AI_PROVIDER_URL || 'https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || 'gpt-4.1-mini',
          messages: [
            {
              role: 'system',
              content: 'أنت مساعد دعم ذكي لمنصة دينارك. أجب بالعربية بشكل قصير وعملي وركز على الاشتراكات، الإيداع والسحب بالعملات الرقمية، الإحالات، والمهام اليومية.',
            },
            {
              role: 'user',
              content: `اسم المستخدم: ${user?.fullName || 'زائر'}\nالسؤال: ${text}`,
            },
          ],
          temperature: 0.4,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (content) return content;
      }
    } catch (error) {
      // fallback below
    }
  }

  const normalized = text.toLowerCase();
  if (normalized.includes('إيداع') || normalized.includes('deposit')) {
    return 'في دينارك الإيداع متاح فقط عبر العملات الرقمية. اختر العملة والشبكة، ثم أرسل المبلغ وهاش التحويل وسيظهر الطلب في لوحة الأدمن للمراجعة.';
  }
  if (normalized.includes('سحب') || normalized.includes('withdraw')) {
    return 'السحب أيضاً عبر العملات الرقمية فقط. أدخل العملة، الشبكة، عنوان المحفظة والمبلغ، وسيتم إرسال الطلب للمراجعة قبل الإكمال.';
  }
  if (normalized.includes('إحالة') || normalized.includes('referral')) {
    return 'لكل مستخدم رابط إحالة خاص يمكن مشاركته مباشرة. عند تسجيل مستخدم جديد برمزك يمكن منح مكافأة إحالة ومتابعتها من لوحة التحكم ولوحة الأدمن.';
  }
  if (normalized.includes('اشتراك') || normalized.includes('مستوى')) {
    return 'مستويات الاشتراك في دينارك مرتبطة بعدد المهام اليومي والربح الثابت لكل مستوى، وليس هناك ربح عشوائي. كل مستوى له مهام محددة وقيمة ربح يومية واضحة.';
  }
  if (normalized.includes('تسجيل') || normalized.includes('دخول')) {
    return 'التسجيل في دينارك سريع وطبيعي: الاسم، البريد، الهاتف وكلمة المرور فقط، مع إمكانية إدخال رمز إحالة عند الحاجة. بعد ذلك يمكنك تسجيل الدخول مباشرة.';
  }

  return 'مرحباً بك في دعم دينارك الذكي. أستطيع مساعدتك في التسجيل، الإيداع والسحب بالعملات الرقمية، رابط الإحالة، المهام اليومية، والمستويات المرتبطة بالأرباح.';
}

async function seedData() {
  for (const level of levelSeeds) {
    const upserted = await prisma.subscriptionLevel.upsert({
      where: { name: level.name },
      update: {
        priceUsd: level.priceUsd,
        dailyTaskCount: level.dailyTaskCount,
        dailyProfitUsd: level.dailyProfitUsd,
        benefits: level.benefits,
        sortOrder: level.sortOrder,
        isActive: true,
      },
      create: {
        ...level,
        isActive: true,
      },
    });

    const existingTasks = await prisma.taskTemplate.findMany({ where: { levelId: upserted.id } });
    if (existingTasks.length !== level.dailyTaskCount) {
      await prisma.taskTemplate.deleteMany({ where: { levelId: upserted.id } });
      await prisma.taskTemplate.createMany({
        data: makeTasksForLevel(level).map((task) => ({ ...task, levelId: upserted.id })),
      });
    }
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@dinarak.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@12345';
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!admin) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.user.create({
      data: {
        fullName: 'مدير النظام',
        email: adminEmail,
        phone: '0000000000',
        passwordHash,
        referralCode: makeReferralCode('ADM'),
        role: 'ADMIN',
      },
    });
  }
}

app.get('/api/health', async (req, res) => {
  const counts = await prisma.user.count();
  res.json({ ok: true, siteName: SITE_NAME, users: counts });
});

app.get('/api/public/config', (req, res) => {
  res.json({
    siteName: SITE_NAME,
    publicUrl: getPublicBaseUrl(req),
    cryptoOnly: true,
    wallets: {
      BTC: process.env.BTC_WALLET || 'bc1qexamplewallet',
      ETH: process.env.ETH_WALLET || '0xExampleWalletAddress',
      USDT_TRC20: process.env.USDT_TRC20_WALLET || 'TRC20ExampleWalletAddress',
      USDT_BEP20: process.env.USDT_BEP20_WALLET || 'BEP20ExampleWalletAddress',
    },
  });
});

app.get('/api/subscriptions', async (req, res) => {
  const levels = await prisma.subscriptionLevel.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(levels);
});

app.post('/api/auth/register', async (req, res) => {
  const { fullName, email, phone, password, referralCode } = req.body || {};

  if (!fullName || !email || !password) {
    return res.status(400).json({ error: 'الاسم والبريد وكلمة المرور مطلوبة.' });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'هذا البريد مستخدم مسبقاً.' });
  }

  let referredById = null;
  if (referralCode) {
    const referrer = await prisma.user.findUnique({ where: { referralCode } });
    if (!referrer) {
      return res.status(400).json({ error: 'رمز الإحالة غير صحيح.' });
    }
    referredById = referrer.id;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      fullName,
      email,
      phone: phone || null,
      passwordHash,
      referralCode: makeReferralCode(fullName),
      referredById,
    },
  });

  if (referredById) {
    await prisma.user.update({
      where: { id: referredById },
      data: {
        balance: { increment: 2 },
        totalEarned: { increment: 2 },
      },
    });

    await prisma.walletTransaction.create({
      data: {
        userId: referredById,
        type: 'REFERRAL_REWARD',
        status: 'COMPLETED',
        currency: 'USDT',
        network: 'REFERRAL',
        amount: 2,
        notes: `مكافأة إحالة عند تسجيل ${fullName}`,
      },
    });
  }

  const token = signToken(user);
  const profile = await buildUserPayload(user.id, req);
  res.status(201).json({ token, user: profile });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'أدخل البريد وكلمة المرور.' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
  }

  const token = signToken(user);
  const profile = await buildUserPayload(user.id, req);
  res.json({ token, user: profile });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const profile = await buildUserPayload(req.user.id, req);
  res.json(profile);
});

app.post('/api/subscriptions/request', authMiddleware, async (req, res) => {
  const { levelId } = req.body || {};
  if (!levelId) {
    return res.status(400).json({ error: 'اختر مستوى الاشتراك.' });
  }

  const level = await prisma.subscriptionLevel.findUnique({ where: { id: levelId } });
  if (!level) {
    return res.status(404).json({ error: 'المستوى غير موجود.' });
  }

  const existing = await prisma.userSubscription.findFirst({
    where: {
      userId: req.user.id,
      status: { in: ['PENDING', 'ACTIVE'] },
    },
  });

  if (existing) {
    return res.status(409).json({ error: 'لديك اشتراك نشط أو طلب قيد المراجعة بالفعل.' });
  }

  const request = await prisma.userSubscription.create({
    data: {
      userId: req.user.id,
      levelId: level.id,
      status: 'PENDING',
    },
    include: { level: true },
  });

  res.status(201).json({
    message: 'تم إرسال طلب الاشتراك إلى لوحة الأدمن للمراجعة.',
    subscription: request,
  });
});

app.get('/api/tasks/daily', authMiddleware, async (req, res) => {
  const activeSubscription = await prisma.userSubscription.findFirst({
    where: { userId: req.user.id, status: 'ACTIVE' },
    include: { level: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!activeSubscription) {
    return res.json({
      activeSubscription: null,
      tasks: [],
      message: 'لا توجد عضوية فعالة بعد. اختر مستوى وانتظر موافقة الأدمن.',
    });
  }

  const tasks = await prisma.taskTemplate.findMany({
    where: { levelId: activeSubscription.levelId, isActive: true },
    orderBy: { sortOrder: 'asc' },
  });

  const completions = await prisma.taskLog.findMany({
    where: { userId: req.user.id, completedOn: todayKey() },
    select: { taskTemplateId: true },
  });

  const completedSet = new Set(completions.map((item) => item.taskTemplateId));

  res.json({
    activeSubscription: {
      name: activeSubscription.level.name,
      dailyTaskCount: activeSubscription.level.dailyTaskCount,
      dailyProfitUsd: activeSubscription.level.dailyProfitUsd,
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      rewardUsd: task.rewardUsd,
      completed: completedSet.has(task.id),
    })),
  });
});

app.post('/api/tasks/:taskId/complete', authMiddleware, async (req, res) => {
  const { taskId } = req.params;

  const activeSubscription = await prisma.userSubscription.findFirst({
    where: { userId: req.user.id, status: 'ACTIVE' },
    include: { level: true },
  });

  if (!activeSubscription) {
    return res.status(400).json({ error: 'يجب تفعيل اشتراك أولاً.' });
  }

  const task = await prisma.taskTemplate.findUnique({ where: { id: taskId } });
  if (!task || task.levelId !== activeSubscription.levelId) {
    return res.status(404).json({ error: 'المهمة غير متاحة لهذا المستوى.' });
  }

  const completedOn = todayKey();
  const exists = await prisma.taskLog.findUnique({
    where: {
      userId_taskTemplateId_completedOn: {
        userId: req.user.id,
        taskTemplateId: task.id,
        completedOn,
      },
    },
  });

  if (exists) {
    return res.status(409).json({ error: 'تم تنفيذ هذه المهمة اليوم بالفعل.' });
  }

  await prisma.$transaction([
    prisma.taskLog.create({
      data: {
        userId: req.user.id,
        taskTemplateId: task.id,
        completedOn,
        rewardUsd: task.rewardUsd,
      },
    }),
    prisma.user.update({
      where: { id: req.user.id },
      data: {
        balance: { increment: task.rewardUsd },
        totalEarned: { increment: task.rewardUsd },
      },
    }),
    prisma.walletTransaction.create({
      data: {
        userId: req.user.id,
        type: 'TASK_REWARD',
        status: 'COMPLETED',
        currency: 'USDT',
        network: activeSubscription.level.name,
        amount: task.rewardUsd,
        notes: `مكافأة عن ${task.title}`,
      },
    }),
  ]);

  res.json({ message: 'تم اعتماد المهمة وإضافة الربح إلى الرصيد.' });
});

app.get('/api/referrals/me', authMiddleware, async (req, res) => {
  const referrals = await prisma.user.findMany({
    where: { referredById: req.user.id },
    select: { id: true, fullName: true, email: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    code: req.user.referralCode,
    link: `${getPublicBaseUrl(req)}/?ref=${req.user.referralCode}`,
    referrals,
  });
});

app.get('/api/wallet/transactions', authMiddleware, async (req, res) => {
  const transactions = await prisma.walletTransaction.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(transactions);
});

app.post('/api/wallet/deposits', authMiddleware, async (req, res) => {
  const { currency, network, amount, txHash } = req.body || {};
  const parsedAmount = parsePositiveNumber(amount);

  if (!currency || !network || !parsedAmount || !txHash) {
    return res.status(400).json({ error: 'أدخل العملة، الشبكة، المبلغ وهاش التحويل.' });
  }

  const deposit = await prisma.walletTransaction.create({
    data: {
      userId: req.user.id,
      type: 'DEPOSIT',
      status: 'PENDING',
      currency,
      network,
      amount: parsedAmount,
      txHash,
      notes: 'إيداع عبر العملات الرقمية فقط',
    },
  });

  res.status(201).json({
    message: 'تم إرسال طلب الإيداع الرقمي وسيظهر في لوحة الأدمن للمراجعة.',
    deposit,
  });
});

app.post('/api/wallet/withdrawals', authMiddleware, async (req, res) => {
  const { currency, network, amount, walletAddress } = req.body || {};
  const parsedAmount = parsePositiveNumber(amount);

  if (!currency || !network || !parsedAmount || !walletAddress) {
    return res.status(400).json({ error: 'أدخل العملة، الشبكة، المبلغ وعنوان المحفظة.' });
  }

  const pendingWithdrawals = await prisma.walletTransaction.findMany({
    where: {
      userId: req.user.id,
      type: 'WITHDRAWAL',
      status: 'PENDING',
    },
    select: { amount: true },
  });

  const lockedAmount = pendingWithdrawals.reduce((sum, item) => sum + item.amount, 0);
  const availableBalance = req.user.balance - lockedAmount;

  if (parsedAmount > availableBalance) {
    return res.status(400).json({ error: 'الرصيد المتاح غير كافٍ بعد خصم طلبات السحب المعلقة.' });
  }

  const withdrawal = await prisma.walletTransaction.create({
    data: {
      userId: req.user.id,
      type: 'WITHDRAWAL',
      status: 'PENDING',
      currency,
      network,
      amount: parsedAmount,
      walletAddress,
      notes: 'سحب رقمي بانتظار موافقة الأدمن',
    },
  });

  res.status(201).json({
    message: 'تم إرسال طلب السحب إلى لوحة الأدمن.',
    withdrawal,
  });
});

app.post('/api/support/ai', authMiddleware, async (req, res) => {
  const { message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: 'أدخل رسالة الدعم.' });
  }

  const reply = await generateAiReply(message, req.user);

  await prisma.supportMessage.createMany({
    data: [
      { userId: req.user.id, role: 'user', message },
      { userId: req.user.id, role: 'assistant', message: reply },
    ],
  });

  res.json({ reply });
});

app.get('/api/admin/overview', authMiddleware, adminMiddleware, async (req, res) => {
  const [
    totalUsers,
    activeSubscriptions,
    pendingSubscriptions,
    pendingTransactions,
    users,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'USER' } }),
    prisma.userSubscription.count({ where: { status: 'ACTIVE' } }),
    prisma.userSubscription.findMany({
      where: { status: 'PENDING' },
      include: { user: true, level: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.walletTransaction.findMany({
      where: { status: 'PENDING' },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findMany({
      where: { role: 'USER' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        subscriptions: {
          include: { level: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    }),
  ]);

  const balances = users.reduce((sum, user) => sum + user.balance, 0);

  res.json({
    metrics: {
      totalUsers,
      activeSubscriptions,
      pendingSubscriptions: pendingSubscriptions.length,
      pendingTransactions: pendingTransactions.length,
      totalVisibleBalances: Number(balances.toFixed(2)),
    },
    pendingSubscriptions,
    pendingTransactions,
    users: users.map((user) => ({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      balance: user.balance,
      referralCode: user.referralCode,
      latestSubscription: user.subscriptions[0] || null,
      createdAt: user.createdAt,
    })),
  });
});

app.post('/api/admin/subscriptions/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const subscription = await prisma.userSubscription.findUnique({
    where: { id: req.params.id },
    include: { user: true, level: true },
  });

  if (!subscription) {
    return res.status(404).json({ error: 'طلب الاشتراك غير موجود.' });
  }

  await prisma.$transaction([
    prisma.userSubscription.updateMany({
      where: {
        userId: subscription.userId,
        status: 'ACTIVE',
      },
      data: { status: 'EXPIRED', endsAt: new Date() },
    }),
    prisma.userSubscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        startedAt: new Date(),
        endsAt: null,
      },
    }),
  ]);

  res.json({ message: `تم تفعيل ${subscription.level.name} للمستخدم ${subscription.user.fullName}.` });
});

app.post('/api/admin/transactions/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  const transaction = await prisma.walletTransaction.findUnique({
    where: { id: req.params.id },
  });

  if (!transaction) {
    return res.status(404).json({ error: 'المعاملة غير موجودة.' });
  }

  if (transaction.status !== 'PENDING') {
    return res.status(400).json({ error: 'هذه المعاملة تمت معالجتها مسبقاً.' });
  }

  if (transaction.type === 'DEPOSIT') {
    await prisma.$transaction([
      prisma.walletTransaction.update({
        where: { id: transaction.id },
        data: { status: 'COMPLETED' },
      }),
      prisma.user.update({
        where: { id: transaction.userId },
        data: { balance: { increment: transaction.amount } },
      }),
    ]);
  } else if (transaction.type === 'WITHDRAWAL') {
    const user = await prisma.user.findUnique({ where: { id: transaction.userId } });
    if (!user || user.balance < transaction.amount) {
      return res.status(400).json({ error: 'الرصيد لم يعد كافياً لإكمال السحب.' });
    }

    await prisma.$transaction([
      prisma.walletTransaction.update({
        where: { id: transaction.id },
        data: { status: 'COMPLETED' },
      }),
      prisma.user.update({
        where: { id: transaction.userId },
        data: { balance: { decrement: transaction.amount } },
      }),
    ]);
  } else {
    await prisma.walletTransaction.update({
      where: { id: transaction.id },
      data: { status: 'COMPLETED' },
    });
  }

  res.json({ message: 'تم اعتماد المعاملة بنجاح.' });
});

app.post('/api/admin/transactions/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  const transaction = await prisma.walletTransaction.findUnique({ where: { id: req.params.id } });
  if (!transaction) {
    return res.status(404).json({ error: 'المعاملة غير موجودة.' });
  }
  await prisma.walletTransaction.update({
    where: { id: transaction.id },
    data: { status: 'REJECTED' },
  });
  res.json({ message: 'تم رفض المعاملة.' });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'حدث خطأ داخلي غير متوقع.' });
});

(async () => {
  try {
    await seedData();
    app.listen(PORT, () => {
      console.log(`${SITE_NAME} running on ${DEFAULT_PUBLIC_URL}`);
    });
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
})();
