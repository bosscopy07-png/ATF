import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from './middleware';
import { RelayAddress } from '../models/RelayAddress';
import { TransferOperation } from '../models/TransferOperation';
import { TransferRelayService } from '../services/transfer-relay-service';
import { config } from '../config';

export const relayAdminRouter = Router();

relayAdminRouter.use(authMiddleware);

/**
 * NEVER returns encryptedMnemonic / iv / tag. Public address + status only.
 */
relayAdminRouter.get('/addresses', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, page = '1' } = req.query as any;
    const filter: any = {};
    if (status) filter.status = status;

    const pageSize = 20;
    const [items, total] = await Promise.all([
      RelayAddress.find(filter)
        .sort({ updatedAt: -1 })
        .skip((Number(page) - 1) * pageSize)
        .limit(pageSize)
        .select('-encryptedMnemonic -iv -tag'),   // ⛔ signing material never leaves the server
      RelayAddress.countDocuments(filter),
    ]);

    // Enrich with pending op counts + last activity
    const enriched = await Promise.all(items.map(async (a) => {
      const [pendingCount, lastOp] = await Promise.all([
        TransferOperation.countDocuments({
          relayAddressId: a._id,
          state: { $in: ['FUNDING', 'FUNDED', 'SENDING', 'RECOVERY_REQUIRED'] },
        }),
        TransferOperation.findOne({ relayAddressId: a._id }).sort({ updatedAt: -1 })
          .select('state updatedAt fundingTxHash outgoingTxHash requestedAmountNano'),
      ]);
      return {
        id: a._id,
        address: a.address,
        userId: a.userId,
        label: a.label,
        status: a.status,
        walletVersion: a.walletVersion,
        cachedBalanceNano: a.cachedBalanceNano,
        pendingTransactionCount: pendingCount,
        nextEligibleAt: a.nextEligibleAt,
        lastActivityAt: a.lastActivityAt ?? lastOp?.updatedAt,
        lastOperation: lastOp ? {
          state: lastOp.state,
          fundingTxHash: lastOp.fundingTxHash,
          outgoingTxHash: lastOp.outgoingTxHash,
        } : null,
        recoveryRequired: a.status === 'recovery_required',
      };
    }));

    res.json({ items: enriched, total, page: Number(page), pageSize });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load relay addresses' });
  }
});

relayAdminRouter.get('/operations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { state, page = '1' } = req.query as any;
    const filter: any = {};
    if (state) filter.state = state;

    const pageSize = 20;
    const [items, total] = await Promise.all([
      TransferOperation.find(filter)
        .sort({ updatedAt: -1 })
        .skip((Number(page) - 1) * pageSize)
        .limit(pageSize),
      TransferOperation.countDocuments(filter),
    ]);

    res.json({ items, total, page: Number(page), pageSize });
  } catch {
    res.status(500).json({ error: 'Failed to load relay operations' });
  }
});

/**
 * Treasury consolidation. Explicit admin confirmation, idempotent audit.
 */
relayAdminRouter.post('/treasury-sweep', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!config.features.treasurySweep) {
      res.status(403).json({ error: 'Treasury sweep feature is disabled' });
      return;
    }
    if (!req.adminUser?.isSuperAdmin) {
      res.status(403).json({ error: 'Super Admin required' });
      return;
    }

    const { reason } = req.body || {};
    const service = new TransferRelayService();
    const results = await service.sweepResidualToTreasury(
      req.adminUser.telegramId,
      String(reason || '')
    );

    res.json({
      ok: true,
      swept: results.filter((r) => !r.error).length,
      failed: results.filter((r) => r.error).length,
      results: results.map((r) => ({
        address: r.address,
        amountNano: r.amountNano,
        txHash: r.txHash,
        error: r.error,
      })),
    });
  } catch (err: any) {
    res.status(400).json({ error: String(err.message).slice(0, 300) });
  }
});
