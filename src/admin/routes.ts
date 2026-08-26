import { Router, Response } from 'express';
import { AuthenticatedRequest, requireSuperAdmin } from './middleware';
import { User } from '../models/User';
import { Transaction } from '../models/Transaction';
import { AdminAction } from '../models/AdminAction';
import { Wallet } from '../models/Wallet';
import { Precision } from '../utils/precision';
import { config, TON_DECIMALS, AFT_DECIMALS } from '../config';

const router = Router();

router.get('/dashboard', async (req: AuthenticatedRequest, res: Response) => {
  const totalUsers = await User.countDocuments();
  const totalSwaps = await Transaction.countDocuments({ type: 'swap' });
  const totalDeposits = await Transaction.countDocuments({ type: 'deposit' });
  const totalWithdrawals = await Transaction.countDocuments({ type: 'withdrawal' });
  const pendingTxs = await Transaction.countDocuments({ status: { $in: ['pending', 'processing'] } });

  const users = await User.find().select('tonBalance aftBalance');
  let totalTon = BigInt(0);
  let totalAft = BigInt(0);
  for (const u of users) {
    totalTon += BigInt(u.tonBalance);
    totalAft += BigInt(u.aftBalance);
  }

  res.json({
    totalUsers,
    totalSwaps,
    totalDeposits,
    totalWithdrawals,
    pendingTransactions: pendingTxs,
    totalTonCustodial: Precision.fromBaseUnits(totalTon, TON_DECIMALS),
    totalAftCustodial: Precision.fromBaseUnits(totalAft, AFT_DECIMALS),
    adminFeeWallet: config.adminFeeWalletAddress.replace(/(.{6}).+(.{4})/, '$1...$2'),
    platformFeePercent: config.platformSwapFeePercent,
    minSwapTon: config.minSwapTon,
    maxSlippagePercent: config.maxSlippagePercent,
  });
});

router.get('/users', async (req: AuthenticatedRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const skip = (page - 1) * limit;

  const users = await User.find()
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .select('-stateData');

  const total = await User.countDocuments();

  res.json({ users, total, page, pages: Math.ceil(total / limit) });
});

router.get('/users/:telegramId', async (req: AuthenticatedRequest, res: Response) => {
  const user = await User.findOne({ telegramId: parseInt(req.params.telegramId, 10) }).select('-stateData');
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const wallet = await Wallet.findOne({ userId: user._id }).select('address isImported');
  const transactions = await Transaction.find({ userId: user._id })
    .sort({ createdAt: -1 })
    .limit(20);

  res.json({ user, wallet, transactions });
});

router.post('/users/:telegramId/freeze', async (req: AuthenticatedRequest, res: Response) => {
  const targetId = parseInt(req.params.telegramId, 10);

  if (targetId === config.superAdminTelegramId) {
    res.status(403).json({ error: 'Cannot freeze Super Admin' });
    return;
  }

  const user = await User.findOne({ telegramId: targetId });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  user.isFrozen = !user.isFrozen;
  await user.save();

  await AdminAction.create({
    adminId: req.adminUser!.telegramId,
    action: user.isFrozen ? 'USER_FROZEN' : 'USER_UNFROZEN',
    target: targetId.toString(),
    result: 'success',
  });

  res.json({ success: true, isFrozen: user.isFrozen });
});

router.get('/transactions', async (req: AuthenticatedRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const skip = (page - 1) * limit;

  const filter: any = {};
  if (req.query.type) filter.type = req.query.type;
  if (req.query.status) filter.status = req.query.status;

  const txs = await Transaction.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('userId', 'telegramId firstName');

  const total = await Transaction.countDocuments(filter);

  res.json({ transactions: txs, total, page, pages: Math.ceil(total / limit) });
});

router.get('/transactions/:id', async (req: AuthenticatedRequest, res: Response) => {
  const tx = await Transaction.findById(req.params.id).populate('userId', 'telegramId firstName');
  if (!tx) {
    res.status(404).json({ error: 'Transaction not found' });
    return;
  }
  res.json(tx);
});

router.post('/admins', requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { telegramId } = req.body;
  const target = await User.findOne({ telegramId: parseInt(telegramId, 10) });

  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  target.isAdmin = true;
  await target.save();

  await AdminAction.create({
    adminId: req.adminUser!.telegramId,
    action: 'ADMIN_CREATED',
    target: telegramId,
    result: 'success',
  });

  res.json({ success: true });
});

router.delete('/admins/:telegramId', requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const targetId = parseInt(req.params.telegramId, 10);

  if (targetId === config.superAdminTelegramId) {
    res.status(403).json({ error: 'Cannot remove Super Admin' });
    return;
  }

  const target = await User.findOne({ telegramId: targetId });
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  target.isAdmin = false;
  await target.save();

  await AdminAction.create({
    adminId: req.adminUser!.telegramId,
    action: 'ADMIN_REMOVED',
    target: targetId.toString(),
    result: 'success',
  });

  res.json({ success: true });
});

router.get('/admins', requireSuperAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const admins = await User.find({ isAdmin: true }).select('telegramId firstName username isSuperAdmin createdAt');
  res.json({ admins });
});

router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 50;
  const skip = (page - 1) * limit;

  const logs = await AdminAction.find()
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await AdminAction.countDocuments();

  res.json({ logs, total, page, pages: Math.ceil(total / limit) });
});

router.get('/settings', async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    adminFeeWallet: config.adminFeeWalletAddress,
    platformFeePercent: config.platformSwapFeePercent,
    minSwapTon: config.minSwapTon,
    maxSlippagePercent: config.maxSlippagePercent,
    aftJettonAddress: config.aftJettonAddress,
    tonNetwork: config.tonNetwork,
  });
});

router.get('/reconciliation', async (req: AuthenticatedRequest, res: Response) => {
  const pendingSwaps = await Transaction.countDocuments({ type: 'swap', status: 'processing' });
  const pendingWithdrawals = await Transaction.countDocuments({ type: 'withdrawal', status: 'processing' });
  const pendingFees = await Transaction.countDocuments({ type: 'fee_transfer', status: 'processing' });
  const failedFees = await Transaction.countDocuments({ type: 'fee_transfer', status: 'failed' });

  res.json({
    pendingSwaps,
    pendingWithdrawals,
    pendingFees,
    failedFees,
    adminFeeWallet: config.adminFeeWalletAddress,
  });
});

export { router as adminRoutes };
    
